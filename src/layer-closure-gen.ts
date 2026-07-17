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
 * @module layer-closure-gen
 */

import type { TerrainTile, TerrainData, LayerClosureInput, LayerClosureOutput, DebtMetrics, ColorAllocationMode } from './types.js';
import { getAllTiles } from './terrain-loader.js';

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

  const depthMap = computeDependencyDepth(allTiles, tileMap);
  const maxDepth = Math.max(...depthMap.values());
  const depthLayers: TerrainTile[][] = [];
  for (let d = 1; d <= maxDepth; d++) {
    depthLayers.push(allTiles.filter(t => depthMap.get(t.id) === d)); // 全量分层
  }

  // ── 2. 分层统计 ──
  const freeTilesPerDepth = depthLayers.map(l => l.filter(t => !t.isConst).length);
  const allTilesPerDepth = depthLayers.map(l => l.length);
  const totalTriplets = freeTiles.length / 3;
  const colorTotalTiles = assignColorTotals(totalTriplets, colorCount, colorAllocationMode, rng, colorAllocationMaxRatio);
  const heavyColor = colorAllocationMode === 'single-heavy'
    ? colorTotalTiles.indexOf(Math.max(...colorTotalTiles)) + 1
    : 0;

  // ── 3. 逐层约束满足 → 矩阵 M[c][d] ──
  const { matrix, retainedOldDebtTilesByLayer } = buildMatrixByCloseRates(
    colorTotalTiles, freeTilesPerDepth, allTilesPerDepth, closeRates, p,
  );

  // ── 4. 矩阵 → 具体方块贴花色（仅自由牌参与选择）──
  const sp = spreadParam ?? 0.5;
  const tileDepSets = computeTileDepSets(allTiles, tileMap);
  const assignments = placeSuitsFromMatrixWithSpread(matrix, depthLayers, tileDepSets, sp, rng);

  // ── 5. 真实闭合率（const 花色参与累积）──
  const actualCloseRates = computeCloseRatesFromAssignments(assignments, depthLayers);

  // ── 6. 重建三元组（const 也参与）──
  const triplets = buildTriplets(assignments, depthLayers);

  // ── 7. 难度指标（const 全面参与）──
  const metrics = computeMetrics(assignments, allTiles, depthLayers, depthMap, tileMap, tileDepSets, dock, colorCount, actualCloseRates, p, retainedOldDebtTilesByLayer, colorAllocationMode, heavyColor, colorTotalTiles);

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

/**
 * 将 totalTriplets 组牌按 mode 分配给 colorCount 种花色。
 *
 * - balanced: 均匀分配，每色约 totalTriplets / colorCount 组，余数摊给前几个花色。
 * - single-heavy: 随机选一个主花色，其余 K-1 色各 1 组，主花色获得 T-K+1 组。
 *
 * 返回值是每色 tile 数（triplet 数 × 3）。
 */
export function assignColorTotals(
  totalTriplets: number,
  colorCount: number,
  mode: ColorAllocationMode = 'balanced',
  rng: () => number = Math.random,
  maxHeavyRatio?: number,
): number[] {
  if (colorCount > totalTriplets) {
    if (mode === 'single-heavy' && totalTriplets === colorCount) {
      // 每色只能一组，退化为均匀分配
      return Array.from({ length: colorCount }, () => 3);
    }
    throw new Error(
      `花色数 ${colorCount} 超过可用 triplet 组数 ${totalTriplets}，无法分配`,
    );
  }

  if (mode === 'single-heavy') {
    // 随机选一个主花色；限制主色后，剩余组数在其他花色间均分。
    const heavyColor = Math.floor(rng() * colorCount);
    const unconstrainedHeavy = totalTriplets - colorCount + 1;
    const ratio = maxHeavyRatio == null ? 1 : Math.max(0, Math.min(1, maxHeavyRatio));
    const cappedHeavy = Math.floor(totalTriplets * ratio);
    const heavyTriplets = colorCount === 1
      ? totalTriplets
      : Math.max(1, Math.min(unconstrainedHeavy, cappedHeavy));
    const rest = totalTriplets - heavyTriplets;
    const otherBase = colorCount > 1 ? Math.floor(rest / (colorCount - 1)) : 0;
    let otherExtra = colorCount > 1 ? rest % (colorCount - 1) : 0;
    const result: number[] = [];
    for (let c = 0; c < colorCount; c++) {
      if (c === heavyColor) {
        result.push(heavyTriplets * 3);
      } else {
        result.push((otherBase + (otherExtra-- > 0 ? 1 : 0)) * 3);
      }
    }
    return result;
  }

  // balanced (默认)
  const base = Math.floor(totalTriplets / colorCount);
  const extra = totalTriplets % colorCount;
  const result: number[] = [];
  for (let c = 0; c < colorCount; c++) {
    result.push((base + (c < extra ? 1 : 0)) * 3);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════
// 3. 逐层约束满足：尽力让每层已完成 triplet 数 = target
// ═══════════════════════════════════════════════════════════

/**
 * 逐层分配。每层做一次简单的决策：
 *   "当前完成了 X 个 triplet，目标是 Y 个 → 需要多完成几个 triplet"
 *
 * 决策在容量（该层方块数）和物理（颜色剩余牌数）约束下进行。
 * 不保证完美命中，但会往目标方向尽力。
 *
 * 闭合率的单位是 triplet（组），不是颜色。花色是手段，闭合率是结果。
 *
 * 债务持续权重 p 控制"下一层债务中保留多少旧债务 tile"：
 *   目标保留 = round(p × min(本层旧债务 tile 数, 下一层债务 tile 数))
 *   p=0 → 优先闭合旧债务色（清旧债）；p=1 → 优先闭合非债务色（留旧债）。
 *   p 是软目标，closeRate(数量)与 mod3 闭合预算(硬约束)优先。
 *
 * @returns { matrix, actualCloseRates, retainedOldDebtTilesByLayer }
 */
function buildMatrixByCloseRates(
  colorTotalTiles: number[],
  freeTilesPerDepth: number[],
  allTilesPerDepth: number[],
  closeRates: number[],
  debtPersistenceWeight: number,
): { matrix: number[][]; actualCloseRates: number[]; retainedOldDebtTilesByLayer: number[] } {
  const C = colorTotalTiles.length;
  const D = freeTilesPerDepth.length;
  const p = debtPersistenceWeight;

  // 活跃颜色（有牌的）
  const active = new Set<number>();
  for (let c = 0; c < C; c++) {
    if (colorTotalTiles[c] > 0) active.add(c);
  }

  // 补全 closeRates
  const fullRates = [...closeRates];
  while (fullRates.length < D) fullRates.push(1.0);

  // 状态追踪
  const cumulative = new Array(C).fill(0); // 已分配数
  const remaining = [...colorTotalTiles];   // 剩余待分配
  const M: number[][] = Array.from({ length: C }, () => new Array(D).fill(0));
  const actualCloseRates: number[] = [];
  const retainedOldDebtTilesByLayer: number[] = [];

  // 全量累积牌数（用于 P = ⌊全量 ÷ 3⌋，闭合率分母包含 const）
  let allCumulative = 0;

  for (let d = 0; d < D; d++) {
    const capacity = freeTilesPerDepth[d]; // 本层分配容量（仅自由牌）

    // ── 目标完成 triplet 数 ──
    // P = 本层后的 triplet 总数上限（分母：全量累积，含 const）
    const allTilesAfter = allCumulative + allTilesPerDepth[d];
    const P = Math.floor(allTilesAfter / 3);
    const target = d === D - 1
      ? P  // 最后一层：全部完成
      : clamp(Math.round(fullRates[d] * P), 0, P);

    // 当前已完成 triplet 数
    const currentlyCompleted = countCompletedTriplets(cumulative);

    // ── 决策：需要多完成几个 triplet ──
    // 每关闭 1 个颜色 = 完成 1 个 triplet
    const toClose: number[] = []; // 需要完成 triplet 的颜色
    const toOpen: number[] = [];  // 需要"打开"的颜色（target < current 时极少触发）

    if (target > currentlyCompleted) {
      const need = target - currentlyCompleted;

      // ── 债务持续权重 p：决定本层闭合多少旧债务色 vs 非债务色 ──
      // oldDebtTiles = 进入本层前的旧债务 tile 总数（Σ cum%3，非0项）
      // nextDebtTiles = 本层末债务 tile 总数（累计 tile − 已闭合 tile）
      // targetRetained = round(p × min(oldDebtTiles, nextDebtTiles))
      // oldDebtToClear = oldDebtTiles − targetRetained（本层应清掉的旧债务 tile 数）
      const oldDebt = [...active].filter(c => cumulative[c] % 3 !== 0 && remaining[c] > 0);
      const oldDebtTiles = oldDebt.reduce((s, c) => s + (cumulative[c] % 3), 0);
      const nextDebtTiles = Math.max(0, allTilesAfter - target * 3);
      const targetRetained = Math.round(p * Math.min(oldDebtTiles, nextDebtTiles));
      const oldDebtToClear = Math.max(0, oldDebtTiles - targetRetained);

      // 旧债务色按 r=cum%3 降序（r=2 先清，单色清 2 tile 且只需 1 张牌，性价比高）
      oldDebt.sort((a, b) => (cumulative[b] % 3) - (cumulative[a] % 3));

      // 1) 选旧债务色子集，Σ r_c ≈ oldDebtToClear，数量 ≤ need
      const toCloseOld: number[] = [];
      let clearedTiles = 0;
      for (const c of oldDebt) {
        if (toCloseOld.length >= need) break;
        if (clearedTiles >= oldDebtToClear) break;
        toCloseOld.push(c);
        clearedTiles += cumulative[c] % 3;
      }

      // 2) 补足 need：优先非债务色（cum%3=0，闭合不动旧债 → 保留旧债）
      //    非债务色需 remaining≥3 才能凑出一个 triplet
      const nonDebt = [...active].filter(c =>
        cumulative[c] % 3 === 0 && remaining[c] >= 3 && !toCloseOld.includes(c));
      const toCloseNew: number[] = [];
      for (const c of nonDebt) {
        if (toCloseOld.length + toCloseNew.length >= need) break;
        toCloseNew.push(c);
      }

      // 3) 仍不够（非债务色余量不足）→ 被迫从剩余旧债务色补（动旧债，实际保留 < 目标）
      if (toCloseOld.length + toCloseNew.length < need) {
        for (const c of oldDebt) {
          if (toCloseOld.includes(c)) continue;
          if (toCloseOld.length + toCloseNew.length >= need) break;
          toCloseOld.push(c);
        }
      }

      toClose.push(...toCloseOld, ...toCloseNew);
    } else if (target < currentlyCompleted) {
      // 已完成的 triplet 无法撤销。target 是软目标，不做状态变更。
      // toOpen 留空，仅通过 safe-fill 填充本层。
    }

    // ── 闭合预算检查：后续容量必须足够闭合所有花色 ──
    // 这是 mod3 硬约束的前瞻保障：确保后续容量足以消除所有不完整 triplet 的债务。
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
        futureCapacity += freeTilesPerDepth[dd];
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

    // ── 记录本层保留的旧债务 tile 数（实际值，供输出校验）──
    // 在 forceClose 之后计算，计入强制闭合的旧债务色（也算清掉）。
    // d=0 无"进入本层前的旧债"，不计入。
    if (d > 0) {
      let retainedThisLayer = 0;
      for (const c of active) {
        const r = cumulative[c] % 3;
        if (r === 0) continue;
        // 旧债务色：未被 toClose 选中 → 保留全部 r；被选中 → 清 0
        retainedThisLayer += toClose.includes(c) ? 0 : r;
      }
      retainedOldDebtTilesByLayer.push(retainedThisLayer);
    }

    // ── 分配：先满足状态变更，再填满容量 ──
    const plan: number[] = new Array(C).fill(0);
    let used = 0;

    // 第一轮：状态变更的最小需求
    for (const c of toClose) {
      // 完成 1 个 triplet 所需牌数：cum%3=0→3张，cum%3=1→2张，cum%3=2→1张
      const need = (3 - (cumulative[c] % 3)) % 3 || 3;
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
      const cur = cumulative[c] + plan[c];
      const stillNeed = (3 - (cur % 3)) % 3;
      // stillNeed === 0 表示已在 triplet 边界（已完成），无需补票
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
        //
        // 在 triplet 口径下，给 3 的倍数 = +1 完成 triplet（与旧模型的"颜色 mod3 闭合"不同）。
        // 因此 safe-fill Step A 必须有目标上限：只补到 target，超过后只做 Step B。

        // 计算 toClose 两轮后的已完成 triplet 数（基于 projected cumulative）
        const projectedCum = cumulative.map((c, i) => c + plan[i]);
        const completedAfterRounds = countCompletedTriplets(projectedCum);
        const remainingToTarget = target - completedAfterRounds; // 还可以完成几个 triplet

        // Step A: 每次 1 个 triplet，放完重排序存，避免单色独吞
        if (remainingToTarget > 0) {
          let tripletsAdded = 0;
          while (tripletsAdded < remainingToTarget && slack >= 3) {
            // 重排序存，选当前库存最大的颜色
            const sorted = [...active]
              .map(c => ({ c, stock: remaining[c] - plan[c] }))
              .filter(x => x.stock >= 3)
              .sort((a, b) => b.stock - a.stock);
            if (sorted.length === 0) break; // 无人有能力收 triplet
            const pick = sorted[0].c;
            plan[pick] += 3;
            used += 3;
            slack -= 3;
            tripletsAdded++;
          }
        }

        // Step B: safe-fill — 在 triplet 口径下，safe 值确保不增加 floor(cum/3)
        //
        // curMod=0: safe=[1,2]（+1/+2 不跨边界）
        // curMod=1: safe=[1]  （只有+1不跨边界）
        // curMod=2: safe=[]   （任何正数都跨边界，只能跳过）
        if (slack > 0) {
          for (const c of byRemaining) {
            if (slack <= 0) break;
            let maxAdd = remaining[c] - plan[c];
            if (maxAdd <= 0) continue;
            let curMod = (cumulative[c] + plan[c]) % 3;
            const safe = curMod === 0 ? [1, 2] : curMod === 1 ? [1] : [];
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
    allCumulative += allTilesPerDepth[d];

    // ── 记录实际闭合率（triplet 口径）──
    const actualCompleted = countCompletedTriplets(cumulative);
    actualCloseRates.push(P > 0 ? actualCompleted / P : 0);
  }

  return { matrix: M, actualCloseRates, retainedOldDebtTilesByLayer };
}

/** 完成 1 个 triplet 的成本：需要几张牌才能让 floor(cum/3) 增加 1 */
function tripletCost(cum: number): number {
  return cum % 3 === 0 ? 3 : 3 - (cum % 3);
}

/** 不完整 triplet 的债务：还需要几张牌才能消除当前不完整的 triplet 组（用于 debt check） */
function closeCost(cum: number): number {
  const r = cum % 3;
  return r === 0 ? 0 : 3 - r;
}

/** 统计已完成的 triplet 数：Σ⌊cum[c] ÷ 3⌋ */
function countCompletedTriplets(cumulative: number[]): number {
  let n = 0;
  for (const cum of cumulative) n += Math.floor(cum / 3);
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
export function computeTileDepSets(
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
  rng: () => number,
): Map<number, number> {
  const assignments = new Map<number, number>();
  const D = depthLayers.length;
  const C = matrix.length;

  // 每个花色的累计领土（已分配 tiles 的 depSet 并集）
  const territory = new Map<number, Set<number>>();

  for (let d = 0; d < D; d++) {
    const pool = new Set(depthLayers[d].filter(t => !t.isConst && !assignments.has(t.id)).map(t => t.id));

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
        const chosenTileId = selectTile(candidates, scores, spreadParam, rng);

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
  rng: () => number,
): number {
  // ── 极端值：确定性选择 ──
  if (spreadParam <= 0) return pickMin(candidates, scores, rng);
  if (spreadParam >= 1) return pickMax(candidates, scores, rng);

  // ── 中性：均匀随机 ──
  const bias = Math.abs(spreadParam - 0.5) * 2; // 0(中性) ~ 1(极端)
  if (bias < 0.001) {
    return candidates[Math.floor(rng() * candidates.length)];
  }

  // ── 中间值：coin flip 混合 ──
  if (rng() < bias) {
    // 倾向策略
    return spreadParam < 0.5
      ? pickMin(candidates, scores, rng)
      : pickMax(candidates, scores, rng);
  } else {
    // 随机
    return candidates[Math.floor(rng() * candidates.length)];
  }
}

/** 从候选列表中选增量最小的 tile（多个并列时随机打破平局） */
function pickMin(candidates: number[], scores: number[], rng: () => number): number {
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
  return candidates[minIndices[Math.floor(rng() * minIndices.length)]];
}

/** 从候选列表中选增量最大的 tile（多个并列时随机打破平局） */
function pickMax(candidates: number[], scores: number[], rng: () => number): number {
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
  return candidates[maxIndices[Math.floor(rng() * maxIndices.length)]];
}

// ═══════════════════════════════════════════════════════════
// 5. 重建三元组
// ═══════════════════════════════════════════════════════════

function buildTriplets(
  assignments: Map<number, number>,
  depthLayers: TerrainTile[][],
): Array<{ suitIndex: number; depths: [number, number, number] }> {
  const depthOf = new Map<number, number>();
  const allAssignments = new Map<number, number>(assignments);
  for (let d = 0; d < depthLayers.length; d++) {
    for (const t of depthLayers[d]) {
      depthOf.set(t.id, d + 1);
      if (t.isConst && t.constElementValue > 0) {
        allAssignments.set(t.id, t.constElementValue);
      }
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
): number[] {
  const cumByColor = new Map<number, number>();
  const closeRates: number[] = [];

  for (const layer of depthLayers) {
    // 累加本层方块
    for (const tile of layer) {
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

export function computeMetrics(
  assignments: Map<number, number>,
  tiles: TerrainTile[],
  depthLayers: TerrainTile[][],
  depthMap: Map<number, number>,
  tileMap: Map<number, TerrainTile>,
  tileDepSets: Map<number, Set<number>>,
  dock: number,
  colorCount: number,
  actualCloseRates: number[],
  debtPersistenceWeight: number,
  buildRetainedOldDebtTilesByLayer: number[],
  colorAllocationMode?: ColorAllocationMode,
  heavyColor?: number,
  colorTotalTilesArg?: number[],
): DebtMetrics {
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
    computeLayerProgressMetrics(allAssign, depthLayers);

  // 逐层保留旧债务 tile 数必须采用落色后的事实统计。
  void buildRetainedOldDebtTilesByLayer;
  const retainedOldDebtTilesByLayer = metricsRetained;
  const totalRetainedOldDebtTiles = retainedOldDebtTilesByLayer.reduce((a, b) => a + b, 0);

  // debtByLayer: 纯累计（含 const 花色）
  const cumSuitCounts = new Map<number, number>();
  const debtByLayer: number[] = [];
  for (let d = 0; d < D; d++) {
    for (const tile of depthLayers[d]) {
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
): {
  colorUsageRates: number[];
  averageColorActivationLayer: number;
  debtTileCountsByLayer: number[];
  debtRetentionRates: number[];
  weightedDebtRetentionRate: number;
  retainedOldDebtTilesByLayer: number[];
  debtDurationHistogram: number[];
} {
  const allColors = new Set(assignments.values());
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

function emptyMetrics(): DebtMetrics {
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
