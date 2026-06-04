/**
 * Batch Board Analysis v2 — comprehensive, cached, 2000+ boards.
 *
 * Key improvements over v1:
 *   1. Sampled uniformly across grades (2 per grade per terrain)
 *   2. Results cached to disk for incremental runs
 *   3. Both color-group DAG + triple-level DAG features
 *   4. Complete solver results preserved (picks, costLog, dockLog, etc.)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadTerrainFromFile } from '../terrain-loader.js';
import { decodeFromString, getCanonicalTileOrder } from '../replay-serializer.js';
import { createGame } from '../solver/offline-game.js';
import { solveDFS, hasColorParityIssue } from '../solver/solver-dfs.js';
import { solveGreedy } from '../solver/solver-greedy.js';
import { solveRandomBatch } from '../solver/solver-random.js';
import { TileState } from '../types.js';
import type { TerrainData, TerrainTile, ReplayData } from '../types.js';
import { buildColorGroupDAG, buildBoardDAG, extractDAGFeatures } from './board-dag.js';
import type { ColorGroupDAG, BoardDAG } from './board-dag.js';
import type { SolverResult, GreedyResult, DAGFeatures } from '../solver/types.js';
import { logger, setLogLevel, LogLevel } from '../logger.js';

setLogLevel(LogLevel.Error);

// ═══════════════════════════════════════════════════
//  Paths
// ═══════════════════════════════════════════════════

const LEVELS_DIR = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
const REPLAYS_DIR = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Replays';
const CACHE_DIR = join(process.cwd(), '.reversegen-cache', 'board-results-v2');
const AGGREGATE_PATH = join(process.cwd(), '.reversegen-cache', 'aggregate-v2.json');

// ═══════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════

interface CachedResult {
  board: {
    levelResId: number;
    replayKey: string;
    grade: string;
    completionStatus: string;
    terrainHash: string;
    freeTiles: number;
    totalTiles: number;
  };
  dfs: {
    win: boolean;
    failReason: string | null;
    stepCount: number;
    statesVisited: number;
    deadStateCount: number;
    elapsedMs: number;
    picks: number[]; // full elimination sequence
  } | null;
  greedy: {
    win: boolean;
    failReason: string | null;
    stepCount: number;
    elapsedMs: number;
    picks: number[];
    costLog: number[];
    dockLog: number[];
  } | null;
  random: {
    runs: number;
    wins: number;
    winRate: number;
    avgStepsOnWin: number;
  } | null;
  features: {
    colorParityOk: boolean;
    colorCount: number;
    colorGroupSizes: number[];
    avgGroupSize: number;
    maxGroupSize: number;
    initialClickableCount: number;
    avgDepClosureSize: number;
    maxDepClosureSize: number;
    greedyDeathStep: number;
    greedyMaxDock: number;
    greedyAvgDock: number;
    greedyCostVolatility: number;
    // Color-group DAG
    cgNodeCount: number;
    cgEdgeCount: number;
    cgMaxChainLength: number;
    cgParallelSources: number;
    cgAvgDepSetSize: number;
    cgMaxDepSetSize: number;
    cgSinkCount: number;
    // Triple-level DAG
    tdagTripleCount: number;
    tdagEdgeCount: number;
    tdagDepthMax: number;
    tdagRootCount: number;
    tdagLeafCount: number;
    tdagMaxParallelism: number;
    tdagAvgParallelism: number;
    tdagOverlapDensity: number;
    tdagCrossColorEdgeRatio: number;
    tdagAvgDepSetSize: number;
    tdagMaxBottleneckScore: number;
  };
  error?: string;
}

// ═══════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════

function main() {
  try { mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

  const replayFiles = existsSync(REPLAYS_DIR)
    ? readdirSync(REPLAYS_DIR).filter(f => f.endsWith('.json'))
    : [];
  const skipIds = new Set([100001]);
  console.log(`Replay files: ${replayFiles.length}\n`);

  let totalBoards = 0;
  let cached = 0;
  let analyzed = 0;
  let errors = 0;

  for (const file of replayFiles) {
    const levelResId = parseInt(file.replace('.json', ''), 10);
    if (skipIds.has(levelResId)) continue;

    // Load terrain once per file
    const terrainPath = join(LEVELS_DIR, file);
    if (!existsSync(terrainPath)) continue;

    let terrain: TerrainData;
    try { terrain = loadTerrainFromFile(terrainPath); }
    catch { continue; }

    const allTiles = flattenTiles(terrain);
    const canonicalOrder = getCanonicalTileOrder(allTiles);

    // Load replay file
    let replayJson: any;
    try { replayJson = JSON.parse(readFileSync(join(REPLAYS_DIR, file), 'utf-8')); }
    catch { continue; }

    const infoDict = replayJson.replayInfoDict || {};

    for (const [grade, entries] of Object.entries(infoDict)) {
      if (!Array.isArray(entries)) continue;
      // Take up to 2 per grade
      const sampled = (entries as any[]).slice(0, 2);

      for (const entry of sampled) {
        totalBoards++;
        const replayKey = entry.ReplayKey ?? 'unknown';
        const cacheKey = `${levelResId}_${sanitize(replayKey)}`;
        const cachePath = join(CACHE_DIR, `${cacheKey}.json`);

        // Check cache
        if (existsSync(cachePath)) {
          cached++;
          continue;
        }

        // Analyze
        try {
          const result = analyzeOneBoard(
            terrain, allTiles, canonicalOrder,
            entry, grade, levelResId,
          );
          writeFileSync(cachePath, JSON.stringify(result, null, 2));
          analyzed++;
        } catch (e: any) {
          const errResult: CachedResult = {
            board: { levelResId, replayKey, grade, completionStatus: entry.CompletionStatus ?? '', terrainHash: '', freeTiles: 0, totalTiles: 0 },
            dfs: null, greedy: null, random: null,
            features: emptyFeatures(),
            error: e.message,
          };
          writeFileSync(cachePath, JSON.stringify(errResult, null, 2));
          errors++;
        }

        // Progress
        if (analyzed % 50 === 0) {
          const cachedFiles = existsSync(CACHE_DIR) ? readdirSync(CACHE_DIR).filter(f => f.endsWith('.json')).length : 0;
          console.log(`  Analyzed: ${analyzed} | Cached: ${cachedFiles} | Errors: ${errors} | Total boards found: ${totalBoards}`);
        }
      }
    }
  }

  // Final count
  const cachedFiles = existsSync(CACHE_DIR) ? readdirSync(CACHE_DIR).filter(f => f.endsWith('.json')).length : 0;
  console.log(`\n=== Done ===`);
  console.log(`  Total boards found:  ${totalBoards}`);
  console.log(`  Newly analyzed:      ${analyzed}`);
  console.log(`  From cache:          ${cached}`);
  console.log(`  Errors:              ${errors}`);
  console.log(`  Total cached:        ${cachedFiles}`);
}

// ═══════════════════════════════════════════════════
//  Single board analysis
// ═══════════════════════════════════════════════════

function analyzeOneBoard(
  terrain: TerrainData,
  allTiles: TerrainTile[],
  canonicalOrder: TerrainTile[],
  entry: { ReplayKey?: string; ReplayCode?: string; CompletionStatus?: string },
  grade: string,
  levelResId: number,
): CachedResult {
  const replayCode = entry.ReplayCode ?? '';
  const replayData = decodeFromString(replayCode);
  if (!replayData) throw new Error('ReplayCode decode failed');

  const freeTiles = allTiles.filter(t => !t.isConst);

  // Canonical index → terrain tile ID
  const cIdxToTerrainId = new Map<number, number>();
  for (let i = 0; i < canonicalOrder.length; i++) {
    cIdxToTerrainId.set(i, canonicalOrder[i].id);
  }

  // Extract element values & state
  const elementValues = new Map<number, number>();
  const initialDock: { tileId: number; element: number }[] = [];
  const eliminatedIds = new Set<number>();
  const suitMap = new Map<number, number>();

  for (let i = 0; i < replayData.instanceArray.length; i++) {
    const terrainId = cIdxToTerrainId.get(i);
    if (terrainId === undefined) continue;
    const ev = (replayData.instanceArray[i] & 0x3F) + 1;
    elementValues.set(terrainId, ev);
    suitMap.set(terrainId, ev);
    const st = ((replayData.instanceArray[i] >> 6) & 0x3) as TileState;
    if (st === TileState.InDock) initialDock.push({ tileId: terrainId, element: ev });
    else if (st === TileState.Eliminated) eliminatedIds.add(terrainId);
  }
  for (const de of replayData.dockEntries) {
    const terrainId = cIdxToTerrainId.get(de.tileId);
    if (terrainId !== undefined) {
      initialDock.push({ tileId: terrainId, element: de.element });
      elementValues.set(terrainId, de.element);
      suitMap.set(terrainId, de.element);
    }
  }

  // Create game
  const game = createGame({ terrainTiles: allTiles, elementValues, initialDock, eliminatedTileIds: eliminatedIds });

  // ── DFS solver ──
  let dfsResult: SolverResult | null = null;
  try {
    dfsResult = solveDFS(game, { timeoutMs: 15_000, collectDeadStates: true });
  } catch (e) { /* timeout or error */ }

  // ── Greedy solver ──
  let greedyResult: GreedyResult | null = null;
  try {
    greedyResult = solveGreedy(game);
  } catch (e) { /* error */ }

  // ── Random solver ──
  let randomResult: { runs: number; wins: number; winRate: number; avgStepsOnWin: number } | null = null;
  try {
    randomResult = solveRandomBatch(game, 50);
  } catch (e) { /* error */ }

  // ── Features ──
  const features = computeAllFeatures(game, allTiles, freeTiles, suitMap, greedyResult, dfsResult);

  return {
    board: {
      levelResId,
      replayKey: entry.ReplayKey ?? 'unknown',
      grade,
      completionStatus: entry.CompletionStatus ?? '',
      terrainHash: terrain.levelHash ?? '',
      freeTiles: freeTiles.length,
      totalTiles: allTiles.length,
    },
    dfs: dfsResult ? {
      win: dfsResult.win,
      failReason: dfsResult.failReason,
      stepCount: dfsResult.stepCount,
      statesVisited: dfsResult.statesVisited,
      deadStateCount: dfsResult.deadStates.length,
      elapsedMs: dfsResult.elapsedMs,
      picks: dfsResult.picks,
    } : null,
    greedy: greedyResult ? {
      win: greedyResult.win,
      failReason: greedyResult.failReason,
      stepCount: greedyResult.stepCount,
      elapsedMs: greedyResult.elapsedMs,
      picks: greedyResult.picks,
      costLog: greedyResult.costLog,
      dockLog: greedyResult.dockLog,
    } : null,
    random: randomResult,
    features,
  };
}

// ═══════════════════════════════════════════════════
//  Feature computation
// ═══════════════════════════════════════════════════

function computeAllFeatures(
  game: ReturnType<typeof createGame>,
  allTiles: TerrainTile[],
  freeTiles: TerrainTile[],
  suitMap: Map<number, number>,
  greedyResult: GreedyResult | null,
  dfsResult: SolverResult | null,
): CachedResult['features'] {
  // Basic
  const colorSizes = new Map<number, number>();
  for (const [, t] of game.allTiles) {
    if ((t.flags & 0x8) !== 0) continue; // skip destroyed
    colorSizes.set(t.elementValue, (colorSizes.get(t.elementValue) ?? 0) + 1);
  }
  const groupSizes = [...colorSizes.values()];
  const colorParityOk = groupSizes.every(s => s % 3 === 0);

  const depSizes = computeDepClosureSizes(allTiles);
  const avgDep = depSizes.length > 0 ? depSizes.reduce((a, b) => a + b, 0) / depSizes.length : 0;
  const maxDep = depSizes.length > 0 ? Math.max(...depSizes) : 0;

  const initClickable = [...game.allTiles.values()].filter(t => (t.flags & 0x8) === 0 && t.isClickable).length;

  // Greedy stats
  let gDeathStep = 0, gMaxDock = 0, gAvgDock = 0, gCostVol = 0;
  if (greedyResult) {
    gDeathStep = greedyResult.stepCount;
    gMaxDock = greedyResult.dockLog.length > 0 ? Math.max(...greedyResult.dockLog) : 0;
    gAvgDock = greedyResult.dockLog.length > 0
      ? greedyResult.dockLog.reduce((a, b) => a + b, 0) / greedyResult.dockLog.length : 0;
    if (greedyResult.costLog.length > 1) {
      const mean = greedyResult.costLog.reduce((a, b) => a + b, 0) / greedyResult.costLog.length;
      gCostVol = Math.sqrt(greedyResult.costLog.reduce((s, c) => s + (c - mean) ** 2, 0) / greedyResult.costLog.length);
    }
  }

  // ── Color-group DAG ──
  let cgDAG: ColorGroupDAG | null = null;
  try { cgDAG = buildColorGroupDAG(freeTiles, suitMap); } catch {}

  // ── Triple-level DAG ──
  let tdag: BoardDAG | null = null;
  let tdagFeatures: DAGFeatures | null = null;
  try {
    tdag = buildBoardDAG(freeTiles, suitMap);
    if (tdag.nodes.length <= 10000) {
      tdagFeatures = extractDAGFeatures(tdag);
    }
  } catch {}

  // Triple DAG cross-color edge ratio
  let crossColorEdgeRatio = 0;
  if (tdag && tdag.edges.length > 0) {
    let crossColorEdges = 0;
    for (const e of tdag.edges) {
      if (tdag.nodes[e.from].color !== tdag.nodes[e.to].color) crossColorEdges++;
    }
    crossColorEdgeRatio = crossColorEdges / tdag.edges.length;
  }

  // Sink count for color-group DAG
  let cgSinkCount = 0;
  if (cgDAG) {
    const hasOutgoing = new Set<number>();
    for (const [a] of cgDAG.edges) hasOutgoing.add(a);
    for (let i = 0; i < cgDAG.nodes.length; i++) {
      if (!hasOutgoing.has(i)) cgSinkCount++;
    }
  }

  return {
    colorParityOk,
    colorCount: colorSizes.size,
    colorGroupSizes: groupSizes.sort((a, b) => b - a),
    avgGroupSize: groupSizes.length > 0 ? groupSizes.reduce((a, b) => a + b, 0) / groupSizes.length : 0,
    maxGroupSize: groupSizes.length > 0 ? Math.max(...groupSizes) : 0,
    initialClickableCount: initClickable,
    avgDepClosureSize: avgDep,
    maxDepClosureSize: maxDep,
    greedyDeathStep: gDeathStep,
    greedyMaxDock: gMaxDock,
    greedyAvgDock: gAvgDock,
    greedyCostVolatility: gCostVol,
    // Color-group DAG
    cgNodeCount: cgDAG?.nodes.length ?? 0,
    cgEdgeCount: cgDAG?.edges.length ?? 0,
    cgMaxChainLength: cgDAG?.maxChainLength ?? 0,
    cgParallelSources: cgDAG?.parallelGroups ?? 0,
    cgAvgDepSetSize: cgDAG && cgDAG.nodes.length > 0
      ? cgDAG.nodes.reduce((s, n) => s + n.depSetSize, 0) / cgDAG.nodes.length : 0,
    cgMaxDepSetSize: cgDAG && cgDAG.nodes.length > 0
      ? Math.max(...cgDAG.nodes.map(n => n.depSetSize)) : 0,
    cgSinkCount,
    // Triple-level DAG
    tdagTripleCount: tdag?.nodes.length ?? 0,
    tdagEdgeCount: tdag?.edges.length ?? 0,
    tdagDepthMax: tdagFeatures?.depthMax ?? 0,
    tdagRootCount: tdagFeatures?.rootTripleCount ?? 0,
    tdagLeafCount: tdagFeatures?.leafTripleCount ?? 0,
    tdagMaxParallelism: tdagFeatures?.maxParallelism ?? 0,
    tdagAvgParallelism: tdagFeatures?.avgParallelism ?? 0,
    tdagOverlapDensity: tdagFeatures?.overlapDensity ?? 0,
    tdagCrossColorEdgeRatio: crossColorEdgeRatio,
    tdagAvgDepSetSize: tdagFeatures?.avgDepSetSize ?? 0,
    tdagMaxBottleneckScore: tdagFeatures?.maxBottleneckScore ?? 0,
  };
}

// ═══════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════

function flattenTiles(terrain: TerrainData): TerrainTile[] {
  const tiles: TerrainTile[] = [];
  for (const layer of terrain.layers) for (const tile of layer.tiles) tiles.push(tile);
  return tiles;
}

function computeDepClosureSizes(tiles: TerrainTile[]): number[] {
  const tileMap = new Map<number, TerrainTile>();
  for (const t of tiles) tileMap.set(t.id, t);
  const sizes: number[] = [];
  for (const tile of tiles) {
    const visited = new Set<number>();
    const queue = [...tile.dependencies];
    let head = 0;
    while (head < queue.length) {
      const id = queue[head++];
      if (visited.has(id)) continue;
      visited.add(id);
      const dep = tileMap.get(id);
      if (dep) queue.push(...dep.dependencies);
    }
    sizes.push(visited.size);
  }
  return sizes;
}

function sanitize(s: string): string {
  return s.replace(/[/\\?%*:|"<>]/g, '_').substring(0, 64);
}

function emptyFeatures(): CachedResult['features'] {
  return {
    colorParityOk: false, colorCount: 0, colorGroupSizes: [], avgGroupSize: 0, maxGroupSize: 0,
    initialClickableCount: 0, avgDepClosureSize: 0, maxDepClosureSize: 0,
    greedyDeathStep: 0, greedyMaxDock: 0, greedyAvgDock: 0, greedyCostVolatility: 0,
    cgNodeCount: 0, cgEdgeCount: 0, cgMaxChainLength: 0, cgParallelSources: 0,
    cgAvgDepSetSize: 0, cgMaxDepSetSize: 0, cgSinkCount: 0,
    tdagTripleCount: 0, tdagEdgeCount: 0, tdagDepthMax: 0, tdagRootCount: 0,
    tdagLeafCount: 0, tdagMaxParallelism: 0, tdagAvgParallelism: 0,
    tdagOverlapDensity: 0, tdagCrossColorEdgeRatio: 0,
    tdagAvgDepSetSize: 0, tdagMaxBottleneckScore: 0,
  };
}

// ── Run ──
main();
