/**
 * 纯贪心模拟 — 落色后的独立验证。
 *
 * 在 ReverseGen 完成花色分配后，按花色分组重新构建同色 triple，
 * 每步严格选择动态 cost 最小的 triple，产生 cost 链和策略分支日志。
 *
 * 直接对应 C# 版: ReverseGenAlgorithm.RunPureGreedySimulation
 */

import type { TerrainTile, Triple } from './types.js';
import { buildTriples, overlaps, computeCost } from './triple-builder.js';
import { MAX_DOCK_SLOTS } from './constants.js';

/**
 * 执行纯贪心模拟。
 *
 * @param freeTiles - 自由牌列表（已分配花色值）
 * @param assignments - tileId → 花色值 的映射
 * @param allDeps - 所有牌的传递依赖闭包
 * @param steps - 总步数（自由牌 ÷ 3）
 * @returns costLog（每步 cost）和 branchLog（每步可选同色 triple 数）
 */
export function runPureGreedySimulation(
  freeTiles: TerrainTile[],
  assignments: Map<number, number>,
  allDeps: Map<number, Set<number>>,
  steps: number
): { costLog: number[]; branchLog: number[] } {
  // 按花色分组
  const colorGroups = new Map<number, TerrainTile[]>();
  for (const tile of freeTiles) {
    const ev = assignments.get(tile.id) ?? 0;
    if (ev <= 0) continue;
    let group = colorGroups.get(ev);
    if (!group) {
      group = [];
      colorGroups.set(ev, group);
    }
    group.push(tile);
  }

  // 在每个花色组内构建同色 triple
  const colorTriples: Triple[] = [];
  for (const [, tiles] of colorGroups) {
    if (tiles.length >= 3) {
      colorTriples.push(...buildTriples(tiles, allDeps));
    }
  }

  const costLog: number[] = [];
  const branchLog: number[] = [];
  const usedIds = new Set<number>();
  const collectedIds = new Set<number>();

  for (let s = 0; s < steps; s++) {
    // Dock 占用 = 已释放依赖但尚未匹配的牌
    const dockUsed = collectedIds.size - usedIds.size;
    const remainSlots = dockUsed >= MAX_DOCK_SLOTS ? 0 : MAX_DOCK_SLOTS - dockUsed;

    let best: Triple | null = null;
    let bestCost = Infinity;
    let safeCount = 0;

    for (const t of colorTriples) {
      if (overlaps(t, usedIds)) continue;
      const cost = computeCost(t, collectedIds);
      if (cost <= remainSlots) safeCount++;
      if (cost < bestCost) {
        bestCost = cost;
        best = t;
      }
    }

    if (best === null) break;

    costLog.push(bestCost);
    branchLog.push(safeCount);

    for (const id of best.tileIds) usedIds.add(id);
    for (const id of best.depSet) collectedIds.add(id);
  }

  return { costLog, branchLog };
}
