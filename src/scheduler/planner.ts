import { TUNING, ACT_REVERSE_RATIO } from "../core/tuning";
import type {
  Word,
  WordStats,
  EncounterOutcome,
  Direction,
  DailyPlan,
  ZombieSpec,
  ActPlan,
  DaySnapshot,
} from "../core/model";
import { appendEncounter, latestEncounter } from "../core/stats";

/** SRS 调度器:间隔阶梯 + 威胁指数 + 每日计划 + Boss 提名 */

/**
 * 计划语义版本:分幕分派 / 重复轮次 / 练习分配等生成规则变化时 +1。
 * 快照中的计划落后于该版本(或缺省)即判为陈旧,由 app 用新规则重建当日计划。
 */
export const PLAN_VERSION = 1;

export function initWordStats(
  wordId: string,
  introducedDay: number,
  introducedBatch: number,
): WordStats {
  return {
    wordId,
    intervalRung: 0,
    threatIndex: 0,
    introducedDay,
    introducedBatch,
    encounterHistory: [],
  };
}

/** 会话结束:落账 + 更新威胁指数 + 推进间隔 */
export function applyOutcome(
  stats: WordStats,
  outcome: EncounterOutcome,
  day: number,
  act: number,
): WordStats {
  let updated = appendEncounter(stats, outcome, day, act);
  if (outcome.success) {
    updated = { ...updated, intervalRung: nextRung(updated.intervalRung) };
  } else {
    // fail:威胁+1,间隔降档(至少回到档0)
    updated = {
      ...updated,
      threatIndex: updated.threatIndex + 1,
      intervalRung: Math.max(0, updated.intervalRung - 1),
    };
  }
  return updated;
}

/**
 * 同日单条结记:同一天反复开局的记录不重复累计,后写覆盖。
 * 先回滚当天旧记录的效果再套用新记录 → 历史不膨胀、当天多局不叠加难度,跨日语义保持不变。
 */
export function commitOutcome(
  stats: WordStats,
  outcome: EncounterOutcome,
  day: number,
  act: number,
): WordStats {
  const prev = stats.encounterHistory.find((e) => e.day === day);
  if (!prev) return applyOutcome(stats, outcome, day, act);
  let base: WordStats = { ...stats, encounterHistory: stats.encounterHistory.filter((e) => e.day !== day) };
  if (prev.success) {
    base = { ...base, intervalRung: prevRung(base.intervalRung) };
  } else {
    base = {
      ...base,
      threatIndex: Math.max(0, base.threatIndex - 1),
      intervalRung: nextRung(base.intervalRung),
    };
  }
  return applyOutcome(base, outcome, day, act);
}

export function nextRung(rung: number): number {
  return Math.min(rung + 1, TUNING.intervalLadder.length - 1);
}

export function prevRung(rung: number): number {
  return Math.max(0, rung - 1);
}

/** Boss 毕业:清空威胁指数,间隔升一档 */
export function graduateBoss(stats: WordStats): WordStats {
  return {
    ...stats,
    threatIndex: 0,
    intervalRung: nextRung(stats.intervalRung),
  };
}

export function isDue(stats: WordStats, today: number): boolean {
  if (stats.encounterHistory.length === 0) return false;
  const last = stats.encounterHistory[stats.encounterHistory.length - 1];
  return today > last.day + TUNING.intervalLadder[stats.intervalRung];
}

/**
 * 当日候选词池(有序、去重):新词 → 短到期 → 长到期 → 错词(urgent)→ Boss 候选。
 * 顺序即分块顺序:新词恒落第 1 块(教学局),其余按难度顺延。
 */
function dailyPool(
  words: Word[],
  statsByWord: Map<string, WordStats>,
  today: number,
): string[] {
  const idOf = (w: Word) => w.id;
  const newIds = words
    .filter((w) => !hasEncounter(statsByWord.get(w.id)))
    .slice(0, TUNING.dailyNewWords)
    .map(idOf);
  const allDue = words
    .filter((w) => {
      const s = statsByWord.get(w.id);
      return s && hasEncounter(s) && isDue(s, today) && !newIds.includes(w.id);
    })
    .map(idOf);
  const urgentIds = words
    .filter((w) => {
      const s = statsByWord.get(w.id);
      const last = latestEncounter(s);
      return !!last && !last.success && !newIds.includes(w.id);
    })
    .map(idOf);
  const rungOf = (id: string) => statsByWord.get(id)?.intervalRung ?? 0;
  const bossIds = words
    .filter((w) => {
      const s = statsByWord.get(w.id);
      return s && s.threatIndex > 0 && hasEncounter(s);
    })
    .sort((a, b) => threat(statsByWord, b.id) - threat(statsByWord, a.id))
    .slice(0, 3)
    .map(idOf);
  const ordered = [
    ...newIds,
    ...allDue.filter((id) => rungOf(id) <= 1),
    ...allDue.filter((id) => rungOf(id) > 1),
    ...urgentIds,
    ...bossIds,
  ];
  return ordered.filter((id, i, arr) => arr.indexOf(id) === i);
}

/**
 * 由显式候选词 id 清单构建一份完整 5 幕计划(分块与整日共用同一套幕逻辑):
 * 幕内角色按记忆状态在该清单内重定(教学/到期/错词/Boss),借词不出块、兜底可跨词表。
 */
export function buildPlanForIds(
  ids: string[],
  words: Word[],
  statsByWord: Map<string, WordStats>,
  today: number,
): DailyPlan {
  const newIds = ids.filter((id) => !hasEncounter(statsByWord.get(id)));
  const dueIds = ids.filter((id) => {
    const s = statsByWord.get(id);
    return s && hasEncounter(s) && isDue(s, today) && !newIds.includes(id);
  });
  const urgentIds = ids.filter((id) => {
    const s = statsByWord.get(id);
    const last = latestEncounter(s);
    return !!last && !last.success && !newIds.includes(id);
  });
  const bossIds = ids
    .filter((id) => {
      const s = statsByWord.get(id);
      return s && s.threatIndex > 0 && hasEncounter(s);
    })
    .sort((a, b) => threat(statsByWord, b) - threat(statsByWord, a))
    .slice(0, 3);

  // 复习池 = 到期 ∪ 上次失败,剔除已入 Act4 的头目词(头目只答一次,不与 Act3 重复)。
  // 按难度(打分)升序排齐,再对半均分:较易一半进 Act2、较难一半进 Act3 → 数量均匀 + 难度渐进。
  const reviewIds = [...new Set([...dueIds, ...urgentIds])]
    .filter((id) => !bossIds.includes(id))
    .sort(
      (a, b) =>
        difficultyScore(statsByWord.get(a)) - difficultyScore(statsByWord.get(b)) ||
        threat(statsByWord, a) - threat(statsByWord, b) ||
        a.localeCompare(b),
    );
  const half = Math.ceil(reviewIds.length / 2);
  const act2Ids = reviewIds.slice(0, half);
  const act3Ids = reviewIds.slice(half);

  // 教学后的新词反向练习:每新词 1 只 reverse、无提示,按比例分入 Act2/Act3
  // (Act1 只保留教学,练习不参与复习翻倍,故在统一重复轮次之后再追加)
  const recallSplit = Math.round(newIds.length * TUNING.newRecallAct2Share);
  const act2Recall = newIds.slice(0, recallSplit);
  const act3Recall = newIds.slice(recallSplit);

  const acts: ActPlan[] = [
    { act: 1, zombies: newIds.map(specZ("forward", true, false, 1)) },
    { act: 2, zombies: act2Ids.map((id) => specZ(hashDirection(id, 2), false, false, 2)(id)) },
    { act: 3, zombies: act3Ids.map((id) => specZ(hashDirection(id, 3), false, false, 3)(id)) },
    { act: 4, zombies: bossIds.map((id) => specZ(hashDirection(id, 4), false, true, 4)(id)) },
  ];

  fillEmptyActs(acts, words, statsByWord);

  for (const a of acts) {
    a.zombies = repeatRounds(a.zombies, TUNING.actRepeatRounds[a.act - 1] ?? 1);
  }

  // 练习副本各 1 只追加到对应幕末尾(Act1 纯教学,练习挪到 Act2/Act3)
  acts.find((a) => a.act === 2)?.zombies.push(...act2Recall.map((id) => specZ("reverse", false, false, 2)(id)));
  acts.find((a) => a.act === 3)?.zombies.push(...act3Recall.map((id) => specZ("reverse", false, false, 3)(id)));

  // 恒 5 幕:第 5 幕「终局」= 一只跨 lane 接力 boss,体内轮换「全网 Top3 最难词」
  // (难度打分高优先、威胁高次之、id 收尾),可与 Act4 头目词不同;无复习词时回退 Act4 词。
  // 每词段方向沿用 Act4 的 hashDirection,答法一致。
  const act4 = acts.find((a) => a.act === 4);
  if (act4 && act4.zombies.length > 0) {
    const source = [...new Set([...dueIds, ...urgentIds, ...bossIds])];
    let cycle: { wordId: string; direction: Direction }[];
    if (source.length > 0) {
      cycle = source
        .sort(
          (a, b) =>
            difficultyScore(statsByWord.get(b)) - difficultyScore(statsByWord.get(a)) ||
            threat(statsByWord, b) - threat(statsByWord, a) ||
            a.localeCompare(b),
        )
        .slice(0, 3)
        .map((id) => ({ wordId: id, direction: hashDirection(id, 4) as Direction }));
    } else {
      cycle = act4.zombies
        .map((z) => ({ wordId: z.wordId, direction: z.direction as Direction }))
        .filter((p, i, arr) => arr.findIndex((q) => q.wordId === p.wordId) === i)
        .slice(0, 3);
    }
    // Fisher–Yates 打乱出场顺序
    for (let i = cycle.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cycle[i], cycle[j]] = [cycle[j], cycle[i]];
    }
    const first = cycle[0];
    acts.push({
      act: 5,
      zombies: [{ wordId: first.wordId, direction: first.direction, teaching: false, boss: true, act: 5, ultimate: true, cycle }],
    });
  }

  return {
    day: today,
    newWords: newIds,
    acts,
    bossCandidates: bossIds,
  };
}

/**
 * 词条难度打分(服务分幕):
 * 0=新词(教学)、1=短间隔到期(上次成功且 rung≤1)、2=长间隔到期(rung≥2)、3=上次失败(urgent)。
 */
function difficultyScore(stats: WordStats | undefined): number {
  if (!stats || stats.encounterHistory.length === 0) return 0;
  const last = latestEncounter(stats);
  if (last && !last.success) return 3;
  return stats.intervalRung >= 2 ? 2 : 1;
}

/** 单日一整份计划(不切块;等价于 buildDailyChunks 在池不超上限时的单块结果,保持旧语义)。 */
export function buildDailyPlan(
  words: Word[],
  statsByWord: Map<string, WordStats>,
  today: number,
): DailyPlan {
  return buildPlanForIds(dailyPool(words, statsByWord, today), words, statsByWord, today);
}

/**
 * 每日候选按 sessionWordCap 分块:一局=一块,多局覆盖当日全部待复习词;
 * 块内恒 5 幕、跨块词不重叠。候选为空(全部已学且未到期)时仍产出一块兜底实心复习(与旧行为一致)。
 */
export function buildDailyChunks(
  words: Word[],
  statsByWord: Map<string, WordStats>,
  today: number,
  cap = TUNING.sessionWordCap,
): DailyPlan[] {
  if (words.length === 0) return []; // 无词表 → 无计划
  const pool = dailyPool(words, statsByWord, today);
  if (pool.length === 0) return [buildPlanForIds([], words, statsByWord, today)];
  const chunks: string[][] = [];
  for (let i = 0; i < pool.length; i += cap) chunks.push(pool.slice(i, i + cap));
  return chunks.map((ids) => buildPlanForIds(ids, words, statsByWord, today));
}

/** 一块计划里去重后的字数(含终局接力词段)。 */
export function countPlanWords(plan: DailyPlan): number {
  const ids = new Set<string>();
  for (const a of plan.acts) {
    for (const z of a.zombies) {
      ids.add(z.wordId);
      for (const c of z.cycle ?? []) ids.add(c.wordId);
    }
  }
  return ids.size;
}

/**
 * 快照迁移:恒 5 幕上线前生成的当日计划可能只有 4 幕。
 * 已含 Act5 或 Act4 为空时原样返回;否则从 Act4 最终词补出第 5 幕(语义与 buildDailyPlan 一致)。
 */
export function ensureAct5(plan: DailyPlan): DailyPlan {
  if (plan.acts.some((a) => a.act === 5)) return plan;
  const act4 = plan.acts.find((a) => a.act === 4);
  if (!act4 || act4.zombies.length === 0) return plan;
  const cycle = act4.zombies
    .map((z) => ({ wordId: z.wordId, direction: z.direction as Direction }))
    .filter((p, i, arr) => arr.findIndex((q) => q.wordId === p.wordId) === i)
    .slice(0, 3);
  for (let i = cycle.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cycle[i], cycle[j]] = [cycle[j], cycle[i]];
  }
  const first = cycle[0];
  return {
    ...plan,
    acts: [
      ...plan.acts,
      {
        act: 5,
        zombies: [{ wordId: first.wordId, direction: first.direction, teaching: false, boss: true, act: 5, ultimate: true, cycle }],
      },
    ],
  };
}

/**
 * 快照迁移:分块上线前 `DaySnapshot.plan` 单计划 → 新 `plans[] + played` 结构。
 * 旧计划顺带 ensureAct5(4 幕旧档补出终局),幂等:已是新结构原样返回。
 */
export function ensureChunks(snap: DaySnapshot): DaySnapshot {
  const anySnap = snap as DaySnapshot & { plan?: DailyPlan };
  if (Array.isArray(anySnap.plans) && anySnap.plans.length) return snap;
  const plan = ensureAct5(anySnap.plan ?? { day: snap.day, newWords: [], acts: [], bossCandidates: [] });
  return { day: snap.day, plans: [plan], played: 0, stats: snap.stats ?? [] };
}

/** 计划是否陈旧(生成规则已演进):缺版本号或低于当前 PLAN_VERSION → 需要重建当日计划 */
export function isStalePlan(snap: DaySnapshot): boolean {
  return (snap.planVersion ?? 0) < PLAN_VERSION;
}

/** 幕内词重复:各幕把同词的第二只以相反方向复现,第二轮不显示答案提示(教完即反向回忆)。 */
function repeatRounds(zombies: ZombieSpec[], rounds: number): ZombieSpec[] {
  if (rounds <= 1) return zombies;
  const second: ZombieSpec[] = zombies.map((z) => ({
    ...z,
    direction: z.direction === "forward" ? "reverse" : "forward",
    teaching: false,
  }));
  return [...zombies, ...second];
}

/** 让四幕尽量非空:易→难借词与已学词兜底(幕内唯一,重复允许跨幕)。 */
function fillEmptyActs(
  acts: ActPlan[],
  words: Word[],
  statsByWord: Map<string, WordStats>,
): void {
  // 借词池:按难度升序自然分派(新词教学 < 短到期 < 长/urgent < boss),借词沿用其自然方向
  const pool = acts.flatMap((a) => a.zombies);
  const candidates = pool.length > 0 ? pool : fallbackPool(words, statsByWord);

  for (const plan of acts) {
    if (plan.zombies.length > 0) continue;
    const inAct = new Set(plan.zombies.map((z) => z.wordId));
    const pick = candidates.find((f) => !inAct.has(f.wordId));
    if (pick) {
      // 借词仅 Act1 保留答案提示;Act2+ 复测/复习不显示头顶中文
      plan.zombies.push(specZ(pick.direction, plan.act === 1 ? pick.teaching : false, pick.boss, plan.act)(pick.wordId));
    }
  }
}

/** 兜底:没有新词/到期/boss 时,取"记忆最弱"的已学词(间隔档低/威胁高)做实心复习。 */
function fallbackPool(words: Word[], statsByWord: Map<string, WordStats>): ZombieSpec[] {
  return words
    .filter((w) => statsByWord.has(w.id))
    .sort((a, b) => {
      const sa = statsByWord.get(a.id)!;
      const sb = statsByWord.get(b.id)!;
      return sa.intervalRung - sb.intervalRung || sb.threatIndex - sa.threatIndex;
    })
    .map((w) => ({ wordId: w.id, direction: "forward" as Direction, teaching: true, boss: false, act: 1 }));
}

function threat(statsByWord: Map<string, WordStats>, id: string): number {
  return statsByWord.get(id)?.threatIndex ?? 0;
}

function hasEncounter(s: WordStats | undefined): boolean {
  return !!s && s.encounterHistory.length > 0;
}

function specZ(
  direction: Direction,
  teaching: boolean,
  boss: boolean,
  act: number,
): (id: string) => ZombieSpec {
  return (wordId: string) => ({ wordId, direction, teaching, boss, act });
}

/** 各幕反向占比递进:按 id 哈希稳定决定方向(FNV-1a 32bit,避免线性哈希偏斜) */
export function hashDirection(id: string, act: number): Direction {
  let hash = 0x811c9dc5 >>> 0;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash >>>= 0;
  const u = hash / 4294967296; // [0,1)
  const reverseRatio = ACT_REVERSE_RATIO[act - 1] ?? 0.3;
  return u < reverseRatio ? "reverse" : "forward";
}