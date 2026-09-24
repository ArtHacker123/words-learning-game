import type { Word, WordStats, Direction, EncounterOutcome } from "../core/model";
import { TUNING } from "../core/tuning";

// 布局常量:植物格原点(x=120,cells 每 60px)与精灵碰撞半宽
const PLANT_ORIGIN_X = 120;
const PLANT_CELL_W = 60;
const ZOMBIE_HALF_W = 22;
const PLANT_HALF_W = 24;
const BASE_EDGE_X = 24; // 基地墙(画布左侧)右缘:僵尸身体边缘碰到即开始攻城
const ZOMBIE_SPRITE_CX = 30; // renderer 把 z.x 左移 30 像素作为精灵中心

export interface Zombie {
  id: string;
  wordId: string;
  direction: Direction;
  teaching: boolean;
  boss: boolean;
  act: number; // 所属幕 1..5
  hp: number;
  maxHp: number;
  speed: number; // px/s,向左推进速度
  x: number; // 像素位置(从右往左)
  lane: number;
  buffed: boolean; // 曾被错配激怒(视觉放大)
  reachedBase: boolean;
  frozenUntil: number; // 凝固弹冻结截止(绝对战斗时刻),>=0
  nibbleUntil?: number; // 啃食完成截止时刻(绝对);期间不推进
  nibblingPlantId?: string; // 正在啃食的植物 id(植物被移除则恢复前进)
  siegeTimer?: number; // 到岸攻城的咬击倒计时
  ultimate?: boolean; // 终局接力 boss(跨全 lane 行进)
  phaseIdx?: number; // 当前接力词段游标
  cycle?: { wordId: string; direction: Direction }[]; // 接力词段(词段打空换下一个)
  escortOf?: string; // 护卫小怪:所属终局 boss 的 id
  escortOffset?: number; // 护卫小怪相对 boss 精灵中心的 x 偏移(+右/后扬 -左/前出)
}

export interface ZombieSpec {
  wordId: string;
  direction: Direction;
  teaching: boolean;
  boss: boolean;
  act: number; // 1..5 所属幕
  ultimate?: boolean; // 终局接力 boss
  cycle?: { wordId: string; direction: Direction }[]; // 接力词段
}

/** 单株武器升级项 */
export type UpgradeKey = "autoFire" | "dmg" | "reload" | "freeze";

export interface Plant {
  id: string;
  wordId: string;
  labelText: string; // 展示文本(中文/外语 视方向)
  lane: number;
  cellX: number;
  reloadRemain: number; // 剩余装弹时间(s),<=0 表示可发射
  jamming: boolean; // 哑火中
  rescueCooldown: number; // 救援免费装弹冷却
  autoFire: boolean; // 自动发射升级
  dmgBoost: number; // 破甲弹药(+1/+2)
  reloadBoost: boolean; // 急速装填(reload 1.5→1.0s)
  freezeStun: boolean; // 凝固弹
}

/** 终局冲击波:整场竖排光带,右→左横扫,摧毁路径上所有植物后消散(不伤僵尸/基地) */
export interface Shockwave {
  id: string;
  x: number; // 光带前缘 x(px),向左推进
  speed: number; // px/s
}

export interface BattleEvents {
  /** 僵尸被击倒时:记录本次回忆 */
  onKill?: (outcome: EncounterOutcome) => void;
  /** 错匹配时通知(供统计 correction 与日志) */
  onMismatch?: (plant: Plant, zombie: Zombie) => void;
  onReplace?: (plant: Plant) => void; // 种不同词替换掉旧株时回调参数为被移除的旧株
  /** 每次发射后通知(供动画层播放炮弹/受击效果) */
  onShot?: (plant: Plant, zombie: Zombie, hit: boolean) => void;
  onBaseHit?: (zombie: Zombie) => void;
  onNibble?: (plant: Plant, zombie: Zombie) => void; // 僵尸撞上植物开始啃食
  onVore?: (plant: Plant) => void; // 植物被啃食殆尽(移除)
  onShockHit?: (plant: Plant) => void; // 植物被终局冲击波摧毁(不退款)
  onDefeat?: () => void;
  onVic?: () => void;
}

export class Battle {
  zombies: Zombie[] = [];
  plants: Plant[] = [];
  shockwaves: Shockwave[] = [];
  sun = 100;
  baseHp = 100;
  baseArmorUntil = 0; // 基地护甲激活的绝对战斗时刻截止点(<=this.time 表示未激活)
  combo = 0;
  maxCombo = 0;
  time = 0;
  fieldWidth = 0;
  fieldHeight = 0;
  laneCount = 3;
  laneHeight = 0;
  currentAct = 0; // 当前进行的幕(1..4);0=尚未出怪
  lastAct = 0;   // 胜利所需的最终幕(会话层通过 setActWave 设置)

  private spawnQueue: ZombieSpec[];
  private spawnTimer = 0;
  private spawnInterval: number;
  private maxAlive: number;
  private parallelProb: number;
  private words: Map<string, Word>;
  private statsByWord: Map<string, WordStats>;
  private events: BattleEvents;
  private outcomePerWord = new Map<string, EncounterOutcome>();
  private over = false;
  private victory = false;
  paused = false; // true=升级面板等场景整体冻结:时间/僵尸推进/装弹/自动开火全停
  private fieldIsReady = false;
  // 第 5 幕冲击波调度:终局 boss 存活期间随机发波,累计最多 shockCount 次
  private shockArmed = false;
  private shockRemaining = 0;
  private shockTimer = 0;

  constructor(
    options: {
      zombies: ZombieSpec[];
      spawnInterval: number;
      maxAlive: number;
      parallelProb?: number; // 并行出怪概率 0..1(同一帧同时弹出多只)
      words: Map<string, Word>;
      statsByWord: Map<string, WordStats>;
      events?: BattleEvents;
    },
  ) {
    this.words = options.words;
    this.statsByWord = options.statsByWord;
    this.events = options.events ?? {};
    this.spawnInterval = options.spawnInterval;
    this.maxAlive = options.maxAlive;
    this.parallelProb = options.parallelProb ?? 0;
    this.spawnQueue = options.zombies;
  }

  /** 换幕:重填出怪队列与节奏,回到该幕起始参数。 */
  setActWave(zombies: ZombieSpec[], spawnInterval: number, maxAlive: number, act: number, parallelProb = 0): void {
    this.spawnQueue = zombies.length ? [...zombies] : [];
    this.spawnInterval = spawnInterval;
    this.maxAlive = maxAlive;
    this.parallelProb = parallelProb;
    this.currentAct = act;
    this.spawnTimer = 0;
  }

  /** 当前幕是否打完(队列空且场上无僵尸)。 */
  isWaveCleared(): boolean {
    return this.spawnQueue.length === 0 && this.zombies.length === 0;
  }

  /** 终局 boss 出场护卫:前后各一对(lane1/3),词段与 boss 当前段一致,相对 x 偏移固定。 */
  private spawnUltimateEscorts(boss: Zombie): void {
    // 前后 x 偏移:前出(靠基地,负)>后扬(靠右边,正),以 boss 精灵中心为基准。
    // 偏移必须 ≥ boss 身体半径,否则护卫会与大怪身体重叠;再加 50px 间距及护卫自身半径余量
    const gap = this.spriteRadius(boss) + 50;
    const formation: { lane: number; offset: number }[] = [
      { lane: 1, offset: -gap },
      { lane: 3, offset: -gap },
      { lane: 1, offset: +gap },
      { lane: 3, offset: +gap },
    ];
    for (const f of formation) {
      const esc = makeZombie(
        { wordId: boss.wordId, direction: boss.direction, teaching: false, boss: false, act: 5 },
        f.lane,
        this.statsByWord.get(boss.wordId),
        boss.x,
        this.statsByWord,
      );
      esc.escortOf = boss.id;
      esc.escortOffset = f.offset;
      esc.x = boss.x + f.offset;
      this.zombies.push(esc);
    }
  }

  static size(w: number, h: number, laneCount: number): { fieldWidth: number; fieldHeight: number; laneHeight: number } {
    return { fieldWidth: w, fieldHeight: h, laneHeight: h / laneCount };
  }

  setField(w: number, h: number, laneCount: number): void {
    this.fieldWidth = w;
    this.fieldHeight = h;
    this.laneCount = laneCount;
    this.laneHeight = h / laneCount;
    this.fieldIsReady = true;
  }

  /** 帧更新(秒为单位推进) */
  tick(dt: number): void {
    if (this.over || this.paused || !this.fieldIsReady) return;
    this.time += dt;

    // 阳光自动滴漏
    this.sun += TUNING.sunDripPerSecond * dt;

    // 出怪:按 queue 与压力参数;以 parallelProb 概率同帧弹 batch(2只)并行出怪
    if (this.spawnQueue.length > 0) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0 && this.aliveCount() < this.maxAlive) {
        const batch = this.rollBatch();
        const lanes = this.pickLanes(batch);
        for (let i = 0; i < batch && this.spawnQueue.length > 0; i++) {
          const spec = this.spawnQueue.shift()!;
          const lane = lanes[i];
          const z = makeZombie(spec, lane, this.statsByWord.get(spec.wordId), this.fieldWidth + 40, this.statsByWord);
          this.zombies.push(z);
          this.currentAct = Math.max(this.currentAct, spec.act ?? 1);
          // 终局 boss 出场:前后各一对护卫小怪(lane 1/3),同段词、相对位置固定
          if (z.ultimate) this.spawnUltimateEscorts(z);
        }
        this.spawnTimer = this.spawnInterval;
      }
    }

    // 僵尸推进:凝固弹冻结中的僵尸暂停移动;撞上植物时停下啃食 2 秒后植物消失;
    // 到达基地的僵尸不消失,留在场上周期性"咬基地"直到基地沦陷。
    for (const z of this.zombies) {
      // 护卫小怪:不独立行走/啃食/攻城,每帧吸附到所属 boss 的相对位置
      if (z.escortOf) {
        const boss = this.zombies.find((b) => b.id === z.escortOf);
        if (!boss) continue; // boss 本帧已死亡消失,清理段负责移除
        z.x = boss.x + (z.escortOffset ?? 0);
        continue;
      }
      if (z.frozenUntil > this.time) continue;
      // 攻城僵尸:原地周期性破坏基地(可被玩家射杀阻止)
      if (z.reachedBase) {
        if (z.siegeTimer === undefined) z.siegeTimer = TUNING.baseSiegeInterval;
        z.siegeTimer -= dt;
        if (z.siegeTimer <= 0) {
          z.siegeTimer = TUNING.baseSiegeInterval;
          this.baseHp -= this.damageOnReach(z);
          this.events.onBaseHit?.(z);
        }
        continue;
      }
      // 啃食中:到点即吃掉植物并恢复前进;若植物提前消失则立恢复正常
      if (z.nibblingPlantId) {
        const p = this.plants.find((q) => q.id === z.nibblingPlantId);
        if (!p) {
          z.nibblingPlantId = undefined;
          z.nibbleUntil = 0;
        } else if (z.nibbleUntil !== undefined && z.nibbleUntil <= this.time) {
          this.eatPlant(p);
          z.nibblingPlantId = undefined;
          z.nibbleUntil = 0;
        } else {
          continue; // 仍在啃食,原地不动
        }
      }
      // 前方撞到新植物:开始啃食(终局 boss 跨 lane 行进,不啃植物)
      const ahead = z.ultimate ? undefined : this.plantAhead(z);
      if (ahead) {
        z.nibblingPlantId = ahead.id;
        z.nibbleUntil = this.time + TUNING.eatPlantSeconds;
        this.events.onNibble?.(ahead, z);
        continue;
      }
      z.x -= z.speed * dt;
      // 触墙判定用"身体边缘"而非中心点:精灵左缘(身体半径)碰到基地墙右缘即停步攻城,
      // 避免身体先穿墙后才开始咬基地。体型越大(头目/终局)越早触墙,与视觉一致。
      if (z.x + ZOMBIE_SPRITE_CX - this.spriteRadius(z) <= BASE_EDGE_X) {
        z.reachedBase = true;
        z.siegeTimer = TUNING.baseSiegeInterval;
        this.recordZombieLost(z); // 到岸即错过回忆(成功粘住语义保留)
        this.baseHp -= this.damageOnReach(z); // 到岸立即咬第一口
        this.events.onBaseHit?.(z);
      }
    }

    // 第 5 幕终局冲击波:终局 boss 存活期间随机发波(最多 shockCount 次);
    // 整场竖排光带右→左横扫,摧毁路径上所有植物后于左侧消散(不伤僵尸/基地)
    this.tickShockwaves(dt);

    // 植物装弹恢复;哑火持续到救援冷却结束(错配后 3s 内不可开火)
    for (const p of this.plants) {
      if (p.reloadRemain > 0) p.reloadRemain -= dt;
      if (p.rescueCooldown > 0) p.rescueCooldown -= dt;
      p.jamming = p.rescueCooldown > 0;
    }

    // 自动发射升级:装弹完成且未哑火的株,自动打同 lane 匹配非教学僵尸
    this.autoTickFire();

    // 清掉死亡僵尸;到岸僵尸留在场上继续攻城(再被杀:直接退场,不再重复记录)
    const remaining: Zombie[] = [];
    // 本帧死亡/退场的终局 boss,其护卫小怪随之消失(不额外发奖);
    // 到岸但仍存活的 boss 保留护卫(它们跟着 boss 一起围攻)
    const goneBossIds = new Set<string>();
    for (const z of this.zombies) {
      if (z.ultimate && z.hp <= 0) goneBossIds.add(z.id);
    }
    for (const z of this.zombies) {
      if (z.escortOf && goneBossIds.has(z.escortOf)) continue; // 护卫随 boss 一起退场
      if (z.hp <= 0) {
        if (z.reachedBase) continue; // 攻城僵尸被击退:已记录失败,不再走 kill 覆盖
        if (z.ultimate && (z.phaseIdx ?? 0) < (z.cycle?.length ?? 1) - 1) {
          remaining.push(z); // 防御:段尚未打完不该死亡(越段余量由 advance 吸收)
          continue;
        }
        this.kill(z);
        continue;
      }
      if (z.reachedBase) {
        remaining.push(z);
        continue;
      }
      remaining.push(z);
    }
    this.zombies = remaining;

    // 失败/胜利判定
    if (this.baseHp <= 0) {
      this.over = true;
      this.victory = false;
      this.events.onDefeat?.();
    } else if (this.spawnQueue.length === 0 && this.zombies.length === 0 && this.currentAct >= this.lastAct) {
      this.over = true;
      this.victory = true;
      this.events.onVic?.();
    }
  }

  aliveCount(): number {
    return this.zombies.length;
  }

  /** 并行出怪:掷骰决定本帧弹几只(1 或 2),并受 maxAlive 余量约束。 */
  private rollBatch(): number {
    if (this.parallelProb <= 0) return 1;
    const headroom = this.maxAlive - this.aliveCount();
    const would = Math.random() < this.parallelProb ? 2 : 1;
    return Math.min(would, headroom, 2);
  }

  /** 为 batch 选取互不相同的随机 lane(优先当前无僵尸的空 lane)。 */
  private pickLanes(batch: number): number[] {
    const all = Array.from({ length: this.laneCount }, (_, i) => i);
    const free = all.filter((l) => !this.zombies.some((z) => z.lane === l));
    const source = free.length >= batch ? shuffle(free) : shuffle(all);
    return source.slice(0, batch);
  }

  /**
   * 终局冲击波:调度 + 推进 + 命中 + 消散。
   * - 首次发现存活终局 boss(z.ultimate && hp>0)时武装,首波延迟随机 [firstDelayMin, firstDelayMax];
   * - 之后每隔随机 [intervalMin, intervalMax] 发一波,累计最多 shockCount 次;
   * - boss 阵亡即停止调度(已在场的波照常跑完);
   * - 每波**从终局 boss 中心点**起向左扫,路径上(整列)植物全灭(不退款)后于左缘消散。
   */
  private tickShockwaves(dt: number): void {
    const ultimate = this.zombies.find((z) => z.ultimate && z.hp > 0);
    const ultimateAlive = !!ultimate;
    if (ultimateAlive && !this.shockArmed) {
      // 第 5 幕终局 boss 首次在场:武装并安排首波随机延迟
      this.shockArmed = true;
      this.shockRemaining = TUNING.shockCount;
      this.shockTimer = randBetween(TUNING.shockFirstDelayMin, TUNING.shockFirstDelayMax);
    }
    if (!this.shockArmed || this.shockRemaining <= 0) {
      // 未武装 / 额度用尽;boss 已死则维持 armed=false(不再重启)
      if (!ultimateAlive && this.shockArmed) this.shockArmed = false;
    } else if (ultimateAlive) {
      this.shockTimer -= dt;
      if (this.shockTimer <= 0) {
        // 波从 boss 中心或右侧身缘发出
        this.spawnShockwave(ultimate!.x + ZOMBIE_SPRITE_CX + TUNING.shockTw / 2);
        this.shockRemaining -= 1;
        this.shockTimer = randBetween(TUNING.shockIntervalMin, TUNING.shockIntervalMax);
      }
    }

    // 推进 + 命中 + 消散
    const remaining: Shockwave[] = [];
    for (const sw of this.shockwaves) {
      sw.x -= sw.speed * dt;
      // 竖排光带扫过的整列植物全灭:|px - sw.x| <= tw/2(波宽覆盖该列)
      const hit = this.plants.filter((p) => Math.abs(plantX(p) - sw.x) <= TUNING.shockTw / 2);
      for (const p of hit) {
        const idx = this.plants.indexOf(p);
        if (idx >= 0) this.plants.splice(idx, 1);
        this.events.onShockHit?.(p);
      }
      if (sw.x <= -TUNING.shockTw) continue; // 已越出左缘 → 消散
      remaining.push(sw);
    }
    this.shockwaves = remaining;
  }

  /**
   * 手动发射一道冲击波(测试/调试用;正常由 tickShockwaves 调度)。
   * 未给定 startX 时默认从终局 boss 中心点发出;无 boss 则退化为画布右缘。
   */
  spawnShockwave(startX?: number): void {
    const ultimate = this.zombies.find((z) => z.ultimate && z.hp > 0);
    const origin = startX ?? (ultimate ? ultimate.x + ZOMBIE_SPRITE_CX + TUNING.shockTw / 2 : this.fieldWidth + TUNING.shockTw / 2);
    this.shockwaves.push({
      id: `sw${Math.random().toString(36).slice(2)}`,
      x: origin,
      speed: TUNING.shockSpeed,
    });
  }

  damageOnReach(z: Zombie): number {
    // 到岸僵尸每次咬基地的伤害(每 baseSiegeInterval 秒咬一口):教学/弱怪低,头目高,终局最高
    const base = z.ultimate
      ? TUNING.ultimateSiegeDamage
      : z.boss
        ? 16
        : z.teaching
          ? 2
          : 6;
    // 基地护甲生效期间:僵尸攻击力减半(向上取整,至少 1)
    if (this.baseArmorActive()) return Math.max(1, Math.ceil(base / 2));
    return base;
  }

  /** 基地护甲是否生效:激活时长 baseArmorSeconds 内有效,到时自动失效。 */
  baseArmorActive(): boolean {
    return this.time < this.baseArmorUntil;
  }

  /** 激活基地护甲(升级面板「基地护甲」购买):从当前时刻起持续 baseArmorSeconds。 */
  activateBaseArmor(): void {
    this.baseArmorUntil = this.time + TUNING.baseArmorSeconds;
  }

  /** 僵尸精灵可视半径(与 renderer.placeholderDrawer 的 r 同步):
   *  终局=车道高×1.4;其余=基础 18 ×(1 + 头目1.3 / 发怒0.25)。用于"身体边缘触墙"判定。 */
  spriteRadius(z: Zombie): number {
    if (z.ultimate) return (this.fieldHeight / this.laneCount) * 1.4;
    return 18 * (1 + (z.boss ? 1.3 : z.buffed ? 0.25 : 0));
  }

  /** 种植一根植物到某 lane;label 由 UI 按方向决定(正向=中文,反向=外语)。
   *  规则:同一 lane 中新种与已有植物词不同 → 自动移除旧株(替换,不退款);
   *       同词 → 并存(每株独立装弹/升级,可一起攻击)。 */
  placePlant(wordId: string, lane: number, labelText?: string): Plant | null {
    if (this.sun < TUNING.plantCostSun) return null;
    // 同一 lane 同词并存上限(默认 3 株):超出拒绝种植,不扣阳光
    const sameInLane = this.plants.filter((p) => p.lane === lane && p.wordId === wordId).length;
    if (sameInLane >= TUNING.maxSamePlantPerLane) return null;
    const word = this.words.get(wordId);
    const label = labelText ?? (word ? word.chinese : wordId);
    // 同 lane 不同词:替换移除旧株(不退款)
    const replaced = this.plants.filter((p) => p.lane === lane && p.wordId !== wordId);
    for (const r of replaced) {
      const idx = this.plants.indexOf(r);
      if (idx >= 0) this.plants.splice(idx, 1);
      this.events.onReplace?.(r);
    }
    this.sun -= TUNING.plantCostSun;
    // 同 lane 全株(含同词并存)横向排开,避免重叠不可点
    const cellX = this.plants.filter((p) => p.lane === lane).length;
    const plant: Plant = {
      id: `p${this.plants.length}`,
      wordId,
      labelText: label,
      lane,
      cellX,
      reloadRemain: 0, // 种下即装填完毕:种植即首发判定(5.1)
      jamming: false,
      rescueCooldown: 0,
      autoFire: false,
      dmgBoost: 0,
      reloadBoost: false,
      freezeStun: false,
    };
    this.plants.push(plant);
    return plant;
  }

  /** 该株开火所需间隔(急速装填 1.0s 否则 1.5s;凝固弹株射速减半 = 装填 ×2)。 */
  reloadTime(plant: Plant): number {
    const base = plant.reloadBoost ? TUNING.upgradeReloadSeconds : TUNING.reloadSeconds;
    return plant.freezeStun ? base * TUNING.freezeFireIntervalScale : base;
  }

  /** 移出已种的植物(右键),退还阳光成本。 */
  removePlant(plant: Plant): void {
    const idx = this.plants.indexOf(plant);
    if (idx < 0) return;
    this.plants.splice(idx, 1);
    this.sun += TUNING.plantCostSun;
  }

  /** 僵尸前方(同 lane)最右侧的那株植物,碰撞即触发啃食 */
  private plantAhead(z: Zombie): Plant | null {
    const zCenter = z.x + 30; // renderer 偏移:精灵中心
    let best: Plant | null = null;
    let bestX = -Infinity;
    for (const p of this.plants) {
      if (p.lane !== z.lane) continue;
      const px = PLANT_ORIGIN_X + p.cellX * PLANT_CELL_W;
      if (Math.abs(zCenter - px) <= ZOMBIE_HALF_W + PLANT_HALF_W && px > bestX) {
        best = p;
        bestX = px;
      }
    }
    return best;
  }

  /** 啃食殆尽:直接从场上移除该植物(不退还阳光),通知 UI */
  private eatPlant(p: Plant): void {
    const idx = this.plants.indexOf(p);
    if (idx >= 0) this.plants.splice(idx, 1);
    this.events.onVore?.(p);
  }

  /** 手动点火:选植物 -> 选同 lane 僵尸;MVP 由 UI 层决定目标,此处做命中判定 */
  fire(plant: Plant, zombie: Zombie): { hit: boolean; plant: Plant; zombie: Zombie } {
    if (plant.lane !== zombie.lane && !zombie.ultimate) {
      // 跨 lane 不可攻击(终局 boss 横跨全 lane,任意行植物均可朝其开火):
      // 返回 miss 但不算错配(视为无法瞄准)
      return { hit: false, plant, zombie };
    }
    // 需要在装弹完成、未哑火才可发射
    if (plant.reloadRemain > 0 || plant.jamming) {
      return { hit: false, plant, zombie };
    }
    // 判定:该 lane、同词的植物,标签文本需与僵尸的"答案侧"一致。
    // 正向:僵尸穿外语,植物标签=中文;反向:僵尸穿中文,植物标签=外语。
    const word = this.words.get(zombie.wordId);
    if (!word) {
      return { hit: false, plant, zombie };
    }
    const expected =
      zombie.direction === "forward" ? word.chinese : word.foreign;
    const match =
      plant.wordId === zombie.wordId && plant.labelText === expected;

    // 消耗装弹
    plant.reloadRemain = this.reloadTime(plant);

    if (match) {
      zombie.hp -= 1 + plant.dmgBoost;
      // 终局 boss:打空一段即原位换下一个接力词段(HP 重置到该段上线值)
      if (zombie.ultimate) this.advanceUltimatePhase(zombie);
      this.combo += 1;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      this.sun += TUNING.sunHitBonus;
      // 凝固弹:命中冻结(普通 2.5s,Boss 缩至 1s)
      if (plant.freezeStun) {
        zombie.frozenUntil = this.time + (zombie.boss ? TUNING.freezeStunSeconds * TUNING.bossStunScale : TUNING.freezeStunSeconds);
      }
      this.events.onShot?.(plant, zombie, true);
      return { hit: true, plant, zombie };
    }
    // 错配:植物哑火 + 僵尸变强
    plant.jamming = true;
    plant.rescueCooldown = 3; // 错配后短暂救援冷却
    zombie.hp += 1;
    zombie.speed *= 1.25;
    zombie.buffed = true;
    this.combo = 0;
    this.recordMismatchForWord(zombie.wordId);
    this.events.onMismatch?.(plant, zombie);
    this.events.onShot?.(plant, zombie, false);
    return { hit: false, plant, zombie };
  }

  /** 自动发射升级:tick 内调用。仅对装填完成、未哑火、autoFire 的株生效;只打同 lane 匹配的非教学僵尸。 */
  private autoTickFire(): void {
    if (this.over) return;
    for (const p of this.plants) {
      if (!p.autoFire || p.reloadRemain > 0 || p.jamming) continue;
      const word = this.words.get(p.wordId);
      if (!word) continue;
      // 该 lane 最先出现的匹配非教学僵尸(终局 boss 恒视为同 lane);自动射击不产生错配,教学词保持手动回忆
      const target = this.zombies
        .filter((z) => (z.lane === p.lane || !!z.ultimate) && z.hp > 0 && !z.teaching && z.wordId === p.wordId && (z.direction === "forward" ? word.chinese : word.foreign) === p.labelText)
        .sort((a, b) => a.x - b.x)[0];
      if (target) this.fire(p, target);
    }
  }

  /** 某项升级的费用(破甲弹药按等级递增),未支持或满级返回 null。 */
  upgradeCost(plant: Plant, key: UpgradeKey): number | null {
    switch (key) {
      case "autoFire":
        return plant.autoFire ? null : TUNING.upgradeAutoFireCost;
      case "reload":
        return plant.reloadBoost ? null : TUNING.upgradeReloadCost;
      case "freeze":
        return plant.freezeStun ? null : TUNING.upgradeFreezeCost;
      case "dmg":
        return plant.dmgBoost >= TUNING.upgradeDmgMaxLevel
          ? null
          : TUNING.upgradeDmgCostBase + plant.dmgBoost * 120;
    }
  }

  /** 购买并应用单株升级;阳光不足/已满级/无效 key 返回 false。 */
  upgradePlant(plant: Plant, key: UpgradeKey): boolean {
    const cost = this.upgradeCost(plant, key);
    if (cost === null || this.sun < cost) return false;
    this.sun -= cost;
    switch (key) {
      case "autoFire":
        plant.autoFire = true;
        break;
      case "reload":
        plant.reloadBoost = true;
        break;
      case "freeze":
        plant.freezeStun = true;
        break;
      case "dmg":
        plant.dmgBoost += 1;
        break;
    }
    return true;
  }

  kill(z: Zombie): void {
    // 消灭奖励:按僵尸所属幕给阳光(Act1 → Act5 递增;越往后越值钱)
    const rewardIdx = z.act >= 1 && z.act <= TUNING.killSunByAct.length ? z.act - 1 : 0;
    this.sun += TUNING.killSunByAct[rewardIdx];
    // 终局 boss 击毙:接力过的每个词都记为一次成功回忆(击杀奖只发一次)
    if (z.ultimate && z.cycle && z.cycle.length > 0) {
      for (const ph of z.cycle) {
        const outcome: EncounterOutcome = {
          wordId: ph.wordId,
          direction: ph.direction,
          retries: this.mismatchCount.get(ph.wordId) ?? 0,
          success: true,
        };
        this.outcomePerWord.set(ph.wordId, outcome);
        this.events.onKill?.(outcome);
      }
      return;
    }
    // 决定 retries 来自累积错配次数(简单版:本战斗该词错配计数)
    const outcome: EncounterOutcome = {
      wordId: z.wordId,
      direction: z.direction,
      retries: this.mismatchCount.get(z.wordId) ?? 0,
      success: true,
    };
    this.outcomePerWord.set(z.wordId, outcome);
    this.events.onKill?.(outcome);
  }

  /** 终局 boss 接力推进:当前词段被打空(hp 越过段间边界)就换上下一段,hp 重置为该段满值。 */
  private advanceUltimatePhase(z: Zombie): void {
    const n = z.cycle?.length ?? 0;
    const seg = z.phaseIdx ?? 0;
    if (n <= 1 || seg >= n - 1) return;
    const segHp = z.maxHp / n;
    const boundary = z.maxHp - segHp * (seg + 1);
    if (z.hp <= boundary) {
      z.phaseIdx = seg + 1;
      const ph = z.cycle![z.phaseIdx];
      z.wordId = ph.wordId;
      z.direction = ph.direction;
      z.hp = z.maxHp - segHp * (z.phaseIdx); // 打到下一段上限(越段余量吸收)
      z.buffed = false;
      z.frozenUntil = Math.max(z.frozenUntil, this.time); // 换段即刻唤醒
      // 护卫小怪词段同步:跟随大怪当前段词
      for (const esc of this.zombies) {
        if (esc.escortOf === z.id) {
          esc.wordId = ph.wordId;
          esc.direction = ph.direction;
        }
      }
    }
  }

  private mismatchCount = new Map<string, number>();

  recordMismatchForWord(wordId: string): void {
    this.mismatchCount.set(wordId, (this.mismatchCount.get(wordId) ?? 0) + 1);
  }

  recordZombieLost(z: Zombie): void {
    // 只要该词被击杀过就算“打过”(success 粘住),后续漏到基地不推翻通过结论
    const prev = this.outcomePerWord.get(z.wordId);
    const outcome: EncounterOutcome = {
      wordId: z.wordId,
      direction: z.direction,
      retries: this.mismatchCount.get(z.wordId) ?? 0,
      success: prev?.success === true,
    };
    this.outcomePerWord.set(z.wordId, outcome);
    this.events.onKill?.(outcome);
  }

  getOutcomes(): EncounterOutcome[] {
    return [...this.outcomePerWord.values()];
  }

  isOver(): boolean {
    return this.over;
  }

  isVictory(): boolean {
    return this.victory;
  }
}

/** 从 WordStats 生成僵尸强度(design 6 节:retries 曲线的 HP/速度) */
export function makeZombie(
  spec: ZombieSpec,
  lane: number,
  stats: WordStats | undefined,
  spawnFromRight: number,
  statsByWord?: Map<string, WordStats>,
): Zombie {
  const last = stats?.encounterHistory[stats.encounterHistory.length - 1];
  const curve = (s: WordStats | undefined): number => {
    const l = s?.encounterHistory[s.encounterHistory.length - 1];
    if (l && !l.success) return 3;
    if (l && l.retries >= 2) return 4;
    return TUNING.baseHp;
  };
  let hp = curve(stats); // 至少2
  let speed: number = 60;
  if (last && !last.success) {
    speed = 90;
  } else if (last && last.retries >= 2) {
    speed = 100;
  }
  if (spec.boss) {
    hp = Math.max(hp, TUNING.bossHp);
    speed = Math.max(speed, TUNING.bossSpeed);
  }
  // 第 5 幕僵尸血量翻倍(终局 boss 由 Act4 头目档推得后整体乘倍)
  const act5Scale = (spec.act ?? 1) === 5 ? TUNING.act5HpMultiplier : 1;
  if (spec.teaching) speed = Math.min(speed, 30);
  if (spec.ultimate && spec.cycle && spec.cycle.length > 0) {
    // 终局 boss:总血 = 各词段按 Act4 头目档波动后的 HP 最大值 × N;每词段均分。
    // 段 HP 上限显示(maxHp 保留总量,血条按剩余总量推进)
    let base = hp;
    for (const ph of spec.cycle) {
      const b = Math.max(curve(statsByWord?.get(ph.wordId)), TUNING.bossHp);
      if (b > base) base = b;
    }
    const total = base * TUNING.ultimateBossHpScale * act5Scale;
    hp = total; // z.hp 存剩余总量;词段推进阈值由 advanceUltimatePhase 按 maxHp/段数 计算
    speed = TUNING.ultimateBossSpeed;
    return {
      id: `z${Math.random().toString(36).slice(2)}`,
      wordId: spec.cycle[0].wordId,
      direction: spec.cycle[0].direction,
      teaching: spec.teaching,
      boss: spec.boss,
      act: spec.act ?? 5,
      hp,
      maxHp: total,
      speed,
      x: spawnFromRight,
      lane,
      buffed: false,
      reachedBase: false,
      frozenUntil: 0,
      ultimate: true,
      phaseIdx: 0,
      cycle: spec.cycle.map((p) => ({ ...p })),
    };
  }
  return {
    id: `z${Math.random().toString(36).slice(2)}`,
    wordId: spec.wordId,
    direction: spec.direction,
    teaching: spec.teaching,
    boss: spec.boss,
    act: spec.act ?? 1,
    hp: hp * act5Scale,
    maxHp: hp * act5Scale,
    speed,
    x: spawnFromRight,
    lane,
    buffed: false,
    reachedBase: false,
    frozenUntil: 0,
  };
}

/** Fisher–Yates 洗牌(返回新数组),用于随机 lane 分配。 */
function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 植物格子的像素坐标(与 renderer.drawPlant 的 x 一致)。 */
function plantX(p: Plant): number {
  return PLANT_ORIGIN_X + p.cellX * PLANT_CELL_W;
}

/** [min, max] 闭区间随机数。 */
function randBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** 将僵尸的词卡方向换算成期望答案文本:forward 显示该词的 foreign,reverse 显示 chinese */
export function expectedLabel(z: Zombie, words: Map<string, Word>): string | undefined {
  const w = words.get(z.wordId);
  if (!w) return undefined;
  return z.direction === "forward" ? w.chinese : w.foreign;
}

/**
 * 开火模式"点空地"的自动选目标(与点中僵尸形式一致):
 * 优先同 lane 的匹配目标(安全),无匹配目标时退回最近的任意僵尸,由 fire 判定命中/错配。
 */
export function pickAutoTarget(
  alive: Zombie[],
  lane: number,
  plant: Plant,
  words: Map<string, Word>,
): Zombie | undefined {
  return alive
    .filter((zz) => (zz.lane === lane || !!zz.ultimate) && zz.hp > 0)
    .sort((a, b) => {
      const aOk = expectedLabel(a, words) === plant.labelText ? 1 : 0;
      const bOk = expectedLabel(b, words) === plant.labelText ? 1 : 0;
      if (aOk !== bOk) return bOk - aOk;
      return a.x - b.x;
    })[0];
}