import { describe, it, expect } from "vitest";
import { eligibleForDiamond } from "../src/core/awards";
import { TUNING } from "../src/core/tuning";

const base = {
  won: true,
  baseHp: TUNING.baseMaxHp,
  baseFull: TUNING.baseMaxHp,
  lastAct: 5,
  today: 3,
};

describe("awards: 钻石(五幕全通+基地无损,每天最多 1 颗)", () => {
  it("五幕全通且基地满血 → 发", () => {
    expect(eligibleForDiamond({ ...base, lastAwardDay: 2 })).toBe(true);
  });

  it("从未发过(缺省 lastAwardDay)→ 发", () => {
    expect(eligibleForDiamond({ ...base })).toBe(true);
  });

  it("没有通关 → 不发", () => {
    expect(eligibleForDiamond({ ...base, won: false })).toBe(false);
  });

  it("未打到第 5 幕(如空词库空壳局,lastAct=4)→ 不发", () => {
    expect(eligibleForDiamond({ ...base, lastAct: 4 })).toBe(false);
  });

  it("基地受损过(baseHp < 满血)→ 不发", () => {
    expect(eligibleForDiamond({ ...base, baseHp: TUNING.baseMaxHp - 6 })).toBe(false);
  });

  it("同一天已发过 → 不再发(防刷)", () => {
    expect(eligibleForDiamond({ ...base, lastAwardDay: 3 })).toBe(false);
  });

  it("次天再通关 → 再发", () => {
    expect(eligibleForDiamond({ ...base, lastAwardDay: 1, today: 2 })).toBe(true);
  });

  it("异常参数(baseFull<=0)不误发", () => {
    expect(eligibleForDiamond({ ...base, baseFull: 0 })).toBe(false);
  });
});