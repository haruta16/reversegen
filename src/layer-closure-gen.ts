/**
 * LayerClosure（层闭合）花色分配算法 — v3 逐层约束满足。
 *
 * === 闭合率的定义 ===
 *
 * 闭合率 = 已完成的 triplet 数 ÷ 累积 tile 数对应的可能 triplet 数。
 *
 * 例：1~n 层共 62 个 tile（20 组 + 2），闭合率 50% = 完成了 10 个 triplet（10 次消除）。
 *
 * "闭合"的单位是 triplet（组），不是颜色。花色是手段，闭合率是结果。
 *
 * === 与 v1/v2 的本质区别 ===
 *
 * v1/v2: closeRates → 翻译成中间表示 → 分配 → 算 actualCloseRates（只展示）
 * v3:    closeRates → 每层直接求解"该完成几个 triplet" → 分配 → actualCloseRates 尽量接近目标
 *
 * 不再有深度模式、配额、累积曲线、closureStyle 等中间概念。
 * 只做一件事：每层尽量让已完成 triplet 数 = round(closeRate × 累积 tile 数 ÷ 3)。
 *
 * === 模块结构 ===
 *
 * 本文件是编排入口 + 向后兼容 re-export 中心，具体实现拆分在:
 *   layer-closure/quota.ts      每色总牌数分配（assignColorTotals）
 *   layer-closure/matrix.ts     逐层约束满足矩阵（buildMatrixByCloseRates）
 *   layer-closure/placement.ts  矩阵 → 具体方块贴花色（领土增量）
 *   layer-closure/metrics.ts    指标计算（computeMetrics 等）
 *
 * @module layer-closure-gen
 */

import type { LayerClosureInput, LayerClosureOutput } from './types.js';
import { getAllTiles } from './terrain-loader.js';
import { buildGenerationLogicalLayers } from './logical-layers.js';
import { assignColorTotals, buildSingleHeavyTripletPlan } from './layer-closure/quota.js';
import { buildMatrixByCloseRates } from './layer-closure/matrix.js';
import { computeTileDepSets, placeSuitsFromMatrixWithSpread } from './layer-closure/placement.js';
import {
  buildTriplets,
  computeCloseRatesFromAssignments,
  computeMetrics,
  emptyMetrics,
} from './layer-closure/metrics.js';

// ── 向后兼容 re-export（保持原有导入路径与公共 API 不变）──
export { computeDependencyDepth } from './logical-layers.js';
export { assignColorTotals } from './layer-closure/quota.js';
export { buildSingleHeavyTripletPlan } from './layer-closure/quota.js';
export { buildMatrixByCloseRates } from './layer-closure/matrix.js';
export { computeTileDepSets, placeSuitsFromMatrixWithSpread } from './layer-closure/placement.js';
export {
  computeCloseRatesFromAssignments,
  computeExpDebt,
  computeLayerProgressMetrics,
  computeMetrics,
  emptyMetrics,
} from './layer-closure/metrics.js';
export type { ComputeMetricsInput } from './layer-closure/metrics.js';

// ═══════════════════════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════════════════════

export function runLayerClosureGen(input: LayerClosureInput): LayerClosureOutput {
  const { terrain, colorCount, dock, closeRates, spreadParam, debtPersistenceWeight, colorAllocationMode, colorAllocationMaxRatio, colorAllocationRng } = input;
  const rng = input.rng ?? colorAllocationRng ?? Math.random;
  const p = Math.max(0, Math.min(1, debtPersistenceWeight ?? 0));

  // ── 1. 提取全量牌，算依赖深度（const 也参与）──
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(t => !t.isConst);
  const tileMap = new Map(allTiles.map(t => [t.id, t])); // 全量，const 进入依赖图

  if (freeTiles.length === 0) {
    return { assignments: new Map(), triplets: [], metrics: emptyMetrics() };
  }
  if (freeTiles.length % 3 !== 0) {
    throw new Error(`自由牌数量 ${freeTiles.length} 不是 3 的倍数`);
  }

  const logicalTerrain = buildGenerationLogicalLayers(terrain);
  const depthMap = logicalTerrain.depthById;
  const depthLayers = logicalTerrain.layers;

  // ── 2. 分层统计 ──
  const freeTilesPerDepth = depthLayers.map(l => l.filter(t => !t.isConst).length);
  const allTilesPerDepth = depthLayers.map(l => l.length);
  const totalTriplets = freeTiles.length / 3;
  const isSingleHeavy = colorAllocationMode === 'single-heavy';
  // single-heavy 先按最大花色生成：每个三元组拥有唯一源花色。完成落位后再
  // 整组三元组改色，避免主色配额提前干扰 LayerClosure 的初始生成过程。
  const generationColorTotalTiles = isSingleHeavy
    ? Array.from({ length: totalTriplets }, () => 3)
    : assignColorTotals(totalTriplets, colorCount, 'balanced', rng);

  // ── 3. 逐层约束满足 → 矩阵 M[c][d] ──
  const { matrix } = buildMatrixByCloseRates(
    generationColorTotalTiles, freeTilesPerDepth, allTilesPerDepth, closeRates, p,
  );

  // ── 4. 矩阵 → 具体方块贴花色（仅自由牌参与选择）──
  const sp = spreadParam ?? 0.5;
  const tileDepSets = computeTileDepSets(allTiles, tileMap);
  const assignments = placeSuitsFromMatrixWithSpread(matrix, depthLayers, tileDepSets, sp, rng);

  let heavyColor = 0;
  let colorTotalTiles = generationColorTotalTiles;
  if (isSingleHeavy) {
    const plan = buildSingleHeavyTripletPlan(
      totalTriplets,
      colorCount,
      colorAllocationMaxRatio ?? 1,
      rng,
    );
    for (const [tileId, sourceColor] of assignments) {
      const targetColor = plan.colorBySourceTriplet[sourceColor - 1];
      if (targetColor == null) throw new Error(`缺少源花色 ${sourceColor} 的单色改色映射`);
      assignments.set(tileId, targetColor);
    }
    heavyColor = plan.heavyColor;
    colorTotalTiles = plan.colorTripletCounts.map(count => count * 3);
  }

  // ── 5. 真实闭合率（const 花色参与累积）──
  const actualCloseRates = computeCloseRatesFromAssignments(assignments, depthLayers);

  // ── 6. 重建三元组（const 也参与）──
  const triplets = buildTriplets(assignments, depthLayers);

  // ── 7. 难度指标（const 全面参与）──
  const metrics = computeMetrics({
    assignments,
    tiles: allTiles,
    depthLayers,
    depthMap,
    tileMap,
    tileDepSets,
    dock,
    colorCount,
    actualCloseRates,
    debtPersistenceWeight: p,
    colorAllocationMode,
    heavyColor,
    colorTotalTiles,
  });

  return { assignments, triplets, metrics };
}
