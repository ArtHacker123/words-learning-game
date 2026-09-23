import type { Word, ProfileId } from "./core/model";
import { TUNING, ACT_PRESSURE } from "./core/tuning";
import wordHash from "./core/hash";
import { saveWords, saveStats, getStatsByWordId, getAllWords, getMeta, setMeta, saveSnapshot, getSnapshot, deleteSnapshot, resetProfile, getActiveProfile, setActiveProfile } from "./store/db";
import { initWordStats, buildDailyChunks, commitOutcome, graduateBoss, ensureChunks } from "./scheduler/planner";
import { eligibleForDiamond } from "./core/awards";
import { Battle, pickAutoTarget } from "./battle/battle";
import { BattleRenderer } from "./render/renderer";
import { UI, parseWordLines } from "./ui/ui";

export async function initApp(): Promise<void> {
  const root = document.getElementById("app")!;
  const ui = new UI(root);
  let profile: ProfileId = await getActiveProfile();
  ui.state.profile = profile;

  /** 载入当前词库的 words/stats(导入/切换词库后共用) */
  async function loadProfile(): Promise<void> {
    const allWords = await getAllWords(profile);
    const stats = await getStatsByWordId(profile);
    ui.state.words = allWords;
    ui.state.statsByWord = stats;
    ui.state.profile = profile;
  }

  async function refreshMenu(): Promise<void> {
    await loadProfile();
    ui.updateHud();
    ui.renderMainMenu();
  }

  ui.onSwitchProfile(async (id) => {
    if (id === profile) return;
    profile = id;
    await setActiveProfile(id);
    const today = (await getMeta(profile, "day")) ?? 1;
    ui.state.today = today;
    const diamond = (await getMeta(profile, "diamond")) ?? 0;
    ui.state.diamond = diamond;
    const snap = await getSnapshot(profile, today);
    if (snap) {
      ui.state.plans = snap.plans;
      ui.state.sessionIdx = snap.played;
      ui.state.plan = snap.plans[snap.played] ?? null;
    } else {
      ui.state.plans = [];
      ui.state.plan = null;
      ui.state.sessionIdx = 0;
    }
    await refreshMenu();
  });

  root.addEventListener("click", () => { /* keep layout simple */ });

  ui.onImport(async (lines) => {
    const pairs = parseWordLines(lines);
    if (!pairs.length) return;
    const existing = new Set((await getAllWords(profile)).map((w) => w.id));
    const words: Word[] = [];
    for (const p of pairs) {
      const id = wordHash(p.foreign, p.chinese);
      if (existing.has(id)) continue;
      const fresh: Word = { id, foreign: p.foreign, chinese: p.chinese, profile };
      words.push(fresh);
    }
    if (words.length) await saveWords(profile, words);
    ui.log(`导入 ${words.length} 词`);
    await refreshMenu();
  });

  ui.onSkipImport(async () => {
    await refreshMenu();
  });

  ui.onCreatePlan(async () => {
    const today = (await getMeta(profile, "day")) ?? 1;
    const allWords = await getAllWords(profile);
    if (!allWords.length) return;
    const existing = await getSnapshot(profile, today);
    if (existing) {
      // 当天已有快照:恢复当日分块计划与基线,不再重初始化、不覆盖基线(当天体验保持一致)。
      // 分块上线前的旧快照只有单 plan(可能只有 4 幕)→ ensureChunks 统一迁移成分块结构并补终局幕。
      const snap = ensureChunks(existing);
      await saveSnapshot(profile, snap);
      ui.state.words = allWords;
      ui.state.statsByWord = await getStatsByWordId(profile);
      ui.state.plans = snap.plans;
      ui.state.sessionIdx = snap.plans.length > 0 ? snap.played : 0;
      ui.state.plan = snap.plans[snap.played] ?? null;
      ui.state.today = today;
      ui.renderMainMenu();
      return;
    }
    const stats = await getStatsByWordId(profile);
    const newList = allWords.filter((w) => !stats.has(w.id));
    // 初始化未学过词的 stats,introducedDay=today
    for (const w of newList) {
      const s = initWordStats(w.id, today, 0);
      stats.set(w.id, s);
    }
    // 分块计划:一局=一块(≤sessionWordCap 词),按序推进覆盖当日全部待复习词
    const plans = buildDailyChunks(allWords, stats, today, TUNING.sessionWordCap);
    await saveStats(profile, [...stats.values()]);
    await setMeta(profile, "day", today);
    await saveSnapshot(profile, { day: today, plans, played: 0, stats: [...stats.values()], profile });
    ui.state.words = allWords;
    ui.state.statsByWord = stats;
    ui.state.plans = plans;
    ui.state.sessionIdx = 0;
    ui.state.plan = plans[0] ?? null;
    ui.state.today = today;
    ui.renderMainMenu();
  });

  ui.onNextDay(async () => {
    const today = (await getMeta(profile, "day")) ?? 1;
    await setMeta(profile, "day", today + 1);
    await deleteSnapshot(profile, today); // 当日快照次日即失效,清理待重建档
    ui.state.plan = null;
    ui.state.plans = [];
    ui.state.sessionIdx = 0;
    ui.state.today = today + 1;
    ui.renderMainMenu();
  });

  ui.onReset(async () => {
    await resetProfile(profile); // 清当前词库学习进度/快照,day→1、diamond→0,其词表保留
    const allWords = await getAllWords(profile);
    ui.state.words = allWords;
    ui.state.statsByWord = new Map();
    ui.state.plans = [];
    ui.state.plan = null;
    ui.state.sessionIdx = 0;
    ui.state.today = 1;
    ui.state.diamond = 0;
    ui.log("已复位:当前词库回到第 1 天,词表保留,全部重新计为新词");
    ui.renderMainMenu();
  });

  ui.onStartBattle(async () => {
    const plan = ui.state.plan;
    if (!plan) return;
    ui.renderBattle(
      document.createElement("canvas"),
      document.createElement("div"),
      document.createElement("button"),
    );
    await runSession(ui, profile, plan.day, ui.state.sessionIdx, 0);
  });

  // 词库非空 → 跳过导入,直接进主菜单
  const today = (await getMeta(profile, "day")) ?? 1;
  ui.state.today = today;
  const diamond = (await getMeta(profile, "diamond")) ?? 0;
  ui.state.diamond = diamond;
  // 同一天刷新/回访:恢复当日分块计划与推进进度(played),菜单按进度展示
  const snap = await getSnapshot(profile, today);
  if (snap) {
    const restored = ensureChunks(snap);
    if (restored !== snap) await saveSnapshot(profile, restored); // 旧单 plan 档落库为分块结构,runSession 才拿得到 plans[]
    ui.state.plans = restored.plans;
    ui.state.sessionIdx = restored.played;
    ui.state.plan = restored.plans[restored.played] ?? null;
  }
  const allWords = await getAllWords(profile);
  if (allWords.length) {
    const stats = await getStatsByWordId(profile);
    ui.state.words = allWords;
    ui.state.statsByWord = stats;
    ui.renderMainMenu();
  }
  ui.updateHud();
}

async function runSession(ui: UI, profile: ProfileId, day: number, chunkIdx: number, startIdx = 0): Promise<void> {
  const raw = await getSnapshot(profile, day);
  if (!raw) {
    ui.renderMainMenu();
    return;
  }
  const snap = ensureChunks(raw); // 迁移防御:旧单 plan 档转分块结构(幂等),并落库保持 DB 一致
  if (snap !== raw) await saveSnapshot(profile, snap);
  if (!snap.plans[chunkIdx]) {
    ui.renderMainMenu();
    return;
  }
  const daySnap = snap; // 闭包(结算/重开)里保持非空类型
  const plan = snap.plans[chunkIdx];
  const allWords = await getAllWords(profile);
  const words = new Map(allWords.map((w) => [w.id, w]));
  // 生活账本 vs 当日基线:战斗难度用快照基线(当天各局一致),结算只写生活账本(一天一记)。
  const liveStats = new Map(await getStatsByWordId(profile));
  const battleStats = snap ? new Map(snap.stats.map((s) => [s.wordId, s])) : liveStats;

  const field = document.querySelector<HTMLCanvasElement>("#field")!;
  const trayEl = document.querySelector<HTMLElement>("#tray")!;
  const pauseBtn = document.querySelector<HTMLButtonElement>("#pauseBtn")!;

  // 幕参数:出怪节奏/同时在场数/并行概率逐幕递进(设计 6.3 Act escalation,tuning.ACT_PRESSURE)
  const actNames = ["", "第一幕 教学", "第二幕 演练", "第三幕 复习", "第四幕 头目", "第五幕 终局"];

  // 只启动有词的幕;空幕跳过(planner 已尽量填满,极端空库时仍可全空)
  const activeActs = plan.acts.map((a) => a.act).sort((a, b) => a - b);
  if (activeActs.length === 0) {
    ui.renderResult("今日无词可练", "返回主菜单", () => ui.renderMainMenu());
    ui.renderRecap([]);
    return;
  }
  const lastAct = activeActs[activeActs.length - 1];

  let actIdx = 0; // 当前幕在 activeActs 中的下标
  if (startIdx > 0) actIdx = startIdx; // 重开本幕:直接落在失败的那一幕
  const startAct = (): void => {
    const actNo = activeActs[actIdx];
    const actPlan = plan.acts.find((a) => a.act === actNo)!;
    const p = ACT_PRESSURE[actNo - 1];
    battle.setActWave(actPlan.zombies, p.spawnInterval, p.maxAlive, actNo, p.parallelProb);
    gameMode = null;
    renderer.setSelected(null);
    ui.setMsg(`—— ${actNames[actNo]} ——`);
    updateHud(ui, battle);
  };

  const battle = new Battle({
    zombies: [],
    spawnInterval: 6,
    maxAlive: 1,
    words,
    statsByWord: battleStats,
    events: {
      onKill: () => {},
      onMismatch: () => {},
      onShot: (p, z, hit) => renderer.spawnShot(p, z, hit),
      onBaseHit: () => {
        renderer.flashBase();
        updateHud(ui, battle);
      },
      onNibble: (p) => ui.setMsg(`「${p.labelText}」正在被僵尸啃食…`),
      onVore: (p) => ui.setMsg(`「${p.labelText}」植株被啃食殆尽!`),
      onShockHit: (p) => {
        ui.setMsg(`「${p.labelText}」被终局冲击波摧毁!`);
        updateHud(ui, battle);
      },
      onDefeat: () => finishSession(),
      onVic: () => finishSession(),
    },
  });
  // 开发态调试钩子:冒烟测试直接观测战斗内部状态
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__battle = battle;
  }

  const size = Battle.size(field.clientWidth, field.clientHeight, TUNING.laneCount);
  battle.setField(size.fieldWidth, size.fieldHeight, TUNING.laneCount);
  battle.lastAct = lastAct;

  const renderer = new BattleRenderer(field, battle, words, {
    onFrame: () => {
      updateHud(ui, battle);
      if (ui.upgradeOpen()) ui.refreshUpgradePanel(battle.sun); // 阳光够即启用购买按钮
      // 幕完成:该幕出过怪且已清场 → 自动进入下一幕
      if (battle.currentAct > 0 && battle.isWaveCleared() && actIdx < activeActs.length - 1 && !battle.isOver()) {
        actIdx += 1;
        startAct();
      }
    },
  });
  // 育苗盘与幕解耦:整局一次建成。每词同时提供正向(中文)与反向(外语)两张卡,
  // 避免"只有一张卡可点"造成的猜词;实际命中仍要求标签与僵尸答案侧一致。
  const dailyCards = new Map<string, { wordId: string; dir: import("./core/model").Direction }>();
  for (const actPlan of plan.acts) {
    for (const z of actPlan.zombies) {
      dailyCards.set(`${z.wordId}:forward`, { wordId: z.wordId, dir: "forward" });
      dailyCards.set(`${z.wordId}:reverse`, { wordId: z.wordId, dir: "reverse" });
    }
  }
  buildTray(trayEl, [...dailyCards.values()], words, renderer, ui);

  // 必须先启动首幕再开渲染循环,否则 start() 首帧空场会被误判"清场可换幕"
  startAct();

  bindFieldClick(battle, field, ui, renderer, words);
  renderer.start();

  // 升级模式:HUD「升级」按钮切换。进升级模式 → 战斗冻结;点植物弹面板;退出/关闭恢复。
  ui.onToggleUpgradeMode(() => {
    if (battle.isOver()) return;
    if (gameMode?.kind === "upgrade-select") {
      gameMode = null;
      renderer.setSelected(null);
      battle.paused = false; // 再点升级按钮退出 → 战斗恢复
      ui.setMsg("");
    } else {
      gameMode = { kind: "upgrade-select" };
      renderer.setSelected(null);
      battle.paused = true; // 进入升级选择 → 战斗冻结,便于从容选株购买
      ui.setMsg("升级模式(战斗已暂停):点已种植物打开升级面板,点空地恢复");
    }
    updateHud(ui, battle);
  });

  pauseBtn.textContent = "暂停";
  pauseBtn.addEventListener("click", () => {
    if (!battle.isOver()) {
      location.reload();
    }
  });

  async function finishSession(): Promise<void> {
    ui.setMsg("");
    ui.closeUpgradePanel(); // 结束即清理战场残留(消息/升级面板)
    const outcomes = battle.getOutcomes();
    const updated = new Map(liveStats); // 只写生活账本:同日同词一条,后写覆盖
    for (const o of outcomes) {
      const s = updated.get(o.wordId);
      if (!s) continue;
      // 幕归属取最大幕:终局 boss 接力词(body 内 cycle)也记为第 5 幕,而非其 Act4 出身
      let act = 1;
      for (let i = plan.acts.length - 1; i >= 0; i--) {
        const zs = plan.acts[i].zombies;
        if (zs.some((z) => z.wordId === o.wordId || z.cycle?.some((c) => c.wordId === o.wordId))) {
          act = plan.acts[i].act;
          break;
        }
      }
      updated.set(o.wordId, commitOutcome(s, o, plan.day, act));
    }
    // Boss 毕业
    for (const id of plan.bossCandidates) {
      const s = updated.get(id);
      if (s && s.threatIndex === 0 && outcomes.some((o) => o.wordId === id && o.success)) {
        updated.set(id, graduateBoss(s));
      }
    }
    await saveStats(profile, [...updated.values()]);
    // 菜单「已学 N 词」等展示刷新为最新账本,不再停留在开场快照
    ui.state.statsByWord = updated;
    ui.state.words = [...words.values()];

    // 复盘分类:一次过 / 有困难也过了 / 没通过
    const passFirst: string[] = [];
    const passRetry: string[] = [];
    const fail: string[] = [];
    for (const o of outcomes) {
      const w = words.get(o.wordId);
      const label = w ? `${w.foreign} ↔ ${w.chinese}` : o.wordId;
      if (o.success && o.retries === 0) passFirst.push(label);
      else if (o.success) passRetry.push(label);
      else fail.push(label);
    }

    const won = battle.isVictory();
    // 钻石奖励:五幕全通 + 基地无损 + 当天未发过 → +1(跨天累计)
    let diamondNote = "";
    if (won) {
      const diamondTotal = (await getMeta(profile, "diamond")) ?? 0;
      const lastAwardDay = await getMeta(profile, "diamondDay");
      const granted = eligibleForDiamond({
        won,
        baseHp: battle.baseHp,
        baseFull: TUNING.baseMaxHp,
        lastAct: battle.lastAct,
        lastAwardDay,
        today: plan.day,
      });
      if (granted) {
        await setMeta(profile, "diamond", diamondTotal + 1);
        await setMeta(profile, "diamondDay", plan.day);
        ui.state.diamond = diamondTotal + 1;
        diamondNote = `<div style="color:#74d7ff;font-weight:700;">💎 获得 1 颗钻石(五幕全通 · 基地无损)</div>`;
      }
    }
    // 复盘窗停在右侧,不遮挡居中的结果弹窗
    ui.renderRecap([
      { title: "✅ 一次通过", words: passFirst },
      { title: "😓 有困难但通过", words: passRetry },
      { title: "💪 没通过,继续加油", words: fail },
    ]);
    if (won) {
      // 分块推进:本块胜利即 played+1 落库;还有剩余块 → 直接进下一块,否则今日完成
      const nextIdx = chunkIdx + 1;
      daySnap.played = nextIdx;
      await saveSnapshot(profile, daySnap);
      ui.state.sessionIdx = nextIdx;
      if (nextIdx < daySnap.plans.length) {
        const next = daySnap.plans[nextIdx];
        ui.state.plan = next;
        ui.renderResult(
          `<b>第 ${nextIdx}/${daySnap.plans.length} 局 今日胜利!</b>${diamondNote}`,
          `下一局(第 ${nextIdx + 1}/${daySnap.plans.length} 局)`,
          () => {
            ui.clearOverlays();
            ui.renderBattle(
              document.createElement("canvas"),
              document.createElement("div"),
              document.createElement("button"),
            );
            void runSession(ui, profile, day, nextIdx, 0);
          },
        );
      } else {
        ui.state.plan = null;
        ui.renderResult(`<b>今日全部完成!</b>${diamondNote}`, "确认,返回主菜单", () => {
          ui.state.plan = null;
          ui.renderMainMenu();
        });
      }
    } else {
      const failNo = battle.currentAct;
      const failIdx = activeActs.indexOf(failNo);
      ui.renderResult("<b>基地沦陷,本幕重来。</b>", "重新开始", () => {
        restartAct(failIdx);
      });
      ui.state.plan = daySnap.plans[chunkIdx]; // 主菜单可回看当前块;重开由 runSession 快照驱动
    }
    ui.state.baseHp = battle.baseHp;
    ui.state.sun = battle.sun;
    ui.state.baseSiege = false; // 战场收束,熄灭围城红闪(含 HUD)
    ui.updateHud();
  }

  /** 原地重开失败的一幕:停掉旧渲染循环,清浮层,从失败幕重建战场(保留当前块的同一份计划)。 */
  function restartAct(failIdx: number): void {
    renderer.stop();
    ui.clearOverlays();
    ui.renderBattle(
      document.createElement("canvas"),
      document.createElement("div"),
      document.createElement("button"),
    );
    void runSession(ui, profile, plan.day, chunkIdx, failIdx);
  }
}

function buildTray(
  tray: HTMLElement,
  cards: { wordId: string; dir: import("./core/model").Direction }[],
  words: Map<string, Word>,
  renderer: BattleRenderer,
  ui: UI,
): void {
  tray.innerHTML = "";
  // 育苗盘分区:中文卡(正向标签)一组、外语卡(反向标签)一组,各自组内随机,
  // 避免中/外混排的成对规律与查找成本;区与区之间由分组容器视觉分隔。
  const buildGroup = (title: string, group: { wordId: string; dir: import("./core/model").Direction }[]): void => {
    const panel = document.createElement("div");
    panel.className = "tray-group";
    const head = document.createElement("span");
    head.className = "tray-group-title";
    head.textContent = title;
    panel.appendChild(head);
    for (const { wordId: id, dir } of shuffleCards(group)) {
      const w = words.get(id);
      if (!w) continue;
      const label = dir === "forward" ? w.chinese : w.foreign;
      const btn = document.createElement("button");
      btn.className = "card";
      btn.textContent = label;
      btn.dataset.wordId = id;
      btn.dataset.dir = dir;
      btn.title = `${w.foreign} ↔ ${w.chinese}`;
      btn.addEventListener("click", () => {
        // 点卡:取消正在进行的开火意图,进入种植模式
        gameMode = { kind: "planting", w, label };
        renderer.setSelected(null);
        ui.setMsg(`已选「${label}」,点击场地空格种植`);
      });
      panel.appendChild(btn);
    }
    tray.appendChild(panel);
  };
  buildGroup("中文", cards.filter((c) => c.dir === "forward"));
  buildGroup("外语", cards.filter((c) => c.dir === "reverse"));
}

/** Fisher–Yates 洗牌,返回新数组(不修改入参);顺带保证任意相邻两项不同词(组内已无双卡,天然满足)。 */
function shuffleCards<T extends { wordId: string }>(arr: T[]): T[] {
  let out = [...arr];
  for (let attempt = 0; attempt < 32; attempt++) {
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    let ok = true;
    for (let i = 1; i < out.length; i++) {
      if (out[i].wordId === out[i - 1].wordId) {
        ok = false;
        break;
      }
    }
    if (ok) return out;
  }
  return out; // 极端尝试后仍相邻则接受(数据量极小几乎不会发生)
}

/** 交互状态:null=空闲 | planting=待种植 | firing=待开火 | upgrade-select=待选株升级 */
type GameMode =
  | { kind: "planting"; w: Word; label: string }
  | { kind: "firing"; plant: import("./battle/battle").Plant }
  | { kind: "upgrade-select" }
  | null;
let gameMode: GameMode = null;

/** 挂一次常驻点击处理器:选苗/种植/点火/升级都在这里分派 */
function bindFieldClick(battle: Battle, field: HTMLCanvasElement, ui: UI, renderer: BattleRenderer, words: Map<string, Word>): void {
  const laneH = () => field.getBoundingClientRect().height / TUNING.laneCount;

  // 升级面板:当前选中的株与打开/购买
  let upgradePlantNow: import("./battle/battle").Plant | null = null;
  const openUpgrade = (p: import("./battle/battle").Plant): void => {
    upgradePlantNow = p;
    renderer.setSelected(p);
    const entries = [
      { key: "reload", name: "⚡ 急速装填", desc: "装弹 1.5s → 1.0s", cost: battle.upgradeCost(p, "reload"), applied: p.reloadBoost },
      { key: "dmg", name: "🔱 破甲弹药", desc: `命中伤害 +1(当前 +${p.dmgBoost})`, cost: battle.upgradeCost(p, "dmg"), applied: p.dmgBoost > 0 },
      { key: "autoFire", name: "🤖 自动发射", desc: "装填完自动打同 lane 匹配非教学僵尸", cost: battle.upgradeCost(p, "autoFire"), applied: p.autoFire },
      { key: "freeze", name: "🧊 凝固弹", desc: "命中冻结 2.5s(Boss 1s)·射速减半(间隔=装填×2)", cost: battle.upgradeCost(p, "freeze"), applied: p.freezeStun },
    ];
    ui.renderUpgradePanel(p.labelText, entries);
  };
  ui.onUpgradeBuy((key) => {
    if (!upgradePlantNow) return;
    const p = upgradePlantNow;
    const ok = battle.upgradePlant(p, key as import("./battle/battle").UpgradeKey);
    if (ok) ui.setMsg(`「${p.labelText}」升级成功${p.autoFire ? ",自动发射中" : ""} ${key === "reload" ? "(急速装填)" : ""}`);
    else ui.setMsg("阳光不足或已满级");
    updateHud(ui, battle);
    openUpgrade(p); // 重绘面板(刷新可用/满级/价格)
  });
  ui.onUpgradeClose(() => {
    upgradePlantNow = null;
    renderer.setSelected(null);
    ui.closeUpgradePanel();
    gameMode = null;
    battle.paused = false; // 关闭升级面板 → 战斗恢复
    ui.setMsg("");
  });

  // 右键已种植物 → 移出并退阳光
  field.addEventListener("contextmenu", (e) => {
    const rect = field.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < 0 || x > rect.width || y < 0 || y > rect.height) return;
    const lane = Math.floor(y / laneH());
    const hitPlant = battle.plants
      .filter((p) => p.lane === lane && Math.abs(120 + p.cellX * 60 - x) < 34)
      .sort((a, b) => Math.abs(120 + a.cellX * 60 - x) - Math.abs(120 + b.cellX * 60 - x))[0];
    if (!hitPlant) return;
    e.preventDefault();
    battle.removePlant(hitPlant);
    if (gameMode?.kind === "firing" && gameMode.plant === hitPlant) {
      gameMode = null;
      renderer.setSelected(null);
    }
    ui.setMsg(`已移出「${hitPlant.labelText}」(-1 株,退还阳光)`);
    updateHud(ui, battle);
  });
  field.addEventListener("click", (e) => {
    const rect = field.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < 0 || x > rect.width || y < 0 || y > rect.height) return;
    const lane = Math.floor(y / laneH());
    const alive = battle.zombies.filter((z) => z.hp > 0);

    // 1) 点到已有植物:升级模式下打开升级面板;否则切换为开火选择
    const hitPlant = battle.plants
      .filter((p) => p.lane === lane && Math.abs(120 + p.cellX * 60 - x) < 34)
      .sort((a, b) => Math.abs(120 + a.cellX * 60 - x) - Math.abs(120 + b.cellX * 60 - x))[0];
    if (hitPlant) {
      if (gameMode?.kind === "upgrade-select") {
        openUpgrade(hitPlant);
        return;
      }
      gameMode = { kind: "firing", plant: hitPlant };
      renderer.setSelected(hitPlant);
      ui.setMsg(`已装弹${hitPlant.jamming ? "(哑火)" : hitPlant.reloadRemain > 0 ? "(装弹中)" : "✓"} — 点同 lane 僵尸开火(错打会激怒它)`);
      updateHud(ui, battle);
      return;
    }

    // 2) 待种植 → 种到该 lane 并自动首发判定
    if (gameMode?.kind === "planting") {
      const { w, label } = gameMode;
      // 是否会发生"替换旧株"(同 lane 已有不同词将要被自动移除),用于提示
      const willReplace = battle.plants.some((p) => p.lane === lane && p.wordId !== w.id);
      // 同一 lane 同词上限 3 株
      const sameInLane = battle.plants.filter((p) => p.lane === lane && p.wordId === w.id).length;
      if (sameInLane >= 3) {
        ui.setMsg("同一 lane 同词最多 3 株,换 lane 或换词");
        updateHud(ui, battle);
        return;
      }
      const plant = battle.placePlant(w.id, lane, label);
      if (!plant) {
        ui.setMsg(`阳光不足(${Math.round(battle.sun)})`);
        updateHud(ui, battle);
        return;
      }
      // 种下即自动装填:进入该株开火待命(不自动攻击,等玩家点击僵尸发射)
      ui.setMsg(willReplace ? `「${label}」已自动装填✓(替换了同 lane 旧株),点同 lane 僵尸开火` : `「${label}」已自动装填✓,点同 lane 僵尸开火(错打会激怒它)`);
      gameMode = { kind: "firing", plant };
      renderer.setSelected(plant);
      updateHud(ui, battle);
      return;
    }

    // 3) 待开火 → 点僵尸发射或点空地自动选目标。核心:指哪打哪,会不会错配由 fire 判定(答错就惩罚)
    if (gameMode?.kind === "firing") {
      const plant = gameMode.plant;
      if (plant.reloadRemain > 0 || plant.jamming) {
        ui.setMsg(plant.jamming ? "植物哑火中,等待救援" : "装弹中…");
        return;
      }
      // 优先:玩家明确点中了某只僵尸(约一整个精灵宽度)→ 直接打它(匹配=命中,不匹配=错配惩罚)
      // 终局 boss 横跨全 lane:任意行的这列 x 均可直接点中,命中框放宽到身体半径
      const hitZombie: import("./battle/battle").Zombie | undefined = alive
        .filter((zz) => (zz.lane === lane || !!zz.ultimate) && Math.abs(zz.x + 30 - x) < (zz.ultimate ? 220 : 55))
        .sort((a, b) => Math.abs(a.x + 30 - x) - Math.abs(b.x + 30 - x))[0];
      if (hitZombie) {
        const res = battle.fire(plant, hitZombie);
        ui.setMsg(res.hit ? "命中!" : "错配:僵尸被激怒(+1血/加速)");
        updateHud(ui, battle);
        return;
      }
      // 没点中具体僵尸 → 自动选目标(优先匹配,无匹配则打最近的任意僵尸,由 fire 判定)
      const auto = pickAutoTarget(alive, lane, plant, words);
      if (auto) {
        const res = battle.fire(plant, auto);
        ui.setMsg(res.hit ? "命中!" : "错配:僵尸被激怒(+1血/加速)");
        updateHud(ui, battle);
        return;
      }
      ui.setMsg("该 lane 没有可攻击的僵尸");
      return;
    }

    // 4) 空点取消选择(升级模式→退出升级模式;开火/种植→取消)
    const wasUpgrade = gameMode?.kind === "upgrade-select";
    ui.closeUpgradePanel();
    renderer.setSelected(null);
    gameMode = null;
    if (wasUpgrade) battle.paused = false; // 升级模式点空地=恢复战斗
  });
}

function updateHud(ui: UI, battle: Battle): void {
  ui.state.sun = battle.sun;
  ui.state.baseHp = battle.baseHp;
  ui.state.act = battle.currentAct;
  ui.state.combo = battle.combo;
  ui.state.baseSiege = battle.zombies.some((z) => z.reachedBase);
  ui.updateHud();
}