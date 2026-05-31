/**
 * 依赖图计算 — BFS 传递闭包。
 * 直接对应 C# 版 ReverseGenAlgorithm.TransitiveClosure。
 */

import type { TerrainTile } from './types.js';

/**
 * 计算单张牌的传递依赖闭包。
 * 沿依赖链向下 BFS 遍历所有被直接或间接压在下面的牌。
 */
export function transitiveClosure(
  tile: TerrainTile,
  tileMap: Map<number, TerrainTile>
): Set<number> {
  const closure = new Set<number>();
  // 头指针队列实现 O(1) 出队（Array.shift() 是 O(n)，大数据量下不可接受）
  const queue: number[] = [];
  let head = 0;

  for (const dep of tile.dependencies) {
    queue.push(dep);
  }

  while (head < queue.length) {
    const id = queue[head++];
    if (closure.has(id)) continue;
    closure.add(id);

    const depTile = tileMap.get(id);
    if (depTile) {
      for (const next of depTile.dependencies) {
        if (!closure.has(next)) {
          queue.push(next);
        }
      }
    }
  }

  return closure;
}

/**
 * 为所有牌批量计算传递闭包。
 * 返回 tileId → 传递闭包集合 的映射。
 */
export function computeAllDependencies(
  tiles: TerrainTile[]
): Map<number, Set<number>> {
  const tileMap = new Map<number, TerrainTile>();
  for (const tile of tiles) {
    tileMap.set(tile.id, tile);
  }

  const allDeps = new Map<number, Set<number>>();
  for (const tile of tiles) {
    allDeps.set(tile.id, transitiveClosure(tile, tileMap));
  }

  return allDeps;
}
