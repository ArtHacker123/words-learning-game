import { TUNING, ACT_REVERSE_RATIO } from "../core/tuning";
import type {
  Word,
  WordStats,
  EncounterOutcome,
  Direction,
  DailyPlan,
  ZombieSpec,
  ActPlan,
} from "../core/model";
import { appendEncounter, latestEncounter } from "../core/stats";

/** SRS 调度器:间隔阶梯 + 威胁指数 + 每日计划 + Boss 提名 */

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
 * 每日计划生成
 * - 新词:取词表最早未学过的最多 N 个
 * - 到期复习:按到期长短分派 Act2(短)/Act3(长)
 * - urgent 错词(最近一次 encounter 失败)→ Act3
 * - Boss:threatIndex 最高 1~3 词,且必须已有 encounterHistory
 * - 恒产出 Act1..4 且每幕尽量非空:空幕按"更易优先"从其余幕借词补齐;
 *   全部都不是到期/新词时,兜底取"记忆最弱"的已学词填空(跨幕可重复,幕内不重复)。
 */
export function buildDailyPlan(
  words: Word[],
  statsByWord: Map<string, WordStats>,
  today: number,
): DailyPlan {
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
      return !!last && !last.success;
    })
    .map(idOf)
    .filter((id) => !newIds.includes(id));

  // 分派:短间隔就诊Act2,长间隔就诊Act3;urgent 强制 Act3
  const rungOf = (id: string) => statsByWord.get(id)?.intervalRung ?? 0;
  const act2Ids = allDue.filter((id) => rungOf(id) <= 1 && !urgentIds.includes(id));
  const act3Ids = [
    ...allDue.filter((id) => rungOf(id) > 1 || urgentIds.includes(id)),
    ...urgentIds,
  ].filter((id, i, arr) => arr.indexOf(id) === i);

  // Boss 提名
  const bossIds = words
    .filter((w) => {
      const s = statsByWord.get(w.id);
      return s && s.threatIndex > 0 && hasEncounter(s);
    })
    .sort((a, b) => threat(statsByWord, b.id) - threat(statsByWord, a.id))
    .slice(0, 3)
    .map(idOf);

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

  // 恒 5 幕:第 5 幕「终局」= 一只跨 lane 接力 boss,体内轮换 Act4 最终上场的词(1~3)。
  // 出场顺序随机化(计划写入快照 → 当天各局一致),每词段用其在 Act4 的方向作答。
  const act4 = acts.find((a) => a.act === 4);
  if (act4 && act4.zombies.length > 0) {
    const cycle = act4.zombies
      .map((z) => ({ wordId: z.wordId, direction: z.direction as Direction }))
      .filter((p, i, arr) => arr.findIndex((q) => q.wordId === p.wordId) === i)
      .slice(0, 3);
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