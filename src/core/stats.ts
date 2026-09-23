import type { Word, WordStats, Encounter, EncounterOutcome } from "../core/model";

/** 集中管理"一次会话对单词的结果"的落账与派生统计 */

export function latestEncounter(stats: WordStats | undefined): Encounter | undefined {
  if (!stats || stats.encounterHistory.length === 0) return undefined;
  return stats.encounterHistory[stats.encounterHistory.length - 1];
}

/** outcome 分类:一次过 / 多次过 / 没记住 */
export type RecallKind = "pass_first" | "pass_retry" | "fail";

export function recallKind(e: Encounter | undefined): RecallKind {
  if (!e) return "fail";
  if (!e.success) return "fail";
  return e.retries === 0 ? "pass_first" : "pass_retry";
}

export function latestKind(stats: WordStats | undefined): RecallKind {
  return recallKind(latestEncounter(stats));
}

/** "今天新学的词"分布统计:一次过/多次过/没记住 */
export interface DaySummary {
  learnedCount: number;
  passFirst: string[]; // wordId
  passRetry: string[];
  fail: string[];
}

export function summarizeDay(
  words: Word[],
  statsByWord: Map<string, WordStats>,
  day: number,
): DaySummary {
  const learned = words.filter((w) => {
    const s = statsByWord.get(w.id);
    return s && s.introducedDay === day;
  });
  const result: DaySummary = {
    learnedCount: learned.length,
    passFirst: [],
    passRetry: [],
    fail: [],
  };
  for (const w of learned) {
    const kind = latestKind(statsByWord.get(w.id));
    if (kind === "pass_first") result.passFirst.push(w.id);
    else if (kind === "pass_retry") result.passRetry.push(w.id);
    else result.fail.push(w.id);
  }
  return result;
}

/** 会话/战斗结束时落账:把 outcome 追加到某词 history */
export function appendEncounter(
  stats: WordStats,
  outcome: EncounterOutcome,
  day: number,
  act: number,
): WordStats {
  const e: Encounter = {
    day,
    act,
    direction: outcome.direction,
    retries: outcome.retries,
    success: outcome.success,
  };
  return {
    ...stats,
    encounterHistory: [...stats.encounterHistory, e],
  };
}