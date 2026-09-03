/**
 * 死锁前缀生成器（deadlock-layer-closure）领域类型。
 *
 * 数学基础（对齐 /mnt/e/BaiduSyncdisk/Obsidiannote/TM/tool/DAG理论完整证明.md）：
 *  - 槽位占用 = Σ_花色(已收集数 mod 3)，满 7 = 唯一死法（平衡配色，每色恰 3 张）
 *  - 必死判据（定理 2.2）：每色「三消闭包」≥ 8 ⇔ 纯玩法第 7 手必死
 *  - 最小性（定理 3.x）：tile ≥ 12（≥4 色 × 3）、1 层必可解、2 层不可能 ⇒ 层数 ≥ 3
 *
 * 本域只依赖基础层（types / dependency-graph / logical-layers），
 * 不依赖 solver / strategy / gui，与 layer-closure 域平级。
 */

/** dagT 模板节点：结构角色 + 模板内直接依赖 + 模板花色。 */
export interface DagTNode {
  /** 模板内节点 id（1 起，与参考实现 dag_geometry.py 的 tile id 一致） */
  id: number;
  /** 模板逻辑层（1 = 顶层，严格向下递增） */
  layer: number;
  /** 模板内直接依赖的节点 id（严格指向更低层） */
  deps: number[];
  /** 模板花色（0 起；生成时归一化为 1..n 实际花色值） */
  color: number;
}

/** 一个 dagT 变体（结构 + 染色表）。染色依据变体表；搜索只用结构。 */
export interface DagTVariant {
  /** 变体 id（如 '12t3l-h0-a0-p0'，hub/avoid/pick 参数化） */
  id: string;
  /** t：tile 总数（= 3n，n = 花色数） */
  tileCount: number;
  /** l：层数限制 */
  layerLimit: number;
  /** 直接依赖边数 */
  edges: number;
  /** 模板节点（按 id 升序） */
  nodes: DagTNode[];
}

export type DepthPreference = 'deepest' | 'shallowest' | 'neutral';
export type DensityPreference = 'densest' | 'sparsest' | 'neutral';

/** 前置死锁步骤配置。t（tileCount）与 l（layerLimit）均为入参，默认 12t3l。 */
export interface DeadlockPrefixSpec {
  /** t：死锁 tile 总数（3 的倍数，t/3 = 花色数 n ≥ 4）。默认 12。 */
  tileCount?: number;
  /** l：dagT 层数限制（≥ 3）。默认 3。 */
  layerLimit?: number;
  /** 多包含时深度偏好（逻辑依赖深度，computeDependencyDepth 口径）。默认 'neutral'。 */
  depthPreference?: DepthPreference;
  /** 多包含时空间密度偏好（所选牌成对 Chebyshev 距离）。默认 'neutral'。 */
  densityPreference?: DensityPreference;
  /** 同分破平种子（mulberry32）。默认 0（确定性）。 */
  selectionSeed?: number;
  /**
   * 骨架匹配收集上限。枚举按 enumerationSeed 洗牌后的随机序进行，
   * 取前 searchLimit 个 ≈ 从全部包含中随机采样。默认 256（≤0 视为 1）。
   */
  searchLimit?: number;
  /**
   * 枚举顺序种子：候选按 mulberry32(seed) 洗牌（确定性）。
   * 采样不改变「是否有结果」——只要地形存在包含且 limit ≥ 1 必有返回。默认 0。
   */
  enumerationSeed?: number;
  /** 每个骨架匹配的 wildcard 组合枚举上限。默认 256。 */
  wildcardPairLimit?: number;
}

/** 一次搜索产出的骨架匹配（不含 wildcard 完成）。 */
export interface DeadlockCoreMatch {
  /** 使用的模板变体 id */
  variantId: string;
  /** templateNodeId → terrainTileId（仅核心角色，wildcard 未分配） */
  coreMapping: Map<number, number>;
  /** 核心角色的 tileId 集合 */
  coreTileIds: number[];
  /** 逐模板色的「直接依赖子图闭包」核心值（完整闭包 = 核心值 + wildcard 贡献） */
  coreClosures: Map<number, number>;
  /** 本匹配可用的 wildcard 剩余候选（= 候选池 − 核心 tile） */
  wildcardPool: number[];
  /**
   * wildcard 补全约束（信息性诊断数据，选择阶段以 verifyFullEmbedding 为最终
   * 仲裁者、不再消费本字段）：记录 cap→父 的结构桥接需求。
   */
  wildcardConstraints?: WildcardConstraint[];
  /**
   * wildcard 提示：闭包可行性分析给出的「有增益/桥接价值」的 tile。
   * 选择阶段优先尝试这些组合（合法组合的命中率大幅提高）。
   */
  wildcardHints?: number[];
}

/** wildcard 补全约束（完整枚举的闭环：桥接/增长 wildcard 不再被遗漏）。 */
export interface WildcardConstraint {
  /** 需要的 wildcard 数（1=单张，2=两张） */
  arity: 1 | 2;
  /** 可满足本约束的 wildcard 模板节点 id（按序：assignments[i] 绑定到 eligibleNodeIds[i]） */
  eligibleNodeIds: number[];
  /** 物化候选分配：每个元素 = 完整分配的 tileId 序列（长度 = arity，位置与 eligibleNodeIds 对齐） */
  assignments: number[][];
}

/** 一次完整且验证通过的包含：模板全部角色（含 wildcard）→ 地形 tile。 */
export interface DeadlockEmbedding {
  /** 使用的模板变体 id */
  variantId: string;
  /** templateNodeId → terrainTileId（全部 3n 张） */
  mapping: Map<number, number>;
  /** 逐死锁色（模板色号 0 起）的完整直接依赖子图闭包，全部 ≥ 8 */
  closures: Map<number, number>;
  /** 逻辑依赖深度得分（所选牌均值，越大越深） */
  depthScore: number;
  /** 空间密度得分（成对 Chebyshev 距离和，越小越密） */
  densityScore: number;
}

/** 生成器输出的死锁报告（GUI / 日志消费）。 */
export interface DeadlockReport {
  /** 使用的模板变体 id */
  variantId: string;
  /** t / l（回显） */
  tileCount: number;
  layerLimit: number;
  /** 死锁花色实际值（1..n） */
  deadlockColors: number[];
  /** templateNodeId → terrainTileId */
  mapping: Map<number, number>;
  /** tileId → 花色（仅死锁牌） */
  assignments: Map<number, number>;
  /** 逐模板色的完整闭包（≥ 8） */
  closures: Map<number, number>;
  /** 深浅/疏密得分（回显） */
  depthScore: number;
  densityScore: number;
  /** 剩余牌数量与剩余可用花色数（回显） */
  remainingTileCount: number;
  remainingColorCount: number;
}

/** 死锁闭包阈值：每色闭包 ≥ 8 ⇔ 必死（定理 2.2）。 */
export const DEADLOCK_CLOSURE_THRESHOLD = 8;

/** 棋盘特殊物枚举（51-53 大型地形结构、55 障碍），不可作为死锁牌。 */
export const DEADLOCK_EXCLUDED_EXTRA_ENUMS = new Set<number>([51, 52, 53, 55]);
