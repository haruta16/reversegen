/**
 * 关卡难度分档模块。
 *
 * 纯函数模块，不依赖 I/O。配置由调用方传入，保持可测试性。
 * 与 sim 求解器完全解耦——只接收胜率数字，不关心它们如何产生。
 *
 * 用法：
 *   const config = JSON.parse(readFileSync('config/grade-thresholds.json', 'utf-8'));
 *   const snap = { sim1: 0.92, sim5: 0.73, sim15: 0.48 };
 *   const result = gradeStandard(snap.sim5, config);
 *   const refined = gradeRefined(snap, config);
 */

// ── 类型定义 ──

/** 一次模拟的汇总结果 */
export interface SimResult {
  winRate: number;
  wins: number;
  losses: number;
  runs: number;
  elapsedMs: number;
}

/** sim1% / sim5% / sim15% 三率快照 */
export interface SimSnapshot {
  sim1: SimResult;
  sim5: SimResult;
  sim15: SimResult;
}

/** 精筛条件的类型枚举 */
export type ConditionType =
  | 'sim15Min'     // sim15% ≥ value
  | 'sim1Min'      // sim1% ≥ value
  | 'sim1Max'      // sim1% ≤ value
  | 'sim1Eq'       // sim1% == value
  | 'stabilityMax'; // stability ≤ value

/** 精筛额外条件 */
export interface GradeCondition {
  type: ConditionType;
  value: number;
}

/** 配置中的单条标准版阈值 */
export interface StandardTier {
  grade: number;
  sim5Min: number;
  sim5Max: number;
  label: string;
  targetRate: string;
}

/** 配置中的单条精筛版阈值 */
export interface RefinedTier {
  grade: number;
  sim5Min: number;
  sim5Max?: number;
  condition: GradeCondition;
  conditionLabel: string;
}

/** 分档配置根对象 */
export interface GradeConfig {
  version: number;
  description?: string;
  standard: StandardTier[];
  refined: RefinedTier[];
  simRates: { ceiling: number; baseline: number; floor: number };
  defaultRuns: number;
}

/** 单次分档判定结果 */
export interface GradeVerdict {
  grade: number;
  label: string;
  passed: boolean;
  /** 未通过时的原因说明 */
  reason?: string;
}

/** 完整分档结果（标准版 + 精筛版） */
export interface GradeResult {
  /** sim 快照 */
  snapshot: SimSnapshot;
  /** 稳定性 = sim1% - sim15% */
  stability: number;
  /** 标准版判定 */
  standard: GradeVerdict;
  /** 精筛版判定 */
  refined: GradeVerdict;
}

/** 校验结果（对比目标档位） */
export interface GradeValidation {
  /** 目标档位 */
  targetGrade: number;
  /** 标准版是否匹配目标 */
  standardMatch: boolean;
  /** 精筛版是否匹配目标 */
  refinedMatch: boolean;
  /** 标准版实际档位 */
  standardGrade: number;
  /** 精筛版实际档位 */
  refinedGrade: number;
  /** 不匹配时的说明 */
  reasons: string[];
}

/** 分档策略条件使用的模拟指标 */
export type StrategyMetric = 'sim1' | 'sim5' | 'sim15' | 'stability';

/** 分档策略条件支持的比较运算 */
export type StrategyOperator = 'gt' | 'gte' | 'lt' | 'lte';

/** 分档策略1中的单个判定条件 */
export interface StrategyCondition {
  metric: StrategyMetric;
  operator: StrategyOperator;
  value: number;
}

/** 分档策略1中的单个档位 */
export interface StrategyTier {
  grade: number;
  label: string;
  targetRate: string;
  conditions: StrategyCondition[];
}

/** 可配置的分档策略1 */
export interface GradeStrategy1Config {
  version: number;
  name: string;
  description?: string;
  /** harder-first: 多个规则命中时，档位数字更大的（更难）优先 */
  priority: 'harder-first' | 'listed';
  tiers: StrategyTier[];
  simRates: { ceiling: number; baseline: number; floor: number };
  defaultRuns: number;
}

// ── 纯函数 ──

/**
 * 计算稳定性 = sim1% - sim15%。
 * 值越小越稳定——失误增多时胜率不会暴跌。
 */
export function computeStability(sim1: number, sim15: number): number {
  return Math.max(0, sim1 - sim15);
}

/**
 * 检查精筛条件是否满足。
 */
export function checkCondition(cond: GradeCondition, snap: SimSnapshot, stability: number): boolean {
  switch (cond.type) {
    case 'sim15Min':
      return snap.sim15.winRate >= cond.value;
    case 'sim1Min':
      return snap.sim1.winRate >= cond.value;
    case 'sim1Max':
      return snap.sim1.winRate <= cond.value;
    case 'sim1Eq':
      return snap.sim1.winRate === cond.value;
    case 'stabilityMax':
      return stability <= cond.value;
    default:
      return false;
  }
}

/** 检查分档策略1中的通用条件。 */
export function checkStrategyCondition(
  cond: StrategyCondition,
  snap: SimSnapshot,
  stability: number,
): boolean {
  const epsilon = 1e-9;
  const actual = cond.metric === 'stability'
    ? stability
    : snap[cond.metric].winRate;

  switch (cond.operator) {
    case 'gt': return actual > cond.value + epsilon;
    case 'gte': return actual >= cond.value - epsilon;
    case 'lt': return actual < cond.value - epsilon;
    case 'lte': return actual <= cond.value + epsilon;
    default: return false;
  }
}

/**
 * 六档“分档策略1”。
 *
 * 逐档检查配置中的全部条件。harder-first 模式下先检查更难档位，
 * 用于解决规则区间重叠；没有任何规则命中时返回未认证。
 */
export function gradeStrategy1(
  snap: SimSnapshot,
  config: GradeStrategy1Config,
): GradeVerdict {
  const stability = computeStability(snap.sim1.winRate, snap.sim15.winRate);
  const tiers = config.priority === 'harder-first'
    ? [...config.tiers].sort((a, b) => b.grade - a.grade)
    : config.tiers;

  for (const tier of tiers) {
    if (tier.conditions.every(cond => checkStrategyCondition(cond, snap, stability))) {
      return { grade: tier.grade, label: tier.label, passed: true };
    }
  }

  return {
    grade: -1,
    label: '未认证',
    passed: false,
    reason: `未命中${config.name}任何档位（sim1%=${(snap.sim1.winRate * 100).toFixed(1)}%, sim5%=${(snap.sim5.winRate * 100).toFixed(1)}%, sim15%=${(snap.sim15.winRate * 100).toFixed(1)}%, 稳定性=${(stability * 100).toFixed(1)}%）`,
  };
}

/**
 * 标准版分档：只用 sim5% 判定档位。
 */
export function gradeStandard(sim5: number, config: GradeConfig): GradeVerdict {
  for (const tier of config.standard) {
    if (sim5 >= tier.sim5Min && sim5 <= tier.sim5Max) {
      return { grade: tier.grade, label: tier.label, passed: true };
    }
  }
  return { grade: -1, label: '未分档', passed: false, reason: `sim5%=${(sim5 * 100).toFixed(1)}% 不在任何档位区间内` };
}

/**
 * 根据 sim5% 查找对应的精筛规则条目。
 * 精筛版先按 sim5% 定位档位，再检查额外条件。
 */
function findRefinedTier(sim5: number, config: GradeConfig): RefinedTier | undefined {
  return config.refined.find(t => {
    const max = t.sim5Max ?? 1.0;
    return sim5 >= t.sim5Min && sim5 <= max;
  });
}

/**
 * 精筛版分档：sim5% 定位档位 + 额外条件验证。
 * 只有通过额外条件的关卡才能"认证"为该档位。
 */
export function gradeRefined(snap: SimSnapshot, config: GradeConfig): GradeVerdict {
  const base = gradeStandard(snap.sim5.winRate, config);
  if (!base.passed) return base;

  const stability = computeStability(snap.sim1.winRate, snap.sim15.winRate);
  const tier = findRefinedTier(snap.sim5.winRate, config);
  if (!tier) {
    return { ...base, passed: false, reason: '该档位无精筛规则' };
  }

  if (!checkCondition(tier.condition, snap, stability)) {
    return {
      grade: base.grade,
      label: base.label,
      passed: false,
      reason: `未通过精筛条件: ${tier.conditionLabel}（实际: sim1%=${(snap.sim1.winRate * 100).toFixed(1)}%, sim15%=${(snap.sim15.winRate * 100).toFixed(1)}%, 稳定性=${(stability * 100).toFixed(1)}%）`,
    };
  }

  return { grade: base.grade, label: base.label, passed: true };
}

/**
 * 完整分档：同时给出标准版和精筛版结果。
 */
export function gradeFull(snap: SimSnapshot, config: GradeConfig): GradeResult {
  const stability = computeStability(snap.sim1.winRate, snap.sim15.winRate);
  return {
    snapshot: snap,
    stability,
    standard: gradeStandard(snap.sim5.winRate, config),
    refined: gradeRefined(snap, config),
  };
}

/**
 * 校验关卡是否达到目标档位。
 *
 * @param snap — sim 三率快照
 * @param targetGrade — 目标档位 (0-7)
 * @param config — 分档配置
 */
export function validateGrade(snap: SimSnapshot, targetGrade: number, config: GradeConfig): GradeValidation {
  const full = gradeFull(snap, config);
  const reasons: string[] = [];

  const standardMatch = full.standard.passed && full.standard.grade === targetGrade;
  const refinedMatch = full.refined.passed && full.refined.grade === targetGrade;

  if (!standardMatch) {
    if (!full.standard.passed) {
      reasons.push(`标准版: ${full.standard.reason}`);
    } else {
      reasons.push(`标准版: 实际档${full.standard.grade}(${full.standard.label})，目标档${targetGrade}`);
    }
  }

  if (!refinedMatch) {
    if (!full.refined.passed) {
      reasons.push(`精筛版: ${full.refined.reason}`);
    } else {
      reasons.push(`精筛版: 实际档${full.refined.grade}(${full.refined.label})，目标档${targetGrade}`);
    }
  }

  return {
    targetGrade,
    standardMatch,
    refinedMatch,
    standardGrade: full.standard.grade,
    refinedGrade: full.refined.grade,
    reasons,
  };
}
