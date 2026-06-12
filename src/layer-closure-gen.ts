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
  const { terrain, colorCount, dock, closeRates, spreadParam } = input;

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

  // ── 4. 矩阵 → 具体方块贴花色（支持 spreadParam 控制分布）──
  const sp = spreadParam ?? 0.5;
  const tileDepSets = computeTileDepSets(freeTiles, tileMap);
  const assignments = placeSuitsFromMatrixWithSpread(matrix, depthLayers, tileDepSets, sp);

  // ── 5. 重建三元组 ──
  const triplets = buildTriplets(assignments, depthLayers);

  // ── 6. 难度指标 ──
  const metrics = computeMetrics(assignments, freeTiles, depthLayers, depthMap, tileMap, tileDepSets, dock, colorCount, actualCloseRates);

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

    // ── 闭合预算检查：后续容量必须足够闭合所有花色 ──
    // 这是 mod3 硬约束的前瞻保障：如果 closeRates 要求保持太多花色开放，
    // 导致最终层容量不足以闭合全部花色，则在此层强制多闭合几个。
    if (d < D - 1) {
      let projectedDebt = 0;
      for (const c of active) {
        projectedDebt += (3 - (cumulative[c] % 3)) % 3;
      }
      for (const c of toClose) {
        projectedDebt -= closeCost(cumulative[c]);
      }
      for (const _ of toOpen) {
        projectedDebt += 2; // 闭合→开放：产生 2 张牌的债务
      }
      let futureCapacity = 0;
      for (let dd = d + 1; dd < D; dd++) {
        futureCapacity += tilesPerDepth[dd];
      }
      if (projectedDebt > futureCapacity) {
        let excess = projectedDebt - futureCapacity;
        const forceCloseCandidates = [...active]
          .filter(c => cumulative[c] % 3 !== 0 && remaining[c] > 0 && !toClose.includes(c))
          .sort((a, b) => closeCost(cumulative[a]) - closeCost(cumulative[b]));
        for (const c of forceCloseCandidates) {
          if (excess <= 0) break;
          excess -= closeCost(cumulative[c]);
          toClose.push(c);
        }
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

    // 第三轮：填满剩余容量
    if (used < capacity) {
      let slack = capacity - used;

      const byRemaining = [...active].sort((a, b) =>
        (remaining[b] - plan[b]) - (remaining[a] - plan[a]),
      );

      if (d === D - 1) {
        // ── 最后一层：闭合优先（close-fill），绝不做 safe-fill ──
        // Step A: 闭合所有仍开着的花色
        for (const c of byRemaining) {
          if (slack <= 0) break;
          const cur = cumulative[c] + plan[c];
          const need = (3 - (cur % 3)) % 3;
          if (need > 0) {
            const maxAdd = remaining[c] - plan[c];
            const give = Math.min(need, maxAdd, slack);
            if (give > 0) {
              plan[c] += give;
              used += give;
              slack -= give;
            }
          }
        }
        // Step B: 剩余容量只给 3 的倍数（保持闭合，绝不重新打开）
        for (const c of byRemaining) {
          if (slack <= 0) break;
          const maxAdd = remaining[c] - plan[c];
          if (maxAdd < 3) continue;
          const triplets = Math.floor(maxAdd / 3);
          const give = Math.min(triplets * 3, slack);
          if (give > 0) {
            plan[c] += give;
            used += give;
            slack -= give;
          }
        }
      } else {
        // ── 中间层：safe-fill（尽量不破坏目标闭合状态）──
        // Step A: 给 3 的倍数
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
        // Step B: safe-fill — 每次迭代重算 curMod 和 maxAdd
        if (slack > 0) {
          for (const c of byRemaining) {
            if (slack <= 0) break;
            let maxAdd = remaining[c] - plan[c];
            if (maxAdd <= 0) continue;
            let curMod = (cumulative[c] + plan[c]) % 3;
            const safe = curMod === 1 ? [1, 3] : curMod === 2 ? [2, 3] : [1, 2];
            for (const s of safe) {
              if (slack <= 0) break;
              // ★ 每次重算：plan[c] 已在上轮 s 迭代中更新
              maxAdd = remaining[c] - plan[c];
              curMod = (cumulative[c] + plan[c]) % 3;
              const give = Math.min(s, maxAdd, slack);
              if (give > 0 && (curMod + give) % 3 !== 0) {
                plan[c] += give;
                used += give;
                slack -= give;
              }
            }
          }
        }
      }

      // ── 兜底：如果仍填不满，强制填满（闭合率是软目标，mod3 是硬约束）──
      if (slack > 0) {
        for (const c of byRemaining) {
          if (slack <= 0) break;
          const maxAdd = remaining[c] - plan[c];
          if (maxAdd <= 0) continue;
          const give = Math.min(maxAdd, slack);
          plan[c] += give;
          used += give;
          slack -= give;
        }
      }
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
// 4. 矩阵 → 具体方块贴花色（花色领土增量控制）
// ═══════════════════════════════════════════════════════════

/**
 * 为每个 tile 计算其 depSet：自身 + 传递依赖闭包。
 */
function computeTileDepSets(
  tiles: TerrainTile[],
  tileMap: Map<number, TerrainTile>,
): Map<number, Set<number>> {
  const cache = new Map<number, Set<number>>();

  function collect(tileId: number): Set<number> {
    const cached = cache.get(tileId);
    if (cached) return cached;

    const depSet = new Set<number>();
    depSet.add(tileId);

    const tile = tileMap.get(tileId);
    if (tile) {
      for (const depId of tile.dependencies) {
        const sub = collect(depId);
        for (const x of sub) depSet.add(x);
      }
    }

    cache.set(tileId, depSet);
    return depSet;
  }

  for (const tile of tiles) collect(tile.id);
  return cache;
}

/**
 * 逐层贴花色 — 按"花色领土增量"控制同色 tile 在依赖图中的分布。
 *
 * === 核心度量：领土增量 ===
 *
 * 每个花色维护一个累计并集 U = 该花色已分配 tiles 的 depSet 的并集。
 * 候选 tile T 的"增量" = |depSet(T) \ U|，即 T 带来了多少个 U 里还没有
 * 的依赖节点。这是**可数的物理量**，不需要归一化、不需要权重、不需要
 * softmax。
 *
 * === 参数行为 ===
 *
 *   spreadParam = 0  → cluster（选增量最小的 → 不扩张领土 → 容易收集）
 *   spreadParam = 1  → spread （选增量最大的 → 扩张领土   → 难以收集）
 *   中间值           → 用 coin flip 混合策略与随机，连续过渡
 *
 * === 关键性质 ===
 *
 * - 第一张牌不会再盲选：U=∅ 时增量 = depSet 大小。cluster 选 depSet
 *   最小的（表层牌 → 更容易围过来），spread 选 depSet 最大的（深层牌 →
 *   拉开距离）。
 * - 没有平均（不会洗掉信号）、没有 softmax（没有魔法常数）、没有归一化。
 * - 极端值 100% 确定性选择。只有平局时随机打破。
 */
function placeSuitsFromMatrixWithSpread(
  matrix: number[][],
  depthLayers: TerrainTile[][],
  tileDepSets: Map<number, Set<number>>,
  spreadParam: number,
): Map<number, number> {
  const assignments = new Map<number, number>();
  const D = depthLayers.length;
  const C = matrix.length;

  // 每个花色的累计领土（已分配 tiles 的 depSet 并集）
  const territory = new Map<number, Set<number>>();

  for (let d = 0; d < D; d++) {
    const pool = new Set(depthLayers[d].map(t => t.id).filter(id => !assignments.has(id)));

    // 本层各花色的配额
    const colorsNeeded: Array<{ color: number; count: number }> = [];
    for (let c = 0; c < C; c++) {
      if (matrix[c][d] > 0) {
        colorsNeeded.push({ color: c + 1, count: matrix[c][d] });
      }
    }

    // 约束多的先选：已分配 tile 多的花色优先
    colorsNeeded.sort((a, b) => {
      const ta = territory.get(a.color);
      const tb = territory.get(b.color);
      return (tb?.size ?? 0) - (ta?.size ?? 0);
    });

    for (const { color, count } of colorsNeeded) {
      // 确保该花色的领土集存在
      if (!territory.has(color)) {
        territory.set(color, new Set<number>());
      }
      const U = territory.get(color)!;

      for (let i = 0; i < count; i++) {
        if (pool.size === 0) break;

        const candidates = [...pool];
        const scores = new Array<number>(candidates.length);

        // 对每个候选，算增量：|depSet \ U|
        for (let j = 0; j < candidates.length; j++) {
          const ds = tileDepSets.get(candidates[j])!;
          let inc = 0;
          for (const node of ds) {
            if (!U.has(node)) inc++;
          }
          scores[j] = inc;
        }

        // ── 选择 ──
        const chosenTileId = selectTile(candidates, scores, spreadParam);

        pool.delete(chosenTileId);
        assignments.set(chosenTileId, color);

        // 扩张领土：把选中 tile 的 depSet 节点加入 U
        const chosenDS = tileDepSets.get(chosenTileId)!;
        for (const node of chosenDS) {
          U.add(node);
        }
      }
    }
  }

  return assignments;
}

/**
 * 根据 spreadParam 从候选列表中选一张 tile。
 *
 * 策略：
 *   spreadParam ≤ 0  → 硬选增量最小的
 *   spreadParam ≥ 1  → 硬选增量最大的
 *   0 < sp < 0.5     → 以 bias=(0.5-sp)×2 的概率选最小，其余随机
 *   sp = 0.5         → 均匀随机
 *   0.5 < sp < 1     → 以 bias=(sp-0.5)×2 的概率选最大，其余随机
 *
 * 无评分、无权重、无 softmax、无魔法常数。
 */
function selectTile(
  candidates: number[],
  scores: number[],
  spreadParam: number,
): number {
  // ── 极端值：确定性选择 ──
  if (spreadParam <= 0) return pickMin(candidates, scores);
  if (spreadParam >= 1) return pickMax(candidates, scores);

  // ── 中性：均匀随机 ──
  const bias = Math.abs(spreadParam - 0.5) * 2; // 0(中性) ~ 1(极端)
  if (bias < 0.001) {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  // ── 中间值：coin flip 混合 ──
  if (Math.random() < bias) {
    // 倾向策略
    return spreadParam < 0.5
      ? pickMin(candidates, scores)
      : pickMax(candidates, scores);
  } else {
    // 随机
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
}

/** 从候选列表中选增量最小的 tile（多个并列时随机打破平局） */
function pickMin(candidates: number[], scores: number[]): number {
  let minScore = Infinity;
  let minIndices: number[] = [];
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] < minScore) {
      minScore = scores[i];
      minIndices = [i];
    } else if (scores[i] === minScore) {
      minIndices.push(i);
    }
  }
  return candidates[minIndices[Math.floor(Math.random() * minIndices.length)]];
}

/** 从候选列表中选增量最大的 tile（多个并列时随机打破平局） */
function pickMax(candidates: number[], scores: number[]): number {
  let maxScore = -Infinity;
  let maxIndices: number[] = [];
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] > maxScore) {
      maxScore = scores[i];
      maxIndices = [i];
    } else if (scores[i] === maxScore) {
      maxIndices.push(i);
    }
  }
  return candidates[maxIndices[Math.floor(Math.random() * maxIndices.length)]];
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
  tileDepSets: Map<number, Set<number>>,
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
      for (const [tid, s] of assignments) {
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
    averageOcclusion: Math.round(averageOcclusion * 100) / 100,
    totalEdges,
    sameColorEdges,
    crossColorEdges,
    allSuitsClosed,
    isDoomed: peakDebt > dock,
    suitSpread,
    suitSpreadNorm,
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
    suitSpread: 0, suitSpreadNorm: 0,
  };
}
