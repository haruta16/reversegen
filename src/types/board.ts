/**
 * 牌局领域类型：生成算法输入/输出与 ReplayCode 序列化。
 *
 * 从 src/types.ts 拆出，统一由 src/types.ts re-export。
 */

import type { TerrainTile } from './terrain.js';

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

