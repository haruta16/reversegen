/**
 * LayerClosure（层闭合）花色分配算法。
 *
 * === 与 CostLadder 的区别 ===
 *
 * CostLadder 通过 cost 目标数组控制"每一步消除的难度"，
 * LayerClosure 通过"每层闭合率"控制"同时产生债务的花色数"。
 *
 * === 核心思路 ===
 *
 * 1. 把所有方块按依赖关系算出"深度"（被多少层方块压着）
 * 2. 按深度分层，每层有一定数量的方块
 * 3. 用户设定每层的"闭合率"：到该层为止，多少比例的花色计数是 3 的倍数
 * 4. 算法把花色拆成三元组分配到各层，满足闭合率约束
 * 5. 最终统计"债务"（未闭合花色数）是否超过 Dock 容量 → 是否必输
 *
 * === 关键概念 ===
 *
 * - 闭合 (closed): 某花色的方块总数是 3 的倍数 → 可以完整消除
 * - 债务 (debt): 某花色的方块总数不是 3 的倍数 → 会有剩余卡在手里
 * - 暴露债务 (expDebt): 考虑依赖解锁后，玩家实际能看到的债务
 *
 * @module layer-closure-gen
 */

import type { TerrainTile, TerrainData, LayerClosureInput, LayerClosureOutput, DebtMetrics } from './types.js';
import { getAllTiles } from './terrain-loader.js';

// ═══════════════════════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════════════════════

export function runLayerClosureGen(input: LayerClosureInput): LayerClosureOutput {
  const {
    terrain,
    colorCount,
    dock,
    closeRates,
    spread,
  } = input;

  // ── 1. 提取自由牌，算依赖深度 ──
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(t => !t.isConst);
  const tileMap = new Map(freeTiles.map(t => [t.id, t]));

  if (freeTiles.length === 0) {
    return { assignments: new Map(), triplets: [], metrics: emptyMetrics() };
  }
  if (freeTiles.length % 3 !== 0) {
    throw new Error(`自由牌数量 ${freeTiles.length} 不是 3 的倍数，无法构成完整三元组`);
  }

  const depthMap = computeDependencyDepth(freeTiles, tileMap);
  const maxDepth = Math.max(...depthMap.values());

  // 按深度分组
  const depthLayers: TerrainTile[][] = [];
  for (let d = 1; d <= maxDepth; d++) {
    depthLayers.push(freeTiles.filter(t => depthMap.get(t.id) === d));
  }

  // ── 2. 花色值 = 1..colorCount（与 CostLadder 一致，由 ReplaySerializer 归一化）──
  const suits = Array.from({ length: colorCount }, (_, i) => i + 1);

  // ── 3. 闭合率 → 每层三元组配额 ──
  const totalTriplets = freeTiles.length / 3;
  const quotas = closeRatesToQuotas(closeRates, depthLayers, totalTriplets, colorCount);

  // ── 4. 生成深度模式 + 按配额分配 ──
  const patterns = makeDepthPatterns(maxDepth);
  const triplets = allocateTriplets(quotas, patterns, depthLayers, spread, colorCount);

  // ── 5. 把三元组的花色写到具体方块上 ──
  const assignments = placeSuitsOnTiles(triplets, depthLayers, suits);

  // ── 5b. 补齐未被主分配覆盖的方块（容量约束导致的残留）──
  const leftoverTriplets = fillRemainingTiles(assignments, depthLayers, suits, colorCount);
  triplets.push(...leftoverTriplets);

  // ── 6. 计算难度指标 ──
  const metrics = computeMetrics(assignments, freeTiles, depthLayers, depthMap, tileMap, dock);

  return { assignments, triplets, metrics };
}

// ═══════════════════════════════════════════════════════════
// 1. 依赖深度计算
// ═══════════════════════════════════════════════════════════

/**
 * 方块在依赖链上的深度。
 * 不依赖任何方块的 → 深度 1（表层，玩家可以直接点）。
 * 依赖深度为 d 的方块 → 自身深度 = d + 1。
 */
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
// 2. 闭合率 → 三元组配额
// ═══════════════════════════════════════════════════════════

/**
 * 把用户设定的闭合率转换为每层需要分配的三元组数量。
 *
 * 闭合率 = 到该层为止，花色计数可被 3 整除的花色占比。
 * 闭合率越高 → 该层已闭合的花色越多 → 债务越少 → 越简单。
 *
 * 例：24 个方块 = 8 个三元组，3 层深度。
 *   closeRates = [0.25, 0.5]（第3层自动100%）
 *   层1(12方块): 闭合率 25% → 闭合 3 方块 → 1 个三元组
 *   层2(18方块): 闭合率 50% → 闭合 9 方块 → 3 个三元组 → 新增 2 个
 *   层3(24方块): 闭合率 100% → 闭合 24 方块 → 8 个三元组 → 新增 5 个
 *   quotas = [1, 2, 5]
 */
function closeRatesToQuotas(
  rates: number[],
  depthLayers: TerrainTile[][],
  totalTriplets: number,
  colorCount: number,
): number[] {
  const D = depthLayers.length;
  // 补全：最后一层闭合率固定 100%
  const fullRates = [...rates];
  while (fullRates.length < D) fullRates.push(1.0);

  // 累计方块数
  const cumTiles = [0];
  for (let d = 1; d <= D; d++) {
    cumTiles[d] = cumTiles[d - 1] + depthLayers[d - 1].length;
  }

  let prevClosed = 0;
  const quotas: number[] = [];

  for (let m = 1; m <= D; m++) {
    const total = cumTiles[m];
    const maxClosed = Math.floor(total / 3) * 3;

    // 从闭合率换算闭合方块数，并对齐 3 的倍数
    let closedTiles = Math.round(fullRates[m - 1] * total);
    closedTiles = Math.round(closedTiles / 3) * 3;
    closedTiles = Math.min(closedTiles, maxClosed);

    // 闭合数只能递增（浅层已闭合的花色，深层自然也闭合了）
    if (closedTiles < prevClosed) closedTiles = prevClosed;

    // 花色硬下限：给定 tile 总数和花色数，最少闭合数
    const minClosed = suitMinClosed(total, colorCount);
    if (closedTiles < minClosed) closedTiles = minClosed;

    const newTriplets = Math.max(0, (closedTiles - prevClosed) / 3);
    quotas.push(newTriplets);
    prevClosed = closedTiles;
  }

  // 尾差补齐（浮点累积误差修正）
  const sum = quotas.reduce((a, b) => a + b, 0);
  if (sum !== totalTriplets) {
    quotas[quotas.length - 1] += totalTriplets - sum;
  }

  return quotas;
}

/**
 * 花色数约束的硬下限。
 * 给定 total 个方块和 colorCount 种花色，最多允许 2×colorCount 个方块作为
 * "余数"（每种花色最多剩 2 个凑不满 3），其余方块必须能整除 3。
 */
function suitMinClosed(total: number, colorCount: number): number {
  let maxWaste = Math.min(2 * colorCount, total);
  while (maxWaste >= 0 && (total - maxWaste) % 3 !== 0) {
    maxWaste--;
  }
  if (maxWaste < 0) return 0;
  return total - maxWaste;
}

// ═══════════════════════════════════════════════════════════
// 3. 深度模式 + 三元组分配
// ═══════════════════════════════════════════════════════════

/** 生成所有合法的三元组深度模式 [a,b,c]，a≤b≤c */
function makeDepthPatterns(maxDepth: number): Map<number, [number, number, number][]> {
  const byMax = new Map<number, [number, number, number][]>();
  for (let m = 1; m <= maxDepth; m++) byMax.set(m, []);

  for (let a = 1; a <= maxDepth; a++) {
    for (let b = a; b <= maxDepth; b++) {
      for (let c = b; c <= maxDepth; c++) {
        byMax.get(c)!.push([a, b, c]);
      }
    }
  }

  return byMax;
}

/**
 * 按配额把三元组分配到各层的深度模式上。
 *
 * spread 控制花色在深度上的分布偏好：
 *   0 = 浅层优先（同花色尽量用浅层方块 → 早闭合 → 宽松）
 *   100 = 深层优先（同花色尽量用深层方块 → 晚闭合 → 严苛）
 */
function allocateTriplets(
  quotas: number[],
  patternsByMax: Map<number, [number, number, number][]>,
  depthLayers: TerrainTile[][],
  spread: number,
  colorCount: number,
): Array<{ suitIndex: number; depths: [number, number, number] }> {
  const result: Array<{ suitIndex: number; depths: [number, number, number] }> = [];
  const D = quotas.length;

  // 每层剩余可用的方块数
  const cap = depthLayers.map(l => l.length);
  let suitIdx = 0; // 花色轮流计数器

  for (let m = 1; m <= D; m++) {
    let remaining = quotas[m - 1];
    const pats = patternsByMax.get(m);
    if (!pats || pats.length === 0 || remaining <= 0) continue;

    // 按 spread 排序：spread=0 浅层模式先，100 深层模式先
    const sorted = sortPatternsBySpread(pats, m, spread);

    for (const pattern of sorted) {
      if (remaining <= 0) break;

      // 容量约束：该模式最多能用几次（受各层剩余方块数限制）
      const depthNeeds = new Map<number, number>();
      for (const d of pattern) {
        depthNeeds.set(d, (depthNeeds.get(d) || 0) + 1);
      }

      let maxUses = remaining;
      for (const [d, need] of depthNeeds) {
        maxUses = Math.min(maxUses, Math.floor(cap[d - 1] / need));
      }
      if (maxUses <= 0) continue;

      // 分配
      for (let i = 0; i < maxUses; i++) {
        result.push({
          suitIndex: suitIdx % colorCount,
          depths: [...pattern] as [number, number, number],
        });
        suitIdx++;
      }

      // 扣减容量
      for (const [d, need] of depthNeeds) {
        cap[d - 1] -= need * maxUses;
      }
      remaining -= maxUses;
    }
  }

  return result;
}

/**
 * 按 spread 对深度模式排序。
 *
 * 每个模式有一个"浅度分" shallowScore：最浅的深度越浅，分越高。
 * spread=0 → 浅度分高的模式优先（浅层分布）
 * spread=100 → 浅度分低的模式优先（深层集中）
 */
function sortPatternsBySpread(
  patterns: [number, number, number][],
  maxDepth: number,
  spread: number,
): [number, number, number][] {
  const bias = spread / 100;

  return [...patterns].sort((p, q) => {
    // shallowScore: 模式的最浅深度越浅 → 分数越高 (1 = 全部在浅层, 0 = 全部在深层)
    const shallowA = maxDepth > 1 ? 1 - (p[0] - 1) / (maxDepth - 1) : 1;
    const shallowB = maxDepth > 1 ? 1 - (q[0] - 1) / (maxDepth - 1) : 1;

    // 混合：bias=0 选 shallowScore 高的，bias=1 选 shallowScore 低的
    const scoreA = bias * (1 - shallowA) + (1 - bias) * shallowA;
    const scoreB = bias * (1 - shallowB) + (1 - bias) * shallowB;
    return scoreA - scoreB;
  });
}

// ═══════════════════════════════════════════════════════════
// 4. 把花色落实到具体方块
// ═══════════════════════════════════════════════════════════

/**
 * 根据三元组分配结果，给每个方块上色。
 * 对于每个三元组，在其指定的各深度层中随机选一个未上色的方块。
 */
function placeSuitsOnTiles(
  triplets: Array<{ suitIndex: number; depths: [number, number, number] }>,
  depthLayers: TerrainTile[][],
  suits: number[],
): Map<number, number> {
  const assignments = new Map<number, number>();

  // 每层"尚未上色"的方块 ID 列表
  const available: number[][] = depthLayers.map(layer =>
    layer.map(t => t.id),
  );

  for (const { suitIndex, depths } of triplets) {
    const suitValue = suits[suitIndex];
    for (const d of depths) {
      const pool = available[d - 1];
      if (pool.length === 0) continue; // 理论上不应出现（容量约束已保证），防御性处理
      const idx = Math.floor(Math.random() * pool.length);
      const tileId = pool.splice(idx, 1)[0];
      assignments.set(tileId, suitValue);
    }
  }

  return assignments;
}

/**
 * 补齐未被主分配覆盖的方块。
 * 主分配受容量约束可能无法覆盖全部方块（如浅层方块耗尽后深层模式无法继续）。
 * 此函数将剩余方块按深度顺序组成三元组，轮流分配花色。
 *
 * @returns 新增的三元组列表（供调试/展示）
 */
function fillRemainingTiles(
  assignments: Map<number, number>,
  depthLayers: TerrainTile[][],
  suits: number[],
  colorCount: number,
): Array<{ suitIndex: number; depths: [number, number, number] }> {
  // 收集未上色的方块
  const remaining: Array<{ tile: TerrainTile; depth: number }> = [];
  for (let d = 0; d < depthLayers.length; d++) {
    for (const tile of depthLayers[d]) {
      if (!assignments.has(tile.id)) {
        remaining.push({ tile, depth: d + 1 });
      }
    }
  }

  if (remaining.length === 0) return [];
  if (remaining.length % 3 !== 0) return []; // 不应出现（总数必定是 3 的倍数）

  // 按深度排序：浅层优先
  remaining.sort((a, b) => a.depth - b.depth);

  const added: Array<{ suitIndex: number; depths: [number, number, number] }> = [];
  // 从 suits 已用轮次之后开始（避免破坏既有花色分布）
  let suitIdx = [...new Set(assignments.values())].length;

  for (let i = 0; i < remaining.length; i += 3) {
    const depths: [number, number, number] = [
      remaining[i].depth,
      remaining[i + 1].depth,
      remaining[i + 2].depth,
    ].sort((a, b) => a - b) as [number, number, number];

    const suit = suits[suitIdx % colorCount];
    for (let j = 0; j < 3; j++) {
      assignments.set(remaining[i + j].tile.id, suit);
    }
    added.push({ suitIndex: suitIdx % colorCount, depths });
    suitIdx++;
  }

  return added;
}

// ═══════════════════════════════════════════════════════════
// 5. 难度指标计算
// ═══════════════════════════════════════════════════════════

function computeMetrics(
  assignments: Map<number, number>,
  tiles: TerrainTile[],
  depthLayers: TerrainTile[][],
  depthMap: Map<number, number>,
  tileMap: Map<number, TerrainTile>,
  dock: number,
): DebtMetrics {
  const D = depthLayers.length;
  const maxDepth = D;

  // ── 基础统计 ──
  const tilesPerLayer = depthLayers.map(l => l.length);
  const totalTiles = tiles.length;

  // ── 花色-数量验证 ──
  const suitCounts = new Map<number, number>();
  for (const [tileId, suit] of assignments) {
    suitCounts.set(suit, (suitCounts.get(suit) ?? 0) + 1);
  }

  const allSuitsClosed = [...suitCounts.values()].every(c => c % 3 === 0);
  const assignedColorCount = suitCounts.size;

  // ── 逐层债务（不考虑依赖解锁，纯累计统计）──
  // 到深度 d 为止，已出现但计数不是 3 的倍数的花色数
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

  // ── 暴露债务（模拟玩家实际能看到的）──
  // 考虑：(1) 已凑满 3 个的自动消除 (2) 深层被挡住的方块不计入
  const { expDebtByLayer, peakExpDebt, oi, consecutiveOI } =
    computeExpDebt(tiles, depthLayers, depthMap, tileMap, assignments, dock);

  // ── 实际闭合率 ──
  const actualCloseRates: number[] = [];
  for (let d = 0; d < D; d++) {
    const closed = assignedColorCount - debtByLayer[d];
    actualCloseRates.push(assignedColorCount > 0 ? closed / assignedColorCount : 0);
  }

  // ── 遮挡边统计 ──
  let totalEdges = 0;
  let sameColorEdges = 0;
  let crossColorEdges = 0;

  for (const tile of tiles) {
    const deps = tile.dependencies;
    totalEdges += deps.length;
    const mySuit = assignments.get(tile.id);
    for (const depId of deps) {
      const depSuit = assignments.get(depId);
      if (mySuit !== undefined && depSuit !== undefined) {
        if (mySuit === depSuit) sameColorEdges++;
        else crossColorEdges++;
      }
    }
  }

  const averageOcclusion = totalTiles > 0 ? totalEdges / totalTiles : 0;

  // ── 必输判定 ──
  const isDoomed = peakDebt > dock;

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
    isDoomed,
  };
}

/**
 * 计算"暴露债务"——模拟玩家推进到每层时实际面临的手牌压力。
 *
 * 算法逻辑（模拟贪心消除）：
 *   1. 到深度 L 为止，统计所有方块的花色计数
 *   2. 对能凑满 3 个的花色，标记对应方块为"已消除"
 *   3. 深度 > L 的方块中，若其所有依赖都已被消除 → "暴露"给玩家
 *   4. 统计暴露 + 未消除方块中，花色不是 3 的倍数的数量
 *
 * 这比 debtByLayer 更接近真实游戏体验，
 * 因为它考虑了"深层方块暂时卡不到玩家"这个事实。
 */
function computeExpDebt(
  tiles: TerrainTile[],
  depthLayers: TerrainTile[][],
  depthMap: Map<number, number>,
  tileMap: Map<number, TerrainTile>,
  assignments: Map<number, number>,
  dock: number,
): {
  expDebtByLayer: number[];
  peakExpDebt: number;
  oi: number;
  consecutiveOI: number;
} {
  const maxDepth = depthLayers.length;
  const expByLayer: number[] = [];
  let peakExpDebt = 0;
  let oi = 0;
  let consecutiveOI = 0;
  let currentConsecutive = 0;

  for (let L = 1; L <= maxDepth; L++) {
    // 1. 深度 ≤ L 且有花色的方块
    const inRange = tiles.filter(
      t => depthMap.get(t.id)! <= L && assignments.has(t.id),
    );

    // 2. 统计花色计数
    const countBySuit = new Map<number, number>();
    for (const t of inRange) {
      const s = assignments.get(t.id)!;
      countBySuit.set(s, (countBySuit.get(s) ?? 0) + 1);
    }

    // 3. 贪心消除：凑满 3 个的标记清除
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

    // 4. 未消除的方块（会卡在手里）
    const unresolved = inRange.filter(t => !cleared.has(t.id));

    // 5. 深度 > L 的方块：如果依赖全部已清除 → 暴露
    const exposed = [...unresolved];
    for (const t of tiles) {
      if (depthMap.get(t.id)! <= L) continue;
      if (!assignments.has(t.id)) continue;
      if (exposed.includes(t)) continue;

      // 检查所有依赖是否已清除（或该方块不在 tileMap 中 => 已移除）
      const allDepsCleared = t.dependencies.every(
        depId => cleared.has(depId) || !tileMap.has(depId),
      );
      if (allDepsCleared) {
        exposed.push(t);
      }
    }

    // 6. 统计暴露方块中的债务
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

    // 超载统计
    const excess = Math.max(0, debt - dock);
    oi += excess;
    if (excess > 0) {
      currentConsecutive++;
      if (currentConsecutive > consecutiveOI) {
        consecutiveOI = currentConsecutive;
      }
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
    depthCount: 0,
    totalTiles: 0,
    tilesPerLayer: [],
    debtByLayer: [],
    expDebtByLayer: [],
    peakDebt: 0,
    peakExpDebt: 0,
    oi: 0,
    consecutiveOI: 0,
    colorCount: 0,
    actualCloseRates: [],
    averageOcclusion: 0,
    totalEdges: 0,
    sameColorEdges: 0,
    crossColorEdges: 0,
    allSuitsClosed: true,
    isDoomed: false,
  };
}
