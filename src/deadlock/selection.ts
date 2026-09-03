/**
 * 死锁包含的选择 —— wildcard 补全 + 深浅/疏密打分 + 种子破平。
 *
 * 打分口径：
 *  - 深度：所选 3n 张牌的逻辑依赖深度（computeDependencyDepth）均值，越大越深；
 *  - 密度：所选牌成对 Chebyshev 距离之和，越小越密。
 * 偏好语义：
 *  - depthPreference:  deepest → 深优先 / shallowest → 浅优先 / neutral → 不计
 *  - densityPreference: densest → 密优先 / sparsest → 疏优先 / neutral → 不计
 * 同分（两维度精确相等）时用 mulberry32(selectionSeed) 在并列组内确定性取一。
 */

import type {
  DagTVariant,
  DeadlockCoreMatch,
  DeadlockEmbedding,
  DepthPreference,
  DensityPreference,
} from './types.js';
import { verifyFullEmbedding } from './search.js';
import { mulberry32 } from '../random-utils.js';

export interface SelectionContext {
  /** tileId → 逻辑依赖深度（全地形口径） */
  depthById: Map<number, number>;
  /** tileId → 牌面中心坐标 */
  posById: Map<number, { x: number; y: number }>;
  depthPreference: DepthPreference;
  densityPreference: DensityPreference;
  /** 同分破平种子 */
  selectionSeed: number;
}

interface ScoredCandidate {
  embedding: DeadlockEmbedding;
  depthScore: number;
  densityScore: number;
}

function chebyshev(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** 组合枚举（字典序，惰性——首命中即停时避免全表分配）。 */
function* lazyCombos(pool: number[], count: number): Generator<number[]> {
  const chosen: number[] = [];
  function* visit(start: number): Generator<number[]> {
    if (chosen.length === count) {
      yield [...chosen];
      return;
    }
    for (let i = start; i <= pool.length - (count - chosen.length); i++) {
      chosen.push(pool[i]);
      yield* visit(i + 1);
      chosen.pop();
    }
  }
  yield* visit(0);
}

/**
 * 从全部骨架匹配中选出最终包含；无可用匹配返回 null。
 * 全部候选完整闭包验证 ≥ 8（防御：核心门槛已保证，异常即丢弃）。
 */
export function selectDeadlockEmbedding(
  variant: DagTVariant,
  cores: DeadlockCoreMatch[],
  depsOf: Map<number, number[]>,
  ctx: SelectionContext,
): DeadlockEmbedding | null {
  const { depthById, posById, depthPreference, densityPreference, selectionSeed } = ctx;

  const nodeById = new Map(variant.nodes.map(n => [n.id, n]));

  // wildcard = 无模板依赖且无模板孩子
  const childrenCount = new Map<number, number>();
  for (const n of variant.nodes) {
    for (const d of n.deps) childrenCount.set(d, (childrenCount.get(d) ?? 0) + 1);
  }
  const wildcardIds = variant.nodes
    .filter(n => n.deps.length === 0 && (childrenCount.get(n.id) ?? 0) === 0)
    .map(n => n.id)
    .sort((a, b) => a - b);

  const candidates: ScoredCandidate[] = [];

  /** 完整验证 + 打分；返回是否通过（verifyFullEmbedding 为最终仲裁者）。 */
  const pushCandidate = (variantId: string, mapping: Map<number, number>): boolean => {
    const chosenIds = new Set(mapping.values());
    if (chosenIds.size !== variant.nodes.length) return false;
    const colorOf = new Map<number, number>();
    for (const [nodeId, tileId] of mapping) {
      colorOf.set(tileId, nodeById.get(nodeId)!.color);
    }
    let closures: Map<number, number>;
    try {
      closures = verifyFullEmbedding(chosenIds, colorOf, depsOf);
    } catch {
      return false;
    }
    const tileIds = [...chosenIds];
    let depthSum = 0;
    for (const id of tileIds) depthSum += depthById.get(id) ?? 1;
    const depthScore = depthSum / tileIds.length;
    let densityScore = 0;
    for (let i = 0; i < tileIds.length; i++) {
      const pi = posById.get(tileIds[i]);
      if (!pi) continue;
      for (let j = i + 1; j < tileIds.length; j++) {
        const pj = posById.get(tileIds[j]);
        if (!pj) continue;
        densityScore += chebyshev(pi, pj);
      }
    }
    candidates.push({
      embedding: {
        variantId,
        mapping,
        closures,
        depthScore,
        densityScore,
      },
      depthScore,
      densityScore,
    });
    return true;
  };

  for (const core of cores) {
    if (wildcardIds.length === 0) {
      pushCandidate(core.variantId, new Map(core.coreMapping));
      continue;
    }
    // 每个随机核心取「第一个通过完整验证」的 wildcard 组合作为其代表候选
    // （verifyFullEmbedding 为最终仲裁者，桥接/增长 wildcard 自动被验证）。
    // 池排序：增长/桥接提示牌优先 → 偏好启发式 → id 序。
    let pool = [...core.wildcardPool];
    const hints = core.wildcardHints;
    if (hints && hints.length > 0) {
      // 按提示位次排序：已验证可行的组合排最前（首组合即命中，1 次验证/核心）
      const hintRank = new Map<number, number>();
      hints.forEach((t, i) => {
        if (!hintRank.has(t)) hintRank.set(t, i);
      });
      pool.sort((a, b) => {
        const ra = hintRank.has(a) ? hintRank.get(a)! : Infinity;
        const rb = hintRank.has(b) ? hintRank.get(b)! : Infinity;
        if (ra !== rb) return ra - rb;
        return a - b;
      });
    } else if (depthPreference !== 'neutral') {
      pool.sort((a, b) =>
        (depthPreference === 'deepest' ? -1 : 1)
        * ((depthById.get(a) ?? 1) - (depthById.get(b) ?? 1))
        || (a - b));
    } else if (densityPreference !== 'neutral') {
      const nearestCoreDist = (tileId: number): number => {
        const p = posById.get(tileId);
        if (!p) return Infinity;
        let best = Infinity;
        for (const coreId of core.coreTileIds) {
          const q = posById.get(coreId);
          if (!q) continue;
          const d = chebyshev(p, q);
          if (d < best) best = d;
        }
        return best;
      };
      pool.sort((a, b) =>
        (densityPreference === 'densest' ? 1 : -1)
        * (nearestCoreDist(a) - nearestCoreDist(b))
        || (a - b));
    } else {
      pool.sort((a, b) => a - b);
    }
    // 首个通过验证的组合（组合空间 C(k,2) ≤ 约 3k，提示优先使其早期命中）
    for (const combo of lazyCombos(pool, wildcardIds.length)) {
      const mapping = new Map(core.coreMapping);
      for (let i = 0; i < wildcardIds.length; i++) mapping.set(wildcardIds[i], combo[i]);
      if (pushCandidate(core.variantId, mapping)) break;
    }
  }

  if (candidates.length === 0) return null;

  // 偏好排序（深度优先于密度；neutral 不计入比较）
  candidates.sort((a, b) => {
    if (depthPreference === 'deepest') {
      if (a.depthScore !== b.depthScore) return b.depthScore - a.depthScore;
    } else if (depthPreference === 'shallowest') {
      if (a.depthScore !== b.depthScore) return a.depthScore - b.depthScore;
    }
    if (densityPreference === 'densest') {
      if (a.densityScore !== b.densityScore) return a.densityScore - b.densityScore;
    } else if (densityPreference === 'sparsest') {
      if (a.densityScore !== b.densityScore) return b.densityScore - a.densityScore;
    }
    return 0;
  });

  // 精确同分组（(depthScore, densityScore) 相等）内种子破平
  const best = candidates[0];
  const tieGroup = candidates.filter(c =>
    c.depthScore === best.depthScore && c.densityScore === best.densityScore);
  if (tieGroup.length > 1) {
    const rng = mulberry32(selectionSeed | 0);
    const pick = tieGroup[Math.floor(rng() * tieGroup.length)];
    return pick.embedding;
  }
  return best.embedding;
}
