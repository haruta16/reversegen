/**
 * Triple 枚举与 cost 计算。
 * 直接对应 C# 版 ReverseGenAlgorithm.BuildTriples 及相关辅助方法。
 */

import type { TerrainTile, Triple } from './types.js';
import { sortTriple } from './types.js';

/**
 * 从牌列表中枚举所有合法 triple（C(n,3) 组合）。
 * 每个 triple 的 depSet = 三张牌传递闭包的并集 + 牌自身。
 *
 * 直接对应 C# 版:
 *   private static List<Triple> BuildTriples(List<Tile> tiles,
 *       Dictionary<int, HashSet<int>> deps)
 */
export function buildTriples(
  tiles: TerrainTile[],
  allDeps: Map<number, Set<number>>
): Triple[] {
  const result: Triple[] = [];
  const n = tiles.length;

  for (let i = 0; i < n - 2; i++) {
    for (let j = i + 1; j < n - 1; j++) {
      for (let k = j + 1; k < n; k++) {
        const a = tiles[i];
        const b = tiles[j];
        const c = tiles[k];

        const depSet = new Set<number>();

        // 合并三张牌的传递依赖闭包
        const depsA = allDeps.get(a.id);
        const depsB = allDeps.get(b.id);
        const depsC = allDeps.get(c.id);

        if (depsA) for (const id of depsA) depSet.add(id);
        if (depsB) for (const id of depsB) depSet.add(id);
        if (depsC) for (const id of depsC) depSet.add(id);

        // 加入牌自身
        depSet.add(a.id);
        depSet.add(b.id);
        depSet.add(c.id);

        result.push({
          tileIds: sortTriple(a.id, b.id, c.id),
          depSet,
        });
      }
    }
  }

  return result;
}

/**
 * 检查 triple 是否与已使用的牌有重叠。
 * 直接对应 C# 版: Overlaps(Triple t, HashSet<int> used)
 */
export function overlaps(triple: Triple, usedIds: Set<number>): boolean {
  return usedIds.has(triple.tileIds[0])
    || usedIds.has(triple.tileIds[1])
    || usedIds.has(triple.tileIds[2]);
}

/**
 * 计算 triple 的动态 cost。
 * cost = depSet 中尚未被收集的牌数量。
 * 对应 C# 版: t.DepSet.Count(id => !collectedIds.Contains(id))
 */
export function computeCost(triple: Triple, collectedIds: Set<number>): number {
  let cost = 0;
  for (const id of triple.depSet) {
    if (!collectedIds.has(id)) {
      cost++;
    }
  }
  return cost;
}
