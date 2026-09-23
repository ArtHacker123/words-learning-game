/** 所有可调参数集中在此,便于后续调优 */

export const TUNING = {
  dailyNewWords: 10,
  sessionWordCap: 15, // 每局复习词上限:当日候选分块,一局=一块,多局覆盖全部待复习词
  intervalLadder: [1, 2, 4, 7, 15, 30], // 天
  laneCount: 5, // 恒定 5 车道
  baseHp: 2, // 最弱僵尸 2 血
  baseMaxHp: 100, // 基地血量上限/初始值(满血=无损判定基准)
  reloadSeconds: 1.5,
  upgradeReloadSeconds: 1.0, // 急速装填升级后的装弹时长
  plantCostSun: 30,
  maxSamePlantPerLane: 3, // 同一 lane 同词并存上限
  sunDripPerSecond: 6,
  sunHitBonus: 40,
  killSunByAct: [50, 100, 150, 200, 300], // 消灭僵尸按其所属幕奖励的阳光(Act1 → Act5)
  actRepeatRounds: [2, 2, 2, 1, 1], // 各幕同词重复轮数:Act1-3 每词 2 只(第2轮反向),Act4 头目/Act5 终局单只
  reloadSleepMs: 12000,
  bossHp: 9, // 头目血量(基数上按记忆档折算,仍远厚于普通怪)
  bossSpeed: 75, // 头目移动速度(快于普通僵尸,逼抢走位)
  ultimateBossHpScale: 3, // 终局 boss 总血 = 该词 Act4 头目 HP × N(恒定,不随词段数变化)
  ultimateBossSpeed: 110, // 终局 boss 移速(跨 lane 压境)
  ultimateSiegeDamage: 20, // 终局 boss 到岸每口咬基地伤害
  shockCount: 3, // 终局 boss 存活期间随机冲击波次数上限
  shockTw: 60, // 冲击波光带宽度(px)
  shockSpeed: 640, // 冲击波右→左扫速(px/s),跨全场约 1.2s
  shockFirstDelayMin: 2, // 第 5 幕开启后首波随机延迟下限(s)
  shockFirstDelayMax: 5, // 首波随机延迟上限(s)
  shockIntervalMin: 4, // 相邻两次冲击波随机间隔下限(s)
  shockIntervalMax: 9, // 相邻两次冲击波随机间隔上限(s)
  // 单株武器升级
  upgradeReloadCost: 90, // 急速装填:1.5s → 1.0s
  upgradeDmgCostBase: 150, // 破甲弹药首级;每级 +120
  upgradeDmgMaxLevel: 2, // 破甲弹药最多 2 级(+1/+2)
  upgradeAutoFireCost: 180, // 自动发射:装填完成自动打同 lane 匹配非教学僵尸
  upgradeFreezeCost: 160, // 凝固弹:命中冻结 2.5s
  freezeStunSeconds: 2.5, // 普通僵尸冻结时长
  bossStunScale: 0.4, // Boss 冻结时长系数(2.5*0.4=1s)
  eatPlantSeconds: 2, // 僵尸撞上植物后啃食时长,期间植物不消失、僵尸不前进
  baseSiegeInterval: 2, // 到岸僵尸每隔 2 秒咬一口基地(每口伤害见 battle.damageOnReach)
} as const;

/** 场面递进:各幕同时在场僵尸数 / 出怪间隔(秒) / 并行出怪概率(0=永不,1=总是) */
export const ACT_PRESSURE = [
  { maxAlive: 2, spawnInterval: 6, parallelProb: 0.4 }, // Act1 教学(也允许并行,教学僵尸慢)
  { maxAlive: 3, spawnInterval: 3.5, parallelProb: 0.5 }, // Act2 演练
  { maxAlive: 5, spawnInterval: 2.2, parallelProb: 0.65 }, // Act3 复习浪
  { maxAlive: 4, spawnInterval: 4, parallelProb: 0.8 }, // Act4 头目(少而快,单只血厚+到岸重罚)
  { maxAlive: 1, spawnInterval: 6, parallelProb: 0 }, // Act5 终局(单只跨 lane 接力 boss,慢稳出场)
];

/** 各幕反向僵尸占比 */
export const ACT_REVERSE_RATIO = [0, 0.2, 0.5, 0.3];