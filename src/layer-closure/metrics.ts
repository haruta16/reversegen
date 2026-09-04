/**
 * LayerClosure · 指标模块。
 *
 * 三元组重建、真实闭合率、债务/暴露债务/超载指数、花色使用率、
 * 债务保留率、债务持续直方图、遮挡统计与同色离散率。
 */

import type { TerrainTile, DebtMetrics, ColorAllocationMode } from '../types.js';

/**
 * 按层序重建三元组。契约：assignments 的牌必须全部出现在 depthLayers 中
 * （生成路径满足：自由牌 ⊆ 逻辑层）；不在层内的赋值牌会被忽略。
 */
export function buildTriplets(
  assignments: Map<number, number>,
  depthLayers: TerrainTile[][],
  excludedTileIds?: Set<number>,
): Array<{ suitIndex: number; depths: [number, number, number] }> {
  const depthOf = new Map<number, number>();
  const allAssignments = new Map<number, number>();
  for (let d = 0; d < depthLayers.length; d++) {
    for (const t of depthLayers[d]) {
      depthOf.set(t.id, d + 1);
      if (excludedTileIds?.has(t.id)) continue;
      const color = t.isConst && t.constElementValue > 0 ? t.constElementValue : assignments.get(t.id);
      if (color !== undefined && color > 0) allAssignments.set(t.id, color);
    }
  }

  const bySuit = new Map<number, Array<{ tileId: number; depth: number }>>();
  for (const [tileId, suit] of allAssignments) {
    const depth = depthOf.get(tileId) ?? 1;
    if (!bySuit.has(suit)) bySuit.set(suit, []);
    bySuit.get(suit)!.push({ tileId, depth });
  }

  const triplets: Array<{ suitIndex: number; depths: [number, number, number] }> = [];
  for (const [suit, tiles] of bySuit) {
    tiles.sort((a, b) => a.depth - b.depth);
    for (let i = 0; i + 2 < tiles.length; i += 3) {
      const depths = [
        tiles[i].depth, tiles[i + 1].depth, tiles[i + 2].depth,
      ].sort((a, b) => a - b) as [number, number, number];
      triplets.push({ suitIndex: suit - 1, depths });
    }
  }

  return triplets;
}

// ═══════════════════════════════════════════════════════════
// 6. 难度指标
// ═══════════════════════════════════════════════════════════

/**
 * 从真实花色分配和深度分层计算逐层闭合率。
 *
 * 与 buildMatrixByCloseRates 不同的是，此函数基于「实际落色结果」而非「分配计划」。
 * 生成路径在贴花色后调用，导入路径从 replaycode 的花色映射调用。
 * 两者使用同一个函数，保证闭合率计算口径一致。
 *
 * 公式：closeRates[d] = completedTriplets / totalPossibleTriplets
 *   - completedTriplets = Σ⌊cum[c] ÷ 3⌋（已完成的 triplet 数）
 *   - totalPossibleTriplets = ⌊Σcum[c] ÷ 3⌋（累积 tile 数对应的可能 triplet 数）
 */
export function computeCloseRatesFromAssignments(
  assignments: Map<number, number>,
  depthLayers: TerrainTile[][],
  excludedTileIds?: Set<number>,
): number[] {
  const cumByColor = new Map<number, number>();
  const closeRates: number[] = [];

  for (const layer of depthLayers) {
    // 累加本层方块（排除指定牌：如死锁牌，其 triplet 永不闭合，不计入口径）
    for (const tile of layer) {
      if (excludedTileIds?.has(tile.id)) continue;
      const color = tile.isConst ? tile.constElementValue : (assignments.get(tile.id) ?? 0);
      if (color > 0) {
        cumByColor.set(color, (cumByColor.get(color) ?? 0) + 1);
      }
    }

    // 计算 triplet 完成率
    let completedTriplets = 0;
    let totalTiles = 0;
    for (const cum of cumByColor.values()) {
      completedTriplets += Math.floor(cum / 3);
      totalTiles += cum;
    }
    const totalPossible = Math.floor(totalTiles / 3);
    closeRates.push(totalPossible > 0 ? completedTriplets / totalPossible : 0);
  }

  return closeRates;
}

/**
 * 合并自由牌花色 + const 牌花色，供指标计算使用。
 * const 牌的花色视为已知的 assignments。
 */
function allTileAssignments(
  assignments: Map<number, number>,
  depthLayers: TerrainTile[][],
): Map<number, number> {
  const merged = new Map(assignments);
  for (const layer of depthLayers) {
    for (const t of layer) {
      if (t.isConst && t.constElementValue > 0) {
        merged.set(t.id, t.constElementValue);
      }
    }
  }
  return merged;
}

/** computeMetrics 的输入（原 14 个位置参数改为具名对象）。 */
export interface ComputeMetricsInput {
  /** 自由牌花色分配（const 花色在函数内合并） */
  assignments: Map<number, number>;
  /** 参与统计的牌（生成路径传自由牌） */
  tiles: TerrainTile[];
  /** 依赖深度分层（每层一个 TerrainTile 数组） */
  depthLayers: TerrainTile[][];
  /** tileId → 依赖深度 */
  depthMap: Map<number, number>;
  /** tileId → tile（全量，含 const） */
  tileMap: Map<number, TerrainTile>;
  /** tileId → depSet（自身 + 传递闭包） */
  tileDepSets: Map<number, Set<number>>;
  /** Dock 槽位容量 */
  dock: number;
  /** 花色数（回显用） */
  colorCount: number;
  /** 实际逐层闭合率 */
  actualCloseRates: number[];
  /** 债务持续权重 p（回显） */
  debtPersistenceWeight: number;
  /** 债务最大跨层数（新版参数，回显） */
  debtPersistenceLayers?: number;
  /** 花色配额方式（回显） */
  colorAllocationMode?: ColorAllocationMode;
  /** single-heavy 主花色（回显） */
  heavyColor?: number;
  /** 各花色 triplet 组数（回显） */
  colorTotalTiles?: number[];
  /**
   * 闭合率/三元组/逐层进度口径排除的 tileId（如死锁牌：其 triplet 永不闭合）。
   * 依赖结构（expDebt / 遮挡 / 离散率）仍按全量计算。缺省 = 不排除。
   */
  excludedTileIds?: Set<number>;
}

export function computeMetrics(input: ComputeMetricsInput): DebtMetrics {
  const {
    assignments,
    tiles,
    depthLayers,
    depthMap,
    tileMap,
    tileDepSets,
    dock,
    colorCount,
    actualCloseRates,
    debtPersistenceWeight,
    debtPersistenceLayers,
    colorAllocationMode,
    heavyColor,
    colorTotalTiles: colorTotalTilesArg,
    excludedTileIds,
  } = input;
  const D = depthLayers.length;
  const totalTiles = tiles.length;
  const tilesPerLayer = depthLayers.map(l => l.length);

  const allAssign = allTileAssignments(assignments, depthLayers);

  const suitCounts = new Map<number, number>();
  for (const [, suit] of allAssign) {
    suitCounts.set(suit, (suitCounts.get(suit) ?? 0) + 1);
  }
  const allSuitsClosed = [...suitCounts.values()].every(c => c % 3 === 0);
  const assignedColorCount = suitCounts.size;

  const { colorUsageRates, averageColorActivationLayer, debtTileCountsByLayer,
    debtRetentionRates, weightedDebtRetentionRate,
    retainedOldDebtTilesByLayer: metricsRetained, debtDurationHistogram } =
    computeLayerProgressMetrics(allAssign, depthLayers, excludedTileIds);

  // 逐层保留旧债务 tile 数必须采用落色后的事实统计。
  const retainedOldDebtTilesByLayer = metricsRetained;
  const totalRetainedOldDebtTiles = retainedOldDebtTilesByLayer.reduce((a, b) => a + b, 0);

  // debtByLayer: 纯累计（含 const 花色；排除指定牌如死锁牌）
  const cumSuitCounts = new Map<number, number>();
  const debtByLayer: number[] = [];
  for (let d = 0; d < D; d++) {
    for (const tile of depthLayers[d]) {
      if (excludedTileIds?.has(tile.id)) continue;
      const suit = allAssign.get(tile.id);
      if (suit !== undefined) {
        cumSuitCounts.set(suit, (cumSuitCounts.get(suit) ?? 0) + 1);
      }
    }
    let debt = 0;
    for (const count of cumSuitCounts.values()) {
      if (count % 3 !== 0) debt++;
    }
    debtByLayer.push(debt);
  }

  const peakDebt = Math.max(...debtByLayer, 0);

  // expDebt
  const { expDebtByLayer, peakExpDebt, oi, consecutiveOI } =
    computeExpDebt(tiles, depthLayers, depthMap, tileMap, allAssign, dock);

  // 遮挡
  let totalEdges = 0, sameColorEdges = 0, crossColorEdges = 0;
  for (const tile of tiles) {
    totalEdges += tile.dependencies.length;
    const mySuit = allAssign.get(tile.id);
    for (const depId of tile.dependencies) {
      const depSuit = allAssign.get(depId);
      if (mySuit !== undefined && depSuit !== undefined) {
        if (mySuit === depSuit) sameColorEdges++;
        else crossColorEdges++;
      }
    }
  }

  const averageOcclusion = totalTiles > 0 ? totalEdges / totalTiles : 0;

  // ── 同色分布度量 ──
  let suitSpread = 0;
  let suitSpreadNorm = 0;
  const suitColors = [...suitCounts.keys()];
  if (suitColors.length > 0) {
    let totalOverlap = 0;
    let totalNorm = 0;
    for (const suit of suitColors) {
      // 收集该花色所有 tile 的 depSet
      const depSets: Set<number>[] = [];
      for (const [tid, s] of allAssign) {
        if (s === suit) {
          const ds = tileDepSets.get(tid);
          if (ds) depSets.push(new Set(ds));
        }
      }
      if (depSets.length === 0) continue;

      // 领土并集 ∪
      const union = new Set<number>();
      let sumSizes = 0;
      let maxSize = 0;
      for (const ds of depSets) {
        sumSizes += ds.size;
        if (ds.size > maxSize) maxSize = ds.size;
        for (const node of ds) union.add(node);
      }

      // overlapRate = |union| / sum(|depSet|)
      totalOverlap += sumSizes > 0 ? union.size / sumSizes : 1;

      // normalizedSpread = (|union| - max|depSet|) / (sum|depSet| - max|depSet|)
      const denom = sumSizes - maxSize;
      totalNorm += denom > 0 ? (union.size - maxSize) / denom : 0;
    }
    suitSpread = Math.round(totalOverlap / suitColors.length * 10000) / 10000;
    suitSpreadNorm = Math.round(totalNorm / suitColors.length * 10000) / 10000;
  }

  return {
    depthCount: D,
    totalTiles,
    tilesPerLayer,
    debtByLayer,
    expDebtByLayer,
    peakDebt,
    peakExpDebt,
    oi,
    consecutiveOI,
    colorCount: assignedColorCount,
    actualCloseRates,
    colorUsageRates,
    averageColorActivationLayer,
    debtTileCountsByLayer,
    debtRetentionRates,
    weightedDebtRetentionRate,
    configuredDebtPersistenceWeight: debtPersistenceWeight,
    configuredDebtPersistenceLayers: debtPersistenceLayers,
    retainedOldDebtTilesByLayer,
    totalRetainedOldDebtTiles,
    debtDurationHistogram,
    averageOcclusion: Math.round(averageOcclusion * 100) / 100,
    totalEdges,
    sameColorEdges,
    crossColorEdges,
    allSuitsClosed,
    isDoomed: peakDebt > dock,
    suitSpread,
    suitSpreadNorm,
    colorAllocationMode,
    heavyColor: heavyColor ?? 0,
    colorTripletCounts: colorTotalTilesArg?.map(t => t / 3),
  };
}

/**
 * 计算与闭合率同层级的累计花色/债务指标。
 *
 * - 花色使用率按 1~L 累计出现花色数计算。
 * - 债务 tile 是每色累计数量除以 3 后的余数牌。
 * - 债务保留率按具体旧债务 tile 加权：若下一层新增牌足以完成该色当前三连，
 *   该色的旧债务 tile 全部解除；否则全部保留。
 */
export function computeLayerProgressMetrics(
  assignments: Map<number, number>,
  depthLayers: TerrainTile[][],
  excludedTileIds?: Set<number>,
): {
  colorUsageRates: number[];
  averageColorActivationLayer: number;
  debtTileCountsByLayer: number[];
  debtRetentionRates: number[];
  weightedDebtRetentionRate: number;
  retainedOldDebtTilesByLayer: number[];
  debtDurationHistogram: number[];
} {
  const allColors = new Set<number>();
  for (const [tileId, color] of assignments) {
    if (excludedTileIds?.has(tileId)) continue;
    allColors.add(color);
  }
  const totalColors = allColors.size;
  const D = depthLayers.length;
  const cumulative = new Map<number, number>();
  const colorUsageRates: number[] = [];
  const debtTileCountsByLayer: number[] = [];
  const debtRetentionRates: number[] = [];
  const retainedOldDebtTilesByLayer: number[] = [];
  const activationLayer = new Map<number, number>();
  let totalPreviousDebtTiles = 0;
  let totalRetainedDebtTiles = 0;

  // 债务段追踪：每色 cum%3 从 0→非0 记出生层，非0→0 记清除层
  const debtStart = new Map<number, number>(); // color → 出生层(1-indexed)
  const debtDurationHistogram = new Array<number>(D).fill(0);

  for (let d = 0; d < D; d++) {
    const additions = new Map<number, number>();
    for (const tile of depthLayers[d]) {
      if (excludedTileIds?.has(tile.id)) continue;
      const color = assignments.get(tile.id);
      if (color === undefined) continue;
      additions.set(color, (additions.get(color) ?? 0) + 1);
    }

    if (d > 0) {
      let previousDebtTiles = 0;
      let retainedDebtTiles = 0;
      for (const [color, count] of cumulative) {
        const remainder = count % 3;
        if (remainder === 0) continue;
        previousDebtTiles += remainder;
        const added = additions.get(color) ?? 0;
        if (added < 3 - remainder) retainedDebtTiles += remainder;
      }
      debtRetentionRates.push(previousDebtTiles > 0
        ? retainedDebtTiles / previousDebtTiles
        : 0);
      retainedOldDebtTilesByLayer.push(retainedDebtTiles);
      totalPreviousDebtTiles += previousDebtTiles;
      totalRetainedDebtTiles += retainedDebtTiles;
    }

    // 累加并检测债务段状态转换（出生/清除）
    for (const [color, count] of additions) {
      if (!activationLayer.has(color)) activationLayer.set(color, d + 1);
      const prev = cumulative.get(color) ?? 0;
      const next = prev + count;
      const prevR = prev % 3;
      const nextR = next % 3;
      // 出生：0 → 非0
      if (prevR === 0 && nextR !== 0) {
        debtStart.set(color, d + 1);
      }
      // 清除：非0 → 0
      if (prevR !== 0 && nextR === 0) {
        const start = debtStart.get(color);
        if (start !== undefined) {
          // 持续长度 = 债务实际存在过的层末端点数。
          // 若第 start 层末出生，并在当前层被清除，则当前层末已不再是债务，所以不计当前层。
          const dur = (d + 1) - start;
          if (dur >= 1 && dur <= D) debtDurationHistogram[dur - 1]++;
          debtStart.delete(color);
        }
      }
      cumulative.set(color, next);
    }

    colorUsageRates.push(totalColors > 0 ? cumulative.size / totalColors : 0);
    let debtTiles = 0;
    for (const count of cumulative.values()) debtTiles += count % 3;
    debtTileCountsByLayer.push(debtTiles);
  }

  // 到最后一层仍未清除的债务段：持续 = D - 出生层 + 1
  for (const [color, start] of debtStart) {
    const dur = D - start + 1;
    if (dur >= 1 && dur <= D) debtDurationHistogram[dur - 1]++;
  }

  const averageColorActivationLayer = activationLayer.size > 0
    ? [...activationLayer.values()].reduce((a, b) => a + b, 0) / activationLayer.size
    : 0;
  const weightedDebtRetentionRate = totalPreviousDebtTiles > 0
    ? totalRetainedDebtTiles / totalPreviousDebtTiles
    : 0;
  return { colorUsageRates, averageColorActivationLayer, debtTileCountsByLayer,
    debtRetentionRates, weightedDebtRetentionRate,
    retainedOldDebtTilesByLayer, debtDurationHistogram };
}

export function computeExpDebt(
  tiles: TerrainTile[],
  depthLayers: TerrainTile[][],
  depthMap: Map<number, number>,
  tileMap: Map<number, TerrainTile>,
  assignments: Map<number, number>,
  dock: number,
): { expDebtByLayer: number[]; peakExpDebt: number; oi: number; consecutiveOI: number } {
  const maxDepth = depthLayers.length;
  const expByLayer: number[] = [];
  let peakExpDebt = 0;
  let oi = 0;
  let consecutiveOI = 0;
  let currentConsecutive = 0;

  for (let L = 1; L <= maxDepth; L++) {
    const inRange = tiles.filter(t => depthMap.get(t.id)! <= L && assignments.has(t.id));
    const countBySuit = new Map<number, number>();
    for (const t of inRange) {
      const s = assignments.get(t.id)!;
      countBySuit.set(s, (countBySuit.get(s) ?? 0) + 1);
    }

    const cleared = new Set<number>();
    for (const [suit, count] of countBySuit) {
      if (count < 3) continue;
      const toClear = Math.floor(count / 3) * 3;
      let removed = 0;
      for (const t of inRange) {
        if (removed >= toClear) break;
        if (assignments.get(t.id) === suit && !cleared.has(t.id)) {
          cleared.add(t.id);
          removed++;
        }
      }
    }

    const unresolved = inRange.filter(t => !cleared.has(t.id));
    const exposed = [...unresolved];
    for (const t of tiles) {
      if (depthMap.get(t.id)! <= L) continue;
      if (!assignments.has(t.id)) continue;
      if (exposed.includes(t)) continue;
      const allDepsCleared = t.dependencies.every(
        depId => cleared.has(depId),
      );
      if (allDepsCleared) exposed.push(t);
    }

    const expCountBySuit = new Map<number, number>();
    for (const t of exposed) {
      const s = assignments.get(t.id)!;
      expCountBySuit.set(s, (expCountBySuit.get(s) ?? 0) + 1);
    }

    let debt = 0;
    for (const count of expCountBySuit.values()) {
      if (count % 3 !== 0) debt++;
    }

    expByLayer.push(debt);
    if (debt > peakExpDebt) peakExpDebt = debt;
    const excess = Math.max(0, debt - dock);
    oi += excess;
    if (excess > 0) {
      currentConsecutive++;
      if (currentConsecutive > consecutiveOI) consecutiveOI = currentConsecutive;
    } else {
      currentConsecutive = 0;
    }
  }

  return { expDebtByLayer: expByLayer, peakExpDebt, oi, consecutiveOI };
}

// ═══════════════════════════════════════════════════════════
// 辅助
// ═══════════════════════════════════════════════════════════

export function emptyMetrics(): DebtMetrics {
  return {
    depthCount: 0, totalTiles: 0, tilesPerLayer: [],
    debtByLayer: [], expDebtByLayer: [], peakDebt: 0, peakExpDebt: 0,
    oi: 0, consecutiveOI: 0, colorCount: 0, actualCloseRates: [],
    colorUsageRates: [], debtTileCountsByLayer: [], debtRetentionRates: [],
    averageColorActivationLayer: 0, weightedDebtRetentionRate: 0,
    configuredDebtPersistenceWeight: 0, retainedOldDebtTilesByLayer: [],
    totalRetainedOldDebtTiles: 0, debtDurationHistogram: [],
    averageOcclusion: 0, totalEdges: 0, sameColorEdges: 0, crossColorEdges: 0,
    allSuitsClosed: true, isDoomed: false,
    suitSpread: 0, suitSpreadNorm: 0,
    heavyColor: 0, colorTripletCounts: [],
  };
}
