import { describe, expect, it } from "vitest";
import { Battle } from "../src/battle/battle";
import { TUNING } from "../src/core/tuning";

const words = new Map([["a", { id: "a", foreign: "apple", chinese: "苹果", batch: 0, introducedDay: 0 } as any]]);

describe("Battle: 幕与连击推进", () => {
  it("setActWave 换幕:清幕后可进入下一幕,最终幕才判胜", () => {
    const b = new Battle({
      zombies: [],
      spawnInterval: 0.01,
      maxAlive: 5,
      words,
      statsByWord: new Map(),
    });
    b.setField(600, 400, TUNING.laneCount);
    b.lastAct = 3;
    b.setActWave(
      [{ wordId: "a", direction: "forward", teaching: true, boss: false, act: 1 }],
      0.01,
      5,
      1,
    );
    b.tick(0.05); // 出怪
    const z1 = b.zombies[0];
    b.sun = 100;
    const p = b.placePlant("a", z1.lane)!;
    b.fire(p, z1); // 打一枪
    expect(b.isWaveCleared()).toBe(false);
    // 装弹后打死该僵尸
    b.tick(2);
    expect(b.fire(p, z1).hit).toBe(true);
    b.tick(0.05); // 清尸
    expect(b.isWaveCleared()).toBe(true);
    expect(b.isOver()).toBe(false); // 未到最后一幕,不应判胜

    // 进入幕 2
    b.setActWave([{ wordId: "a", direction: "forward", teaching: false, boss: false, act: 2 }], 0.01, 5, 2);
    expect(b.currentAct).toBe(2);
    b.tick(0.05);
    const z2 = b.zombies[0];
    const p2 = b.placePlant("a", z2.lane)!;
    b.tick(2); // 装弹
    expect(b.fire(p2, z2).hit).toBe(true);
    b.tick(2); // 装弹
    expect(b.fire(p2, z2).hit).toBe(true);
    b.tick(0.05);
    // 幕 3 (最终幕)
    b.setActWave([{ wordId: "a", direction: "forward", teaching: false, boss: true, act: 3 }], 0.01, 5, 3);
    b.tick(0.05);
    const z3 = b.zombies[0];
    const p3 = b.placePlant("a", z3.lane)!;
    z3.hp = 1; // 围城机制下 BOSS 到岸即持续咬基地,单株无法拖住;本测试只验证"最终幕清场才判胜"
    for (let i = 0; i < 200 && z3.hp > 0; i++) {
      b.fire(p3, z3);
      b.tick(1);
    }
    b.tick(0.05);
    expect(b.isOver()).toBe(true);
    expect(b.isVictory()).toBe(true);
  });

  it("出怪时幕号随最高 act 推进", () => {
    const b = new Battle({
      zombies: [
        { wordId: "a", direction: "forward", teaching: true, boss: false, act: 1 },
        { wordId: "a", direction: "forward", teaching: false, boss: false, act: 2 },
        { wordId: "a", direction: "forward", teaching: false, boss: true, act: 4 },
      ],
      spawnInterval: 1,
      maxAlive: 5,
      words,
      statsByWord: new Map(),
    });
    b.setField(600, 400, TUNING.laneCount);
    b.tick(0.01);
    expect(b.currentAct).toBe(1);
    b.spawnTimer = 0; b.tick(0.01); // 第二只 act2
    expect(b.currentAct).toBe(2);
    b.spawnTimer = 0; b.tick(0.01); // 第三只 act4
    expect(b.currentAct).toBe(4);
  });

  it("命中递增连击,错配清零", () => {
    const b = new Battle({ zombies: [], spawnInterval: 1, maxAlive: 1, words, statsByWord: new Map() });
    b.setField(600, 400, TUNING.laneCount);
    b.sun = 100;
    const p = b.placePlant("a", 0)!;
    const z1 = { id: "z1", wordId: "a", direction: "forward" as const, teaching: false, boss: false, act: 1, hp: 2, maxHp: 2, speed: 60, x: 300, lane: 0, buffed: false, reachedBase: false };
    b.zombies.push(z1);
    expect(b.fire(p, z1).hit).toBe(true);
    expect(b.combo).toBe(1);
    const z2 = { id: "z2", wordId: "a", direction: "forward" as const, teaching: false, boss: false, act: 1, hp: 2, maxHp: 2, speed: 60, x: 300, lane: 0, buffed: false, reachedBase: false };
    b.zombies.push(z2);
    p.reloadRemain = 0;
    expect(b.fire(p, z2).hit).toBe(true);
    expect(b.combo).toBe(2);
    // 错配清连击:同词但反向(期望 apple,植物"苹果"≠apple)
    const mismatch = { id: "z3", wordId: "a", direction: "reverse" as const, teaching: false, boss: false, act: 1, hp: 2, maxHp: 2, speed: 60, x: 300, lane: 0, buffed: false, reachedBase: false };
    p.reloadRemain = 0;
    expect(b.fire(p, mismatch).hit).toBe(false);
    expect(b.combo).toBe(0);
  });
});

describe("Battle: 并行出怪与随机 lane (5 车道)", () => {
  it("parallelProb>0 时可能同帧弹 batch=2,受 maxAlive 约束", () => {
    const specs = Array.from({ length: 20 }, (_, i) => ({
      wordId: "a", direction: "forward" as const, teaching: false, boss: false, act: 2,
    }));
    const b = new Battle({ zombies: specs, spawnInterval: 0, maxAlive: 6, parallelProb: 1, words, statsByWord: new Map() });
    b.setField(600, 400, TUNING.laneCount);
    b.tick(0.01); // 触发一次出怪
    expect(b.zombies.length).toBeLessThanOrEqual(2); // batch 最大 2
    expect(b.zombies.length).toBeGreaterThan(0);
    if (b.zombies.length === 2) {
      expect(b.zombies[0].lane).not.toBe(b.zombies[1].lane); // batch 内 lane 互不相同
    }
  });
  it("随机 lane 覆盖全部 5 车道(多次出怪)", () => {
    const specs = Array.from({ length: 50 }, (_, i) => ({
      wordId: "a", direction: "forward" as const, teaching: false, boss: false, act: 2,
    }));
    const b = new Battle({ zombies: specs, spawnInterval: 0, maxAlive: 50, parallelProb: 0, words, statsByWord: new Map() });
    b.setField(600, 400, TUNING.laneCount);
    const seen = new Set<number>();
    for (let i = 0; i <= 5; i++) {
      b.tick(0.01);
      for (const z of b.zombies) seen.add(z.lane);
      if (seen.size >= TUNING.laneCount) break;
    }
    expect(seen.size).toBe(TUNING.laneCount); // 全部 5 lane 都被用过
  });
});
