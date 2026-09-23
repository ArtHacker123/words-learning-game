import { describe, it, expect, vi, afterEach } from "vitest";
import { Battle, makeZombie, pickAutoTarget } from "../src/battle/battle";
import { TUNING } from "../src/core/tuning";
import type { Word, WordStats, Zombie, EncounterOutcome } from "../src/core/model";

const WORD_A: Word = { id: "a", foreign: "apple", chinese: "苹果" };
const WORD_B: Word = { id: "b", foreign: "banana", chinese: "香蕉" };
const WORD_C: Word = { id: "c", foreign: "cherry", chinese: "樱桃" };

function words(): Map<string, Word> {
  return new Map([[WORD_A.id, WORD_A], [WORD_B.id, WORD_B], [WORD_C.id, WORD_C]]);
}

function stats(history: WordStats["encounterHistory"] = []): Map<string, WordStats> {
  const m = new Map<string, WordStats>();
  for (const w of [WORD_A, WORD_B]) {
    m.set(w.id, { wordId: w.id, intervalRung: 0, threatIndex: 0, introducedDay: 1, introducedBatch: 0, encounterHistory: [...history] });
  }
  return m;
}

function newBattle(zombies = [], events = {}, opts: { spawnInterval?: number; maxAlive?: number } = {}) {
  const b = new Battle({
    zombies,
    spawnInterval: opts.spawnInterval ?? 1,
    maxAlive: opts.maxAlive ?? 5,
    words: words(),
    statsByWord: stats(),
    events,
  });
  b.setField(800, 600, 3);
  return b;
}

function dormantZombie(wordId: string, lane = 0, direction: "forward" | "reverse" = "forward"): Zombie {
  return makeZombie({ wordId, direction, teaching: false, boss: false }, lane, undefined, 500);
}

describe("makeZombie: 强度映射 (design 6 节)", () => {
  function withLast(enc: WordStats["encounterHistory"]) {
    const m = new Map<string, WordStats>();
    m.set("a", { wordId: "a", intervalRung: 0, threatIndex: 0, introducedDay: 1, introducedBatch: 0, encounterHistory: enc });
    return m.get("a");
  }
  it("无历史(新词):基本 2HP / 常规速", () => {
    const z = makeZombie({ wordId: "a", direction: "forward", teaching: false, boss: false }, 0, undefined, 500);
    expect(z.hp).toBe(2);
    expect(z.speed).toBe(60);
  });
  it("上次成功 retries=0:2HP 常规速(最弱僵尸需 2 发)", () => {
    const s = withLast([{ day: 1, act: 1, direction: "forward", retries: 0, success: true }]);
    const z = makeZombie({ wordId: "a", direction: "forward", teaching: false, boss: false }, 0, s, 500);
    expect(z.hp).toBe(2);
    expect(z.speed).toBe(60);
  });
  it("上次失败:3HP 较快", () => {
    const s = withLast([{ day: 1, act: 1, direction: "forward", retries: 0, success: false }]);
    const z = makeZombie({ wordId: "a", direction: "forward", teaching: false, boss: false }, 0, s, 500);
    expect(z.hp).toBe(3);
    expect(z.speed).toBe(90);
  });
  it("上次 retries>=2 成功:4HP 快", () => {
    const s = withLast([{ day: 1, act: 1, direction: "forward", retries: 2, success: true }]);
    const z = makeZombie({ wordId: "a", direction: "forward", teaching: false, boss: false }, 0, s, 500);
    expect(z.hp).toBe(4);
    expect(z.speed).toBe(100);
  });
  it("Boss:9 血(快于普通僵尸,score>act3)", () => {
    const z = makeZombie({ wordId: "a", direction: "forward", teaching: false, boss: true }, 0, undefined, 500);
    expect(z.hp).toBe(9);
    expect(z.speed).toBe(75);
    expect(z.speed).toBeGreaterThan(60); // 快于普通僵尸
    expect(z.hp).toBeGreaterThan(4);      // 仍厚于 Act3 复习怪(3~4 血)
  });
  it("教学:速度降顶 15", () => {
    const z = makeZombie({ wordId: "a", direction: "forward", teaching: true, boss: false }, 0, undefined, 500);
    expect(z.speed).toBeLessThanOrEqual(30);
  });
});

describe("终局 boss(Act5): 跨 lane 接力", () => {
  const spec = (wordIds: string[], dirs: ("forward" | "reverse")[]) => {
    const cycle = wordIds.map((wordId, i) => ({ wordId, direction: dirs[i] }));
    return { wordId: wordIds[0], direction: dirs[0], teaching: false, boss: true, act: 5, ultimate: true, cycle };
  };

  it("makeZombie:总血=段均分×段数,totalHp=max(bossHp)×3,速度 110,保留 cycle", () => {
    const z = makeZombie(spec(["a", "b", "a"], ["forward", "forward", "reverse"]), 2, undefined, 500, stats());
    expect(z.ultimate).toBe(true);
    expect(z.phaseIdx).toBe(0);
    expect(z.wordId).toBe("a");
    expect(z.maxHp).toBe(TUNING.bossHp * TUNING.ultimateBossHpScale * TUNING.act5HpMultiplier);
    expect(z.hp).toBe(z.maxHp);
    expect(z.speed).toBe(TUNING.ultimateBossSpeed);
    expect(z.cycle).toHaveLength(3);
  });

  it("跨 lane 命中:任意 lane 植物可打;错词仍哑火加怒", () => {
    const b = newBattle([], {});
    b.sun = 100;
    const z = makeZombie(spec(["a"], ["forward"]), 2, undefined, 500);
    b.zombies.push(z);
    const plant = b.placePlant("a", 0)!; // lane 0 ≠ z.lane 2
    const good = b.fire(plant, z);
    expect(good.hit).toBe(true);
    expect(z.hp).toBe(z.maxHp - 1);
    const wrong = b.placePlant("b", 0)!;
    wrong.reloadRemain = 0;
    const bad = b.fire(wrong, z);
    expect(bad.hit).toBe(false);
    expect(z.buffed).toBe(true);
    expect(z.hp).toBe(z.maxHp); // 命中 -1 后错配 +1
  });

  it("打空一段原位换词:HP 复位到段上限,词卡与方向切换", () => {
    const b = newBattle([], {});
    b.sun = 300;
    const z = makeZombie(spec(["a", "b", "c"], ["forward", "reverse", "forward"]), 1, undefined, 500);
    b.zombies.push(z);
    const seg = z.maxHp / 3; // 54/3=18(整数),避免余量干扰断言
    const plant = b.placePlant("a", 1)!; // forward a → 期望 label=苹果(默认中文),匹配
    for (let i = 0; i < seg; i++) {
      plant.reloadRemain = 0;
      expect(b.fire(plant, z).hit).toBe(true);
    }
    // 段①空:切到 b(reverse),hp 复位到第二段满值 36
    expect(z.phaseIdx).toBe(1);
    expect(z.wordId).toBe("b");
    expect(z.direction).toBe("reverse");
    expect(z.hp).toBe(36);
    const plantB = b.placePlant("b", 1, "banana")!; // reverse b → 期望 label=外语 banana
    for (let i = 0; i < seg; i++) {
      plantB.reloadRemain = 0;
      expect(b.fire(plantB, z).hit).toBe(true);
    }
    expect(z.phaseIdx).toBe(2);
    expect(z.wordId).toBe("c");
    expect(z.direction).toBe("forward");
    expect(z.hp).toBe(18);
    const plantC = b.placePlant("c", 1)!; // forward c → 默认中文
    for (let i = 0; i < seg; i++) {
      plantC.reloadRemain = 0;
      expect(b.fire(plantC, z).hit).toBe(true);
    }
    expect(z.hp).toBe(0);
    b.tick(0.1);
    expect(b.zombies).toHaveLength(0);
  });

  it("击毙终局:接力各词全部记 success,击杀奖按第 5 幕发一次", () => {
    const b = newBattle([], {});
    b.sun = 200;
    const z = makeZombie(spec(["a", "b", "a"], ["forward", "forward", "reverse"]), 1, undefined, 500);
    b.zombies.push(z);
    z.hp = 0;
    z.phaseIdx = 2;
    b.tick(0.1);
    expect(b.zombies).toHaveLength(0);
    const os = b.getOutcomes().map((o) => o.wordId).sort();
    expect(os).toEqual(["a", "b"]); // getOutcomes 按词去重;同词多段只记一条
    for (const o of b.getOutcomes()) expect(o.success).toBe(true);
    expect(b.sun).toBeGreaterThan(200 + TUNING.killSunByAct[4] - 0.01); // 击杀奖发了一次
    expect(b.sun).toBeLessThan(200 + TUNING.killSunByAct[4] + 10); // tick 的阳光滴漏很有限,而非重复发奖
  });

  it("终局 boss 不啃植物,直接碾压走过", () => {
    const b = newBattle([], {});
    b.sun = 100;
    const plant = b.placePlant("a", 1)!;
    const z = makeZombie(spec(["a"], ["forward"]), 1, undefined, 250);
    b.zombies.push(z);
    b.tick(0.5);
    expect(b.plants).toContain(plant);
    expect(z.nibblingPlantId).toBeUndefined();
    expect(z.x).toBeLessThan(250);
  });

  it("终局到岸每口咬 20(ultimateSiegeDamage)", () => {
    const b = newBattle([], {});
    const z = makeZombie(spec(["a"], ["forward"]), 0, undefined, 5);
    b.zombies.push(z);
    b.baseHp = 100;
    b.tick(1);
    expect(b.baseHp).toBe(100 - TUNING.ultimateSiegeDamage);
  });
});

describe("Battle: 种植经济", () => {
  it("阳光充足可种,花费 30", () => {
    const b = newBattle([], {}, {});
    b.sun = 100;
    const p = b.placePlant("a", 0);
    expect(p).not.toBeNull();
    expect(b.sun).toBe(70);
  });
  it("阳光不足返回 null 不扣费", () => {
    const b = newBattle();
    b.sun = 10;
    expect(b.placePlant("a", 0)).toBeNull();
    expect(b.sun).toBe(10);
  });
  it("同 lane 同词可并存:两株独立、横向排开、各自装弹", () => {
    const b = newBattle();
    b.sun = 100;
    const p1 = b.placePlant("a", 0)!;
    expect(b.plants.length).toBe(1);
    const p2 = b.placePlant("a", 0)!;
    expect(b.plants.length).toBe(2); // 同词并存
    expect(p2).not.toBe(p1);
    expect(p1.cellX).toBe(0);
    expect(p2.cellX).toBe(1); // 同 lane 横向排开
    expect(b.sun).toBe(100 - TUNING.plantCostSun * 2);
    // 各自独立装弹:打一发只有这一株进入装弹
    const z = dormantZombie("a", 0);
    b.fire(p1, z);
    expect(p1.reloadRemain).toBeGreaterThan(0);
    expect(p2.reloadRemain).toBe(0);
  });
  it("同一 lane 同词最多 3 株,第 4 株被拒绝且不扣阳光", () => {
    const b = newBattle();
    b.sun = 100;
    b.placePlant("a", 0)!;
    b.placePlant("a", 0)!;
    b.placePlant("a", 0)!;
    expect(b.plants.length).toBe(3);
    const before = b.sun;
    expect(b.placePlant("a", 0)).toBeNull(); // 第 4 株拒绝
    expect(b.plants.length).toBe(3);
    expect(b.sun).toBe(before); // 未扣阳光
    // 其他 lane 不受影响,不同词也不受该上限约束
    b.sun = 200;
    b.placePlant("a", 1)!;
    expect(b.plants.length).toBe(4);
    expect(b.placePlant("b", 0)).not.toBeNull(); // 异词替换不受 3 株限制
    expect(b.plants.length).toBe(2);
  });
  it("同 lane 种不同词:自动替换旧株(不退款)", () => {
    let replaced: string[] = [];
    const b = newBattle([], { onReplace: (p) => replaced.push(p.wordId) });
    b.sun = 100;
    b.placePlant("a", 0)!;
    b.placePlant("b", 0)!;
    expect(b.plants.length).toBe(1);
    expect(b.plants[0].wordId).toBe("b");
    expect(replaced).toEqual(["a"]);
    expect(b.sun).toBe(100 - TUNING.plantCostSun * 2); // 替换不退还旧株阳光
  });
  it("某 lane 所有不同词株都被替换,同词株不动", () => {
    const b = newBattle();
    b.sun = 100;
    b.placePlant("a", 0)!;
    b.placePlant("a", 0)!; // 两株 a 并存
    b.placePlant("b", 0)!; // 替换掉 lane0 全部非 b 株
    expect(b.plants.length).toBe(1);
    expect(b.plants[0].wordId).toBe("b");
  });
  it("默认 label = 中文", () => {
    const b = newBattle();
    b.sun = 100;
    const p = b.placePlant("a", 0);
    expect(p?.labelText).toBe("苹果");
  });
  it("任意词株的 cellX 都按同 lane 现株数排开(不同词交互靠替换)…同词并存时错开", () => {
    const b = newBattle();
    b.sun = 100;
    const p1 = b.placePlant("a", 0)!;
    const p2 = b.placePlant("a", 0)!; // 同词并存
    expect(p1.cellX).toBe(0);
    expect(p2.cellX).toBe(1);
  });
  it("removePlant:移出并退还阳光,不影响其他株", () => {
    const b = newBattle();
    b.sun = 100;
    const p1 = b.placePlant("a", 0)!;
    b.placePlant("a", 0)!; // 同词并存,互不影响
    b.removePlant(p1);
    expect(b.plants.length).toBe(1);
    expect(b.plants[0].wordId).toBe("a");
    expect(b.sun).toBe(40 + TUNING.plantCostSun);
  });
});

describe("Battle: 手动点火", () => {
  it("跨 lane 射击:不可命中,且不算错配", () => {
    let mismatchFired = false;
    const b = newBattle([], { onMismatch: () => { mismatchFired = true; } });
    b.sun = 100;
    const plant = b.placePlant("a", 0)!;
    const z = dormantZombie("a", 2); // 不同 lane
    const res = b.fire(plant, z);
    expect(res.hit).toBe(false);
    expect(mismatchFired).toBe(false);
    expect(z.hp).toBe(2); // 未被错配强化
  });

  it("装弹未就绪不可发射", () => {
    const b = newBattle();
    b.sun = 100;
    const plant = b.placePlant("a", 0)!;
    const z = dormantZombie("a", 0);
    plant.reloadRemain = 1; // 未装好
    const res = b.fire(plant, z);
    expect(res.hit).toBe(false);
    expect(z.hp).toBe(2);
  });

  it("同词同方向匹配:命中扣血 + 阳光 + 连击", () => {
    const b = newBattle();
    b.sun = 100;
    const plant = b.placePlant("a", 0)!; // label 苹果
    const z = dormantZombie("a", 0, "forward");
    const res = b.fire(plant, z);
    expect(res.hit).toBe(true);
    expect(z.hp).toBe(1);
    expect(b.combo).toBe(1);
    expect(b.sun).toBe(100 - 30 + TUNING.sunHitBonus);
  });

  it("反向:植物标签应为外语", () => {
    const b = newBattle();
    b.sun = 100;
    const plant = b.placePlant("a", 0, "apple"); // 反向标签外语
    const z = dormantZombie("a", 0, "reverse");
    const res = b.fire(plant!, z);
    expect(res.hit).toBe(true);
  });

  it("错配(标签对但词不同/或同词错方向):哑火 + 僵尸强 + 连击清零", () => {
    const b = newBattle();
    b.sun = 100;
    const plant = b.placePlant("a", 0)!; // 苹果(期待正向=中文)
    const z = dormantZombie("b", 0, "reverse"); // 反向僵尸穿中文,期待外语 banana
    const res = b.fire(plant, z);
    expect(res.hit).toBe(false);
    expect(plant.jamming).toBe(true);
    expect(plant.rescueCooldown).toBe(3);
    expect(z.hp).toBe(3); // HP+1
    expect(z.speed).toBeGreaterThan(30); // 提速 1.25x
    expect(z.buffed).toBe(true);
    expect(b.combo).toBe(0);
    // 哑火需持续到救援冷却结束(不能下一帧就被清掉,否则视觉/惩罚都不会出现)
    b.lastAct = 9; // 防止空场被误判为胜利导致 tick 提前退出
    b.tick(1.0);
    expect(plant.jamming).toBe(true); // 1s 后仍哑火
    b.tick(1.0);
    expect(plant.jamming).toBe(true); // 2s 后仍哑火
    b.tick(1.0);
    expect(plant.jamming).toBe(false); // 3s 冷却结束,恢复
    expect(z.buffed).toBe(true); // 发怒僵尸保持
  });

  it("同 lane 多词:植物 b 打僵尸 b 命中,不会误伤僵尸 a", () => {
    const b = newBattle();
    b.sun = 100;
    const plantB = b.placePlant("b", 0)!; // 香蕉(expects forward=中文 香蕉)
    const za = dormantZombie("a", 0); // 同 lane 第一个僵尸是 a
    const zb = dormantZombie("b", 0);
    zb.x = za.x = 200; // 排在同一位
    const res = b.fire(plantB, zb); // 明确指定目标 = b
    expect(res.hit).toBe(true);
    expect(zb.hp).toBe(1); // b 被扣血
    expect(za.hp).toBe(2); // a 未被错配强化
    expect(za.buffed).toBe(false);
  });

  it("pickAutoTarget:点空地优先同 lane 匹配目标;无匹配则取最近任意僵尸", () => {
    const p = { id: "p", wordId: "a", labelText: "苹果", lane: 0, cellX: 0, reloadRemain: 0, jamming: false, rescueCooldown: 0 };
    // lane0: 正向 a(期待 苹果,匹配)+ 反向 a(期待 apple,不匹配);反向 a 更靠左(更近基地)
    const za = dormantZombie("a", 0); // forward → chinese 苹果
    const zaRev = dormantZombie("a", 0, "reverse"); // reverse → foreign apple
    za.x = 400;
    zaRev.x = 200;
    const target = pickAutoTarget([za, zaRev], 0, p, words());
    expect(target).toBe(za); // 匹配优先,即使 zaRev 更近
    // 只剩全部不匹配 → 选最近(x 最小)的任意僵尸
    const onlyMismatch = pickAutoTarget([zaRev], 0, p, words());
    expect(onlyMismatch).toBe(zaRev);
    // 其他 lane 的僵尸不参与
    const otherLane = dormantZombie("a", 2, "reverse");
    otherLane.x = 100;
    expect(pickAutoTarget([otherLane], 0, p, words())).toBeUndefined();
    // 死亡僵尸排除(到岸后仍可被瞄准,由存活守城僵尸单独用例覆盖)
    const dead = dormantZombie("a", 0);
    dead.hp = 0;
    dead.reachedBase = true;
    expect(pickAutoTarget([dead], 0, p, words())).toBeUndefined();
  });
});

describe("Battle: 标签与词双重校验", () => {
  it("同词但标签方向给错 → 错配(反向场景代理人)", () => {
    const b = newBattle();
    b.sun = 100;
    const plant = b.placePlant("a", 0, "apple"); // 反向想打正向僵尸
    const z = dormantZombie("a", 0, "forward"); // 正向期待 中文 apple→chinese 苹果
    const res = b.fire(plant!, z);
    expect(res.hit).toBe(false);
    expect(z.hp).toBe(3);
  });
});

describe("Battle: 胜负与结算", () => {
  it("击杀全部僵尸 → 胜利 + outcome(success, retries)", () => {
    const outcomes: EncounterOutcome[] = [];
    const b = newBattle(
      [{ wordId: "a", direction: "forward", teaching: false, boss: false }],
      { onKill: (o) => outcomes.push(o) },
      { spawnInterval: 0.1, maxAlive: 5 },
    );
    // 立即出怪
    b.tick(0.2);
    expect(b.zombies).toHaveLength(1);
    const z = b.zombies[0];
    b.sun = 100;
    const plant = b.placePlant("a", z.lane)!; // 苹果
    // 正向→匹配,2 血需 2 发(间隔装弹)
    let r1 = b.fire(plant, z);
    expect(r1.hit).toBe(true);
    expect(z.hp).toBe(1);
    b.tick(2); // 装弹恢复,僵尸接近
    let r2 = b.fire(plant, z);
    expect(r2.hit).toBe(true);
    expect(z.hp).toBe(0);
    b.tick(0.1); // 清尸+胜利判定
    expect(b.isOver()).toBe(true);
    expect(b.isVictory()).toBe(true);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].wordId).toBe("a");
    expect(outcomes[0].success).toBe(true);
    expect(outcomes[0].retries).toBe(0);
  });

  it("僵尸到达基地:扣基地血 + 记 success=false;基地扣光才失败", () => {
    const outcomes: EncounterOutcome[] = [];
    const b = newBattle(
      [{ wordId: "a", direction: "forward", teaching: false, boss: false }],
      { onKill: (o) => outcomes.push(o) },
      { spawnInterval: 0.1, maxAlive: 5 },
    );
    b.tick(0.2);
    const z = b.zombies[0];
    expect(z).toBeDefined();
    z.x = 1; // 逼近基地
    b.baseHp = 10; // 普通怪每口 6:一次到达不至于直接塌
    b.tick(1); // 到岸立即咬第一口(伤害 6)
    expect(b.baseHp).toBe(4);
    expect(b.isOver()).toBe(false); // 基地未沦陷,僵尸继续围城
    for (let i = 0; i < 20 && !b.isOver(); i++) b.tick(0.5); // 放任被啃:两口内塌
    expect(b.baseHp).toBeLessThanOrEqual(0);
    expect(b.isOver()).toBe(true);
    expect(b.isVictory()).toBe(false);
    expect(outcomes).toHaveLength(1); // 只到岸记一次失败(success=false)
    expect(outcomes[0].success).toBe(false);
  });

  it("错配计数累计进 retries", () => {
    const outcomes: EncounterOutcome[] = [];
    const b = newBattle(
      [{ wordId: "a", direction: "forward", teaching: false, boss: false }],
      { onKill: (o) => outcomes.push(o) },
      { spawnInterval: 0.1, maxAlive: 5 },
    );
    b.tick(0.2);
    const z = b.zombies[0];
    b.sun = 100;
    const wrongPlant = b.placePlant("b", z.lane)!; // 香蕉 vs 苹果正向 → 错配,同lane同词规则不影响跨境…
    b.fire(wrongPlant, z); // hp 2→3
    // 同 lane 同词唯一,换个 word 继续:
    const rightPlant = b.placePlant("a", z.lane)!; // 苹果
    expect(rightPlant).not.toBeNull();
    let res = b.fire(rightPlant, z); // hp 3→2
    expect(res.hit).toBe(true);
    b.tick(2); // 装弹;僵尸 x 从 500 → 500-37.5*2=425
    b.fire(rightPlant, z); // hp 2→1
    b.tick(2);
    b.fire(rightPlant, z); // hp 1→0
    b.tick(0.1);
    expect(b.isVictory()).toBe(true);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].retries).toBe(1);
  });

  it("击杀后再到基地:success 粘住为通过,retries 为最终累积错配", () => {
    const b = newBattle();
    const za = dormantZombie("a", 0);
    const zb = dormantZombie("b", 0);
    b.recordMismatchForWord("a"); // a 错配 1 次
    b.kill(za); // 击杀 → success true,retries 1
    expect(b.getOutcomes()).toHaveLength(1);
    expect(b.getOutcomes()[0]).toMatchObject({ wordId: "a", success: true, retries: 1 });
    b.recordZombieLost(zb); // 同词 b 又漏到基地 → success 不得被覆盖
    const o = b.getOutcomes().find((x) => x.wordId === "a");
    expect(o).toBeDefined();
    expect(o!.success).toBe(true);
  });
});

describe("僵尸啃食植物", () => {
  it("撞上植物停 2 秒啃食,植物消失后恢复前进", () => {
    let vored = 0;
    const b = newBattle([], { onVore: () => vored++ });
    b.sun = 100;
    const p = b.placePlant("a", 0)!; // 植物格 x=120
    const z = makeZombie({ wordId: "a", direction: "forward", teaching: false, boss: false }, 0, undefined, 130);
    b.zombies.push(z);
    b.tick(0.1); // 碰撞并进入啃食
    expect(z.nibblingPlantId).toBe(p.id);
    const xDuring = z.x;
    expect(b.plants).toContain(p);
    b.tick(1.9); // 接近 2s 仍啃、位置不动
    expect(b.plants).toContain(p);
    expect(z.x).toBe(xDuring);
    b.tick(0.2); // 超过 2s:植物被吃,僵尸恢复前进
    expect(b.plants).not.toContain(p);
    expect(vored).toBe(1);
    expect(z.nibblingPlantId).toBeUndefined();
    const x0 = z.x;
    b.tick(0.5);
    expect(z.x).toBeLessThan(x0);
  });

  it("啃食期间击毙僵尸:植物保下来", () => {
    let vored = 0;
    const b = newBattle([], { onVore: () => vored++ });
    b.sun = 100;
    const p = b.placePlant("a", 0)!;
    const z = makeZombie({ wordId: "a", direction: "forward", teaching: false, boss: false }, 0, undefined, 130);
    z.hp = 1;
    b.zombies.push(z);
    b.tick(0.1); // 开始啃食
    expect(z.nibblingPlantId).toBe(p.id);
    const res = b.fire(p, z); // 击毙(1 血)
    expect(res.hit).toBe(true);
    b.tick(0.1); // 清理死亡僵尸
    expect(b.zombies).not.toContain(z);
    expect(b.plants).toContain(p); // 植物幸存
    expect(vored).toBe(0);
  });

  it("同 lane 多株被依次啃食,每株 2 秒", () => {
    const b = newBattle();
    b.sun = 200;
    b.placePlant("a", 0)!; // cellX0 @120
    b.placePlant("a", 0)!; // cellX1 @180
    b.placePlant("a", 0)!; // cellX2 @240
    const z = makeZombie({ wordId: "a", direction: "forward", teaching: false, boss: false }, 0, undefined, 266); // 从右侧逼近 @240
    b.zombies.push(z);
    const advanceUntil = (pred: () => boolean, maxTicks = 800): number => {
      for (let i = 0; i < maxTicks; i++) {
        b.tick(0.1);
        if (pred()) return b.time;
      }
      throw new Error("timeout waiting for plants to shrink");
    };
    const t3to2 = advanceUntil(() => b.plants.length === 2);
    expect(t3to2).toBeGreaterThan(1.9); // 第一株被啃要 ~2s
    const t2to1 = advanceUntil(() => b.plants.length === 1);
    expect(t2to1 - t3to2).toBeGreaterThan(1.9); // 第二株同样 2s
    const t1to0 = advanceUntil(() => b.plants.length === 0);
    expect(t1to0 - t2to1).toBeGreaterThan(1.9); // 第三株 2s
    expect(z.nibblingPlantId).toBeUndefined();
  });
});

describe("僵尸攻城基地", () => {
  it("到岸僵尸不消失,每 ~2 秒咬一口基地", () => {
    const b = newBattle();
    const z = makeZombie({ wordId: "a", direction: "forward", teaching: false, boss: false }, 0, undefined, 5);
    b.zombies.push(z);
    b.tick(0.1); // 立刻到岸,并咬第一口
    expect(b.zombies).toContain(z); // 不再消失
    expect(b.baseHp).toBeLessThan(100);
    const afterFirst = b.baseHp;
    b.tick(1.9); // 距第一口约 1.9s:尚未到下一个咬击间隔
    expect(b.baseHp).toBe(afterFirst);
    b.tick(0.2); // 累计超过 2s:第二口
    expect(b.baseHp).toBeLessThan(afterFirst);
  });

  it("击退攻城僵尸后基地停止掉血", () => {
    const b = newBattle();
    b.sun = 100;
    const p = b.placePlant("a", 0)!;
    const z = makeZombie({ wordId: "a", direction: "forward", teaching: false, boss: false }, 0, undefined, 5);
    z.hp = 1;
    b.zombies.push(z);
    b.tick(0.1); // 到岸扣一口
    expect(z.reachedBase).toBe(true);
    const res = b.fire(p, z); // 射击攻城僵尸
    expect(res.hit).toBe(true);
    b.tick(0.1); // 清理退场
    expect(b.zombies).not.toContain(z);
    const after = b.baseHp;
    b.tick(2.5);
    expect(b.baseHp).toBe(after); // 不再被咬
  });

  it("基地被啃到 0:触发失败", () => {
    let defeated = 0;
    const b = newBattle([], { onDefeat: () => defeated++ });
    b.baseHp = 8; // 普通怪 6/2s,两口即塌
    const z = makeZombie({ wordId: "a", direction: "forward", teaching: false, boss: false }, 0, undefined, 20);
    b.zombies.push(z);
    for (let i = 0; i < 30 && !b.isOver(); i++) b.tick(0.5);
    expect(b.isOver()).toBe(true);
    expect(b.isVictory()).toBe(false);
    expect(defeated).toBe(1);
  });

  it("身体边缘碰到基地墙即停步攻城,而非中心点", () => {
    const b = newBattle([], {});
    const z = makeZombie({ wordId: "a", direction: "forward", teaching: false, boss: false }, 0, undefined, 8);
    b.zombies.push(z);
    // 中心(38)离墙还很远,但身体左缘(8+30-18=20)已贴到墙右缘 24 内
    expect(z.x + 30 - b.spriteRadius(z)).toBeLessThanOrEqual(24);
    expect(z.x).toBeGreaterThan(0); // 中心尚未过墙
    b.tick(0.01);
    expect(z.reachedBase).toBe(true);
    expect(z.x).toBeGreaterThan(-6); // 身体贴墙即停,中心不再深陷墙体
  });

  it("体型越大(头目)越早触墙:头目在中心更远处就停下攻城", () => {
    const b = newBattle([], {});
    const z = makeZombie({ wordId: "a", direction: "forward", teaching: false, boss: true }, 0, undefined, 30);
    b.zombies.push(z);
    // 头目半径 41.4:中心 60 时左缘 18.6 已触墙
    expect(z.x + 30 - b.spriteRadius(z)).toBeLessThanOrEqual(24);
    expect(z.x + 30).toBeGreaterThan(40); // 中心明显还在墙外
    b.tick(0.01);
    expect(z.reachedBase).toBe(true);
  });

  it("未触墙的僵尸继续前进(中心已近墙但身体未贴到)", () => {
    const b = newBattle([], {});
    const z = makeZombie({ wordId: "a", direction: "forward", teaching: false, boss: false }, 0, undefined, 60);
    expect(z.x + 30 - b.spriteRadius(z)).toBeGreaterThan(24);
    b.tick(0.1); // 走 6px,中心 84:左缘 66 仍未触墙
    expect(z.reachedBase).toBe(false);
  });

  it("到岸活僵尸同样可被手动瞄准(pickAutoTarget)", () => {
    const b = newBattle();
    const p = b.placePlant("a", 0)!;
    p.reloadRemain = 0;
    const sieger = dormantZombie("a", 0);
    sieger.reachedBase = true;
    expect(pickAutoTarget([sieger], 0, p, words())).toBe(sieger);
  });
});

describe("消灭僵尸的按幕阳光奖励", () => {
  it("Act1 击杀 +50,Act4 击杀 +200", () => {
    const b = newBattle();
    b.sun = 0;
    const z1 = makeZombie({ wordId: "a", direction: "forward", teaching: false, boss: false, act: 1 }, 0, undefined, 500);
    b.kill(z1);
    expect(b.sun).toBe(50);
    const z4 = makeZombie({ wordId: "b", direction: "forward", teaching: false, boss: false, act: 4 }, 0, undefined, 500);
    b.kill(z4);
    expect(b.sun).toBe(50 + 200);
  });

  it("实战击杀走 kill 结算:命中 +40 与按幕奖励一并入账", () => {
    const b = newBattle();
    b.sun = 100;
    const p = b.placePlant("a", 0)!; // -30 → 70
    const z = makeZombie({ wordId: "a", direction: "forward", teaching: false, boss: false, act: 3 }, 0, undefined, 500);
    z.hp = 1;
    b.zombies.push(z);
    b.fire(p, z); // hp→0,命中 +40 → 110
    const afterFire = b.sun;
    expect(afterFire).toBe(100 - TUNING.plantCostSun + TUNING.sunHitBonus);
    b.tick(0); // 清理死亡僵尸 → kill → Act3 奖励(滴漏 dt=0 不掺入)
    expect(b.sun).toBe(afterFire + TUNING.killSunByAct[2]);
  });
});

describe("第 5 幕终局冲击波(AOE 破阵)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  let b: Battle;

  /** 造一只存活终局 boss(speed=0 免得它走到基地触发攻城影响测试)。 */
  function liveUltimate(): Zombie {
    const z = makeZombie(
      { wordId: "a", direction: "forward", teaching: false, boss: true, act: 5, ultimate: true, cycle: [{ wordId: "a", direction: "forward" }] },
      2,
      undefined,
      400,
    );
    z.speed = 0;
    b.zombies.push(z);
    return z;
  }

  it("boss 存活期间按随机间隔发波,累计最多 3 次", () => {
    b = newBattle([], {});
    b.lastAct = 9; // 防空场误判胜利
    liveUltimate();
    const spy = vi.spyOn(b, "spawnShockwave");
    vi.spyOn(Math, "random").mockReturnValue(0); // 首波=FIRST_MIN,后续=INTERVAL_MIN 已定
    // 少量 t 连发三波
    b.tick(TUNING.shockFirstDelayMax + 0.1);
    expect(spy).toHaveBeenCalledTimes(1);
    b.tick(TUNING.shockIntervalMax);
    expect(spy).toHaveBeenCalledTimes(2);
    b.tick(TUNING.shockIntervalMax);
    expect(spy).toHaveBeenCalledTimes(3);
    // 已到 3 次上限:再长时间也不再触发
    b.tick(120);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("boss 阵亡 → 停止调度,已在场的波跑完消散", () => {
    b = newBattle([], {});
    b.lastAct = 9;
    const z = liveUltimate();
    const spy = vi.spyOn(b, "spawnShockwave");
    vi.spyOn(Math, "random").mockReturnValue(0);
    b.tick(TUNING.shockFirstDelayMax + 0.1); // 首波已发
    expect(spy).toHaveBeenCalledTimes(1);
    z.hp = 0; // 击杀 boss
    b.tick(1);
    b.tick(TUNING.shockIntervalMax * 4);
    expect(spy).toHaveBeenCalledTimes(1); // 不再发新波
    // 已发的波最终全部消散
    expect(b.shockwaves).toHaveLength(0);
  });

  it("波整列摧毁路径上全部植物:摧毁不退款,不伤僵尸/基地", () => {
    let hits: string[] = [];
    b = newBattle([], { onShockHit: (p) => hits.push(p.labelText) });
    b.lastAct = 9;
    b.sun = 300;
    b.placePlant("a", 0)!; // 120
    b.placePlant("a", 0)!; // 180
    b.placePlant("b", 1)!; // 120
    b.placePlant("b", 2)!; // 120
    const sunBefore = b.sun;
    const z = dormantZombie("a", 0);
    z.x = 250; // 波径上方有一只普通僵尸,不应受影响
    z.speed = 0; // 固定不走到基地,避免攻城伤及 baseHp 干扰断言
    b.zombies.push(z);
    const hpBefore = z.hp;
    const baseBefore = b.baseHp;
    b.spawnShockwave();
    // 光带从右缘以 shockSpeed 左移,反复推进直到越左缘消散
    let guard = 0;
    while (b.shockwaves.length > 0 && guard < 2000) {
      b.tick(1 / 60);
      guard++;
    }
    expect(b.plants).toHaveLength(0); // 四株全灭
    expect(hits).toHaveLength(4);
    // 摧毁不退款:期间仅阳光滴漏增加(sunBefore + 6/s × 耗时)
    expect(b.sun).toBeCloseTo(sunBefore + TUNING.sunDripPerSecond * (guard / 60), 5);
    expect(b.shockwaves).toHaveLength(0); // 消散
    expect(b.baseHp).toBe(baseBefore); // 不伤基地
    expect(z.hp).toBe(hpBefore); // 不伤僵尸
  });

  it("暂停(升级面板)时波停走;恢复后继续", () => {
    b = newBattle([], {});
    b.lastAct = 9;
    b.spawnShockwave();
    const x0 = b.shockwaves[0].x;
    b.paused = true;
    b.tick(1);
    expect(b.shockwaves[0].x).toBe(x0); // 冻结
    b.paused = false;
    b.tick(0.1);
    expect(b.shockwaves[0].x).toBeLessThan(x0); // 恢复推进
  });
});