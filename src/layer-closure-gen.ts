/**
 * LayerClosure（层闭合）花色分配算法 — v3 逐层约束满足。
 *
 * === 与 v1/v2 的本质区别 ===
 *
 * v1/v2: closeRates → 翻译成中间表示 → 分配 → 算 actualCloseRates（只展示）
 * v3:    closeRates → 每层直接求解"哪些颜色该闭合" → 分配 → actualCloseRates 尽量接近目标
 *
 * 不再有深度模式、配额、累积曲线、closureStyle 等中间概念。
 * 只做一件事：每层尽量让闭合颜色数 = round(closeRate × 总色数)。
 *
 * @module layer-closure-gen
 */

import type { TerrainTile, TerrainData, LayerClosureInput, LayerClosureOutput, DebtMetrics } from './types.js';
import { getAllTiles } from './terrain-loader.js';

// ═══════════════════════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════════════════════

export function runLayerClosureGen(input: LayerClosureInput): LayerClosureOutput {
  const { terrain, colorCount, dock, closeRates } = input;

  // ── 1. 提取自由牌，算依赖深度 ──
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(t => !t.isConst);
  const tileMap = new Map(freeTiles.map(t => [t.id, t]));

  if (freeTiles.length === 0) {
    return { assignments: new Map(), triplets: [], metrics: emptyMetrics() };
  }
  if (freeTiles.length % 3 !== 0) {
    throw new Error(`自由牌数量 ${freeTiles.length} 不是 3 的倍数`);
  }

  const depthMap = computeDependencyDepth(freeTiles, tileMap);
  const maxDepth = Math.max(...depthMap.values());
  const depthLayers: TerrainTile[][] = [];
  for (let d = 1; d <= maxDepth; d++) {
    depthLayers.push(freeTiles.filter(t => depthMap.get(t.id) === d));
  }

  // ── 2. 每色总牌数 ──
  const tilesPerDepth = depthLayers.map(l => l.length);
  const totalTriplets = freeTiles.length / 3;
  const colorTotalTiles = assignColorTotals(totalTriplets, colorCount);

  // ── 3. 逐层约束满足 → 矩阵 M[c][d] ──
  const { matrix, actualCloseRates } = buildMatrixByCloseRates(
    colorTotalTiles, tilesPerDepth, closeRates,
  );

  // ── 4. 矩阵 → 具体方块贴花色 ──
  const assignments = placeSuitsFromMatrix(matrix, depthLayers);

  // ── 5. 重建三元组 ──
  const triplets = buildTriplets(assignments, depthLayers);

  // ── 6. 难度指标 ──
  const metrics = computeMetrics(assignments, freeTiles, depthLayers, depthMap, tileMap, dock, colorCount, actualCloseRates);

  return { assignments, triplets, metrics };
}

// ═══════════════════════════════════════════════════════════
// 1. 依赖深度计算
// ═══════════════════════════════════════════════════════════

export function computeDependencyDepth(
  tiles: TerrainTile[],
  tileMap: Map<number, TerrainTile>,
): Map<number, number> {
  const depth = new Map<number, number>();

  function walk(tileId: number): number {
    const cached = depth.get(tileId);
    if (cached !== undefined) return cached;

    const tile = tileMap.get(tileId);
    if (!tile || tile.dependencies.length === 0) {
      depth.set(tileId, 1);
      return 1;
    }

    let maxDep = 0;
    for (const depId of tile.dependencies) {
      const d = walk(depId);
      if (d > maxDep) maxDep = d;
    }
    const result = maxDep + 1;
    depth.set(tileId, result);
    return result;
  }

  for (const tile of tiles) walk(tile.id);
  return depth;
}

// ═══════════════════════════════════════════════════════════
// 2. 每色总牌数
// ═══════════════════════════════════════════════════════════

function assignColorTotals(totalTriplets: number, colorCount: number): number[] {
  const base = Math.floor(totalTriplets / colorCount);
  const extra = totalTriplets % colorCount;
  const result: number[] = [];
  for (let c = 0; c < colorCount; c++) {
    result.push((base + (c < extra ? 1 : 0)) * 3);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════
// 3. 逐层约束满足：尽力让每层闭合颜色数 = target
// ═══════════════════════════════════════════════════════════

/**
 * 逐层分配。每层做一次简单的决策：
 *   "当前有 X 个颜色闭合，目标是 Y 个 → 需要关掉或打开几个颜色"
 *
 * 决策在容量（该层方块数）和物理（颜色剩余牌数）约束下进行。
 * 不保证完美命中，但会往目标方向尽力。
 *
 * @returns { matrix, actualCloseRates }
 */
function buildMatrixByCloseRates(
  colorTotalTiles: number[],
  tilesPerDepth: number[],
  closeRates: number[],
): { matrix: number[][]; actualCloseRates: number[] } {
  const C = colorTotalTiles.length;
  const D = tilesPerDepth.length;

  // 活跃颜色（有牌的）
  const active = new Set<number>();
  for (let c = 0; c < C; c++) {
    if (colorTotalTiles[c] > 0) active.add(c);
  }
  const A = active.size; // activeColorCount

  // 补全 closeRates
  const fullRates = [...closeRates];
  while (fullRates.length < D) fullRates.push(1.0);

  // 状态追踪
  const cumulative = new Array(C).fill(0); // 已分配数
  const remaining = [...colorTotalTiles];   // 剩余待分配
  const M: number[][] = Array.from({ length: C }, () => new Array(D).fill(0));
  const actualCloseRates: number[] = [];

  for (let d = 0; d < D; d++) {
    const capacity = tilesPerDepth[d];

    // 目标闭合数
    const targetClosed = d === D - 1
      ? A  // 最后一层全闭合
      : clamp(Math.round(fullRates[d] * A), 0, A);

    // 当前闭合数
    const currentlyClosed = countClosed(cumulative, active);

    // ── 决策：需要改几个颜色的状态 ──
    const toClose: number[] = []; // 需要从开→关的颜色
    const toOpen: number[] = [];  // 需要从关→开的颜色

    if (targetClosed > currentlyClosed) {
      const need = targetClosed - currentlyClosed;
      // 从"开着且有剩牌"的颜色中挑 need 个，优先挑关闭成本低的
      const candidates = [...active]
        .filter(c => cumulative[c] % 3 !== 0 && remaining[c] > 0)
        .sort((a, b) => closeCost(cumulative[a]) - closeCost(cumulative[b]));
      for (let i = 0; i < Math.min(need, candidates.length); i++) {
        toClose.push(candidates[i]);
      }
    } else if (targetClosed < currentlyClosed) {
      const need = currentlyClosed - targetClosed;
      // 从"关着且有剩牌"的颜色中挑 need 个
      const candidates = [...active]
        .filter(c => cumulative[c] % 3 === 0 && remaining[c] > 0)
        .sort((a, b) => remaining[a] - remaining[b]);
      for (let i = 0; i < Math.min(need, candidates.length); i++) {
        toOpen.push(candidates[i]);
      }
    }

    // ── 分配：先满足状态变更，再填满容量 ──
    const plan: number[] = new Array(C).fill(0);
    let used = 0;

    // 第一轮：状态变更的最小需求
    for (const c of toClose) {
      const need = 3 - (cumulative[c] % 3); // 1 或 2（因为开着，cum%3=1或2）
      const give = Math.min(need, remaining[c], capacity - used);
      if (give > 0) {
        plan[c] += give;
        used += give;
      }
    }
    for (const c of toOpen) {
      const need = 1; // 最小 1 张即可把关变开
      const give = Math.min(need, remaining[c], capacity - used);
      if (give > 0) {
        plan[c] += give;
        used += give;
      }
    }

    // 第二轮：给还没被满足的状态变更补票（如果容量够）
    for (const c of toClose) {
      const stillNeed = (3 - ((cumulative[c] + plan[c]) % 3)) % 3;
      if (stillNeed > 0) {
        const give = Math.min(stillNeed, remaining[c] - plan[c], capacity - used);
        if (give > 0) {
          plan[c] += give;
          used += give;
        }
      }
    }

    // 第三轮：填满剩余容量（在"不破坏目标状态"的前提下）
    if (used < capacity) {
      let slack = capacity - used;

      // 给关着的颜色加 3 张（关→...→关）
      const byRemaining = [...active].sort((a, b) =>
        (remaining[b] - plan[b]) - (remaining[a] - plan[a]),
      );
      for (const c of byRemaining) {
        if (slack <= 0) break;
        const maxAdd = remaining[c] - plan[c];
        if (maxAdd <= 0) continue;
        const triplets = Math.floor(maxAdd / 3);
        if (triplets > 0) {
          const give = Math.min(triplets * 3, slack);
          plan[c] += give;
          used += give;
          slack -= give;
        }
      }

      if (slack > 0) {
        for (const c of byRemaining) {
          if (slack <= 0) break;
          const maxAdd = remaining[c] - plan[c];
          if (maxAdd <= 0) continue;
          const curMod = (cumulative[c] + plan[c]) % 3;
          const safe = curMod === 1 ? [1, 3] : curMod === 2 ? [2, 3] : [1, 2];
          for (const s of safe) {
            if (slack <= 0) break;
            const give = Math.min(s, maxAdd, slack);
            if (give > 0 && (curMod + give) % 3 !== 0) {
              plan[c] += give;
              used += give;
              slack -= give;
            }
          }
        }
      }

      // 实在填不满就算了
    }

    // ── 应用计划 ──
    for (let c = 0; c < C; c++) {
      const assign = Math.min(plan[c], remaining[c]);
      M[c][d] = assign;
      cumulative[c] += assign;
      remaining[c] -= assign;
    }

    // ── 记录实际闭合率 ──
    const actualClosed = countClosed(cumulative, active);
    actualCloseRates.push(A > 0 ? actualClosed / A : 0);
  }

  return { matrix: M, actualCloseRates };
}

/** 闭合成本：一个开着（cum%3≠0）的颜色需要几张牌才能闭合 */
function closeCost(cum: number): number {
  const r = cum % 3;
  return r === 0 ? 0 : 3 - r;
}

/** 数目前闭合的颜色数 */
function countClosed(cumulative: number[], active: Set<number>): number {
  let n = 0;
  for (const c of active) {
    if (cumulative[c] % 3 === 0) n++;
  }
  return n;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ═══════════════════════════════════════════════════════════
// 4. 矩阵 → 具体方块贴花色
// ═══════════════════════════════════════════════════════════

function placeSuitsFromMatrix(
  matrix: number[][],
  depthLayers: TerrainTile[][],
): Map<number, number> {
  const assignments = new Map<number, number>();
  const D = depthLayers.length;
  const C = matrix.length;

  for (let d = 0; d < D; d++) {
    const pool = depthLayers[d].map(t => t.id).filter(id => !assignments.has(id));

    for (let c = 0; c < C; c++) {
      const count = matrix[c][d];
      if (count <= 0) continue;

      for (let i = 0; i < count; i++) {
        if (pool.length === 0) break;
        const idx = Math.floor(Math.random() * pool.length);
        const tileId = pool.splice(idx, 1)[0];
        assignments.set(tileId, c + 1);
      }
    }
  }

  return assignments;
}

// ═══════════════════════════════════════════════════════════
// 5. 重建三元组
// ═══════════════════════════════════════════════════════════

function buildTriplets(
  assignments: Map<number, number>,
  depthLayers: TerrainTile[][],
): Array<{ suitIndex: number; depths: [number, number, number] }> {
  const depthOf = new Map<number, number>();
  for (let d = 0; d < depthLayers.length; d++) {
    for (const t of depthLayers[d]) {
      depthOf.set(t.id, d + 1);
    }
  }

  const bySuit = new Map<number, Array<{ tileId: number; depth: number }>>();
  for (const [tileId, suit] of assignments) {
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

function computeMetrics(
  assignments: Map<number, number>,
  tiles: TerrainTile[],
  depthLayers: TerrainTile[][],
  depthMap: Map<number, number>,
  tileMap: Map<number, TerrainTile>,
  dock: number,
  colorCount: number,
  actualCloseRates: number[],
): DebtMetrics {
  const D = depthLayers.length;
  const totalTiles = tiles.length;
  const tilesPerLayer = depthLayers.map(l => l.length);

  const suitCounts = new Map<number, number>();
  for (const [, suit] of assignments) {
    suitCounts.set(suit, (suitCounts.get(suit) ?? 0) + 1);
  }
  const allSuitsClosed = [...suitCounts.values()].every(c => c % 3 === 0);
  const assignedColorCount = suitCounts.size;

  // debtByLayer: 纯累计
  const cumSuitCounts = new Map<number, number>();
  const debtByLayer: number[] = [];
  for (let d = 0; d < D; d++) {
    for (const tile of depthLayers[d]) {
      const suit = assignments.get(tile.id);
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
    computeExpDebt(tiles, depthLayers, depthMap, tileMap, assignments, dock);

  // 遮挡
  let totalEdges = 0, sameColorEdges = 0, crossColorEdges = 0;
  for (const tile of tiles) {
    totalEdges += tile.dependencies.length;
    const mySuit = assignments.get(tile.id);
    for (const depId of tile.dependencies) {
      const depSuit = assignments.get(depId);
      if (mySuit !== undefined && depSuit !== undefined) {
        if (mySuit === depSuit) sameColorEdges++;
        else crossColorEdges++;
      }
    }
  }

  const averageOcclusion = totalTiles > 0 ? totalEdges / totalTiles : 0;

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
    averageOcclusion: Math.round(averageOcclusion * 100) / 100,
    totalEdges,
    sameColorEdges,
    crossColorEdges,
    allSuitsClosed,
    isDoomed: peakDebt > dock,
  };
}

function computeExpDebt(
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
        depId => cleared.has(depId) || !tileMap.has(depId),
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

function emptyMetrics(): DebtMetrics {
  return {
    depthCount: 0, totalTiles: 0, tilesPerLayer: [],
    debtByLayer: [], expDebtByLayer: [], peakDebt: 0, peakExpDebt: 0,
    oi: 0, consecutiveOI: 0, colorCount: 0, actualCloseRates: [],
    averageOcclusion: 0, totalEdges: 0, sameColorEdges: 0, crossColorEdges: 0,
    allSuitsClosed: true, isDoomed: false,
  };
}
