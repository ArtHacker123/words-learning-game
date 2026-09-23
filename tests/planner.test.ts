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
  ensureAct5,
  hashDirection,
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

  it("未学超 10 个时:新词取前 10 全进 Act1;空幕由已学词兜底,恒 5 幕", () => {
    const map = new Map<string, WordStats>();
    const plan = buildDailyPlan(words, map, 1);
    expect(plan.newWords).toHaveLength(10);
    expect(plan.newWords[0]).toBe("w1");
    // 恒 5 幕(第 2~4 幕由 Act1 的新词借词填充;Act5 由 Act4 词接力);Act1-3 每词重复 2 只
    expect(plan.acts).toHaveLength(5);
    expect(plan.acts[0].act).toBe(1);
    expect(plan.acts[0].zombies).toHaveLength(20);
    // 第 1 轮:教学正向(带提示);第 2 轮:反向复现、不再给提示
    for (const z of plan.acts[0].zombies.slice(0, 10)) {
      expect(z.teaching).toBe(true);
      expect(z.direction).toBe("forward");
      expect(z.boss).toBe(false);
    }
    for (const z of plan.acts[0].zombies.slice(10)) {
      expect(z.teaching).toBe(false);
      expect(z.direction).toBe("reverse");
      expect(z.boss).toBe(false);
    }
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

  it("已学 ≤1档到期词进 Act2,urgent/长间隔词进 Act3", () => {
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

    const plan = buildDailyPlan(words, map, 7);
    // w1-w3 到期,rung0<=1 且非 urgent → Act2(每词 2 只)
    expect(plan.acts.find((a) => a.act === 2)?.zombies.map((z) => z.wordId).sort()).toEqual(["w1", "w1", "w2", "w2", "w3", "w3"]);
    // w4 urgent → Act3; w5 阶梯4 长间隔但 day7 未到期(1+15=16),不入任何复习
    const act3 = plan.acts.find((a) => a.act === 3)?.zombies.map((z) => z.wordId) ?? [];
    expect(act3).toContain("w4");
    expect(act3).not.toContain("w5");
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

  it("全为未学新词:Act1 满,其余幕从新词借词,每词按幕重复轮数、恒 5 幕", () => {
    const map = new Map<string, WordStats>();
    const plan = buildDailyPlan(words, map, 1);
    expect(plan.acts).toHaveLength(5);
    for (const a of plan.acts) expect(a.zombies.length).toBeGreaterThan(0);
    // 各幕每词恰好出现 actRepeatRounds 次(Act1-3 各 2 次,Act4 头目 1 次)
    for (const a of plan.acts) {
      const counts = new Map<string, number>();
      for (const z of a.zombies) counts.set(z.wordId, (counts.get(z.wordId) ?? 0) + 1);
      for (const c of counts.values()) expect(c).toBe(TUNING.actRepeatRounds[a.act - 1]);
    }
    // 首幕第 1 轮教学词为新词且正向
    const r1 = plan.acts[0].zombies.slice(0, plan.acts[0].zombies.length / TUNING.actRepeatRounds[0]);
    for (const z of r1) {
      expect(z.teaching).toBe(true);
      expect(z.direction).toBe("forward");
      expect(map.has(z.wordId)).toBe(false);
    }
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
