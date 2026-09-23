/** 成就/奖励判定(纯函数,便于单测与后续扩展) */

export interface DiamondEligibility {
  won: boolean; // 整场胜利(包含打通全部幕)
  baseHp: number; // 战斗结束时的基地血量
  baseFull: number; // 基地满血值(tuning.baseHp,100)
  lastAct: number; // 胜利所需的最后幕(battle.lastAct)
  lastAwardDay?: number; // 上次发放钻石的日(缺省=从未发放)
  today: number; // 本场所在日(plan.day)
}

/**
 * 钻石奖励资格:五幕全通(lastAct=5)且基地未受损(baseHp 保持满血),
 * 且当天尚未发放过(防同一天反复重打刷取)。钻石跨天累计,此处只做资格判定。
 */
export function eligibleForDiamond(o: DiamondEligibility): boolean {
  if (!o.won) return false;
  if (o.lastAct !== 5) return false; // 未打到第五幕(如空词库空壳局)不发
  if (o.baseFull <= 0 || o.baseHp < o.baseFull) return false; // 基地受损过(无回血,hp<满 即咬过)
  if (o.lastAwardDay !== undefined && o.lastAwardDay === o.today) return false; // 同天已发
  return true;
}