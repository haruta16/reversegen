/**
 * LayerClosure · 矩阵贴花色模块（花色领土增量控制）。
 *
 * 按"领土增量"（|depSet(T) \ U_c|）选择每层每花色的具体方块，
 * spreadParam 在 cluster ↔ spread 之间连续过渡。
 */

import type { TerrainTile } from '../types.js';

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
export function placeSuitsFromMatrixWithSpread(
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
