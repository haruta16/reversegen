/**
 * Triple（三牌组合）领域类型与键工具函数。
 *
 * 从 src/types.ts 拆出，统一由 src/types.ts re-export。
 */

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
