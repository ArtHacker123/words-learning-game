import { describe, it, expect } from "vitest";
import { Battle, makeZombie } from "../src/battle/battle";
import { TUNING } from "../src/core/tuning";
import type { Word, WordStats, Zombie } from "../src/core/model";

const WORD_A: Word = { id: "a", foreign: "apple", chinese: "苹果" };

function words(): Map<string, Word> {
  return new Map([[WORD_A.id, WORD_A]]);
}

function stats(): Map<string, WordStats> {
  return new Map([[WORD_A.id, { wordId: "a", intervalRung: 0, threatIndex: 0, introducedDay: 1, introducedBatch: 0, encounterHistory: [] }]]);
}

function newBattle() {
  const b = new Battle({
    zombies: [],
    spawnInterval: 1,
    maxAlive: 5,
    words: words(),
    statsByWord: stats(),
    events: {},
  });
  b.setField(800, 600, 3);
  return b;
}

/** 种一株词 a · lane 0 的植物(先给 300 阳光,返回该株)。 */
function plantedA(b: Battle) {
  b.sun = 300;
  return b.placePlant("a", 0)!;
}

function zA(lane = 0, spec: Partial<{ direction: "forward" | "reverse"; teaching: boolean; boss: boolean }> = {}): Zombie {
  return makeZombie(
    { wordId: "a", direction: spec.direction ?? "forward", teaching: spec.teaching ?? false, boss: spec.boss ?? false },
    lane,
    undefined,
    500,
  );
}

describe("Battle: 单株武器升级", () => {
  it("升级暂停:冻结时间/僵尸推进/装弹/自动开火,恢复后继续", () => {
    const b = newBattle();
    const p = plantedA(b);
    b.upgradePlant(p, "autoFire");
    const z = zA();
    z.x = 300;
    b.zombies.push(z);
    b.lastAct = 9;
    const xBefore = z.x;
    const sunBefore = b.sun;

    b.paused = true;
    b.tick(1.0);
    expect(b.time).toBe(0); // 时间冻结
    expect(z.x).toBe(xBefore); // 僵尸不推进
    expect(b.sun).toBe(sunBefore); // 阳光不滴漏
    expect(p.reloadRemain).toBe(0); // 自动开火也冻结(装弹未消耗)

    b.paused = false;
    b.tick(1.0);
    expect(b.time).toBe(1.0); // 恢复后时间前进
    expect(z.x).toBeLessThan(xBefore); // 僵尸恢复推进
    expect(b.sun).toBeGreaterThan(sunBefore); // 阳光恢复滴漏
    expect(p.reloadRemain).toBeGreaterThan(0); // 自动开火恢复
  });

  it("同一株可叠加所有升级(技能互不排斥)", () => {
    const b = newBattle();
    const p = plantedA(b); // 先种,再给足阳光
    b.sun = 1000;
    b.upgradePlant(p, "reload");
    b.upgradePlant(p, "dmg");
    b.upgradePlant(p, "autoFire");
    b.upgradePlant(p, "freeze");
    expect(p.reloadBoost).toBe(true);
    expect(p.dmgBoost).toBe(1);
    expect(p.autoFire).toBe(true);
    expect(p.freezeStun).toBe(true);
    // 叠加后一株即可验证其效果:装弹 1.0s × 凝固弹 2 = 2.0s 间隔 + 一发 2 伤害 + 冻结
    const z = zA();
    b.fire(p, z);
    expect(p.reloadRemain).toBe(TUNING.upgradeReloadSeconds * TUNING.freezeFireIntervalScale);
    expect(z.hp).toBe(0); // 2 - (1+1)
    expect(z.frozenUntil).toBeGreaterThan(b.time);
  });

  it("买单扣阳光并应用效果", () => {
    const b = newBattle();
    const p = plantedA(b); // 300 - 30 = 270
    expect(b.upgradePlant(p, "reload")).toBe(true);
    expect(p.reloadBoost).toBe(true);
    expect(b.sun).toBe(270 - TUNING.upgradeReloadCost);
  });

  it("阳光不足拒绝购买", () => {
    const b = newBattle();
    const p = plantedA(b);
    b.upgradePlant(p, "autoFire");
    b.sun = 5;
    expect(b.upgradePlant(p, "freeze")).toBe(false);
    expect(p.freezeStun).toBe(false);
    expect(b.sun).toBe(5);
  });

  it("已购项不可重复购买(cost 返回 null)", () => {
    const b = newBattle();
    const p = plantedA(b);
    b.upgradePlant(p, "autoFire");
    expect(b.upgradeCost(p, "autoFire")).toBeNull();
    expect(p.autoFire).toBe(true);
    expect(b.sun).toBe(270 - TUNING.upgradeAutoFireCost); // 未重复扣费
  });

  it("破甲弹药:分级定价,2 级封顶", () => {
    const b = newBattle();
    const p = plantedA(b);
    b.sun = 1000;
    expect(b.upgradeCost(p, "dmg")).toBe(TUNING.upgradeDmgCostBase);
    b.upgradePlant(p, "dmg");
    expect(p.dmgBoost).toBe(1);
    expect(b.upgradeCost(p, "dmg")).toBe(TUNING.upgradeDmgCostBase + 120);
    b.upgradePlant(p, "dmg");
    expect(p.dmgBoost).toBe(2);
    expect(b.upgradeCost(p, "dmg")).toBeNull();
  });

  it("急速装填:装弹时长降为 1.0s", () => {
    const b = newBattle();
    const p = plantedA(b);
    b.upgradePlant(p, "reload");
    b.fire(p, zA());
    expect(p.reloadRemain).toBe(TUNING.upgradeReloadSeconds);
    expect(p.reloadRemain).toBeLessThan(TUNING.reloadSeconds);
  });

  it("破甲弹药:命中伤害 1+dmgBoost(2 血僵尸一发毙命)", () => {
    const b = newBattle();
    const p = plantedA(b);
    b.upgradePlant(p, "dmg");
    const z = zA();
    b.fire(p, z);
    expect(z.hp).toBe(0); // 2 - (1+1)
  });

  it("凝固弹:命中冻结普通僵尸 2.5s,冻结期不推进", () => {
    const b = newBattle();
    const p = plantedA(b);
    b.upgradePlant(p, "freeze");
    const z = zA();
    z.x = 400;
    b.zombies.push(z);
    b.fire(p, z);
    expect(z.frozenUntil).toBe(b.time + TUNING.freezeStunSeconds);
    b.lastAct = 9; // 防空场误判胜利提前退出

    const xBefore = z.x;
    b.tick(1.0);
    expect(z.x).toBe(xBefore); // 冻结中不移动
    expect(z.frozenUntil).toBeGreaterThan(b.time);

    b.tick(1.6); // 累计 2.6s > 2.5s
    expect(z.frozenUntil).toBeLessThanOrEqual(b.time);
    b.tick(1.0);
    expect(z.x).toBeLessThan(xBefore); // 解冻后恢复推进
  });

  it("凝固弹命中 Boss:冻结缩短为 1s", () => {
    const b = newBattle();
    const p = plantedA(b);
    b.upgradePlant(p, "freeze");
    const z = zA(0, { boss: true });
    b.fire(p, z);
    expect(z.frozenUntil - b.time).toBeCloseTo(TUNING.freezeStunSeconds * TUNING.bossStunScale, 5);
  });

  it("凝固弹冷却:发射间隔=装填×2(基础 1.5→3.0s),装弹恢复后仍不可再发", () => {
    const b = newBattle();
    const p = plantedA(b);
    b.upgradePlant(p, "freeze");
    const z = zA();
    b.zombies.push(z);
    b.lastAct = 9; // 防空场误判胜利提前退出
    b.fire(p, z);
    expect(p.reloadRemain).toBe(TUNING.reloadSeconds * TUNING.freezeFireIntervalScale);

    // 普通装弹时间已过(1.5s),但发射间隔未满(需 3.0s)→ 仍不可再发
    b.tick(TUNING.reloadSeconds);
    expect(p.reloadRemain).toBeCloseTo(TUNING.reloadSeconds, 5); // 3.0 - 1.5 = 1.5
    const z2 = zA();
    b.zombies.push(z2);
    b.fire(p, z);
    expect(z2.hp).toBe(2); // 未命中:间隔未满,拒绝开火

    // 补齐余下间隔后即可再发
    b.tick(TUNING.reloadSeconds);
    b.zombies.push(zA());
    const last = b.zombies[b.zombies.length - 1];
    b.fire(p, last);
    expect(last.hp).toBeLessThan(last.maxHp); // 命中
    expect(last.frozenUntil).toBeGreaterThan(b.time); // 冻结照常
  });

  it("自动发射:装填完自动打同 lane 匹配非教学僵尸", () => {
    const b = newBattle();
    const p = plantedA(b);
    b.upgradePlant(p, "autoFire");
    b.zombies.push(zA(0), zA(1));
    b.lastAct = 9; // 防空场判定提前换幕/结束
    b.tick(0.1);
    expect(p.reloadRemain).toBeGreaterThan(0); // 已自动开火消耗装弹
    expect(b.zombies.find((z) => z.lane === 0)!.hp).toBe(1); // 同 lane 匹配被打
    expect(b.zombies.find((z) => z.lane === 1)!.hp).toBe(2); // 异 lane 不受影响
  });

  it("自动发射:不打教学僵尸(手动回忆)", () => {
    const b = newBattle();
    const p = plantedA(b);
    b.upgradePlant(p, "autoFire");
    b.zombies.push(zA(0, { teaching: true }));
    b.lastAct = 9;
    b.tick(0.1);
    expect(p.reloadRemain).toBe(0); // 未自动开火
    expect(b.zombies[0].hp).toBe(2);
  });

  it("自动发射:装弹未完成不自动开火", () => {
    const b = newBattle();
    const p = plantedA(b);
    b.upgradePlant(p, "autoFire");
    b.zombies.push(zA(0));
    b.lastAct = 9;
    b.tick(0.1);
    expect(p.reloadRemain).toBeGreaterThan(0); // 打了一发
    b.tick(0.1);
    expect(b.zombies.find((z) => z.lane === 0)!.hp).toBe(1); // 装弹中第二发未出,血量不变
  });

  it("自动发射:哑火株不自动开火", () => {
    const b = newBattle();
    const p = plantedA(b);
    b.upgradePlant(p, "autoFire");
    b.zombies.push(zA(0));
    b.lastAct = 9;
    p.rescueCooldown = 3;
    p.jamming = true;
    b.tick(0.1);
    expect(b.zombies.find((z) => z.lane === 0)!.hp).toBe(2);
  });
});