/**
 * ReverseGen 核心类型定义。
 * 从 Unity TileMatch 项目中剥离，移除所有 Unity 依赖。
 */

// ── 地形 / 关卡 ──

/** 地形中的单张牌（最小数据单元） */
export interface TerrainTile {
  /** 唯一标识 */
  id: number;
  /** 所在层级（0 = 最底层） */
  layer: number;
  /** 直接依赖的牌的 ID 列表（这张牌压在哪些牌上面） */
  dependencies: number[];
  /** 是否为固定花色（算法不分配） */
  isConst: boolean;
  /** 固定花色的值（仅 isConst 为 true 时有效） */
  constElementValue: number;
  /** 牌面中心坐标 X（用于几何可视性计算） */
  posX: number;
  /** 牌面中心坐标 Y（用于几何可视性计算） */
  posY: number;
}

/** 一层牌 */
export interface TerrainLayer {
  tiles: TerrainTile[];
}

/** 完整地形/关卡定义 */
export interface TerrainData {
  levelResId?: number;
  levelHash?: string;       // 16 位小写十六进制，如 "550ede7fd250e2d4"
  layers: TerrainLayer[];
  LevelWidth?: number;
  LevelHeight?: number;
  elementsPerLevel?: number;
}

// ── 算法内部类型 ──

/** 合法 triple（三张可以一起消除的牌） */
export interface Triple {
  /** 排序后的三张牌 ID */
  tileIds: [number, number, number];
  /** 三张牌的传递依赖闭包 + 牌自身（用于计算动态 cost） */
  depSet: Set<number>;
}

/** triple 的稳定键（排序后的 ID 用逗号拼接） */
export type TripleKey = string; // 格式: "id1,id2,id3"

/** 生成调度中的一步 */
export interface ScheduleEntry {
  tileIds: [number, number, number];
  colorIndex: number;
}

// ── 算法输入 / 输出 ──

/** ReverseGen 算法输入 */
export interface ReverseGenInput {
  /** 地形中所有牌（含固定牌） */
  tiles: TerrainTile[];
  /** Cost 目标数组。长度必须 = 自由牌数 ÷ 3 */
  costArray: number[];
  /** 可用花色数量 */
  colorCount: number;
}

/** 每一步的详细记录 */
export interface StepRecord {
  /** 步序号（从 1 开始） */
  step: number;
  /** 选中的 triple 的三张牌 ID */
  tileIds: [number, number, number];
  /** 实际 cost */
  cost: number;
  /** 目标 cost */
  target: number;
  /** 该步可用的候选 triple 总数 */
  candidateCount: number;
  /** 该步被封杀的 triple 数量 */
  bannedCount: number;
  /** 分配的花色索引 */
  colorIndex: number;
  /** 纯贪心模拟中这一步的 cost（落色后独立验证） */
  simCost: number;
  /** 是否来自黑名单抢救 */
  rescued: boolean;
  /** 如果是抢救的: 这个 triple 最初在第几步被拉黑（非抢救步为 -1） */
  bannedAtStep: number;
}

/** ReverseGen 算法输出 */
export interface ReverseGenOutput {
  /** tileId → 归一化花色值（1..colorCount） */
  assignments: Map<number, number>;
  /** tileId → 固定牌的原始花色值 */
  constAssignments: Map<number, number>;
  /** 纯贪心模拟产生的 cost 链（每步一个值） */
  costLog: number[];
  /** 策略分支日志（每步可选同色 triple 数，越大越安全） */
  branchLog: number[];
  /** 每步的详细记录（triple 选择、封杀、抢救信息） */
  stepLog: StepRecord[];
  /** 算法是否成功完成 */
  completed: boolean;
  /** 偏离 cost 目标的步数 */
  deviationCount: number;
  /** 匹配率百分比 */
  matchRate: number;
  /** 总步数 */
  totalSteps: number;
  /** 黑名单中的 triple 数量 */
  banSetSize: number;
  /** cost 统计 */
  stats: CostStats;
}

export interface CostStats {
  min: number;
  max: number;
  avg: number;
}

// ── ReplayCode 类型 ──

/** 序列化后的牌状态 */
export enum TileState {
  OnField = 0,   // 在场上（Desk 中）
  Eliminated = 1, // 已消除
  InDock = 2,     // 在手牌区（Dock）
  Reserved = 3,   // 保留位
}

/** Dock 槽位条目 */
export interface DockEntry {
  /** 规范排序中的 tile 索引（0-255） */
  tileId: number;
  /** 归一化花色值（1..elementCount） */
  element: number;
}

/** 反序列化后的 ReplayCode 数据 */
export interface ReplayData {
  version: number;
  elementCount: number;
  levelHash: bigint;
  instanceArray: Uint8Array;
  dockEntries: DockEntry[];
}

// ── 工具函数 ──

/** 从排序好的 ID 构建稳定的 triple 键 */
export function tripleKey(ids: [number, number, number]): TripleKey {
  return `${ids[0]},${ids[1]},${ids[2]}`;
}

/** 将 triple 键解析回 ID 元组（供 countViolations 使用） */
export function parseTripleKey(key: TripleKey): [number, number, number] {
  const [a, b, c] = key.split(',').map(Number);
  return [a, b, c];
}

/** 三个数升序排序，返回排序后的元组 */
export function sortTriple(a: number, b: number, c: number): [number, number, number] {
  if (a > b) { const t = a; a = b; b = t; }
  if (b > c) { const t = b; b = c; c = t; }
  if (a > b) { const t = a; a = b; b = t; }
  return [a, b, c];
}

// ── LayerClosure（层闭合）花色分配算法 ──

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
   * - 'single-heavy': 随机选一个主花色集中分配，其余花色各 1 组
   */
  colorAllocationMode?: ColorAllocationMode;
  /** single-heavy 主色最多占总 triplet 的比例；未设置时保持旧的极端分配。 */
  colorAllocationMaxRatio?: number;
  /** 花色配额随机源；批量任务传入种子 RNG，默认使用 Math.random。 */
  colorAllocationRng?: () => number;
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
