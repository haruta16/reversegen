/**
 * Deadlock + LayerClosure 牌局生成 —— 编排入口。
 *
 * 流程（镜像 layer-closure-gen.ts 的薄编排模式）：
 *   1. 前置死锁：在候选牌中搜索「最小 dagT」的可达包含（t/l 入参，默认 12t3l），
 *      按变体表染色（消耗 n 种花色），逐色直接依赖子图闭包 ≥ 8 保证必死；
 *   2. 剩余 3m 张牌照常走 LayerClosure（复用 layer-closure/ 四模块），
 *      花色配额 = colorCount − n（死锁花色不再使用）；
 *   3. 闭合率 / 三元组 / 债务指标口径排除死锁牌（可切换）。
 *
 * 死锁不破坏性（论证见 src/deadlock/closures.ts）：
 *   死锁色与剩余色不相交 ⇒ 第 7 张死锁牌入槽必死，与外部牌穿插无关。
 */

import type {
  TerrainData,
  TerrainTile,
  LayerClosureInput,
  LayerClosureOutput,
  DebtMetrics,
} from './types.js';
import { getAllTiles } from './terrain-loader.js';
import { buildGenerationLogicalLayers, computeDependencyDepth } from './logical-layers.js';
import { computeAllDependencies } from './dependency-graph.js';
import { assignColorTotals, buildSingleHeavyTripletPlan } from './layer-closure/quota.js';
import { buildMatrixByCloseRates } from './layer-closure/matrix.js';
import { computeTileDepSets, placeSuitsFromMatrixWithSpread } from './layer-closure/placement.js';
import { buildTriplets, computeCloseRatesFromAssignments, computeMetrics } from './layer-closure/metrics.js';
import { canonicalVariant } from './deadlock/family.js';
import { searchDeadlockCores } from './deadlock/search.js';
import { selectDeadlockEmbedding, type SelectionContext } from './deadlock/selection.js';
import {
  DEADLOCK_EXCLUDED_EXTRA_ENUMS,
  type DeadlockEmbedding,
  type DeadlockPrefixSpec,
  type DeadlockReport,
} from './deadlock/types.js';
import { logger } from './logger.js';
import { MAX_DOCK_SLOTS } from './constants.js';

// ── 输入 / 输出 ──

/** deadlock-layer-closure 输入 = LayerClosure 入参原样保留 + 前置死锁配置。 */
export interface DeadlockLayerClosureInput extends LayerClosureInput {
  /** 前置死锁步骤配置（缺省 = 12t3l 最小 dagT、中性偏好）。 */
  deadlock?: DeadlockPrefixSpec;
}

export interface DeadlockLayerClosureOutput extends LayerClosureOutput {
  /** 死锁报告（命中骨架、逐色闭包、深浅/疏密得分）。 */
  deadlock: DeadlockReport;
}

/** 前置步骤是否使用死锁花色排除口径（闭合率/债务指标不计入死锁牌；可切换）。 */
const EXCLUDE_DEADLOCK_FROM_METRICS = true;

// ── 候选过滤 ──

/**
 * 死锁候选牌：非 const、非 transfer/falling 结构、非棋盘特殊物（51/52/53/55）。
 * 其余地形牌（含 const）仍参与依赖图（路径可穿过）。
 */
export function eligibleDeadlockCandidates(terrain: TerrainData): TerrainTile[] {
  const allTiles = getAllTiles(terrain);
  const structuredIds = new Set<number>();
  for (const structure of terrain.terrainStructures ?? []) {
    for (const id of structure.tileIds) structuredIds.add(id);
  }
  return allTiles.filter(t =>
    !t.isConst
    && !structuredIds.has(t.id)
    && !DEADLOCK_EXCLUDED_EXTRA_ENUMS.has(t.extraEnum ?? 0));
}

// ── 主入口 ──

export function runDeadlockLayerClosureGen(input: DeadlockLayerClosureInput): DeadlockLayerClosureOutput {
  const {
    terrain,
    closeRates,
    colorCount,
    dock = MAX_DOCK_SLOTS,
    spreadParam,
    debtPersistenceWeight,
    colorAllocationMode,
    colorAllocationMaxRatio,
  } = input;
  const rng = input.rng ?? input.colorAllocationRng ?? Math.random;
  const p = Math.max(0, Math.min(1, debtPersistenceWeight ?? 0));

  const spec: Required<Pick<DeadlockPrefixSpec, 'tileCount' | 'layerLimit'>> & DeadlockPrefixSpec = {
    tileCount: input.deadlock?.tileCount ?? 12,
    layerLimit: input.deadlock?.layerLimit ?? 3,
    ...input.deadlock,
  };
  const t = spec.tileCount!;
  const l = spec.layerLimit!;
  const n = t / 3;
  const depthPreference = spec.depthPreference ?? 'neutral';
  const densityPreference = spec.densityPreference ?? 'neutral';
  const selectionSeed = spec.selectionSeed ?? 0;
  const searchLimit = spec.searchLimit ?? 256;
  const enumerationSeed = spec.enumerationSeed ?? 0;

  // ── 1. 校验 ──
  if (!Number.isInteger(n) || n < 4) {
    throw new Error(`deadlock tileCount ${t} 无效：须为 3 的倍数且 ≥ 12（每色 3 张、≥4 色）`);
  }
  if (l < 3) throw new Error(`deadlock layerLimit ${l} 无效：必死 DAG 至少 3 层`);
  const remainingColorCount = colorCount - n;
  if (remainingColorCount < 1) {
    throw new Error(`花色数 ${colorCount} 不足：死锁占 ${n} 色，剩余牌至少需要 1 色`);
  }

  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(tile => !tile.isConst);
  if (freeTiles.length % 3 !== 0) {
    throw new Error(`自由牌数量 ${freeTiles.length} 不是 3 的倍数`);
  }
  const remainingTileCount = freeTiles.length - t;
  if (remainingTileCount < 3 * remainingColorCount) {
    throw new Error(
      `剩余牌 ${remainingTileCount} 张不足以为 ${remainingColorCount} 种花色各分配 3 张`,
    );
  }

  const candidates = eligibleDeadlockCandidates(terrain);
  if (candidates.length < t) {
    throw new Error(`死锁候选牌 ${candidates.length} 张 < 所需 ${t} 张`);
  }

  // ── 2. 地形 DAG（传递后代 / 祖先，全地形口径） ──
  const tileMap = new Map<number, TerrainTile>();
  for (const tile of allTiles) tileMap.set(tile.id, tile);
  const depsOf = new Map<number, number[]>();
  for (const tile of allTiles) depsOf.set(tile.id, [...tile.dependencies]);
  const descendants = computeAllDependencies(allTiles);
  const ancestors = new Map<number, Set<number>>();
  for (const tile of allTiles) ancestors.set(tile.id, new Set());
  for (const [id, desc] of descendants) {
    for (const d of desc) ancestors.get(d)!.add(id);
  }

  // ── 3. 模板族（规范变体：染色依据变体表） ──
  const variant = canonicalVariant(t, l);

  // ── 4. 可达包含搜索（结构口径 + 闭包必要性剪枝） ──
  const depthById = computeDependencyDepth(allTiles, tileMap);
  const cores = searchDeadlockCores({
    variant,
    candidateTiles: candidates,
    depsOf,
    descendants,
    ancestors,
    depthById,
  }, {
    searchLimit,
    enumerationSeed,
    guide: depthPreference !== 'neutral' ? depthPreference : densityPreference,
  });
  if (cores.length === 0) {
    throw new Error(
      `未在地形中找到 ${t}t${l}l 最小 dagT（${variant.id}）的可达包含；`
      + `请换地形或调整 deadlock.tileCount / layerLimit`,
    );
  }

  // ── 5. 选择（wildcard 补全 + 深浅/疏密偏好 + 种子破平） ──
  const selectionCtx: SelectionContext = {
    depthById,
    posById: new Map(allTiles.map(tile => [tile.id, { x: tile.posX, y: tile.posY }])),
    depthPreference,
    densityPreference,
    selectionSeed,
  };
  const embedding = selectDeadlockEmbedding(variant, cores, depsOf, selectionCtx);
  if (!embedding) {
    throw new Error('死锁包含选择失败（全部候选未通过完整闭包验证）');
  }

  // ── 6. 按变体表染色：模板色号 → 实际花色 1..n ──
  const colorOfNode = new Map(variant.nodes.map(node => [node.id, node.color]));
  const deadlockAssignments = new Map<number, number>();
  for (const [nodeId, tileId] of embedding.mapping) {
    const color = (colorOfNode.get(nodeId) ?? 0) + 1;
    if (color < 1 || color > n) throw new Error(`模板花色越界: ${color}`);
    deadlockAssignments.set(tileId, color);
  }
  const deadlockTileIds = new Set(deadlockAssignments.keys());
  logger.info(
    `[Deadlock] ${t}t${l}l 命中 | 变体:${variant.id} | 花色:1..${n} `
    + `| 闭包:[${[...embedding.closures.values()].join(',')}] `
    + `| 深度得分:${embedding.depthScore.toFixed(2)} 密度得分:${embedding.densityScore.toFixed(1)}`,
  );
  logger.info(`[Deadlock] 映射: ${[...embedding.mapping.entries()]
    .sort((a, b) => a[0] - b[0]).map(([r, id]) => `${r}→${id}`).join(' ')}`);

  // ── 7. 剩余 3m 张牌走 LayerClosure（复用 layer-closure/ 模块） ──
  const logicalTerrain = buildGenerationLogicalLayers(terrain);
  const depthLayers = logicalTerrain.layers;
  const depthMap = logicalTerrain.depthById;

  // 容量与闭合率口径排除死锁牌（关闭开关则与 const 口径一致纳入）
  const metricExcluded = EXCLUDE_DEADLOCK_FROM_METRICS ? deadlockTileIds : undefined;
  const freeTilesPerDepth = depthLayers.map(layer =>
    layer.filter(tile => !tile.isConst && !deadlockTileIds.has(tile.id)).length);
  const allTilesPerDepth = depthLayers.map(layer =>
    layer.filter(tile => !deadlockTileIds.has(tile.id)).length);

  const totalTriplets = remainingTileCount / 3;
  const isSingleHeavy = colorAllocationMode === 'single-heavy';
  // single-heavy 先按最大花色生成（每三元组唯一源花色），完成落位后整组改色
  const generationColorTotalTiles = isSingleHeavy
    ? Array.from({ length: totalTriplets }, () => 3)
    : assignColorTotals(totalTriplets, remainingColorCount, 'balanced', rng);

  const { matrix } = buildMatrixByCloseRates(
    generationColorTotalTiles, freeTilesPerDepth, allTilesPerDepth, closeRates, p,
  );

  const sp = spreadParam ?? 0.5;
  const tileDepSets = computeTileDepSets(allTiles, tileMap);
  const placedAssignments = placeSuitsFromMatrixWithSpread(
    matrix, depthLayers, tileDepSets, sp, rng, deadlockTileIds,
  );

  let heavyColor = 0;
  let colorTotalTiles = generationColorTotalTiles;
  let singleHeavyRequestedTriplets = 0;
  let singleHeavyAppliedTriplets = 0;
  if (isSingleHeavy) {
    const sourceGroupCounts = new Map<number, number>();
    for (const sourceColor of placedAssignments.values()) {
      sourceGroupCounts.set(sourceColor, (sourceGroupCounts.get(sourceColor) ?? 0) + 1);
    }
    if (sourceGroupCounts.size !== totalTriplets || [...sourceGroupCounts.values()].some(count => count !== 3)) {
      throw new Error('single-heavy 最大花色生成结果不是“每个全局源花色恰好一个三元组”');
    }
    const plan = buildSingleHeavyTripletPlan(
      totalTriplets, remainingColorCount, colorAllocationMaxRatio ?? 1, rng,
    );
    for (const [tileId, sourceColor] of placedAssignments) {
      const targetColor = plan.colorBySourceTriplet[sourceColor - 1];
      if (targetColor == null) throw new Error(`缺少源花色 ${sourceColor} 的单色改色映射`);
      placedAssignments.set(tileId, targetColor);
    }
    heavyColor = plan.heavyColor;
    colorTotalTiles = plan.colorTripletCounts.map(count => count * 3);
    singleHeavyRequestedTriplets = plan.requestedHeavyTriplets;
    singleHeavyAppliedTriplets = plan.heavyTriplets;
  }

  // 剩余花色整体偏移到 n+1..K（死锁花色 1..n 独占）
  const finalAssignments = new Map<number, number>();
  for (const [tileId, color] of placedAssignments) finalAssignments.set(tileId, color + n);
  for (const [tileId, color] of deadlockAssignments) finalAssignments.set(tileId, color);

  // ── 8. 指标（死锁牌排除口径） ──
  const actualCloseRates = computeCloseRatesFromAssignments(finalAssignments, depthLayers, metricExcluded);
  const triplets = buildTriplets(finalAssignments, depthLayers, metricExcluded);
  const metrics = computeMetrics({
    assignments: finalAssignments,
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
    heavyColor: heavyColor > 0 ? heavyColor + n : 0,
    colorTotalTiles,
    excludedTileIds: metricExcluded,
  });
  if (isSingleHeavy) {
    metrics.singleHeavyRecolorStrategy = 'global-triplet-random';
    metrics.singleHeavySourceColorCount = totalTriplets;
    metrics.singleHeavyRequestedTriplets = singleHeavyRequestedTriplets;
    metrics.singleHeavyAppliedTriplets = singleHeavyAppliedTriplets;
  }

  logger.info(
    `[Deadlock+Closure] 完成 | 死锁:${t}张/${n}色 剩余:${remainingTileCount}张/${remainingColorCount}色 `
    + `| 闭合率:[${actualCloseRates.map(r => (r * 100).toFixed(0) + '%').join(', ')}] `
    + `| 峰值债务:${metrics.peakDebt} 暴露峰值:${metrics.peakExpDebt} OI:${metrics.oi}`,
  );

  // ── 9. 死锁报告 ──
  const deadlock: DeadlockReport = {
    variantId: variant.id,
    tileCount: t,
    layerLimit: l,
    deadlockColors: Array.from({ length: n }, (_, i) => i + 1),
    mapping: new Map(embedding.mapping),
    assignments: new Map(deadlockAssignments),
    closures: new Map(embedding.closures),
    depthScore: embedding.depthScore,
    densityScore: embedding.densityScore,
    remainingTileCount,
    remainingColorCount,
  };

  return { assignments: finalAssignments, triplets, metrics, deadlock };
}

// ── 向后兼容 re-export（供编排与调试复用） ──
export { DEADLOCK_EXCLUDED_EXTRA_ENUMS };
export type { DeadlockEmbedding, DeadlockPrefixSpec, DeadlockReport, DebtMetrics };
