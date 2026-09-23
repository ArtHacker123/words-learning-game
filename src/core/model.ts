export type Language = "foreign" | "chinese";

export interface Word {
  id: string;
  foreign: string;
  chinese: string;
}

export type Direction = "forward" | "reverse";

/** 记忆状态:会话结果与统计字段 */
export interface WordStats {
  wordId: string;
  intervalRung: number; // 0..6,对应阶梯下标
  threatIndex: number;
  introducedDay: number;
  introducedBatch: number;
  encounterHistory: Encounter[];
}

export interface Encounter {
  day: number;
  act: number; // 1..4
  direction: Direction;
  retries: number; // 答对前错了几次,首发命中=0
  success: boolean; // 最终是否击倒
}

export interface ZombieSpec {
  wordId: string;
  direction: Direction;
  teaching: boolean; // 教学僵:头顶亮答案且慢速
  boss: boolean;
  act: number; // 1..5 所属幕
  ultimate?: boolean; // 终局接力 boss
  cycle?: UltimatePhase[]; // 接力词段(可 1~3 段;出现顺序随机化)
}

/** 终局 boss 的一个接力词段:问哪个词、以什么方向作答 */
export interface UltimatePhase {
  wordId: string;
  direction: Direction;
}

export interface ActPlan {
  act: number; // 1..5
  zombies: ZombieSpec[];
}

export interface DailyPlan {
  day: number;
  newWords: string[];
  acts: ActPlan[];
  bossCandidates: string[];
}

/** 当日快照:首局建档时固化。当天所有局都用同一份计划与基线难度,保证体验一致。 */
export interface DaySnapshot {
  day: number;
  /** 当日分块计划:一局=一块(每块 ≤ sessionWordCap 词),顺序即推进顺序;跨块互不重叠。 */
  plans: DailyPlan[];
  /** 已胜利完结的块数(推进指针):失败/未打完不计入;只有块胜利才 +1。 */
  played: number;
  stats: WordStats[]; // 当日基线(敌人强度来源,不含当日已提交的记录)
}

export interface EncounterOutcome {
  wordId: string;
  direction: Direction;
  retries: number;
  success: boolean;
}