import { describe, it, expect } from "vitest";
import {
  latestEncounter,
  recallKind,
  latestKind,
  summarizeDay,
  appendEncounter,
} from "../src/core/stats";
import type { Word, WordStats, EncounterOutcome } from "../src/core/model";

function stats(history: WordStats["encounterHistory"]): WordStats {
  return {
    wordId: "w1",
    intervalRung: 0,
    threatIndex: 0,
    introducedDay: 1,
    introducedBatch: 0,
    encounterHistory: history,
  };
}

describe("stats: 回忆分类", () => {
  it("无历史 → fail", () => {
    expect(recallKind(undefined)).toBe("fail");
    expect(recallKind(stats([]).encounterHistory.at(-1))).toBe("fail");
  });

  it("算错0次且成功 → pass_first", () => {
    const e = { day: 1, act: 1, direction: "forward" as const, retries: 0, success: true };
    expect(recallKind(e)).toBe("pass_first");
  });

  it("算错≥1次但成功 → pass_retry", () => {
    const e = { day: 1, act: 1, direction: "forward" as const, retries: 2, success: true };
    expect(recallKind(e)).toBe("pass_retry");
  });

  it("未成功 → fail", () => {
    const e = { day: 1, act: 1, direction: "forward" as const, retries: 1, success: false };
    expect(recallKind(e)).toBe("fail");
  });
});

describe("stats: appendEncounter 落账", () => {
  it("追加一条记录并保留其它字段", () => {
    const before = stats([]);
    const o: EncounterOutcome = {
      wordId: "w1",
      direction: "reverse",
      retries: 3,
      success: true,
    };
    const after = appendEncounter(before, o, 5, 4);
    expect(after.encounterHistory).toHaveLength(1);
    expect(after.encounterHistory[0]).toEqual({ day: 5, act: 4, direction: "reverse", retries: 3, success: true });
    expect(after.introducedDay).toBe(1);
  });
});

describe("stats: summarizeDay 日复盘", () => {
  const words: Word[] = [
    { id: "a", foreign: "apple", chinese: "苹果" },
    { id: "b", foreign: "banana", chinese: "香蕉" },
    { id: "c", foreign: "car", chinese: "汽车" },
  ];
  function mk(id: string, day: number, history: WordStats["encounterHistory"]): WordStats {
    return { wordId: id, intervalRung: 0, threatIndex: 0, introducedDay: day, introducedBatch: 0, encounterHistory: history };
  }
  it("只统计今天初学的词,并正确分组", () => {
    const map = new Map<string, WordStats>([
      ["a", mk("a", 1, [{ day: 1, act: 1, direction: "forward", retries: 0, success: true }])],
      ["b", mk("b", 1, [{ day: 1, act: 2, direction: "forward", retries: 2, success: true }])],
      ["c", mk("c", 1, [{ day: 1, act: 2, direction: "forward", retries: 0, success: false }])],
    ]);
    const sum = summarizeDay(words, map, 1);
    expect(sum.learnedCount).toBe(3);
    expect(sum.passFirst).toEqual(["a"]);
    expect(sum.passRetry).toEqual(["b"]);
    expect(sum.fail).toEqual(["c"]);
  });

  it("旧词(非今日初学)不计入 learnedCount", () => {
    const map = new Map<string, WordStats>([
      ["a", mk("a", 0, [{ day: 0, act: 1, direction: "forward", retries: 0, success: true }])],
    ]);
    const sum = summarizeDay(words, map, 1);
    expect(sum.learnedCount).toBe(0);
  });
});

describe("stats: latestEncounter / latestKind", () => {
  it("取最后一条,无历史返回 undefined / fail", () => {
    expect(latestEncounter(stats([]))).toBeUndefined();
    expect(latestKind(stats([]))).toBe("fail");
    const s = stats([
      { day: 1, act: 1, direction: "forward", retries: 0, success: false },
      { day: 1, act: 2, direction: "forward", retries: 1, success: true },
    ]);
    expect(latestEncounter(s)?.retries).toBe(1);
    expect(latestKind(s)).toBe("pass_retry");
  });
});