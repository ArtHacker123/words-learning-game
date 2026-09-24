import { Battle } from "../battle/battle";
import type { Plant, Zombie } from "../battle/battle";
import type { Word } from "../core/model";

export interface DrawContext {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  time: number;
  laneHeight?: number; // 植物标签等依据车道高度限缩,避免越界
}

/**
 * 渲染骨架层:所有视觉实体都携带 spriteKey,由 spriteOf() 提供统一入口,
 * 未来接美术素材只需替换本层(AssetDrawer),战斗逻辑零改动。
 */
export interface SpriteArgs {
  kind: "zombie" | "plant";
  text: string;
  strength: 0 | 1 | 2; // 0弱 1中 2强
  teaching?: boolean;
  boss?: boolean;
  buffed?: boolean;
  frozen?: boolean; // 冻结中:行走动画停摆
  dying?: boolean; // 倒地淡出动画中的僵尸快照
  ultimate?: boolean; // 终局接力 boss(跨全 lane 的巨大身躯)
  direction: "forward" | "reverse";
}

export type SpriteDrawer = (d: DrawContext, x: number, y: number, args: SpriteArgs) => void;

export interface RendererOptions {
  /** 当前占位 dtype:默认内置简易码绘制 */
  drawer?: SpriteDrawer;
  /** 每帧回调(战斗推进后),用于实时刷新 HUD */
  onFrame?: () => void;
}

interface Shot {
  from: { x: number; y: number }; // y 为 lane 下标,渲染时换算
  to: { x: number; y: number };
  t: number; // 已飞行时间
  dur: number; // 总时长(s)
  hit: boolean;
  zid: string;
}

export class BattleRenderer {
  private canvas: HTMLCanvasElement;
  private battle: Battle;
  private words: Map<string, Word>;
  private drawer: SpriteDrawer;
  private time = 0;
  private raf = 0;
  private selected: Plant | null = null;
  private shots: Shot[] = [];
  private flashes = new Map<string, number>(); // 僵尸受击闪烁剩余时间
  // 浮动文字反馈(命中时"×N连击"、错配"错配!")向上飘 + 淡出
  private floaters: { x: number; y: number; text: string; color: string; t0: number }[] = [];
  private baseHitFlash = 0; // 基地被咬一口后的红闪剩余秒数
  // 僵尸死亡倒地特效(renderer 层快照,不改动战斗逻辑)
  private zSnap = new Map<string, { x: number; lane: number; boss: boolean; buffed: boolean; wordId: string; direction: "forward" | "reverse"; ultimate: boolean }>();
  private dying: (typeof this.zSnap extends Map<string, infer S> ? S & { id: string; t0: number } : never)[] = [];

  setSelected(p: Plant | null): void {
    this.selected = p;
  }

  /** 基地被咬一口:触发一次短促红闪(由 onBaseHit 接入) */
  flashBase(): void {
    this.baseHitFlash = 0.3;
  }

  /** 在战场某点浮出文字反馈(命中连击 / 错配警示)。 */
  spawnFloater(zombie: Zombie, text: string, color: string): void {
    const y = zombie.ultimate
      ? this.canvas.clientHeight / 2 - this.canvas.clientHeight / this.battle.laneCount
      : zombie.lane * (this.canvas.clientHeight / this.battle.laneCount) + this.canvas.clientHeight / this.battle.laneCount / 2 - 34;
    this.floaters.push({ x: zombie.x + 30, y, text, color, t0: this.time });
  }

  /** 发射动画:一粒炮弹从植物飞向僵尸(指定到达时间,约300ms) */
  spawnShot(plant: Plant, zombie: Zombie, hit: boolean): void {
    const from = { x: 120 + plant.cellX * 60, y: plant.lane };
    // 终局 boss 横跨全 lane:炮弹飞向其纵向中轴(身体中心)
    const to = { x: zombie.x + 30, y: zombie.ultimate ? this.battle.laneCount / 2 - 0.5 : zombie.lane };
    this.shots.push({
      from,
      to,
      t: 0,
      dur: 0.3,
      hit,
      zid: zombie.id,
    });
  }

  constructor(canvas: HTMLCanvasElement, battle: Battle, words: Map<string, Word>, opts: RendererOptions = {}) {
    this.canvas = canvas;
    this.battle = battle;
    this.words = words;
    this.drawer = opts.drawer ?? placeholderDrawer;
    this.onFrame = opts.onFrame;
  }

  private onFrame?: () => void;
  private stopped = false;

  start(): void {
    this.stopped = false;
    const loop = (t: number) => {
      if (this.stopped) return; // 已被 stop():彻底断链,不再续排 rAF
      const dt = Math.min((t - (this.time || t)) / 1000, 0.05);
      this.time = t;
      this.battle.tick(dt);
      this.onFrame?.();
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.stopped = true;
    cancelAnimationFrame(this.raf);
  }

  private draw(): void {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // bg
    ctx.fillStyle = "#1e2a1e";
    ctx.fillRect(0, 0, w, h);
    const laneCount = this.battle.laneCount;
    const laneH = h / laneCount;
    for (let i = 0; i < laneCount; i++) {
      ctx.fillStyle = i % 2 === 0 ? "rgba(120,180,90,0.25)" : "rgba(90,150,70,0.25)";
      ctx.fillRect(0, i * laneH, w, laneH);
      ctx.strokeStyle = "rgba(255,255,255,0.2)";
      ctx.beginPath();
      ctx.moveTo(0, (i + 1) * laneH);
      ctx.lineTo(w, (i + 1) * laneH);
      ctx.stroke();
    }
    // 基地(左墙):被围攻时红色脉冲,咬一口时短促亮闪 + 向右溢红晕
    const besieged = this.battle.zombies.some((z) => z.reachedBase);
    const pulse = besieged ? (Math.sin((this.time / 1000) * 7) + 1) / 2 : 0;
    const biteK = Math.min(1, this.baseHitFlash / 0.3);
    if (this.baseHitFlash > 0) this.baseHitFlash -= 1 / 60;
    ctx.fillStyle = "#996b3f";
    ctx.fillRect(0, 0, 24, h);
    // 基地血量竖向条(左墙上缘→下缘),颜色随血量满→红渐变
    const baseRatio = Math.max(0, Math.min(1, this.battle.baseHp / 100));
    const barH = Math.max(0, (h - 8) * baseRatio);
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.fillRect(3, 4, 5, h - 8);
    ctx.fillStyle = baseRatio > 0.5 ? "#8fd14f" : baseRatio > 0.25 ? "#e8c34a" : "#ff5a3c";
    ctx.fillRect(3, 4 + (h - 8 - barH), 5, barH);
    ctx.fillStyle = "#d8a25e";
    ctx.fillRect(0, h - 26, 24, 6);
    if (besieged || biteK > 0) {
      const glowW = 8 + 10 * biteK;
      ctx.fillStyle = `rgba(255,80,50,${0.3 * pulse + 0.85 * biteK})`;
      ctx.fillRect(0, 0, 24, h);
      ctx.fillStyle = `rgba(255,80,50,${0.2 * pulse + 0.5 * biteK})`;
      ctx.fillRect(24, 0, glowW, h);
    }

    // 僵尸(含受击闪烁);先快照本轮存活集,捕捉刚死亡的僵尸做倒地特效
    this.updateZombieSnap();
    for (const z of this.battle.zombies) {
      const flashing = (this.flashes.get(z.id) ?? 0) > 0;
      this.drawZombie(ctx, z, flashing);
    }
    this.drawDying(ctx, laneH);
    // 植物
    for (const p of this.battle.plants) {
      this.drawPlant(ctx, p);
    }
    // 炮弹
    this.updateShots();
    for (const s of this.shots) {
      this.drawShot(ctx, s, laneH);
    }
    // 浮动文字反馈(命中连击/错配),上飘淡出
    this.drawFloaters(ctx);
    // 终局冲击波:竖排光带右→左横扫(绘制在植物之上,揭示威压)
    for (const sw of this.battle.shockwaves) {
      this.drawShockwave(ctx, sw.x, sw.speed);
    }

    // 升级暂停:轻微压暗 + 角标提示(战斗冻结)
    if (this.battle.paused) {
      ctx.fillStyle = "rgba(10,16,10,0.35)";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#c9a7ff";
      ctx.font = "bold 16px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("⏸ 升级中 · 战斗暂停", w / 2, 28);
    }
  }

  /** 维护僵尸存活快照:把本帧仍在场 / 刚离场的僵尸转入倒地动画列表 */
  private updateZombieSnap(): void {
    const aliveNow = new Set<string>();
    for (const z of this.battle.zombies) {
      aliveNow.add(z.id);
      this.zSnap.set(z.id, {
        x: z.x + 30,
        lane: z.lane,
        boss: z.boss,
        buffed: z.buffed,
        wordId: z.wordId,
        direction: z.direction,
        ultimate: !!z.ultimate,
      });
    }
    for (const [id, s] of this.zSnap) {
      if (!aliveNow.has(id)) {
        this.dying.push({ id, ...s, t0: this.time });
        this.zSnap.delete(id);
      }
    }
  }

  /** 死亡倒地特效:旋转 90° 躺倒 + 淡出,约 0.55s */
  private drawDying(ctx: CanvasRenderingContext2D, laneH: number): void {
    const DUR = 0.55;
    const remaining: typeof this.dying = [];
    for (const dy of this.dying) {
      const age = (this.time - dy.t0) / 1000;
      if (age >= DUR) continue;
      remaining.push(dy);
      const y = dy.ultimate ? this.canvas.clientHeight / 2 : dy.lane * laneH + laneH / 2;
      const k = age / DUR;
      const word = this.words.get(dy.wordId);
      const text = dy.direction === "forward" ? word?.foreign ?? "?" : word?.chinese ?? "?";
      ctx.save();
      ctx.globalAlpha = 1 - k * k;
      ctx.translate(dy.x, y);
      ctx.rotate((k * Math.PI) / 2);
      const d: DrawContext = { ctx, w: this.canvas.clientWidth, h: this.canvas.clientHeight, time: this.time, laneHeight: laneH };
      this.drawer(d, 0, 0, {
        kind: "zombie",
        text,
        strength: dy.boss ? 2 : dy.buffed ? 1 : 0,
        boss: dy.boss,
        buffed: false,
        ultimate: dy.ultimate,
        direction: dy.direction,
        dying: true,
      });
      ctx.restore();
    }
    this.dying = remaining;
  }

  private updateShots(): void {
    const remaining: Shot[] = [];
    for (const s of this.shots) {
      s.t += 1 / 60;
      if (s.t >= s.dur) {
        // 炮弹到达:命中→受击白闪 + 连击文字;miss→错配警示文字
        const z = this.battle.zombies.find((zz) => zz.id === s.zid);
        if (s.hit) {
          this.flashes.set(s.zid, 0.25);
          if (z && this.battle.combo >= 2) this.spawnFloater(z, `×${this.battle.combo}`, "#ffd25e");
        } else if (z) {
          this.spawnFloater(z, "错配!", "#ff6a5a");
        }
      } else {
        remaining.push(s);
      }
    }
    this.shots = remaining;
    // 闪烁倒计时
    for (const [id, t] of [...this.flashes]) {
      const next = t - 1 / 60;
      if (next <= 0) this.flashes.delete(id);
      else this.flashes.set(id, next);
    }
    // 浮动文字老化(约 0.9s 后移除)
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      if ((this.time - this.floaters[i].t0) / 1000 > 0.9) this.floaters.splice(i, 1);
    }
  }

  /** 浮动文字:向上飘 + 淡出 */
  private drawFloaters(ctx: CanvasRenderingContext2D): void {
    for (const f of this.floaters) {
      const age = (this.time - f.t0) / 1000;
      const k = Math.min(1, age / 0.9);
      ctx.save();
      ctx.globalAlpha = 1 - k * k;
      ctx.font = "bold 16px sans-serif";
      ctx.textAlign = "center";
      ctx.shadowColor = "rgba(0,0,0,0.6)";
      ctx.shadowBlur = 4;
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y - k * 30);
      ctx.restore();
    }
  }

  private drawShot(ctx: CanvasRenderingContext2D, s: Shot, laneH: number): void {
    const k = Math.min(1, s.t / s.dur);
    const x = s.from.x + (s.to.x - s.from.x) * k;
    const y = (s.from.y + (s.to.y - s.from.y)) * laneH + laneH / 2;
    // 炮弹:小光球,尾焰渐隐
    const g = ctx.createRadialGradient(x, y, 0, x, y, 10);
    g.addColorStop(0, "rgba(255,255,230,1)");
    g.addColorStop(0.4, s.hit ? "rgba(255,160,80,0.95)" : "rgba(200,120,255,0.95)");
    g.addColorStop(1, "rgba(255,160,80,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = s.hit ? "#fff3b0" : "#ffe9f9";
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  /** 终局冲击波:全高竖直光带(亮前端 + 尾迹渐隐),右→左推进震颤。 */
  private drawShockwave(ctx: CanvasRenderingContext2D, x: number, speed: number): void {
    const h = this.canvas.clientHeight;
    const tw = TUNING_RE.shockTw;
    const jitter = Math.sin((this.time / 38) % (Math.PI * 2)) * 2;
    const frontX = x + jitter;
    const tint = Math.min(1, speed / 700);
    ctx.save();
    // 尾迹:从后缘向左渐变淡出
    const trail = ctx.createLinearGradient(frontX - tw, 0, frontX, 0);
    trail.addColorStop(0, `rgba(140,90,255,0)`);
    trail.addColorStop(0.7, `rgba(200,140,255,0.35)`);
    trail.addColorStop(1, `rgba(255,255,255,0.75)`);
    ctx.fillStyle = trail;
    ctx.fillRect(frontX - tw, 0, tw, h);
    // 前缘亮线
    ctx.fillStyle = `rgba(255,250,230,${0.55 + 0.25 * tint})`;
    ctx.fillRect(frontX - 3, 0, 3, h);
    // 纵向细涟漪
    ctx.strokeStyle = `rgba(255,255,255,${0.25 * tint})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = 4; y < h; y += 14) {
      ctx.moveTo(frontX + 2, y);
      ctx.lineTo(frontX + 2 + Math.sin((y / 6 + this.time / 90) % (Math.PI * 2)) * 3, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  private spriteArgs(z: Zombie): SpriteArgs {
    const strength = z.boss ? 2 : z.buffed ? 1 : 0;
    const word = this.words.get(z.wordId);
    const text = z.direction === "forward" ? word?.foreign ?? "?" : word?.chinese ?? "?";
    return { kind: "zombie", text, strength, teaching: z.teaching, boss: z.boss, buffed: z.buffed, ultimate: z.ultimate, direction: z.direction };
  }

  private drawZombie(ctx: CanvasRenderingContext2D, z: Zombie, flashing = false): void {
    const laneH = this.canvas.clientHeight / this.battle.laneCount;
    const cx = z.x + 30;
    // 终局 boss 横跨全 lane:锚点取画布纵向中轴
    const y = z.ultimate ? this.canvas.clientHeight / 2 : z.lane * laneH + laneH / 2;
    const d: DrawContext = { ctx, w: this.canvas.clientWidth, h: this.canvas.clientHeight, time: this.time, laneHeight: laneH };
    this.drawer(d, cx, y, { ...this.spriteArgs(z), frozen: z.frozenUntil > this.battle.time });

    // 受击白闪
    if (flashing) {
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(cx, y, z.ultimate ? laneH * 1.4 : 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 教学僵头顶答案气泡
    if (z.teaching) {
      const word = this.words.get(z.wordId);
      const label = z.direction === "forward" ? word?.chinese ?? "?" : word?.foreign ?? "?";
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.beginPath();
      ctx.arc(cx, y - 42, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#222";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(label, cx, y - 38);
    }

    // 啃食植物 / 攻城咬基地 提示气泡
    if (z.nibblingPlantId && this.battle.plants.some((p) => p.id === z.nibblingPlantId)) {
      ctx.fillStyle = "rgba(255,236,200,0.92)";
      ctx.beginPath();
      ctx.roundRect(cx - 22, y - 62, 44, 20, 6);
      ctx.fill();
      ctx.fillStyle = "#7a4a00";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("啃啃", cx, y - 52);
      ctx.textBaseline = "alphabetic";
    } else if (z.reachedBase) {
      ctx.fillStyle = "rgba(255,90,90,0.92)";
      ctx.beginPath();
      ctx.roundRect(cx - 22, y - 62, 44, 20, 6);
      ctx.fill();
      ctx.fillStyle = "#8a1a1a";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("🔨基地", cx, y - 52);
      ctx.textBaseline = "alphabetic";
    }

    // hp 条:终局 boss 用横贯底部的总血条 + 词段刻痕 + 「段落 n/N」
    const hpw = z.ultimate ? Math.min(260, this.canvas.clientWidth * 0.45) : 46;
    const hpRatio = Math.min(1, z.hp / z.maxHp);
    const barY = z.ultimate ? this.canvas.clientHeight - 22 : y + 34;
    ctx.fillStyle = "#333";
    ctx.fillRect(cx - hpw / 2, barY, hpw, 6);
    ctx.fillStyle = z.ultimate ? "#b886f0" : z.boss ? "#f33" : "#4caf50";
    ctx.fillRect(cx - hpw / 2, barY, hpw * hpRatio, 6);
    if (z.ultimate) {
      const n = z.cycle?.length ?? 1;
      ctx.strokeStyle = "#ffd25e";
      ctx.lineWidth = 1.5;
      for (let i = 1; i < n; i++) {
        const px = cx - hpw / 2 + (hpw * i) / n;
        ctx.beginPath();
        ctx.moveTo(px, barY - 2);
        ctx.lineTo(px, barY + 8);
        ctx.stroke();
      }
      ctx.fillStyle = "#ffd25e";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`👑 ${Math.min(n, (z.phaseIdx ?? 0) + 1)}/${n}`, cx, barY - 14);
      ctx.textBaseline = "alphabetic";
    }

    // 凝固弹冻结覆盖:冰蓝半透明 + 雪花
    if (z.frozenUntil > this.battle.time) {
      ctx.save();
      ctx.fillStyle = "rgba(120,200,255,0.45)";
      ctx.beginPath();
      ctx.arc(cx, y, 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#e8f8ff";
      ctx.font = "bold 13px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("❄", cx + 16, y + 22);
      ctx.restore();
    }
  }

  private drawPlant(ctx: CanvasRenderingContext2D, p: Plant): void {
    const laneH = this.canvas.clientHeight / this.battle.laneCount;
    const x = 120 + p.cellX * 60;
    const y = p.lane * laneH + laneH / 2;
    const ready = p.reloadRemain <= 0 && !p.jamming;
    const d: DrawContext = { ctx, w: this.canvas.clientWidth, h: this.canvas.clientHeight, time: this.time, laneHeight: laneH };
    this.drawer(d, x, y, {
      kind: "plant",
      text: p.labelText,
      strength: ready ? 1 : 0,
      direction: "forward",
    });
    // 装饰:升级标记/装弹进度环/哑火/就绪
    if (p.autoFire || p.dmgBoost > 0 || p.reloadBoost || p.freezeStun) {
      ctx.fillStyle = "#c9a7ff";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("★", x + 18, y - 34);
    }
    const maxR = TUNING_ROLE.reloadSeconds;
    if (p.jamming) {
      ctx.fillStyle = "#f33";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("哑火", x, y - 38);
      ctx.strokeStyle = "rgba(255,51,51,0.8)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 22, 0, Math.PI * 2);
      ctx.stroke();
    } else if (p.reloadRemain > 0) {
      const ratio = 1 - p.reloadRemain / maxR;
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y - 36, 12, -Math.PI / 2, -Math.PI / 2 + ratio * Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.fillStyle = "#ffe08a";
      ctx.beginPath();
      ctx.arc(x, y - 36, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    // 选中高亮
    if (this.selected === p) {
      ctx.strokeStyle = "rgba(255,220,120,0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 26, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "rgba(255,220,120,0.15)";
      ctx.fill();
    }
  }
}

const TUNING_ROLE = { reloadSeconds: 1.5 };

const TUNING_RE = { shockTw: 60 };

/** 僵尸行走动画参数(纯程序化,按需微调) */
const Z_ANIM = {
  stepHz: 4.2, // 普通僵尸步频
  bossStepHz: 2.0, // boss 步频慢
  ultStepHz: 1.4, // 终局 boss 沉稳重步
  bob: 1.6, // 上下颠簸幅度
  legSpan: 7, // 腿摆动幅度
  legLen: 12, // 腿长
  sway: 0.09, // 身体前倾幅度(弧度)
};

/** 占位码绘制:植物 emoji + 单词牌;僵尸分层像素风(腿/身体/手臂/眼/牙/胸前词牌) */
export const placeholderDrawer: SpriteDrawer = (d, x, y, args) => {
  const { ctx } = d;
  if (args.kind === "zombie") {
    // 终局 boss:跨约 4 条车道的巨体(非整场,3~5 lane 之间按车道高缩放)
    const laneH = d.laneHeight ?? d.h / 5;
    const r = args.ultimate
      ? laneH * 1.4
      : 18 * (1 + args.strength * 0.25 + (args.boss ? 0.8 : 0));
    const scale = r / 18;
    // 行走动画:时间驱动摆动;冻结或倒地时定格
    const frozen = !!args.frozen || !!args.dying;
    const t = d.time / 1000;
    const freq = args.ultimate
      ? Z_ANIM.ultStepHz
      : (args.boss ? Z_ANIM.bossStepHz : Z_ANIM.stepHz) * (1 + args.strength * 0.15);
    const ph = frozen ? 0 : t * freq * Math.PI * 2;
    const bob = frozen || args.dying ? 0 : Math.abs(Math.sin(ph)) * Z_ANIM.bob * scale;
    const swing = frozen ? 0 : Math.sin(ph) * Z_ANIM.legSpan * scale;
    const drawY = y + bob;
    const bodyY = drawY + 2;
    const legY = bodyY + r * 1.02;

    // 皮肤配色:普通绿 / boss 深棕 / 终局暗紫金 / 发怒红
    const skin = args.ultimate
      ? ["#8c51c2", "#3c1c66"]
      : args.boss
        ? ["#8a5a3a", "#4a2a22"]
        : args.buffed
          ? ["#ff8a5a", "#c22a1a"]
          : ["#8ada6f", "#2f7a2f"];
    const skinLight = skin[0];
    const skinDark = skin[1];

    // 腿(身体之后,含走路交替)
    const legOff = 5 * scale;
    const legSwingA = swing;
    const legSwingB = -swing;
    const oneLeg = (dir: 1 | -1, sw: number) => {
      const kneeY = legY + Z_ANIM.legLen * 0.5;
      const footY = legY + Z_ANIM.legLen;
      ctx.moveTo(x + dir * legOff, legY);
      ctx.lineTo(x + dir * legOff * 0.6 + sw * 0.5, kneeY);
      ctx.lineTo(x + dir * legOff * 0.35 + sw, footY);
    };
    if (args.dying) {
      // 倒地:双退并拢垂地
      ctx.strokeStyle = skinDark;
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x + 3 * scale, legY);
      ctx.lineTo(x + 3 * scale, legY + Z_ANIM.legLen);
      ctx.moveTo(x - 3 * scale, legY);
      ctx.lineTo(x - 3 * scale, legY + Z_ANIM.legLen);
      ctx.stroke();
    } else {
      ctx.strokeStyle = skinDark;
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.beginPath();
      oneLeg(1, legSwingA);
      oneLeg(-1, legSwingB);
      ctx.stroke();
    }

    // 手臂:前伸扑向左侧基地
    ctx.strokeStyle = skinDark;
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x + r * 0.35, bodyY - 4);
    ctx.lineTo(x - r * 1.5, bodyY + 8);
    ctx.stroke();
    // 三指爪
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - r * 1.5, bodyY + 8);
    ctx.lineTo(x - r * 1.55, bodyY + 1);
    ctx.lineTo(x - r * 1.68, bodyY + 5);
    ctx.moveTo(x - r * 1.5, bodyY + 8);
    ctx.lineTo(x - r * 1.62, bodyY + 12);
    ctx.stroke();

    // 身体(微前倾),含发怒光晕 / 终局金色呼吸光环
    if (args.buffed) {
      ctx.save();
      ctx.shadowColor = "rgba(255,60,40,0.9)";
      ctx.shadowBlur = 16;
    } else if (args.ultimate && !args.dying) {
      const breathe = 12 + 8 * (Math.abs(Math.sin(d.time / 333)) * 0.5 + 0.5);
      ctx.save();
      ctx.shadowColor = "rgba(255,210,94,0.95)";
      ctx.shadowBlur = breathe;
    }
    const swayR = frozen ? 0 : Math.sin(ph) * Z_ANIM.sway * (args.boss ? 0.6 : 1);
    ctx.save();
    ctx.translate(x, bodyY);
    ctx.rotate(swayR);
    const g = ctx.createLinearGradient(0, -r, 0, r);
    g.addColorStop(0, skinLight);
    g.addColorStop(1, skinDark);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 1.15, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 2;
    ctx.stroke();
    // 眼睛:眼白 + 黑瞳(发怒红瞳变大)
    if (args.buffed) ctx.shadowBlur = 0;
    const eyeY = -r * 0.55;
    const eyeOff = r * 0.3;
    for (const s of [1, -1] as const) {
      ctx.fillStyle = "#f4f4f4";
      ctx.beginPath();
      ctx.arc(s * eyeOff, eyeY, r * 0.24, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = args.buffed ? "#c00" : "#1a1a1a";
      ctx.beginPath();
      ctx.arc(s * eyeOff - r * 0.06, eyeY, args.buffed ? r * 0.16 : r * 0.11, 0, Math.PI * 2);
      ctx.fill();
    }
    // 獠牙:底部两列白色小三角
    ctx.fillStyle = "#f8f6e8";
    for (const s of [1, -1] as const) {
      const tx = s * r * 0.22;
      ctx.beginPath();
      ctx.moveTo(tx - 4 * scale, r * 0.85);
      ctx.lineTo(tx + 4 * scale, r * 0.85);
      ctx.lineTo(tx, r * 1.02);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    if (args.buffed) ctx.restore();
    else if (args.ultimate && !args.dying) ctx.restore();
    // 终局 boss:头顶金冠(三尖角 + 金带),王者符号。
    // 注意:此刻坐标已被 body 的 restore 还原到画布原点,必须重新 translate 到 (x, cy) 局部绘制,否则皇冠会固定画在左上角。
    if (args.ultimate) {
      const cy = drawY - r * 1.15 - 4;
      const hw = r * 0.5;
      const spike = r * 0.3;
      ctx.save();
      ctx.translate(x, cy);
      ctx.fillStyle = "#ffd25e";
      for (const s of [-1, 0, 1] as const) {
        ctx.beginPath();
        ctx.moveTo(s * hw - r * 0.12, spike * 0.3);
        ctx.lineTo(s * hw, -spike);
        ctx.lineTo(s * hw + r * 0.12, spike * 0.3);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillRect(-hw, spike * 0.28, hw * 2, r * 0.1);
      ctx.strokeStyle = "#7a4a00";
      ctx.lineWidth = 2;
      ctx.strokeRect(-hw, spike * 0.28, hw * 2, r * 0.1);
      ctx.restore();
    }
    // 发怒怒号气泡
    if (args.buffed) {
      ctx.fillStyle = "#ffcc33";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("💢", x, bodyY - r * 1.7);
    }

    // 单词牌:浅底深字,挂绳两条,不随身体摇摆(保证可读)。
    // 位置放在血条上方(普通:y+34 血条,终局:底部 h-22 血条),避免遮挡面部。
    const hpBarY = args.ultimate ? d.h - 22 : y + 34;
    const fs = args.ultimate
      ? Math.max(16, Math.min(26, Math.round(d.w / 30)))
      : Math.max(10, Math.min(16, Math.round(9 * scale + 2)));
    const bw = args.ultimate
      ? Math.min(d.w * 0.6, args.text.length * fs * 0.78 + 16)
      : Math.min(96, Math.max(40, args.text.length * fs * 0.72 + 12));
    const bh = fs + (args.ultimate ? 14 : 8);
    // 终局血条上方还有「👑 n/N」标记(barY-14),单词牌再往上让开
    const by = (args.ultimate ? hpBarY - 18 - bh : hpBarY - 4 - bh);
    const bx = x - bw / 2;
    ctx.strokeStyle = args.ultimate ? "#ffd25e" : args.boss ? "#5b2c2c" : "#39493a";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - bw * 0.18, by + 2);
    ctx.lineTo(x + bw * 0.18, by + 2);
    ctx.stroke();
    ctx.fillStyle = args.ultimate ? "rgba(38,16,58,0.94)" : "rgba(244,242,224,0.96)";
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = args.ultimate ? "#ffd25e" : args.boss ? "#5b2c2c" : "#39493a";
    ctx.lineWidth = args.ultimate ? 3 : 2;
    ctx.strokeRect(bx, by, bw, bh);
    ctx.fillStyle = args.ultimate ? "#ffe9a8" : "#222";
    ctx.font = `bold ${fs}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(args.text, x, by + bh / 2 + 1);
    return;
  }
  // plant: emoji + 标签
  const ready = args.strength >= 1;
  ctx.font = "24px serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(ready ? "🌻" : "🌱", x, y - 12);
  // 标签文字尽量大,但受车道高度约束不越界(11~17px);
  // 与植物本体拉开明显距离,放在装弹指示圆环(植物上方)的正下方
  const laneH = d.laneHeight ?? 120;
  const fs = Math.max(11, Math.min(17, Math.round(laneH * 0.18)));
  const w = Math.min(96, Math.max(48, args.text.length * fs * 0.78 + 12));
  const labelTop = Math.max(14, Math.round(laneH * 0.16)); // 相对植物中心下移(留出间隙)
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillRect(x - w / 2, y + labelTop, w, fs + 10);
  ctx.fillStyle = "#222";
  ctx.font = `bold ${fs}px sans-serif`;
  ctx.fillText(args.text, x, y + labelTop + (fs + 10) / 2 + 1);
};