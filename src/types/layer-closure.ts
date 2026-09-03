/**
 * LayerClosure（层闭合）算法类型。
 *
 * 从 src/types.ts 拆出，统一由 src/types.ts re-export。
 */

import type { TerrainData } from './terrain.js';

/** 花色配额方式 */
export type ColorAllocationMode = 'balanced' | 'single-heavy';

/**
 * LayerClosure 算法输入。
 *
 * 与 CostLadder 不同，此算法不通过 cost 目标数组控制难度，
 * 而是通过每层的"闭合率"（花色计数为 3 的倍数的花色占比）来控制。
 */
export interface LayerClosureInput {
  /** 地形数据 */
  terrain: TerrainData;
  /** 使用的花色数（花色值自动为 1..colorCount，与 CostLadder 一致） */
  colorCount: number;
  /**
   * 花色配额方式。
   * - 'balanced': 均匀分配（默认，保持旧行为）
   * - 'single-heavy': 先按每组三元组一个花色生成，再整组改色到目标主色比例和花色数
   */
  colorAllocationMode?: ColorAllocationMode;
  /** single-heavy 主色目标占总 triplet 的比例；未设置时取满足目标花色数的可行最大值。 */
  colorAllocationMaxRatio?: number;
  /** 花色配额随机源；批量任务传入种子 RNG，默认使用 Math.random。 */
  colorAllocationRng?: () => number;
  /** 本次生成的统一随机源；同时控制花色配额和 tile 落位。 */
  rng?: () => number;
  /** Dock 槽位容量（用于必输判定等指标，不影响花色分配） */
  dock: number;
  /**
   * 每层目标闭合率 [0-1]。
   * 长度 = 依赖深度层数 - 1（最后一层自动为 1.0，无需传入）。
   *
   * 闭合率的单位是 triplet（组），不是颜色。
   * closeRates[i] = 到深度 i+1 为止，已完成的 triplet 数 ÷ 累积 tile 数对应的可能 triplet 数。
   *
   * 例：4 层共 60 个 tile（20 组），closeRates = [0.2, 0.4, 0.6]：
   *   深度1 12tile: 4 组可能 → 0.2×4≈1 组已完成 → 1 次消除
   *   深度2 30tile: 10 组可能 → 0.4×10=4 组已完成 → 4 次消除
   *   深度3 48tile: 16 组可能 → 0.6×16≈10 组已完成 → 10 次消除
   *   深度4 60tile: 20 组可能 → 1.0×20=20 组全部完成
   */
  closeRates: number[];
  /**
   * 同色方块分布参数 [0-1]，控制同一花色 tiles 在依赖图中的离散程度。
   *
   * - 0.0 = cluster（紧密）：同花色 tiles 的 depSet 高度重叠 → 容易收集
   * - 0.5 = neutral（随机）：等价于当前随机分配行为
   * - 1.0 = spread（分散）：同花色 tiles 的 depSet 尽量不重叠 → 难以收集
   *
   * 默认 0.5（随机，不改变原有行为）。
   * 不影响 Step 1-3（深度计算、花色总数、逐层闭合率矩阵）。
   */
  spreadParam?: number;
  /**
   * 债务持续权重 [0-1]，控制下一层债务中有多少来自上一层的旧债务 tile。
   *
   * - 0 = 尽量清掉旧债务，用新花色制造下一层债务（默认，等价旧行为）
   * - 1 = 尽量延续旧债务；无法延续的部分才换新
   *
   * 目标保留旧债务 tile = round(p × min(本层旧债务 tile 数, 下一层债务 tile 数))。
   * 受花色余量与容量约束，实际保留量不一定精确命中。
   * 闭合率仍负责"每层有多少债务"，此参数只负责"是不是同一批债务"。
   */
  debtPersistenceWeight?: number;
  /**
   * 新版债务跨层上限：不完整三元组最多允许跨过的后续逻辑层数。
   * 0 表示下一层必须优先闭合；可选范围由当前地形逻辑深度决定。
   * 当层容量与闭合率目标无法同时满足时，牌面完整落位优先。
   */
  debtPersistenceLayers?: number;
}

/** 层闭合算法的难度指标 */
export interface DebtMetrics {
  /** 依赖深度层数 */
  depthCount: number;
  /** 自由牌总数 */
  totalTiles: number;
  /** 每层方块数 */
  tilesPerLayer: number[];
  /**
   * 逐层债务（纯累计统计）。
   * debtByLayer[i] = 到深度 i+1 为止，花色计数不是 3 的倍数的花色数。
   */
  debtByLayer: number[];
  /**
   * 逐层暴露债务（模拟玩家实际能看到的花色）。
   * 考虑了依赖解锁：被深层挡住的方块不计入，已凑满 3 个的自动消除。
   * 这个值比 debtByLayer 更接近真实游戏体验。
   */
  expDebtByLayer: number[];
  /** 峰值债务 */
  peakDebt: number;
  /** 暴露债务峰值（考虑依赖解锁后） */
  peakExpDebt: number;
  /**
   * 超载指数 OI = Σ max(0, 暴露债务 - Dock容量)。
   * 正值表示玩家的手牌在某些层会超出槽位限制。
   * 越高越难，0 = 始终在容量内。
   */
  oi: number;
  /** 连续超载层数（连续多少层暴露债务 > Dock容量） */
  consecutiveOI: number;
  /** 实际使用的花色数 */
  colorCount: number;
  /** 每层实际闭合率（triplet 口径：已完成 triplet 数 ÷ 可能 triplet 数，对比 closeRates 看偏差） */
  actualCloseRates: number[];
  /**
   * 逐层累计花色使用率。
   * colorUsageRates[i] = 深度 1~i+1 已出现花色数 ÷ 全局实际花色数。
   */
  colorUsageRates: number[];
  /** 每个花色首次出现的依赖层编号的平均值（层编号从1开始）。 */
  averageColorActivationLayer: number;
  /**
   * 逐层债务 tile 数。
   * debtTileCountsByLayer[i] = 深度 1~i+1 累计后，各花色 count % 3 的总和。
   */
  debtTileCountsByLayer: number[];
  /**
   * 相邻累计层的债务 tile 保留率，长度 = depthCount - 1。
   * debtRetentionRates[i] = 1~i+1 的债务 tile 中，到 1~i+2 后仍未闭合的比例。
   * 若前一层没有债务 tile，则该项为 0。
   */
  debtRetentionRates: number[];
  /** 跨所有相邻层、按旧债务 tile 数加权的债务保留率。 */
  weightedDebtRetentionRate: number;
  /** 配置的债务持续权重 p（回显输入，默认 0） */
  configuredDebtPersistenceWeight: number;
  /** 配置的债务最大跨层数（新版参数）。 */
  configuredDebtPersistenceLayers?: number;
  /** 逐层实际保留的旧债务 tile 数，长度 = depthCount - 1 */
  retainedOldDebtTilesByLayer: number[];
  /** 全部相邻层实际保留旧债务 tile 的总和 */
  totalRetainedOldDebtTiles: number;
  /**
   * 债务持续长度直方图，长度 = depthCount。
   * debtDurationHistogram[k-1] = 持续恰好 k 层的债务段数。
   * 债务段 = 某花色累计 count%3 从 0 变非0（出生）到再次归 0（清除）的区间。
   * 持续长度按“债务实际存在的层末端点数”计算；若下一层马上清除，则长度为 1。
   * 到最后一层仍未清除的段，持续长度 = depthCount - 出生层 + 1。
   */
  debtDurationHistogram: number[];
  /** 平均每方块被多少方块遮挡 */
  averageOcclusion: number;
  /** 遮挡边总数 */
  totalEdges: number;
  /** 遮挡关系中同色边的数量 */
  sameColorEdges: number;
  /** 遮挡关系中异色边的数量 */
  crossColorEdges: number;
  /** 花色分配是否满足 3 的倍数约束（所有花色计数 % 3 === 0） */
  allSuitsClosed: boolean;
  /** 如果峰值债务 > Dock容量，理论上玩家必输 */
  isDoomed: boolean;
  /**
   * 花色离散率 [0-1]。
   * avg over colors: |U_c| / Σ|depSet_i|
   * 值越小 = 同色牌越紧密（挤在同一子树），值越大 = 同色牌越分散。
   * 同关卡内与 spreadParam 单调对应。
   */
  suitSpread: number;
  /**
   * 归一化花色离散率 [0-1]，跨关卡可比。
   * avg over colors: (|U| - max|depSet|) / (Σ|depSet| - max|depSet|)
   * 0 = 最紧密（全部包在同一个 depSet 里），1 = 最松散（所有 depSet 互不重叠）。
   */
  suitSpreadNorm: number;
  /** 花色配额方式（回显输入） */
  colorAllocationMode?: ColorAllocationMode;
  /** single-heavy 模式下的主花色索引（1-based，balanced 模式为 0） */
  heavyColor?: number;
  /** 各花色 triplet 组数 */
  colorTripletCounts?: number[];
  /** single-heavy 后处理路径；存在时表示按已生成的全局完整三元组随机改色。 */
  singleHeavyRecolorStrategy?: 'global-triplet-random';
  /** 改色前的全局源花色数，应等于自由牌数 / 3。 */
  singleHeavySourceColorCount?: number;
  /** 目标比例换算出的主色三元组数。 */
  singleHeavyRequestedTriplets?: number;
  /** 为保留目标总花色数后实际覆盖为主色的三元组数。 */
  singleHeavyAppliedTriplets?: number;
}

/** LayerClosure 算法输出 */
export interface LayerClosureOutput {
  /** tileId → 花色值（1..colorCount，与 CostLadder 一致） */
  assignments: Map<number, number>;
  /** 分配的三元组列表（调试用：每个元素记录花色索引 + 三个方块所在深度） */
  triplets: Array<{ suitIndex: number; depths: [number, number, number] }>;
  /** 难度指标 */
  metrics: DebtMetrics;
}
