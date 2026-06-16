/**
 * Board-level DAG feature extraction.
 *
 * For a specific color assignment, computes structural properties that
 * may predict solvability, death points, and decision complexity.
 *
 * Unlike terrain-level DAG (95k triples, all possible combos),
 * this operates on the ACTUAL color groups defined by the board.
 */

import type { TerrainTile } from '../../src/types.js';
import { computeAllDependencies } from '../../src/dependency-graph.js';
import { buildTriplesBySuit } from '../../src/triple-builder.js';
import { intersectSize } from './triple-analyzer.js';
import type { DAGFeatures } from '../../src/solver/index.js';

// ═══════════════════════════════════════════════════
//  Board DAG Builder
// ═══════════════════════════════════════════════════

export interface BoardDAGNode {
  key: string;
  tileIds: [number, number, number];
  color: number;
  depSetSize: number;
  depSetTiles: number[];
}

export interface BoardDAGEdge {
  from: number; // predecessor triple index
  to: number;   // successor triple index
  overlap: number; // |depSet ∩ depSet|
}

export interface BoardDAG {
  nodes: BoardDAGNode[];
  edges: BoardDAGEdge[];
  /** Nodes grouped by topological layer (0 = root) */
  layers: number[][];
  /** Per-node successor count */
  successorCounts: number[];
  /** Per-node predecessor count */
  predecessorCounts: number[];
}

/**
 * Build board DAG from terrain + color assignments.
 *
 * For each color group, enumerates C(k,3) possible triples
 * and computes partial order (depSet subset) relationships.
 */
export function buildBoardDAG(
  freeTiles: TerrainTile[],
  suitMap: Map<number, number>, // tileId → color
): BoardDAG {
  const allDeps = computeAllDependencies(freeTiles);
  const triples = buildTriplesBySuit(freeTiles, allDeps, suitMap);

  const n = triples.length;
  const nodes: BoardDAGNode[] = [];
  const keyToIndex = new Map<string, number>();
  const depSetArrays: number[][] = [];

  for (let i = 0; i < n; i++) {
    const t = triples[i];
    const key = `${t.tileIds[0]},${t.tileIds[1]},${t.tileIds[2]}`;
    keyToIndex.set(key, i);
    const sorted = [...t.depSet].sort((a, b) => a - b);
    depSetArrays.push(sorted);

    nodes.push({
      key,
      tileIds: t.tileIds,
      color: suitMap.get(t.tileIds[0]) ?? 0,
      depSetSize: t.depSet.size,
      depSetTiles: sorted,
    });
  }

  // ── Build edges: B ≺ A if B.depSet ⊆ A.depSet and disjoint tiles ──
  // For boards with shared colors, limit to avoid O(n²) blowup
  const edges: BoardDAGEdge[] = [];
  const successorCounts = new Array(n).fill(0);
  const predecessorCounts = new Array(n).fill(0);

  // Two options: full O(n²) for small n, or depSet-based enum for large n
  if (n <= 5000) {
    // Full pairwise comparison
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        // Check disjoint tiles
        if (shareTile(nodes[i].tileIds, nodes[j].tileIds)) continue;
        // Check depSet subset
        if (isSubset(depSetArrays[i], depSetArrays[j])) {
          edges.push({ from: i, to: j, overlap: intersectSize(depSetArrays[i], depSetArrays[j]) });
          successorCounts[i]++;
          predecessorCounts[j]++;
        }
      }
    }
  } else {
    // For large n, use depSet-based enumeration (expensive but correct)
    for (let j = 0; j < n; j++) {
      const ds = depSetArrays[j];
      const d = ds.length;
      if (d < 3) continue;
      const [a1, a2, a3] = nodes[j].tileIds;

      for (let x = 0; x < d - 2; x++) {
        const t1 = ds[x];
        if (t1 === a1 || t1 === a2 || t1 === a3) continue;
        for (let y = x + 1; y < d - 1; y++) {
          const t2 = ds[y];
          if (t2 === a1 || t2 === a2 || t2 === a3) continue;
          for (let z = y + 1; z < d; z++) {
            const t3 = ds[z];
            if (t3 === a1 || t3 === a2 || t3 === a3) continue;
            const predKey = `${[t1, t2, t3].sort((a, b) => a - b).join(',')}`;
            const predIdx = keyToIndex.get(predKey);
            if (predIdx !== undefined) {
              edges.push({ from: predIdx, to: j, overlap: intersectSize(depSetArrays[predIdx], ds) });
              successorCounts[predIdx]++;
              predecessorCounts[j]++;
            }
          }
        }
      }
    }
  }

  // ── Compute topological layers (longest predecessor chain) ──
  const depth = new Array(n).fill(0);
  // Process in depSetSize order to ensure predecessors are processed first
  const sortedByDep = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => depSetArrays[a].length - depSetArrays[b].length);

  for (const i of sortedByDep) {
    if (predecessorCounts[i] === 0) {
      depth[i] = 0;
      continue;
    }
    // Find max predecessor depth
    let maxPredDepth = 0;
    for (const e of edges) {
      if (e.to === i && depth[e.from] > maxPredDepth) maxPredDepth = depth[e.from];
    }
    depth[i] = maxPredDepth + 1;
  }

  // ── Group by layer ──
  const maxDepth = Math.max(...depth, 0);
  const layers: number[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (let i = 0; i < n; i++) {
    layers[depth[i]].push(i);
  }

  return { nodes, edges, layers, successorCounts, predecessorCounts };
}

// ═══════════════════════════════════════════════════
//  Feature extraction from Board DAG
// ═══════════════════════════════════════════════════

export function extractDAGFeatures(dag: BoardDAG): DAGFeatures {
  const { nodes, edges, layers, successorCounts, predecessorCounts } = dag;
  const n = nodes.length;

  // depSet stats
  const depSizes = nodes.map(nd => nd.depSetSize);
  const avgDep = depSizes.reduce((a, b) => a + b, 0) / n;

  // Layer distribution
  const layerDist: Record<number, number> = {};
  for (let i = 0; i < layers.length; i++) {
    layerDist[i] = layers[i].length;
  }

  // Leaf nodes (zero successors)
  const leafCount = successorCounts.filter(c => c === 0).length;
  // Root nodes (zero predecessors)
  const rootCount = predecessorCounts.filter(c => c === 0).length;

  // Max parallelism = max nodes in a single layer
  const maxParallelism = Math.max(...layers.map(l => l.length), 0);
  const avgParallelism = layers.reduce((s, l) => s + l.length, 0) / Math.max(layers.length, 1);

  // Bottleneck: tiles appearing in most depSets
  const tileCount = new Map<number, number>();
  for (const nd of nodes) {
    for (const tid of nd.depSetTiles) {
      tileCount.set(tid, (tileCount.get(tid) ?? 0) + 1);
    }
  }
  let maxTileCount = 0;
  for (const c of tileCount.values()) if (c > maxTileCount) maxTileCount = c;
  const bottleneckScores = nodes.map(nd => {
    let score = 0;
    for (const tid of nd.tileIds) {
      score += maxTileCount > 0 ? (tileCount.get(tid) ?? 0) / maxTileCount : 0;
    }
    return score / 3;
  });
  const maxBottleneckScore = Math.max(...bottleneckScores, 0);

  // Overlap density: edges / max_possible_edges among same-layer nodes
  let maxPossibleEdges = 0;
  for (const layer of layers) {
    const k = layer.length;
    maxPossibleEdges += k * (k - 1); // ordered pairs
  }
  const overlapDensity = maxPossibleEdges > 0 ? edges.length / maxPossibleEdges : 0;

  // Net pressure: depSetSize - 3 (new tiles entering dock on elimination)
  const netPressure = depSizes.map(s => s - 3);

  return {
    tripleCount: n,
    edgeCount: edges.length,
    depthMin: 0,
    depthMax: layers.length - 1,
    layerDistribution: layerDist,
    avgDepSetSize: avgDep,
    leafTripleCount: leafCount,
    rootTripleCount: rootCount,
    maxParallelism,
    avgParallelism,
    maxBottleneckScore,
    overlapDensity,
    netPressure: {
      min: Math.min(...netPressure),
      max: Math.max(...netPressure),
      avg: netPressure.reduce((a, b) => a + b, 0) / n,
    },
  };
}

// ═══════════════════════════════════════════════════
//  Color-level DAG (simplified: color groups as nodes)
// ═══════════════════════════════════════════════════

export interface ColorGroupNode {
  color: number;
  tileCount: number;
  /** Tiles in this color group */
  tileIds: number[];
  /** depSet of the whole group (union of all tiles' transitive closures) */
  depSet: Set<number>;
  depSetSize: number;
}

export interface ColorGroupDAG {
  nodes: ColorGroupNode[];
  /** Dependencies between color groups: A → B if any tile in B is blocked by any tile in A */
  edges: [number, number][];
  /** Max chain length (how many color groups must be processed sequentially) */
  maxChainLength: number;
  /** Groups that can be processed in parallel */
  parallelGroups: number;
}

/**
 * Build a simplified DAG where each node is a color group.
 * This captures the high-level structure: which colors block which others.
 */
export function buildColorGroupDAG(
  freeTiles: TerrainTile[],
  suitMap: Map<number, number>,
): ColorGroupDAG {
  const allDeps = computeAllDependencies(freeTiles);

  // Group tiles by color
  const groups = new Map<number, number[]>();
  for (const tile of freeTiles) {
    const color = suitMap.get(tile.id) ?? 0;
    if (color <= 0) continue;
    const list = groups.get(color) ?? [];
    list.push(tile.id);
    groups.set(color, list);
  }

  const nodes: ColorGroupNode[] = [];
  const colorToIdx = new Map<number, number>();

  for (const [color, tileIds] of groups) {
    colorToIdx.set(color, nodes.length);
    const depSet = new Set<number>();
    for (const tid of tileIds) {
      depSet.add(tid);
      const deps = allDeps.get(tid);
      if (deps) for (const d of deps) depSet.add(d);
    }
    nodes.push({ color, tileCount: tileIds.length, tileIds, depSet, depSetSize: depSet.size });
  }

  // Build edges: A → B if color A's tiles block color B's tiles
  // B's tiles are blocked if any of their dependencies are in A's tile set
  const edges: [number, number][] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      // Check: does any tile in group j directly depend on any tile in group i?
      for (const tid of nodes[j].tileIds) {
        const tile = freeTiles.find(t => t.id === tid);
        if (!tile) continue;
        for (const depId of tile.dependencies) {
          if (nodes[i].tileIds.includes(depId)) {
            edges.push([i, j]);
            // break out of both loops for this pair
            // We track edges by pair, so set a flag
            break;
          }
        }
      }
    }
  }

  // Deduplicate edges
  const edgeSet = new Set<string>();
  const uniqueEdges: [number, number][] = [];
  for (const [a, b] of edges) {
    const key = `${a}|${b}`;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      uniqueEdges.push([a, b]);
    }
  }

  // Compute max chain length via topological sort / DP
  const inDegree = new Array(nodes.length).fill(0);
  for (const [, to] of uniqueEdges) inDegree[to]++;
  const longestPath = new Array(nodes.length).fill(0);
  // Kahn's algorithm for DP
  const queue: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    if (inDegree[i] === 0) queue.push(i);
  }
  const topo: number[] = [];
  while (queue.length > 0) {
    const u = queue.shift()!;
    topo.push(u);
    for (const [a, b] of uniqueEdges) {
      if (a === u) {
        longestPath[b] = Math.max(longestPath[b], longestPath[u] + 1);
        if (--inDegree[b] === 0) queue.push(b);
      }
    }
  }
  const maxChainLength = Math.max(...longestPath, 0) + 1;

  // Parallel groups: nodes with same in-degree = 0 at start
  const parallelGroups = nodes.filter((_, i) => {
    // Not a source of any edge that goes to elsewhere?
    const hasOutgoing = uniqueEdges.some(([a]) => a === i);
    const hasIncoming = uniqueEdges.some(([, b]) => b === i);
    return !hasIncoming; // sources (no incoming edges)
  }).length;

  return { nodes, edges: uniqueEdges, maxChainLength, parallelGroups };
}

// ═══════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════

function shareTile(a: [number, number, number], b: [number, number, number]): boolean {
  return a[0] === b[0] || a[0] === b[1] || a[0] === b[2]
    || a[1] === b[0] || a[1] === b[1] || a[1] === b[2]
    || a[2] === b[0] || a[2] === b[1] || a[2] === b[2];
}

function isSubset(a: number[], b: number[]): boolean {
  if (a.length > b.length) return false;
  let j = 0;
  for (let i = 0; i < a.length; i++) {
    while (j < b.length && b[j] < a[i]) j++;
    if (j >= b.length || b[j] !== a[i]) return false;
    j++;
  }
  return true;
}
