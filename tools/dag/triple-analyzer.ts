/**
 * Triple 关系静态分析器（内存高效版 v2）。
 *
 * 核心思路：不存储完整前提边集，而是对每个 triple A 枚举其 depSet 中
 * 的 C(|depSet|,3) 个候选前驱 B，查表确认 B 存在后累加计数值。
 *
 * 复杂度：O(N × C(avg_depSet, 3)) ≈ 20M 次候选检查，完全在内存可承受范围内。
 * 计算结果缓存到 .reversegen-cache/ 目录。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTriples, buildTriplesBySuit } from '../../src/triple-builder.js';
import { computeAllDependencies } from '../../src/dependency-graph.js';
import type { TerrainTile, TerrainData, Triple } from '../../src/types.js';
import { tripleKey, sortTriple } from '../../src/types.js';
import { getAllTiles } from '../../src/terrain-loader.js';

// ═══════════════════════════════════════════════════
//  类型
// ═══════════════════════════════════════════════════

export interface TripleNode {
  key: string;
  tileIds: [number, number, number];
  depSetSize: number;
  topologicalLayer: number;    // depSetSize 分位数桶 (0=最小cost, 越大越深)
  dependencyDepth: number;     // 最大前驱链深度 (0=无前驱, N=最长前驱链长N)
  /** triple 的 depSet 中的 tile ID 列表（已排序）*/
  depSetTiles: number[];
  successorCount: number;
  predecessorCount: number;
  partialOrderSuccessorCount: number;
  partialOrderPredecessorCount: number;
  bottleneckScore: number;
  layerMin: number;
  layerMax: number;
}

export interface AnalysisEdge {
  from: number;
  to: number;
  overlap: number;
}

export interface BottleneckTile {
  tileId: number;
  layer: number;
  tripleCount: number;
  score: number;
}

export interface TripleAnalysisStatistics {
  totalTriples: number;
  triplesWithSuccessors: number;
  triplesWithPredecessors: number;
  isolatedTriples: number;
  totalPrerequisiteEdges: number;
  totalPartialOrderEdges: number;
  costDistribution: { min: number; max: number; avg: number };
  successorDistribution: { min: number; max: number; avg: number };
  layerDistribution: Record<number, number>;
}

export interface TripleAnalysisResult {
  terrainHash: string;
  terrainInfo: {
    levelResId?: number;
    levelHash: string;
    totalTiles: number;
    freeTiles: number;
    layers: number;
  };
  triples: TripleNode[];
  prerequisiteEdges: AnalysisEdge[];
  partialOrderEdges: AnalysisEdge[];
  bottleneckTiles: BottleneckTile[];
  statistics: TripleAnalysisStatistics;
  /** 分析模式: 'terrain' = 空地形全范围, 'replay' = ReplayCode 同花色 */
  mode?: 'terrain' | 'replay';
  /** ReplayCode 模式下的花色统计 */
  suitStats?: {
    suitCount: number;
    tilesPerSuit: { suit: number; count: number }[];
  };
}

// ═══════════════════════════════════════════════════
//  缓存
// ═══════════════════════════════════════════════════

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.reversegen-cache');

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

function getCachePath(cacheKey: string): string {
  return join(CACHE_DIR, `triple-analysis-${cacheKey}.json`);
}

function loadFromCache(cacheKey: string): TripleAnalysisResult | null {
  const cachePath = getCachePath(cacheKey);
  if (!existsSync(cachePath)) return null;
  try {
    return JSON.parse(readFileSync(cachePath, 'utf-8')) as TripleAnalysisResult;
  } catch {
    return null;
  }
}

function saveToCache(cacheKey: string, result: TripleAnalysisResult): void {
  ensureCacheDir();
  try {
    writeFileSync(getCachePath(cacheKey), JSON.stringify(result));
  } catch (e) {
    console.warn(`[triple-analyzer] 缓存写入失败: ${e}`);
  }
}

function hashTerrain(terrain: TerrainData, tiles: TerrainTile[]): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({
    levelResId: terrain.levelResId,
    levelHash: terrain.levelHash,
    layers: terrain.layers.length,
    tileIds: tiles.map(t => `${t.id}:${t.layer}:${t.dependencies.join(',')}`).join('|'),
  }));
  return hash.digest('hex').substring(0, 16);
}

// ═══════════════════════════════════════════════════
//  核心计算
// ═══════════════════════════════════════════════════

/**
 * 对 triple 的 depSet (已排序) 枚举 C(d,3) 个候选前驱，
 * 每个有效前驱调用回调 (predIdx, tripleIdx)。
 *
 * 返回发现的边总数。
 */
function forEachCandidatePredecessor(
  triples: Triple[],
  depSetArrays: number[][],
  keyToIndex: Map<string, number>,
  callback: (predIdx: number, tripleIdx: number) => void,
  progressCallback?: (done: number, total: number) => void,
): number {
  const n = triples.length;
  let edgeCount = 0;

  for (let i = 0; i < n; i++) {
    const depArr = depSetArrays[i];
    const d = depArr.length;
    if (d < 3) continue;
    const A = triples[i];
    const [at1, at2, at3] = A.tileIds;

    // C(d,3) 三重循环
    for (let a = 0; a < d - 2; a++) {
      const t1 = depArr[a];
      // 跳过与 A 共享的牌
      if (t1 === at1 || t1 === at2 || t1 === at3) continue;
      for (let b = a + 1; b < d - 1; b++) {
        const t2 = depArr[b];
        if (t2 === at1 || t2 === at2 || t2 === at3) continue;
        for (let c = b + 1; c < d; c++) {
          const t3 = depArr[c];
          if (t3 === at1 || t3 === at2 || t3 === at3) continue;

          const predKey = tripleKey(sortTriple(t1, t2, t3));
          const predIdx = keyToIndex.get(predKey);
          if (predIdx !== undefined) {
            callback(predIdx, i);
            edgeCount++;
          }
        }
      }
    }

    if (progressCallback && i % 1000 === 0) {
      progressCallback(i, n);
    }
  }

  if (progressCallback) progressCallback(n, n);
  return edgeCount;
}

/**
 * 计算两个已排序数组的交集大小 (O(n+m))。
 */
/** 计算两个已排序数组的交集大小 */
export function intersectSize(a: number[], b: number[]): number {
  let count = 0;
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { count++; i++; j++; }
    else if (a[i] < b[j]) i++;
    else j++;
  }
  return count;
}

/**
 * 检查 a 是否为 b 的子集 (a, b 均已排序)。
 */
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

/**
 * 从前提边集中筛出偏序边 (depSet 子集关系)。
 *
 * 注意：不做传递归约 (Hasse)，因为 BFS-based 传递归约在大图上太慢。
 * Hasse 归约作为未来可选优化（可加 depth-limit BFS 或增量计算）。
 */
function buildPartialOrderEdges(
  depSetArrays: number[][],
  prereqEdges: { from: number; to: number }[],
  maxEdgesPerNode: number,
): AnalysisEdge[] {
  if (prereqEdges.length === 0) return [];

  const nodeEC = new Map<number, number>();
  const result: AnalysisEdge[] = [];

  for (const e of prereqEdges) {
    if (!isSubset(depSetArrays[e.from], depSetArrays[e.to])) continue;
    const cf = nodeEC.get(e.from) ?? 0;
    const ct = nodeEC.get(e.to) ?? 0;
    if (cf >= maxEdgesPerNode && ct >= maxEdgesPerNode) continue;

    result.push({
      from: e.from,
      to: e.to,
      overlap: intersectSize(depSetArrays[e.from], depSetArrays[e.to]),
    });
    nodeEC.set(e.from, cf + 1);
    nodeEC.set(e.to, ct + 1);
  }
  return result;
}

// ═══════════════════════════════════════════════════
//  主入口
// ═══════════════════════════════════════════════════

export interface AnalyzeOptions {
  force?: boolean;
  onProgress?: (phase: string, current: number, total: number) => void;
  /** 构建边时取前 N 个节点 (按 successorCount 降序)，0 = 不构建边 */
  edgeTopN?: number;
  /** 每个节点最多保留的边数 */
  maxEdgesPerNode?: number;
  /** tileId → suitIndex 映射。提供时按花色分组构建 triple（ReplayCode 模式）；
   *  省略时全局 C(n,3) 构建（空地形模式）。 */
  suitMap?: Map<number, number>;
}

/**
 * 对地形执行完整 triple 关系分析。
 */
export function analyzeTriples(
  terrain: TerrainData,
  opts: AnalyzeOptions = {},
): TripleAnalysisResult {
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(t => !t.isConst);
  const terrainHash = hashTerrain(terrain, allTiles);
  const useSuitMode = opts.suitMap !== undefined && opts.suitMap.size > 0;

  // 缓存 key: 地形 hash + 自由牌数（空地形模式）或 + suit hash（ReplayCode 模式）
  let cacheKeySuffix = `${freeTiles.length}`;
  if (useSuitMode) {
    const suitHash = createHash('md5')
      .update([...opts.suitMap!.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([id, s]) => `${id}:${s}`).join(','))
      .digest('hex').substring(0, 8);
    cacheKeySuffix += `-suit-${suitHash}`;
  }
  const cacheKey = `${terrainHash}-${cacheKeySuffix}`;

  // 检查缓存
  if (!opts.force) {
    const cached = loadFromCache(cacheKey);
    if (cached) return cached;
  }

  const report = opts.onProgress || (() => {});
  const edgeTopN = opts.edgeTopN ?? 800;
  const maxE = opts.maxEdgesPerNode ?? 12;

  // ── Step 1: 构建 triples ──
  report('构建 triples', 0, 1);
  const allDeps = computeAllDependencies(freeTiles);
  const triples = useSuitMode
    ? buildTriplesBySuit(freeTiles, allDeps, opts.suitMap!)
    : buildTriples(freeTiles, allDeps);
  const n = triples.length;

  // ── Step 2: 构建辅助数据结构 ──
  report('构建索引', 0, n);
  const keyToIndex = new Map<string, number>();
  const depSetArrays: number[][] = new Array(n);
  const tileLayerMap = new Map<number, number>();
  for (const t of freeTiles) tileLayerMap.set(t.id, t.layer);

  for (let i = 0; i < n; i++) {
    keyToIndex.set(tripleKey(triples[i].tileIds), i);
    // depSet 排序存储 (用于高效交集/子集计算)
    const sorted = [...triples[i].depSet].sort((a, b) => a - b);
    depSetArrays[i] = sorted;
  }

  // ── Step 3: Pass 1 — 计数 (不存边) ──
  report('计数前提关系(Pass 1)', 0, n);
  const successorCounts = new Uint32Array(n);
  const predecessorCounts = new Uint32Array(n);

  const totalEdges = forEachCandidatePredecessor(
    triples, depSetArrays, keyToIndex,
    (predIdx, tripleIdx) => {
      successorCounts[predIdx]++;
      predecessorCounts[tripleIdx]++;
    },
    (done, total) => { if (done % 5000 === 0) report('计数前提关系(Pass 1)', done, total); },
  );

  // ── Step 4: 瓶颈 tile ──
  report('瓶颈分析', 0, 1);
  const tileTripleCount = new Map<number, number>();
  for (const t of freeTiles) tileTripleCount.set(t.id, 0);
  for (let i = 0; i < n; i++) {
    for (const tid of triples[i].depSet) {
      const c = tileTripleCount.get(tid);
      if (c !== undefined) tileTripleCount.set(tid, c + 1);
    }
  }
  let maxTileCount = 0;
  for (const c of tileTripleCount.values()) if (c > maxTileCount) maxTileCount = c;

  const bottleneckTiles: BottleneckTile[] = [];
  for (const t of freeTiles) {
    const count = tileTripleCount.get(t.id) ?? 0;
    bottleneckTiles.push({
      tileId: t.id,
      layer: t.layer,
      tripleCount: count,
      score: maxTileCount > 0 ? count / maxTileCount : 0,
    });
  }

  // ── Step 5: Pass 2 — 仅为 top N 节点构建边 (快速路径) ──
  report('构建边(Pass 2)', 0, edgeTopN);

  const rankSorted = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => {
      // 按总关系数降序，确保最"连接"的节点优先建边
      const ta = successorCounts[a] + predecessorCounts[a];
      const tb = successorCounts[b] + predecessorCounts[b];
      return tb - ta;
    });
  const topIndices = rankSorted.slice(0, edgeTopN);
  const topSet = new Set(topIndices);

  const prereqEdgesRaw: { from: number; to: number }[] = [];
  const nodeEdgeCount = new Uint16Array(n);

  // 仅遍历 top N 节点作为 A (target)，找它们的前驱 B (source)
  // 边 B→A 的两端都在 topSet 中才保留
  for (let ti = 0; ti < topIndices.length; ti++) {
    const i = topIndices[ti];
    const depArr = depSetArrays[i];
    const d = depArr.length;
    const A = triples[i];
    const [at1, at2, at3] = A.tileIds;

    for (let a = 0; a < d - 2; a++) {
      const t1 = depArr[a];
      if (t1 === at1 || t1 === at2 || t1 === at3) continue;
      for (let b = a + 1; b < d - 1; b++) {
        const t2 = depArr[b];
        if (t2 === at1 || t2 === at2 || t2 === at3) continue;
        for (let c = b + 1; c < d; c++) {
          const t3 = depArr[c];
          if (t3 === at1 || t3 === at2 || t3 === at3) continue;

          const predKey = tripleKey(sortTriple(t1, t2, t3));
          const predIdx = keyToIndex.get(predKey);
          if (predIdx === undefined) continue;
          if (!topSet.has(predIdx)) continue; // 两端都在 topSet 中

          if (nodeEdgeCount[predIdx] >= maxE && nodeEdgeCount[i] >= maxE) continue;
          prereqEdgesRaw.push({ from: predIdx, to: i });
          nodeEdgeCount[predIdx]++;
          nodeEdgeCount[i]++;
        }
      }
    }

    if (ti % 200 === 0) report('构建边(Pass 2)', ti, topIndices.length);
  }
  report('构建边(Pass 2)', topIndices.length, topIndices.length);

  // 添加 overlap
  const prerequisiteEdges: AnalysisEdge[] = prereqEdgesRaw.map(e => ({
    ...e,
    overlap: intersectSize(depSetArrays[e.from], depSetArrays[e.to]),
  }));

  // ── Step 6: 偏序 Hasse 图 ──
  report('偏序 Hasse 图', 0, 1);
  const partialOrderEdges = buildPartialOrderEdges(depSetArrays, prereqEdgesRaw, maxE);

  // ── Step 7: 计算拓扑层 (depSetSize 分位数桶) ──
  report('计算拓扑层', 0, n);
  const NUM_LAYERS = 8;
  // 收集所有 depSetSize 并分桶
  const depSizesForSort = triples.map(t => t.depSet.size);
  depSizesForSort.sort((a, b) => a - b);
  const bucketSize = Math.ceil(n / NUM_LAYERS);
  // bucketBoundaries[i] = depSetSize 上限 (不含) 属于桶 i
  const bucketBoundaries: number[] = [];
  for (let b = 0; b < NUM_LAYERS; b++) {
    const idx = Math.min((b + 1) * bucketSize, n - 1);
    bucketBoundaries.push(depSizesForSort[idx]);
  }
  // 去重: 确保边界严格递增
  for (let b = NUM_LAYERS - 1; b > 0; b--) {
    if (bucketBoundaries[b] <= bucketBoundaries[b - 1]) {
      bucketBoundaries[b] = bucketBoundaries[b - 1] + 1;
    }
  }

  function getTopoLayer(depSize: number): number {
    for (let b = 0; b < NUM_LAYERS; b++) {
      if (depSize <= bucketBoundaries[b]) return b;
    }
    return NUM_LAYERS - 1;
  }

  // ── Step 7.5: 计算依赖深度 (最大前驱链长度) ──
  // 定义: L0=无前驱, Ln=前驱中最深的+1
  // 按 depSetSize 升序处理，保证前驱一定先处理完
  report('计算依赖深度', 0, n);
  const dependencyDepth = new Uint16Array(n);
  const sortedByDep = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => triples[a].depSet.size - triples[b].depSet.size);

  for (let si = 0; si < n; si++) {
    const i = sortedByDep[si];
    if (predecessorCounts[i] === 0) {
      dependencyDepth[i] = 0;
      if (si % 10000 === 0) report('计算依赖深度', si, n);
      continue;
    }

    const depArr = depSetArrays[i];
    const d = depArr.length;
    const [at1, at2, at3] = triples[i].tileIds;
    let maxPredDepth = 0;

    for (let a = 0; a < d - 2; a++) {
      const t1 = depArr[a];
      if (t1 === at1 || t1 === at2 || t1 === at3) continue;
      for (let b = a + 1; b < d - 1; b++) {
        const t2 = depArr[b];
        if (t2 === at1 || t2 === at2 || t2 === at3) continue;
        for (let c = b + 1; c < d; c++) {
          const t3 = depArr[c];
          if (t3 === at1 || t3 === at2 || t3 === at3) continue;
          const predKey = tripleKey(sortTriple(t1, t2, t3));
          const predIdx = keyToIndex.get(predKey);
          if (predIdx !== undefined && dependencyDepth[predIdx] > maxPredDepth) {
            maxPredDepth = dependencyDepth[predIdx];
          }
        }
      }
    }

    dependencyDepth[i] = maxPredDepth + 1;
    if (si % 10000 === 0) report('计算依赖深度', si, n);
  }
  report('计算依赖深度', n, n);

  // ── Step 8: 组装节点 ──
  report('生成结果', 0, n);
  const tripleNodes: TripleNode[] = [];
  for (let i = 0; i < n; i++) {
    const t = triples[i];
    let poSc = 0, poPc = 0;
    for (const e of partialOrderEdges) {
      if (e.from === i) poSc++;
      if (e.to === i) poPc++;
    }

    let bScore = 0;
    for (const tid of t.tileIds) {
      bScore += maxTileCount > 0 ? (tileTripleCount.get(tid) ?? 0) / maxTileCount : 0;
    }
    bScore /= 3;

    const lMin = Math.min(
      tileLayerMap.get(t.tileIds[0]) ?? 0,
      tileLayerMap.get(t.tileIds[1]) ?? 0,
      tileLayerMap.get(t.tileIds[2]) ?? 0,
    );
    const lMax = Math.max(
      tileLayerMap.get(t.tileIds[0]) ?? 0,
      tileLayerMap.get(t.tileIds[1]) ?? 0,
      tileLayerMap.get(t.tileIds[2]) ?? 0,
    );

    tripleNodes.push({
      key: tripleKey(t.tileIds),
      tileIds: t.tileIds,
      depSetSize: t.depSet.size,
      depSetTiles: depSetArrays[i],
      topologicalLayer: getTopoLayer(t.depSet.size),
      dependencyDepth: dependencyDepth[i],
      successorCount: successorCounts[i],
      predecessorCount: predecessorCounts[i],
      partialOrderSuccessorCount: poSc,
      partialOrderPredecessorCount: poPc,
      bottleneckScore: Math.round(bScore * 10000) / 10000,
      layerMin: lMin,
      layerMax: lMax,
    });
  }

  // ── Step 8: 统计 ──
  const withS = tripleNodes.filter(t => t.successorCount > 0).length;
  const withP = tripleNodes.filter(t => t.predecessorCount > 0).length;
  const isolated = tripleNodes.filter(t => t.successorCount === 0 && t.predecessorCount === 0).length;
  const depSizes = tripleNodes.map(t => t.depSetSize);
  const succVals = tripleNodes.map(t => t.successorCount);

  const layerDist: Record<number, number> = {};
  for (const t of tripleNodes) {
    layerDist[t.topologicalLayer] = (layerDist[t.topologicalLayer] || 0) + 1;
  }

  const statistics: TripleAnalysisStatistics = {
    totalTriples: n,
    triplesWithSuccessors: withS,
    triplesWithPredecessors: withP,
    isolatedTriples: isolated,
    totalPrerequisiteEdges: totalEdges,
    totalPartialOrderEdges: partialOrderEdges.length,
    costDistribution: {
      min: Math.min(...depSizes),
      max: Math.max(...depSizes),
      avg: Math.round(depSizes.reduce((a, b) => a + b, 0) / n * 100) / 100,
    },
    successorDistribution: {
      min: Math.min(...succVals),
      max: Math.max(...succVals),
      avg: Math.round(succVals.reduce((a, b) => a + b, 0) / n * 100) / 100,
    },
    layerDistribution: layerDist,
  };

  // ── suit 统计（仅 ReplayCode 模式）──
  let suitStats: TripleAnalysisResult['suitStats'] = undefined;
  if (useSuitMode) {
    const suitCounts = new Map<number, number>();
    for (const t of freeTiles) {
      const s = opts.suitMap!.get(t.id) ?? 0;
      suitCounts.set(s, (suitCounts.get(s) ?? 0) + 1);
    }
    const tilesPerSuit = [...suitCounts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([suit, count]) => ({ suit, count }));
    suitStats = {
      suitCount: suitCounts.size,
      tilesPerSuit,
    };
  }

  const result: TripleAnalysisResult = {
    terrainHash,
    terrainInfo: {
      levelResId: terrain.levelResId,
      levelHash: terrain.levelHash || '',
      totalTiles: allTiles.length,
      freeTiles: freeTiles.length,
      layers: terrain.layers.length,
    },
    triples: tripleNodes,
    prerequisiteEdges,
    partialOrderEdges,
    bottleneckTiles,
    statistics,
    mode: useSuitMode ? 'replay' : 'terrain',
    suitStats,
  };

  saveToCache(cacheKey, result);
  return result;
}

// ═══════════════════════════════════════════════════
//  图数据过滤 & Triple 详情
// ═══════════════════════════════════════════════════

export interface GraphFilterOptions {
  /** 按总关系数降序取前 N 个 (stratify=false) */
  topN?: number;
  /** 分层采样模式: 每个拓扑层取 perLayer 个节点 */
  stratify?: boolean;
  perLayer?: number;
  minSuccessors?: number;
  minPredecessors?: number;
  maxEdgesPerNode?: number;
  layerMin?: number;
  layerMax?: number;
  /** 'depSetQuantile' (默认) | 'dependencyDepth' */
  layerMode?: string;
  /** 边构建模式: 'full' = 完全包含 (默认), 'partial' = 部分包含 (仅牌局模式) */
  edgeMode?: 'full' | 'partial';
  /** partial 模式下 depSet 重叠率阈值 (0~1)，默认 0.5 */
  partialThreshold?: number;
}

export interface FilteredGraphData {
  nodeIndices: number[];
  prerequisiteEdges: AnalysisEdge[];
  partialOrderEdges: AnalysisEdge[];
}

export function filterGraphData(
  result: TripleAnalysisResult,
  opts: GraphFilterOptions = {},
): FilteredGraphData {
  const { triples } = result;
  const n = triples.length;
  const topN = opts.topN ?? 500;
  const perLayer = opts.perLayer ?? 80;
  const minS = opts.minSuccessors ?? 0;
  const minP = opts.minPredecessors ?? -1;
  const maxE = opts.maxEdgesPerNode ?? 12;
  const lMin = opts.layerMin ?? -1;
  const lMax = opts.layerMax ?? Infinity;
  const useDepth = opts.layerMode === 'dependencyDepth';
  const getLayer = (t: TripleNode) => useDepth ? t.dependencyDepth : t.topologicalLayer;

  // ── Step 1: 选择候选节点 ──
  let candidateSet: Set<number>;

  if (opts.stratify) {
    // 分层采样: 每个拓扑层取 perLayer 个最连接的节点
    candidateSet = new Set<number>();
    const maxLayer = Math.max(...triples.map(getLayer), 0);
    for (let layer = 0; layer <= maxLayer; layer++) {
      if (layer < lMin || layer > lMax) continue;
      const layerTriples = Array.from({ length: n }, (_, i) => i)
        .filter(i => getLayer(triples[i]) === layer
          && triples[i].successorCount >= minS
          && triples[i].predecessorCount >= minP)
        .sort((a, b) => {
          const ta = triples[a].successorCount + triples[a].predecessorCount;
          const tb = triples[b].successorCount + triples[b].predecessorCount;
          return tb - ta;
        });
      for (let i = 0; i < Math.min(perLayer, layerTriples.length); i++) {
        candidateSet.add(layerTriples[i]);
      }
    }
  } else {
    // 全局排序取 top N
    const indices = Array.from({ length: n }, (_, i) => i)
      .sort((a, b) => {
        const ta = triples[a].successorCount + triples[a].predecessorCount;
        const tb = triples[b].successorCount + triples[b].predecessorCount;
        return tb - ta;
      });
    candidateSet = new Set<number>();
    for (const idx of indices) {
      const t = triples[idx];
      if (t.successorCount < minS) continue;
      if (t.predecessorCount < minP) continue;
      if (getLayer(t) < lMin || getLayer(t) > lMax) continue;
      candidateSet.add(idx);
      if (candidateSet.size >= topN) break;
    }
  }

  // ── Step 2: 构建 key→index 查找表 ──
  const keyToIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    keyToIndex.set(triples[i].key, i);
  }

  // ── Step 3: 构建边 ──
  const usePartial = opts.edgeMode === 'partial';
  const partialThreshold = opts.partialThreshold ?? 0.5;
  const edgeMap = new Map<string, AnalysisEdge>(); // `${from}|${to}` → edge

  if (usePartial) {
    // ── partial 模式：两两比较候选节点，重叠率 ≥ 阈值即建边 ──
    const candidateArr = [...candidateSet];
    for (let i = 0; i < candidateArr.length; i++) {
      const fromIdx = candidateArr[i];
      const fromNode = triples[fromIdx];
      const fromDS = fromNode.depSetTiles;
      const fromSize = fromDS.length;
      const fromTiles = fromNode.tileIds;

      for (let j = 0; j < candidateArr.length; j++) {
        if (i === j) continue;
        const toIdx = candidateArr[j];
        const toNode = triples[toIdx];

        // 跳过共享牌的 triple（同一花色内 triple 可能共享牌，边无意义）
        const toTiles = toNode.tileIds;
        if (fromTiles[0] === toTiles[0] || fromTiles[0] === toTiles[1] || fromTiles[0] === toTiles[2] ||
            fromTiles[1] === toTiles[0] || fromTiles[1] === toTiles[1] || fromTiles[1] === toTiles[2] ||
            fromTiles[2] === toTiles[0] || fromTiles[2] === toTiles[1] || fromTiles[2] === toTiles[2]) continue;

        const toDS = toNode.depSetTiles;
        const overlap = intersectSize(fromDS, toDS);
        const ratio = overlap / fromSize;
        if (ratio < partialThreshold) continue;

        const sig = `${fromIdx}|${toIdx}`;
        if (edgeMap.has(sig)) continue;
        edgeMap.set(sig, { from: fromIdx, to: toIdx, overlap });
      }
    }
  } else {
    // ── full 模式：从 depSet 实时枚举重构边 ──
    // 对每个候选节点，枚举其 depSetTiles 中 C(d,3) 个前驱组合。
    // 若前驱也在候选集中，记录边（前驱→当前节点）。
    // 每条边只被"to 端"枚举一次，天然去重。
    for (const idx of candidateSet) {
      const node = triples[idx];
      const ds = node.depSetTiles; // 已排序
      const d = ds.length;
      if (d < 3) continue;
      const [at1, at2, at3] = node.tileIds;

      for (let a = 0; a < d - 2; a++) {
        const t1 = ds[a];
        if (t1 === at1 || t1 === at2 || t1 === at3) continue;
        for (let b = a + 1; b < d - 1; b++) {
          const t2 = ds[b];
          if (t2 === at1 || t2 === at2 || t2 === at3) continue;
          for (let c = b + 1; c < d; c++) {
            const t3 = ds[c];
            if (t3 === at1 || t3 === at2 || t3 === at3) continue;

            const predKey = tripleKey(sortTriple(t1, t2, t3));
            const predIdx = keyToIndex.get(predKey);
            if (predIdx === undefined || !candidateSet.has(predIdx)) continue;

            const sig = `${predIdx}|${idx}`;
            if (edgeMap.has(sig)) continue;

            const overlap = intersectSize(triples[predIdx].depSetTiles, ds);
            edgeMap.set(sig, { from: predIdx, to: idx, overlap });
          }
        }
      }
    }
  }

  // ── Step 4: 按 overlap 降序排序，应用每节点边数上限 ──
  const allEdges = [...edgeMap.values()].sort((a, b) => b.overlap - a.overlap);
  const nodeEC = new Map<number, number>();
  const selectedEdges: AnalysisEdge[] = [];

  for (const e of allEdges) {
    const cf = nodeEC.get(e.from) ?? 0;
    const ct = nodeEC.get(e.to) ?? 0;
    if (cf >= maxE && ct >= maxE) continue;
    selectedEdges.push(e);
    nodeEC.set(e.from, cf + 1);
    nodeEC.set(e.to, ct + 1);
  }

  return {
    nodeIndices: [...candidateSet],
    prerequisiteEdges: selectedEdges,
    partialOrderEdges: [], // 不在过滤层计算偏序边（前端不使用）
  };
}

export function getTripleDetail(
  result: TripleAnalysisResult,
  tripleKeyStr: string,
): {
  node: TripleNode;
  predecessors: { key: string; overlap: number }[];
  successors: { key: string; overlap: number }[];
  topOverlaps: { key: string; overlap: number }[];
} | null {
  const { triples, prerequisiteEdges } = result;
  const idx = triples.findIndex(t => t.key === tripleKeyStr);
  if (idx === -1) return null;

  const node = triples[idx];

  // 构建 key→index 查找表
  const keyToIdx = new Map<string, number>();
  for (let i = 0; i < triples.length; i++) keyToIdx.set(triples[i].key, i);

  // ── 前驱：从 depSetTiles 实时枚举 C(d,3)，完整覆盖 ──
  const predMap = new Map<string, number>(); // key → overlap
  const ds = node.depSetTiles; // 已排序
  const d = ds.length;
  const [at1, at2, at3] = node.tileIds;

  for (let a = 0; a < d - 2; a++) {
    const t1 = ds[a];
    if (t1 === at1 || t1 === at2 || t1 === at3) continue;
    for (let b = a + 1; b < d - 1; b++) {
      const t2 = ds[b];
      if (t2 === at1 || t2 === at2 || t2 === at3) continue;
      for (let c = b + 1; c < d; c++) {
        const t3 = ds[c];
        if (t3 === at1 || t3 === at2 || t3 === at3) continue;
        const predKey = tripleKey(sortTriple(t1, t2, t3));
        const predIdx = keyToIdx.get(predKey);
        if (predIdx === undefined) continue;
        // 计算 overlap = |pred.depSet ∩ node.depSet|
        const overlap = intersectSize(triples[predIdx].depSetTiles, ds);
        predMap.set(predKey, overlap);
      }
    }
  }

  // ── 后继：从存储的边集中查找（存储边覆盖 top 6000，足够表示主要影响方向）──
  const succMap = new Map<string, number>();
  for (const e of prerequisiteEdges) {
    if (e.from === idx) succMap.set(triples[e.to].key, e.overlap);
  }
  // 也补上存储边中的前驱（和实时计算结果合并）
  for (const e of prerequisiteEdges) {
    if (e.to === idx && !predMap.has(triples[e.from].key)) {
      predMap.set(triples[e.from].key, e.overlap);
    }
  }

  // ── 排序 ──
  const preds = [...predMap.entries()]
    .map(([key, overlap]) => ({ key, overlap }))
    .sort((a, b) => b.overlap - a.overlap);
  const succs = [...succMap.entries()]
    .map(([key, overlap]) => ({ key, overlap }))
    .sort((a, b) => b.overlap - a.overlap);
  const topOverlaps = [...preds, ...succs].sort((a, b) => b.overlap - a.overlap).slice(0, 10);

  return { node, predecessors: preds, successors: succs, topOverlaps };
}

export function clearCache(): number {
  if (!existsSync(CACHE_DIR)) return 0;
  let count = 0;
  for (const f of readdirSync(CACHE_DIR)) {
    if (f.startsWith('triple-analysis-') && f.endsWith('.json')) {
      unlinkSync(join(CACHE_DIR, f));
      count++;
    }
  }
  return count;
}
