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
  /** Cost 目标数组。长度必须 = 自由牌数 ÷ 3。为 null/undefined 时使用自然 minCost 模式 */
  costArray?: number[] | null;
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
  /** 目标 cost（自然 minCost 模式时为 -1） */
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
  /** 偏离 cost 目标的步数（仅传入 costArray 时有值） */
  deviationCount?: number;
  /** 匹配率百分比（仅传入 costArray 时有值） */
  matchRate?: number;
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
