import { describe, it, expect } from "vitest";
import {
  initWordStats,
  applyOutcome,
  commitOutcome,
  nextRung,
  prevRung,
  graduateBoss,
  isDue,
  buildDailyPlan,
  buildDailyChunks,
  ensureAct5,
  ensureChunks,
  countPlanWords,
  hashDirection,
  isStalePlan,
  PLAN_VERSION,
} from "../src/scheduler/planner";
import { TUNING, ACT_REVERSE_RATIO } from "../src/core/tuning";
import type { Word, WordStats, EncounterOutcome, DailyPlan } from "../src/core/model";

const LADDER = TUNING.intervalLadder; // [1,2,4,7,15,30]

function mk(id: string, introducedDay: number, history: WordStats["encounterHistory"]): WordStats {
  return {
    wordId: id,
    intervalRung: 0,
    threatIndex: 0,
    introducedDay,
    introducedBatch: 0,
    encounterHistory: history,
  };
}

function outcome(over: Partial<EncounterOutcome> = {}): EncounterOutcome {
  return { wordId: "w1", direction: "forward", retries: 0, success: true, ...over };
}

describe("planner: 间隔阶梯", () => {
  it("成功升档,封顶最后一档", () => {
    expect(nextRung(0)).toBe(1);
    expect(nextRung(2)).toBe(3);
    expect(nextRung(LADDER.length - 1)).toBe(LADDER.length - 1);
  });
  it("失败降档,保底 0", () => {
    expect(prevRung(1)).toBe(0);
    expect(prevRung(0)).toBe(0);
  });
  it("applyOutcome: 成功 → 升档 + 落账,威胁不变", () => {
    const s = initWordStats("w1", 1, 0);
    const r = applyOutcome(s, outcome({ success: true, retries: 0 }), 1, 1);
    expect(r.intervalRung).toBe(1);
    expect(r.threatIndex).toBe(0);
    expect(r.encounterHistory).toHaveLength(1);
  });
  it("applyOutcome: 失败 → 威胁+1 + 降档", () => {
    const s = { ...initWordStats("w1", 1, 0), intervalRung: 3 };
    const r = applyOutcome(s, outcome({ success: false }), 1, 1);
    expect(r.threatIndex).toBe(1);
    expect(r.intervalRung).toBe(2);
  });
});

describe("planner: 到期判定 isDue", () => {
  it("阶梯0(间隔1天):day+1 当天复习,大于才算到期", () => {
    const s = mk("w1", 1, [{ day: 5, act: 1, direction: "forward", retries: 0, success: true }]);
    expect(isDue(s, 6)).toBe(false); // 5+1=6 未超过
    expect(isDue(s, 7)).toBe(true); // >6 到期
  });
  it("无历史 → 永不到期(新词走教学)", () => {
    expect(isDue(initWordStats("w1", 1, 0), 999)).toBe(false);
  });
});

describe("planner: 当日计划生成", () => {
  const words: Word[] = Array.from({ length: 15 }, (_, i) => ({ id: `w${i + 1}`, foreign: `w${i + 1}`, chinese: `词${i + 1}` }));

  it("未学超 10 个时:新词取前 10 全进 Act1 纯教学;练习按 60/40 分派 Act2/3,恒 5 幕", () => {
    const map = new Map<string, WordStats>();
    const plan = buildDailyPlan(words, map, 1);
    expect(plan.newWords).toHaveLength(10);
    expect(plan.newWords[0]).toBe("w1");
    // 恒 5 幕(第 2~4 幕由 Act1 的新词借词填充;Act5 由 Act4 词接力);Act1 纯教学不翻倍
    expect(plan.acts).toHaveLength(5);
    expect(plan.acts[0].act).toBe(1);
    expect(plan.acts[0].zombies).toHaveLength(10);
    // Act1 纯教学:每词 1 只、正向、带提示,不再同幕反向复现
    for (const z of plan.acts[0].zombies) {
      expect(z.teaching).toBe(true);
      expect(z.direction).toBe("forward");
      expect(z.boss).toBe(false);
    }
    // 教学后的反向练习拆到 Act2/Act3:60%(6词)进 Act2,40%(4词)进 Act3,无提示
    const act2 = plan.acts.find((a) => a.act === 2)!;
    const act3 = plan.acts.find((a) => a.act === 3)!;
    const act2Recall = new Set(act2.zombies.filter((z) => !z.teaching && z.direction === "reverse").map((z) => z.wordId));
    const act3Recall = new Set(act3.zombies.filter((z) => !z.teaching && z.direction === "reverse").map((z) => z.wordId));
    for (const id of ["w1", "w2", "w3", "w4", "w5", "w6"]) expect(act2Recall.has(id)).toBe(true);
    for (const id of ["w7", "w8", "w9", "w10"]) expect(act3Recall.has(id)).toBe(true);
    expect(act3Recall.has("w6")).toBe(false); // 60/40 边界不重叠
    for (const a of plan.acts) expect(a.zombies.length).toBeGreaterThan(0);
  });

  it("无新词且无到期(全学完但都未到期):兜底取记忆最弱已学词,保证四幕非空", () => {
    const learned: Word[] = Array.from({ length: 6 }, (_, i) => ({ id: `l${i + 1}`, foreign: `l${i + 1}`, chinese: `词${i + 1}` }));
    const map = new Map<string, WordStats>();
    // 最近学习日在今天(day3),因此全部未到期
    for (let i = 1; i <= 6; i++) {
      map.set(`l${i}`, mk(`l${i}`, 1, [{ day: 3, act: 1, direction: "forward", retries: 0, success: true }]));
    }
    map.get("l1")!.intervalRung = 0; // 记忆最弱 → 兜底优先
    map.get("l2")!.intervalRung = 3;
    const plan = buildDailyPlan(learned, map, 3);
    expect(plan.newWords).toHaveLength(0);
    expect(plan.acts).toHaveLength(5);
    for (const a of plan.acts) expect(a.zombies.length).toBeGreaterThan(0);
    // 兜底词来自已学词;第 1 轮 teaching=true 复用复习
    const half = plan.acts[0].zombies.length / TUNING.actRepeatRounds[0];
    for (const z of plan.acts[0].zombies.slice(0, half)) {
      expect(z.teaching).toBe(true);
      expect(map.has(z.wordId)).toBe(true);
    }
  });

  it("复习池按难度打分对半均分:较易进 Act2,较难进 Act3", () => {
    const map = new Map<string, WordStats>();
    // w1-w3: 已学,day1 之后第7天到期(阶梯0 间隔1)
    for (let i = 1; i <= 3; i++) {
      map.set(`w${i}`, mk(`w${i}`, 1, [{ day: 1, act: 1, direction: "forward", retries: 0, success: true }]));
    }
    // w4: urgent(最近一次失败),也要到期(day7 > day1+1)
    map.set("w4", mk("w4", 0, [
      { day: 1, act: 1, direction: "forward", retries: 1, success: false },
    ]));
    // w5: 长间隔(阶梯4 间隔15),仅第二天不到期……这里用 day30
    map.set("w5", {
      ...mk("w5", 0, [{ day: 1, act: 1, direction: "forward", retries: 0, success: true }]),
      intervalRung: 4,
    });

    // 仅传 w1-w5(其余 w6-w15 未学属新词,会生成练习词干扰本次均分断言)
    const plan = buildDailyPlan(words.slice(0, 5), map, 7);
    // 复习池 = [w1..w4](w5 未到期),难度排序 [w1,w2,w3](score1)+[w4](score3);
    // 对半均分:act2=[w1,w2], act3=[w3,w4](每词 2 只)
    expect(plan.acts.find((a) => a.act === 2)?.zombies.map((z) => z.wordId).sort()).toEqual(["w1", "w1", "w2", "w2"]);
    const act3 = plan.acts.find((a) => a.act === 3)?.zombies.map((z) => z.wordId) ?? [];
    expect(act3).toContain("w3");
    expect(act3).toContain("w4"); // urgent 落较难一半
    expect(act3).not.toContain("w5");
  });

  it("五幕数量更均匀:纯到期复习时 Act2/3 词数均分且相等", () => {
    const dueWords: Word[] = Array.from({ length: 10 }, (_, i) => ({ id: `d${i + 1}`, foreign: `d${i + 1}`, chinese: `词${i + 1}` }));
    const map = new Map<string, WordStats>();
    for (let i = 1; i <= 10; i++) {
      map.set(`d${i}`, mk(`d${i}`, 1, [{ day: 1, act: 1, direction: "forward", retries: 0, success: true }]));
    }
    const plan = buildDailyPlan(dueWords, map, 4); // day4 > day1+1 全部到期
    const act2 = plan.acts.find((a) => a.act === 2)!;
    const act3 = plan.acts.find((a) => a.act === 3)!;
    expect(act2.zombies).toHaveLength(10); // 5 词 × 2 轮
    expect(act3.zombies).toHaveLength(10);
    expect(new Set(act2.zombies.map((z) => z.wordId)).size).toBe(5);
    expect(new Set(act3.zombies.map((z) => z.wordId)).size).toBe(5);
  });

  it("难度渐进:Act3 中较难词(urgent)全部排较易词之后", () => {
    const map = new Map<string, WordStats>();
    for (let i = 1; i <= 4; i++) {
      map.set(`e${i}`, mk(`e${i}`, 1, [{ day: 1, act: 1, direction: "forward", retries: 0, success: true }]));
    }
    map.set("u1", mk("u1", 0, [{ day: 1, act: 1, direction: "forward", retries: 1, success: false }]));
    map.set("u2", mk("u2", 0, [{ day: 1, act: 1, direction: "forward", retries: 2, success: false }]));
    const w: Word[] = [
      ...Array.from({ length: 4 }, (_, i) => ({ id: `e${i + 1}`, foreign: `e${i + 1}`, chinese: `词${i + 1}` })),
      { id: "u1", foreign: "u1", chinese: "U1" },
      { id: "u2", foreign: "u2", chinese: "U2" },
    ];
    const plan = buildDailyPlan(w, map, 4);
    const act2Set = new Set(plan.acts.find((a) => a.act === 2)?.zombies.map((z) => z.wordId) ?? []);
    const act3Set = new Set(plan.acts.find((a) => a.act === 3)?.zombies.map((z) => z.wordId) ?? []);
    // 难度升序 [e1..e4](1) [u1,u2](3) 对半:act2 全易,act3 收尾含 u1/u2
    expect(act2Set.has("u1")).toBe(false);
    expect(act2Set.has("u2")).toBe(false);
    expect(act3Set.has("u1")).toBe(true);
    expect(act3Set.has("u2")).toBe(true);
    expect(act3Set.has("e4")).toBe(true);
  });

  it("Boss:取 threatIndex 最高 1~3 词,且必须有过 encounter", () => {
    const map = new Map<string, WordStats>();
    map.set("h", { ...mk("h", 0, [{ day: 1, act: 1, direction: "forward", retries: 0, success: false }]), threatIndex: 5 });
    map.set("m", { ...mk("m", 0, [{ day: 1, act: 1, direction: "forward", retries: 0, success: false }]), threatIndex: 3 });
    map.set("l", { ...mk("l", 0, [{ day: 1, act: 1, direction: "forward", retries: 0, success: false }]), threatIndex: 1 });
    map.set("noHis", { ...initWordStats("noHis", 0, 0), threatIndex: 9 }); // 无 encounter,不得提名
    const bossWords: Word[] = [
      { id: "h", foreign: "h", chinese: "H" },
      { id: "m", foreign: "m", chinese: "M" },
      { id: "l", foreign: "l", chinese: "L" },
      { id: "noHis", foreign: "nh", chinese: "NH" },
    ];
    const plan = buildDailyPlan(bossWords, map, 8);
    const bossIds = plan.bossCandidates;
    expect(bossIds).toEqual(["h", "m", "l"]); // 按威胁降序
    expect(bossIds).not.toContain("noHis");
    const act4 = plan.acts.find((a) => a.act === 4);
    expect(act4?.zombies.map((z) => z.wordId)).toEqual(["h", "m", "l"]);
    for (const z of act4?.zombies ?? []) expect(z.boss).toBe(true);
  });

  it("graduateBoss:威胁清零 + 升档", () => {
    const s = { ...mk("w", 0, [{ day: 1, act: 1, direction: "forward", retries: 0, success: true }]), threatIndex: 3, intervalRung: 1 };
    const r = graduateBoss(s);
    expect(r.threatIndex).toBe(0);
    expect(r.intervalRung).toBe(2);
  });
});

describe("planner: 终局 Act5(恒 5 幕接力 boss)", () => {
  it("词表非空 → 恒第 5 幕单只 ultimate,cycle=Act4 最终词次序打乱,方向沿用", () => {
    const map = new Map<string, WordStats>();
    map.set("h1", { ...mk("h1", 0, [{ day: 1, act: 4, direction: "forward", retries: 0, success: false }]), threatIndex: 3 });
    map.set("h2", { ...mk("h2", 0, [{ day: 1, act: 4, direction: "forward", retries: 0, success: false }]), threatIndex: 2 });
    map.set("h3", { ...mk("h3", 0, [{ day: 1, act: 4, direction: "forward", retries: 0, success: false }]), threatIndex: 1 });
    const words: Word[] = [
      { id: "h1", foreign: "h1", chinese: "头1" },
      { id: "h2", foreign: "h2", chinese: "头2" },
      { id: "h3", foreign: "h3", chinese: "头3" },
    ];
    const plan = buildDailyPlan(words, map, 8);
    expect(plan.acts).toHaveLength(5);
    const act5 = plan.acts[4];
    expect(act5.act).toBe(5);
    expect(act5.zombies).toHaveLength(1);
    const boss = act5.zombies[0];
    expect(boss.ultimate).toBe(true);
    expect(boss.boss).toBe(true);
    expect(boss.act).toBe(5);
    expect(boss.cycle).toBeDefined();
    // cycle 词集合 == Act4 最终词集合(≤3),出场顺序是其排列;首段即当前 wordId
    const act4 = plan.acts.find((a) => a.act === 4)!;
    const act4Words = new Set(act4.zombies.map((z) => z.wordId));
    expect(act4Words.size).toBeLessThanOrEqual(3);
    const cycWords = new Set(boss.cycle!.map((c) => c.wordId));
    expect(cycWords.size).toBe(act4Words.size);
    for (const w of act4Words) expect(cycWords.has(w)).toBe(true);
    expect(boss.cycle![0].wordId).toBe(boss.wordId);
    const act4Dir = new Map(act4.zombies.map((z) => [z.wordId, z.direction]));
    for (const c of boss.cycle!) expect(c.direction).toBe(act4Dir.get(c.wordId));
  });

  it("cycle 取全网 Top3 最难,可与 Act4 头目词不同", () => {
    // q1/q2:urgent(上次失败,难度3)但不是威胁词 → 不提名头目
    // b1:威胁高 → 提名头目,但上次成功(rung低,难度1)
    const map = new Map<string, WordStats>();
    map.set("q1", mk("q1", 0, [{ day: 1, act: 3, direction: "forward", retries: 1, success: false }]));
    map.set("q2", mk("q2", 0, [{ day: 1, act: 3, direction: "forward", retries: 2, success: false }]));
    map.set("b1", { ...mk("b1", 0, [{ day: 1, act: 4, direction: "forward", retries: 0, success: true }]), threatIndex: 5 });
    const words: Word[] = [
      { id: "q1", foreign: "q1", chinese: "困1" },
      { id: "q2", foreign: "q2", chinese: "困2" },
      { id: "b1", foreign: "b1", chinese: "头1" },
    ];
    const plan = buildDailyPlan(words, map, 7);
    const act4 = plan.acts.find((a) => a.act === 4)!;
    expect(act4.zombies.map((z) => z.wordId)).toEqual(["b1"]); // 头目只有 b1
    const boss = plan.acts.find((a) => a.act === 5)!.zombies[0];
    const cycWords = new Set(boss.cycle!.map((c) => c.wordId));
    // 全网 Top3 最难 = [q1,q2](上次失败) + [b1] → 与 Act4 头目不同,更尖的错词进终局
    expect(cycWords.has("q1")).toBe(true);
    expect(cycWords.has("q2")).toBe(true);
    expect(cycWords.has("b1")).toBe(true);
    expect(boss.cycle!.length).toBe(3);
  });

  it("空词库 → 仅空壳 4 幕,不生成 Act5", () => {
    const plan = buildDailyPlan([], new Map(), 1);
    expect(plan.acts.some((a) => a.act === 5)).toBe(false);
    for (const a of plan.acts) expect(a.zombies).toHaveLength(0);
  });

  it("ensureAct5:旧 4 幕快照计划 → 补出第 5 幕(cycle=Act4 词,首段即当前 wordId)", () => {
    const oldPlan: DailyPlan = {
      day: 3,
      newWords: [],
      acts: [
        { act: 1, zombies: [{ wordId: "a", direction: "forward", teaching: true, boss: false, act: 1 }] },
        { act: 2, zombies: [] },
        { act: 3, zombies: [] },
        {
          act: 4,
          zombies: [
            { wordId: "h1", direction: "reverse", teaching: false, boss: true, act: 4 },
            { wordId: "h2", direction: "forward", teaching: false, boss: true, act: 4 },
            { wordId: "h1", direction: "forward", teaching: false, boss: true, act: 4 },
          ],
        },
      ],
      bossCandidates: ["h1", "h2"],
    };
    const plan = ensureAct5(oldPlan);
    expect(plan.acts).toHaveLength(5);
    const act5 = plan.acts[4];
    expect(act5.act).toBe(5);
    expect(act5.zombies).toHaveLength(1);
    const boss = act5.zombies[0];
    expect(boss.ultimate).toBe(true);
    const cycWords = new Set(boss.cycle!.map((c) => c.wordId));
    expect(cycWords).toEqual(new Set(["h1", "h2"])); // 去重
    expect(boss.cycle![0].wordId).toBe(boss.wordId);
    // 方向沿用 Act4 首次出现方向(reverse/forward)
    expect(boss.cycle!.find((c) => c.wordId === "h1")!.direction).toBe("reverse");
    expect(boss.cycle!.find((c) => c.wordId === "h2")!.direction).toBe("forward");
  });

  it("ensureAct5:已含 Act5 的计划原样返回(幂等)", () => {
    const fresh = buildDailyPlan(
      [
        { id: "h1", foreign: "h1", chinese: "头1" },
        { id: "h2", foreign: "h2", chinese: "头2" },
      ],
      new Map([
        ["h1", { ...mk("h1", 0, [{ day: 1, act: 4, direction: "forward", retries: 0, success: false }]), threatIndex: 2 }],
        ["h2", { ...mk("h2", 0, [{ day: 1, act: 4, direction: "forward", retries: 0, success: false }]), threatIndex: 1 }],
      ]),
      8,
    );
    expect(fresh.acts.some((a) => a.act === 5)).toBe(true);
    expect(ensureAct5(fresh)).toBe(fresh);
  });

  it("ensureAct5:Act4 为空的 4 幕计划 → 不补 Act5", () => {
    const empty4: DailyPlan = {
      day: 1,
      newWords: [],
      acts: [
        { act: 1, zombies: [{ wordId: "a", direction: "forward", teaching: true, boss: false, act: 1 }] },
        { act: 2, zombies: [] },
        { act: 3, zombies: [] },
        { act: 4, zombies: [] },
      ],
      bossCandidates: [],
    };
    expect(ensureAct5(empty4)).toBe(empty4);
  });
});

describe("planner: hashDirection 各幕反向占比", () => {
  it("Act1 恒正向(reverseRatio=0)", () => {
    for (let i = 0; i < 300; i++) {
      expect(hashDirection(`id-${i}`, 1)).toBe("forward");
    }
  });
  it("Act2 反向占比约 20%", () => {
    const n = 2000;
    let rev = 0;
    for (let i = 0; i < n; i++) if (hashDirection(`id-${i}`, 2) === "reverse") rev++;
    const ratio = rev / n;
    expect(ratio).toBeGreaterThan(0.15);
    expect(ratio).toBeLessThan(0.25);
    expect(ratio).toBeCloseTo(ACT_REVERSE_RATIO[1], 1);
  });
  it("稳定:同一 id+act 方向不变", () => {
    const a = hashDirection("stable-1", 3);
    const b = hashDirection("stable-1", 3);
    expect(a).toBe(b);
  });
});
describe("planner: 恒五幕非空(修复从 Act3 开局)", () => {
  const words: Word[] = Array.from({ length: 12 }, (_, i) => ({ id: `w${i + 1}`, foreign: `w${i + 1}`, chinese: `词${i + 1}` }));

  it("全为未学新词:Act1 纯教学,练习 60/40 进 Act2/3,恒 5 幕", () => {
    const map = new Map<string, WordStats>();
    const plan = buildDailyPlan(words, map, 1);
    expect(plan.acts).toHaveLength(5);
    for (const a of plan.acts) expect(a.zombies.length).toBeGreaterThan(0);
    // Act1 纯教学:每新词 1 只正向带提示(不再同幕反向复现)
    for (const z of plan.acts[0].zombies) {
      expect(z.teaching).toBe(true);
      expect(z.direction).toBe("forward");
      expect(map.has(z.wordId)).toBe(false);
    }
    // 复习词按幕轮数:(无到期时)借词入 Act2/3 仍翻倍,练习副本各 1 只
    // 教学后的反向练习按 60/40 分派:Act2 收 6 词、Act3 收 4 词,无提示
    const act2 = plan.acts.find((a) => a.act === 2)!;
    const act3 = plan.acts.find((a) => a.act === 3)!;
    const act2Recall = new Set(act2.zombies.filter((z) => !z.teaching && z.direction === "reverse").map((z) => z.wordId));
    const act3Recall = new Set(act3.zombies.filter((z) => !z.teaching && z.direction === "reverse").map((z) => z.wordId));
    for (const id of ["w1", "w2", "w3", "w4", "w5", "w6"]) expect(act2Recall.has(id)).toBe(true);
    for (const id of ["w7", "w8", "w9", "w10"]) expect(act3Recall.has(id)).toBe(true);
    expect(act3Recall.has("w6")).toBe(false); // 60/40 边界不重叠
    // 借词到 Act2+ 不再带答案提示(复测不显示头顶中文)
    for (const a of plan.acts.slice(1)) {
      for (const z of a.zombies) expect(z.teaching).toBe(false);
    }
  });

  it("全部已学且无到期:兜底填空,首幕也是实心复习(teaching 复用)", () => {
    const learned: Word[] = Array.from({ length: 8 }, (_, i) => ({ id: `l${i + 1}`, foreign: `l${i + 1}`, chinese: `词${i + 1}` }));
    const map = new Map<string, WordStats>();
    for (let i = 1; i <= 8; i++) {
      map.set(`l${i}`, mk(`l${i}`, 1, [{ day: 9, act: 2, direction: "forward", retries: 0, success: true }]));
    }
    const plan = buildDailyPlan(learned, map, 9);
    expect(plan.newWords).toHaveLength(0);
    expect(plan.acts).toHaveLength(5);
    for (const a of plan.acts) expect(a.zombies.length).toBeGreaterThan(0);
  });
});

describe("planner: 幕内词重复 ×2(Act1–3)", () => {
  const map = new Map<string, WordStats>();
  for (let i = 1; i <= 3; i++) {
    map.set(`h${i}`, { ...mk(`h${i}`, 0, [{ day: 1, act: 1, direction: "forward", retries: 0, success: false }]), threatIndex: i });
  }
  const review = Array.from({ length: 6 }, (_, i) => ({ id: `r${i + 1}`, foreign: `r${i + 1}`, chinese: `词${i + 1}` }));
  for (const w of review) {
    map.set(w.id, mk(w.id, 1, [{ day: 1, act: 1, direction: "forward", retries: 0, success: true }]));
  }
  const words: Word[] = [...review, ...Array.from({ length: 3 }, (_, i) => ({ id: `h${i + 1}`, foreign: `h${i + 1}`, chinese: `头目${i + 1}` }))];

  it("第 2 轮方向与第 1 轮相反,teaching 全关;第 1 轮保持原样", () => {
    const plan = buildDailyPlan(words, map, 7);
    for (const a of plan.acts) {
      if (a.act === 4 || TUNING.actRepeatRounds[a.act - 1] <= 1) continue; // 头目幕/终局幕单只
      const half = a.zombies.length / TUNING.actRepeatRounds[a.act - 1];
      for (let i = 0; i < half; i++) {
        expect(a.zombies[i].wordId).toBe(a.zombies[i + half].wordId); // 同词两只
        expect(a.zombies[i + half].direction).not.toBe(a.zombies[i].direction); // 反向
        expect(a.zombies[i + half].teaching).toBe(false); // 第 2 轮不给提示
      }
    }
  });

  it("头目幕不翻倍:每词单只,且与 bossCandidates 一一对应", () => {
    const plan = buildDailyPlan(words, map, 7);
    const act4 = plan.acts.find((a) => a.act === 4)!;
    expect(act4.zombies.map((z) => z.wordId).sort()).toEqual(plan.bossCandidates.slice().sort());
    const ids = act4.zombies.map((z) => z.wordId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const z of act4.zombies) expect(z.boss).toBe(true);
  });
});

describe("planner: 当日快照单条结记 commitOutcome", () => {
  it("同日先败后胜:只保留一条成功记录,历史不膨胀", () => {
    const day = 1;
    let s: WordStats = { ...initWordStats("w1", day, 0), intervalRung: 3 };
    s = commitOutcome(s, outcome({ success: false }), day, 1); // 败:threat+1,rung 2
    expect(s.threatIndex).toBe(1);
    expect(s.intervalRung).toBe(2);
    expect(s.encounterHistory).toHaveLength(1);
    s = commitOutcome(s, outcome({ success: true }), day, 1); // 当日再胜:覆盖同一条
    expect(s.encounterHistory).toHaveLength(1); // 仍一条
    expect(s.encounterHistory[0].success).toBe(true);
    expect(s.encounterHistory[0].day).toBe(day);
    // 回滚败(rung 2→3,threat 1→0)再套胜(rung 3→4):终态=直接胜一次的等价账目
    expect(s.threatIndex).toBe(0);
    expect(s.intervalRung).toBe(4);
  });

  it("同日多次失败:threatIndex 不叠加,同词当日唯一,终态等价只失败一次", () => {
    const s0 = { ...initWordStats("w1", 1, 0), intervalRung: 2 };
    let s = s0;
    for (let i = 0; i < 3; i++) s = commitOutcome(s, outcome({ success: false }), 1, 1);
    const once = applyOutcome(s0, outcome({ success: false }), 1, 1);
    expect(s.threatIndex).toBe(once.threatIndex); // 1,不是 3
    expect(s.intervalRung).toBe(once.intervalRung); // 1,与只失败一次相同
    expect(s.encounterHistory.filter((e) => e.day === 1)).toHaveLength(1);
  });

  it("「败→再胜」与「直接胜」终态一致(第一次从未发生)", () => {
    const base = { ...initWordStats("w1", 1, 0), intervalRung: 1, threatIndex: 2 };
    const twoStep = commitOutcome(commitOutcome(base, outcome({ success: false }), 1, 2), outcome({ success: true, retries: 1 }), 1, 2);
    const direct = applyOutcome(base, outcome({ success: true, retries: 1 }), 1, 2);
    expect(twoStep.intervalRung).toBe(direct.intervalRung);
    expect(twoStep.threatIndex).toBe(direct.threatIndex);
    expect(twoStep.encounterHistory).toEqual(direct.encounterHistory);
  });

  it("跨日多条各自保留,互不回滚", () => {
    const base = { ...initWordStats("w1", 1, 0), intervalRung: 1 };
    const d1 = commitOutcome(base, outcome({ success: false }), 1, 2); // 败
    const d2 = commitOutcome(d1, outcome({ success: true }), 2, 2); // 次日胜
    expect(d2.encounterHistory).toHaveLength(2);
    expect(d2.encounterHistory[0]).toMatchObject({ day: 1, success: false });
    expect(d2.encounterHistory[1]).toMatchObject({ day: 2, success: true });
    expect(d2.threatIndex).toBe(1); // 次日记录不受当日(次日)重复影响前,第1天威胁保留
  });
});

describe("planner: 每日分块 buildDailyChunks(一局=一块,≤sessionWordCap 词)", () => {
  function learnedDue(n: number, day = 0): Word[] {
    return Array.from({ length: n }, (_, i) => ({ id: `r${i + 1}`, foreign: `r${i + 1}`, chinese: `词${i + 1}` }));
  }
  function mapDue(ids: string[], rung = 0) {
    const map = new Map<string, WordStats>();
    for (const id of ids) {
      map.set(id, { ...mk(id, 1, [{ day: 0, act: 1, direction: "forward", retries: 0, success: true }]), intervalRung: rung });
    }
    return map;
  }
  function distinct(plan: DailyPlan): string[] {
    const ids = new Set<string>();
    for (const a of plan.acts) for (const z of a.zombies) ids.add(z.wordId);
    return [...ids];
  }

  it("40 候选(5 新 + 35 到期)-> 3 块 [15,15,10];词不重不漏;新词落第 1 块", () => {
    const newWords: Word[] = Array.from({ length: 5 }, (_, i) => ({ id: `n${i + 1}`, foreign: `n${i + 1}`, chinese: `新${i + 1}` }));
    const due = learnedDue(35);
    const words = [...newWords, ...due];
    const map = mapDue(due.map((w) => w.id));
    const plans = buildDailyChunks(words, map, 2, 15);
    expect(plans.map((p) => p.newWords)).toEqual([["n1", "n2", "n3", "n4", "n5"], [], []]);
    const flat: string[] = [];
    for (const p of plans) {
      flat.push(...distinct(p));
      expect(p.acts.some((a) => a.act === 5)).toBe(true); // 每块恒 5 幕
    }
    expect(flat.length).toBe(40);
    expect(new Set(flat).size).toBe(40); // 无重叠
    for (const w of words.map((x) => x.id)) expect(flat).toContain(w); // 无遗漏
    // 块 0 的教学词 = 全部新词(教学局前置);仅第 1 轮(前半)为教学
    const first = plans[0].acts[0].zombies.slice(0, plans[0].acts[0].zombies.length / TUNING.actRepeatRounds[0]);
    expect(first.map((z) => z.wordId).sort()).toEqual(["n1", "n2", "n3", "n4", "n5"]);
    for (const z of first) expect(z.teaching).toBe(true);
  });

  it("候选不足上限 → 单块;countPlanWords 与块内去重词数一致", () => {
    const due = learnedDue(8);
    const map = mapDue(due.map((w) => w.id));
    const plans = buildDailyChunks(due, map, 3, 15);
    expect(plans).toHaveLength(1);
    expect(countPlanWords(plans[0])).toBe(8);
  });

  it("全部已学且未到期(空候选)→ 仍产一块兜底实心复习,恒 5 幕", () => {
    const learned = learnedDue(6);
    const map = mapDue(learned.map((w) => w.id), 5); // rung 5 → 间隔 30 天,未到期
    const plans = buildDailyChunks(learned, map, 2, 15);
    expect(plans).toHaveLength(1);
    expect(plans[0].acts.some((a) => a.act === 5)).toBe(true);
    for (const a of plans[0].acts) expect(a.zombies.length).toBeGreaterThan(0);
  });

  it("空词表 → 无计划输出", () => {
    expect(buildDailyChunks([], new Map(), 1, 15)).toEqual([]);
  });
});

describe("planner: ensureChunks 快照迁移(单 plan → plans[]+played)", () => {
  it("单 plan 旧快照 → plans=[plan], played=0,并补 Act5(4 幕旧档)", () => {
    const oldPlan: DailyPlan = {
      day: 3,
      newWords: [],
      acts: [
        { act: 1, zombies: [{ wordId: "a", direction: "forward", teaching: true, boss: false, act: 1 }] },
        { act: 2, zombies: [] },
        { act: 3, zombies: [{ wordId: "b", direction: "forward", teaching: false, boss: false, act: 3 }] },
        { act: 4, zombies: [{ wordId: "h", direction: "reverse", teaching: false, boss: true, act: 4 }] },
      ],
      bossCandidates: ["h"],
    };
    const snap = ensureChunks({ day: 3, plan: oldPlan, stats: [] } as never);
    expect(snap.played).toBe(0);
    expect(snap.plans).toHaveLength(1);
    expect(snap.plans[0].acts).toHaveLength(5); // ensureAct5 已补齐终局幕
    expect(snap.plans[0].acts[4].act).toBe(5);
    expect(snap.stats).toEqual([]);
  });

  it("已是新结构 → 原样返回(幂等,不重置 played)", () => {
    const snap = { day: 4, plans: [{ day: 4, newWords: [], acts: [], bossCandidates: [] }], played: 2, stats: [{ wordId: "x", intervalRung: 0, threatIndex: 0, introducedDay: 1, introducedBatch: 0, encounterHistory: [] }] };
    expect(ensureChunks(snap)).toBe(snap);
  });
});

describe("planner: PLAN_VERSION / isStalePlan(计划语义版本)", () => {
  const mkSnap = (planVersion?: number) => ({ day: 1, planVersion, plans: [{ day: 1, newWords: [], acts: [], bossCandidates: [] }], played: 0, stats: [] });

  it("缺版本号(旧档)→ 陈旧,需重建", () => {
    expect(isStalePlan(mkSnap())).toBe(true);
  });

  it("版本号低于当前 → 陈旧", () => {
    expect(isStalePlan(mkSnap(PLAN_VERSION - 1))).toBe(true);
  });

  it("等于当前版本 → 不陈旧", () => {
    expect(isStalePlan(mkSnap(PLAN_VERSION))).toBe(false);
  });

  it("后续版本 → 不陈旧(向前兼容)", () => {
    expect(isStalePlan(mkSnap(PLAN_VERSION + 1))).toBe(false);
  });
});
