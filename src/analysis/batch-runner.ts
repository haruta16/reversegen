/**
 * Batch board analyzer — Phase A core.
 *
 * Reads replay codes (from files or ReverseGen output), runs DFS/greedy/random solvers,
 * extracts features, outputs correlation data.
 *
 * Goal: Find DAG-structural features that deterministically predict board properties.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { loadTerrainFromFile } from '../terrain-loader.js';
import { decodeFromString, getCanonicalTileOrder } from '../replay-serializer.js';
import { generateBoard } from '../index.js';
import type { TerrainData, TerrainTile, ReplayData, DockEntry } from '../types.js';
import { TileState } from '../types.js';
import { createGame, OfflineGame } from '../solver/offline-game.js';
import { solveDFS } from '../solver/solver-dfs.js';
import { solveGreedy } from '../solver/solver-greedy.js';
import { solveRandomBatch } from '../solver/solver-random.js';
import { PileType, type SolverResult, type GreedyResult } from '../solver/types.js';
import { buildColorGroupDAG, type ColorGroupDAG } from './board-dag.js';

// ═══════════════════════════════════════════════════
//  ReplayData helpers (element extraction from instanceArray)
// ═══════════════════════════════════════════════════

/** Extract TileState from instanceArray byte. bit[7:6] */
function getState(instanceArray: Uint8Array, idx: number): TileState {
  return ((instanceArray[idx] >> 6) & 0x3) as TileState;
}

/** Extract normalized element index from instanceArray byte. bit[5:0] */
function getElementIndex(instanceArray: Uint8Array, idx: number): number {
  return instanceArray[idx] & 0x3F;
}

/** Normalized 1-based element value */
function getElementValue(instanceArray: Uint8Array, idx: number): number {
  return getElementIndex(instanceArray, idx) + 1;
}

// ═══════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════

export interface BoardRecord {
  source: string;
  levelResId?: number;
  replayKey?: string;
  grade?: string;
  completionStatus?: string;
  terrainHash: string;
  freeTiles: number;
  totalTiles: number;
  colorCount: number;
  initialDockCount: number;
}

export interface SolverResults {
  dfs: SolverResult | null;
  greedy: GreedyResult | null;
  random: { runs: number; wins: number; winRate: number; avgStepsOnWin: number } | null;
}

export interface BoardFeatures {
  colorParityOk: boolean;
  colorGroupSizes: number[];
  colorCount: number;
  avgGroupSize: number;
  maxGroupSize: number;
  layers: number;
  initialClickableCount: number;
  avgDepClosureSize: number;
  maxDepClosureSize: number;
  greedyDeathStep: number;
  greedyDeathDockSize: number;
  greedyMaxDock: number;
  greedyAvgDock: number;
  greedyCostVolatility: number;
  dfsDeadStateCount: number;
  dfsStatesVisited: number;
  /** Color-group DAG features */
  dagColorGroups: number;
  dagMaxChainLength: number;
  dagEdgeCount: number;
  dagParallelGroups: number;
  dagAvgDepSetSize: number;
}

export interface BatchResult {
  board: BoardRecord;
  solvers: SolverResults;
  features: BoardFeatures;
  error?: string;
}

export interface BatchConfig {
  terrainDir: string;
  replayDir: string;
  skipIds?: Set<number>;
  dfsTimeoutMs?: number;
  randomRuns?: number;
  maxBoards?: number;
  includeReversegen?: boolean;
  reversegenCount?: number;
  /** Write per-board JSON for debugging */
  debugDir?: string;
}

// ═══════════════════════════════════════════════════
//  Batch runner
// ═══════════════════════════════════════════════════

const LEVELS_DIR = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
const REPLAYS_DIR = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Replays';

export function runBatch(config: BatchConfig): BatchResult[] {
  const skipIds = config.skipIds ?? new Set([100001]);
  const dfsTimeoutMs = config.dfsTimeoutMs ?? 30_000;
  const randomRuns = config.randomRuns ?? 50;
  const results: BatchResult[] = [];
  let boardCount = 0;
  const limit = config.maxBoards ?? 0;

  // ── Collect replay files ──
  const replayFiles = existsSync(config.replayDir)
    ? readdirSync(config.replayDir).filter(f => f.endsWith('.json'))
    : [];
  console.log(`Found ${replayFiles.length} replay files`);

  for (const file of replayFiles) {
    if (limit > 0 && boardCount >= limit) break;
    const levelResId = parseInt(file.replace('.json', ''), 10);
    if (skipIds.has(levelResId)) continue;

    const terrainPath = join(config.terrainDir, file);
    if (!existsSync(terrainPath)) {
      console.warn(`Skip ${file}: terrain not found`);
      continue;
    }

    let terrain: TerrainData;
    try { terrain = loadTerrainFromFile(terrainPath); }
    catch { console.warn(`Skip ${file}: terrain load failed`); continue; }

    let replayJson: any;
    try { replayJson = JSON.parse(readFileSync(join(config.replayDir, file), 'utf-8')); }
    catch { console.warn(`Skip ${file}: JSON parse failed`); continue; }

    const allTiles = flattenTiles(terrain);
    const canonicalOrder = getCanonicalTileOrder(allTiles);

    // Sample: take first 2 entries per file to get terrain diversity
    const infoDict = replayJson.replayInfoDict || {};
    let sampledPerFile = 0;
    for (const [grade, entries] of Object.entries(infoDict)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries as any[]) {
        if (limit > 0 && boardCount >= limit) break;
        if (sampledPerFile >= 2) break; // max 2 per terrain
        try {
          const r = analyzeOneBoard(
            terrain, allTiles, canonicalOrder,
            entry, grade, levelResId, 'replay-file',
            dfsTimeoutMs, randomRuns,
          );
          results.push(r);
          boardCount++;
          sampledPerFile++;
        } catch (e: any) {
          results.push(makeErrorResult(levelResId, entry, grade, e.message));
        }
      }
      if (sampledPerFile >= 2) break;
    }
  }

  // ── ReverseGen boards (optional) ──
  if (config.includeReversegen) {
    const count = config.reversegenCount ?? 2;
    const terrainFiles = existsSync(config.terrainDir)
      ? readdirSync(config.terrainDir).filter(f => f.endsWith('.json'))
      : [];
    const sampled = terrainFiles
      .map(f => parseInt(f.replace('.json', ''), 10))
      .filter(id => !skipIds.has(id))
      .slice(0, 20); // Sample 20 terrains

    for (const levelResId of sampled) {
      if (limit > 0 && boardCount >= limit) break;
      const terrainPath = join(config.terrainDir, `${levelResId}.json`);
      let terrain: TerrainData;
      try { terrain = loadTerrainFromFile(terrainPath); }
      catch { continue; }

      const allTiles = flattenTiles(terrain);
      const freeTiles = allTiles.filter(t => !t.isConst);
      const steps = Math.floor(freeTiles.length / 3);
      const colorCount = steps; // Unique colors

      const costConfigs = [
        { name: 'flat-1', costArray: Array(steps).fill(1) },
        { name: 'flat-3', costArray: Array(steps).fill(3) },
        { name: 'climb', costArray: generateClimbArray(steps) },
      ];

      for (const cfg of costConfigs) {
        for (let i = 0; i < count; i++) {
          if (limit > 0 && boardCount >= limit) break;
          try {
            const genResult = generateBoard({ terrain, costArray: cfg.costArray, colorCount });
            const r = analyzeOneBoard(
              terrain, allTiles, getCanonicalTileOrder(allTiles),
              {
                ReplayKey: `rg-${cfg.name}-${i}`,
                ReplayCode: genResult.replayCode,
                CompletionStatus: genResult.matchRate > 80 ? 'Match' : `Deviation(${genResult.matchRate.toFixed(0)}%)`,
              },
              cfg.name, levelResId, 'reversegen',
              dfsTimeoutMs, randomRuns,
            );
            results.push(r);
            boardCount++;
          } catch { /* skip failed gen */ }
        }
      }
    }
  }

  // ── Write debug per-board data ──
  if (config.debugDir) {
    try { mkdirSync(config.debugDir, { recursive: true }); } catch {}
    for (const r of results) {
      const key = `${r.board.levelResId}_${r.board.replayKey ?? 'unknown'}`.replace(/[/\\?%*:|"<>]/g, '_');
      writeFileSync(join(config.debugDir, `${key}.json`), JSON.stringify(r, null, 2));
    }
  }

  return results;
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
  source: string,
  dfsTimeoutMs: number,
  randomRuns: number,
): BatchResult {
  // ── Decode ReplayCode ──
  const replayCode = entry.ReplayCode ?? '';
  const replayData = decodeFromString(replayCode);
  if (!replayData) throw new Error('ReplayCode decode returned null');

  // ── Build canonical index → terrain tile ID mapping ──
  // canonicalOrder[i] is the TerrainTile at canonical position i
  // instanceArray[i] corresponds to canonicalOrder[i]
  // dockEntries[i].tileId is a canonical index (0..N-1)
  const canIdxToTerrainId = new Map<number, number>();
  for (let i = 0; i < canonicalOrder.length; i++) {
    canIdxToTerrainId.set(i, canonicalOrder[i].id);
  }

  // ── Extract element values and state ──
  const elementValues = new Map<number, number>();
  const initialDock: { tileId: number; element: number }[] = [];
  const eliminatedIds = new Set<number>();

  for (let i = 0; i < replayData.instanceArray.length; i++) {
    const terrainId = canIdxToTerrainId.get(i);
    if (terrainId === undefined) continue;

    const ev = getElementValue(replayData.instanceArray, i);
    elementValues.set(terrainId, ev);

    const state = getState(replayData.instanceArray, i);
    if (state === TileState.InDock) {
      initialDock.push({ tileId: terrainId, element: ev });
    } else if (state === TileState.Eliminated) {
      eliminatedIds.add(terrainId);
    }
  }

  // Also add dock entries (these have element values already)
  for (const de of replayData.dockEntries) {
    const terrainId = canIdxToTerrainId.get(de.tileId);
    if (terrainId !== undefined) {
      initialDock.push({ tileId: terrainId, element: de.element });
      elementValues.set(terrainId, de.element);
    }
  }

  // ── Create game ──
  const game = createGame({
    terrainTiles: allTiles,
    elementValues,
    initialDock,
    eliminatedTileIds: eliminatedIds,
  });

  const freeTiles = allTiles.filter(t => !t.isConst);
  const colorSet = new Set(elementValues.values());

  // ── Run solvers ──
  const dfsResult = solveDFS(game, { timeoutMs: dfsTimeoutMs, collectDeadStates: true });
  const greedyResult = solveGreedy(game);
  const randomResults = solveRandomBatch(game, randomRuns);

  // ── Extract features ──
  const features = extractFeatures(game, allTiles, greedyResult, dfsResult);

  return {
    board: {
      source,
      levelResId,
      replayKey: entry.ReplayKey,
      grade,
      completionStatus: entry.CompletionStatus,
      terrainHash: terrain.levelHash ?? '',
      freeTiles: freeTiles.length,
      totalTiles: allTiles.length,
      colorCount: colorSet.size,
      initialDockCount: initialDock.length,
    },
    solvers: {
      dfs: dfsResult,
      greedy: greedyResult,
      random: randomResults,
    },
    features,
  };
}

// ═══════════════════════════════════════════════════
//  Feature extraction
// ═══════════════════════════════════════════════════

function extractFeatures(
  game: OfflineGame,
  allTiles: TerrainTile[],
  greedyResult: GreedyResult | null,
  dfsResult: SolverResult | null,
): BoardFeatures {
  // Build suit map from game state
  const suitMap = new Map<number, number>();
  for (const [, t] of game.allTiles) {
    if (t.elementValue > 0) suitMap.set(t.id, t.elementValue);
  }
  const freeTiles = allTiles.filter(t => !t.isConst);

  // Color-group DAG
  let dagColorGroups = 0, dagMaxChainLength = 0, dagEdgeCount = 0, dagParallelGroups = 0, dagAvgDepSetSize = 0;
  try {
    const dag = buildColorGroupDAG(freeTiles, suitMap);
    dagColorGroups = dag.nodes.length;
    dagMaxChainLength = dag.maxChainLength;
    dagEdgeCount = dag.edges.length;
    dagParallelGroups = dag.parallelGroups;
    dagAvgDepSetSize = dag.nodes.length > 0
      ? dag.nodes.reduce((s, n) => s + n.depSetSize, 0) / dag.nodes.length : 0;
  } catch { /* DAG build failed for this board */ }

  // Color group sizes
  const colorSizes = new Map<number, number>();
  for (const [, t] of game.allTiles) {
    if (t.pileType === PileType.Discard) continue;
    colorSizes.set(t.elementValue, (colorSizes.get(t.elementValue) ?? 0) + 1);
  }
  const groupSizes = [...colorSizes.values()];

  // depSet closure sizes
  const depSizes = computeDepClosureSizes(allTiles);

  // Initial clickable
  const initialClickable = [...game.allTiles.values()].filter(
    t => t.pileType === PileType.Desk && t.isClickable,
  ).length;

  // Greedy stats
  let gdStep = 0, gdDock = 0, gMaxDock = 0, gAvgDock = 0, gVol = 0;
  if (greedyResult) {
    gdStep = greedyResult.stepCount;
    gdDock = greedyResult.dockLog.length > 0 ? greedyResult.dockLog[greedyResult.dockLog.length - 1] : 0;
    gMaxDock = greedyResult.dockLog.length > 0 ? Math.max(...greedyResult.dockLog) : 0;
    gAvgDock = greedyResult.dockLog.length > 0
      ? greedyResult.dockLog.reduce((a, b) => a + b, 0) / greedyResult.dockLog.length : 0;
    if (greedyResult.costLog.length > 1) {
      const mean = greedyResult.costLog.reduce((a, b) => a + b, 0) / greedyResult.costLog.length;
      gVol = Math.sqrt(greedyResult.costLog.reduce((s, c) => s + (c - mean) ** 2, 0) / greedyResult.costLog.length);
    }
  }

  return {
    colorParityOk: groupSizes.every(s => s % 3 === 0),
    colorGroupSizes: groupSizes.sort((a, b) => b - a),
    colorCount: colorSizes.size,
    avgGroupSize: groupSizes.length > 0 ? groupSizes.reduce((a, b) => a + b, 0) / groupSizes.length : 0,
    maxGroupSize: groupSizes.length > 0 ? Math.max(...groupSizes) : 0,
    layers: new Set(allTiles.map(t => t.layer)).size,
    initialClickableCount: initialClickable,
    avgDepClosureSize: depSizes.length > 0 ? depSizes.reduce((a, b) => a + b, 0) / depSizes.length : 0,
    maxDepClosureSize: depSizes.length > 0 ? Math.max(...depSizes) : 0,
    greedyDeathStep: gdStep,
    greedyDeathDockSize: gdDock,
    greedyMaxDock: gMaxDock,
    greedyAvgDock: gAvgDock,
    greedyCostVolatility: gVol,
    dfsDeadStateCount: dfsResult?.deadStates.length ?? 0,
    dfsStatesVisited: dfsResult?.statesVisited ?? 0,
    dagColorGroups,
    dagMaxChainLength,
    dagEdgeCount,
    dagParallelGroups,
    dagAvgDepSetSize,
  };
}

function makeErrorResult(levelResId: number, entry: any, grade: string, msg: string): BatchResult {
  return {
    board: {
      source: 'replay-file', levelResId,
      replayKey: entry?.ReplayKey, grade,
      completionStatus: entry?.CompletionStatus,
      terrainHash: '', freeTiles: 0, totalTiles: 0, colorCount: 0, initialDockCount: 0,
    },
    solvers: { dfs: null, greedy: null, random: null },
    features: emptyFeatures(),
    error: msg,
  };
}

function emptyFeatures(): BoardFeatures {
  return {
    colorParityOk: false, colorGroupSizes: [], colorCount: 0, avgGroupSize: 0, maxGroupSize: 0,
    layers: 0, initialClickableCount: 0, avgDepClosureSize: 0, maxDepClosureSize: 0,
    greedyDeathStep: 0, greedyDeathDockSize: 0, greedyMaxDock: 0, greedyAvgDock: 0,
    greedyCostVolatility: 0, dfsDeadStateCount: 0, dfsStatesVisited: 0,
    dagColorGroups: 0, dagMaxChainLength: 0, dagEdgeCount: 0, dagParallelGroups: 0, dagAvgDepSetSize: 0,
  };
}

// ═══════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════

function flattenTiles(terrain: TerrainData): TerrainTile[] {
  const tiles: TerrainTile[] = [];
  for (const layer of terrain.layers) {
    for (const tile of layer.tiles) tiles.push(tile);
  }
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

function generateClimbArray(steps: number): number[] {
  return Array.from({ length: steps }, (_, i) => Math.min(1 + Math.floor(i / 3), 6));
}

// ═══════════════════════════════════════════════════
//  Main entry + summary
// ═══════════════════════════════════════════════════

export function runMainBatch(): BatchResult[] {
  console.log('═══════════════════════════════════════');
  console.log('  Phase A: Batch Board Analysis');
  console.log('═══════════════════════════════════════\n');

  const results = runBatch({
    terrainDir: LEVELS_DIR,
    replayDir: REPLAYS_DIR,
    dfsTimeoutMs: 30_000,
    randomRuns: 50,
    maxBoards: 300,
    includeReversegen: true,
    reversegenCount: 2,
    debugDir: join(process.cwd(), '.reversegen-cache', 'board-debug'),
  });

  printSummary(results);

  // Write aggregate results
  const outDir = join(process.cwd(), '.reversegen-cache');
  try { mkdirSync(outDir, { recursive: true }); } catch {}
  const outPath = join(outDir, 'batch-analysis.json');
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nFull results: ${outPath} (${results.length} boards)`);

  return results;
}

function printSummary(results: BatchResult[]): void {
  const dfsSolved = results.filter(r => r.solvers.dfs?.win).length;
  const greedySolved = results.filter(r => r.solvers.greedy?.win).length;
  const dfsTimeout = results.filter(r => r.solvers.dfs && !r.solvers.dfs.win && (r.solvers.dfs.failReason?.includes('timeout') ?? false)).length;
  const errors = results.filter(r => r.error).length;

  console.log(`\n═══════════════════════════════════════`);
  console.log(`  Summary (${results.length} boards)`);
  console.log(`═══════════════════════════════════════`);
  console.log(`  DFS solved:      ${dfsSolved}/${results.length - errors}`);
  console.log(`  DFS unsolved:    ${results.length - errors - dfsSolved}`);
  console.log(`  DFS timeout:     ${dfsTimeout}`);
  console.log(`  Greedy solved:   ${greedySolved}/${results.length - errors}`);
  console.log(`  Errors:          ${errors}`);

  // Random stats
  const randomData = results.filter(r => r.solvers.random);
  if (randomData.length > 0) {
    const avgWR = randomData.reduce((s, r) => s + r.solvers.random!.winRate, 0) / randomData.length;
    const highWR = randomData.filter(r => r.solvers.random!.winRate > 0.8).length;
    const lowWR = randomData.filter(r => r.solvers.random!.winRate < 0.2).length;
    console.log(`  Avg random WR:   ${(avgWR * 100).toFixed(1)}%`);
    console.log(`  High WR (>80%):  ${highWR}`);
    console.log(`  Low WR (<20%):   ${lowWR}`);
  }

  // Feature correlations
  console.log(`\n═══════════════════════════════════════`);
  console.log(`  DFS-solvable vs DFS-unsolvable`);
  console.log(`═══════════════════════════════════════`);

  const solved = results.filter(r => r.solvers.dfs?.win && !r.error);
  const unsolved = results.filter(r => r.solvers.dfs && !r.solvers.dfs.win && !r.error);

  if (solved.length > 0 && unsolved.length > 0) {
    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    console.log(`  Feature            | Solved (n=${solved.length}) | Unsolved (n=${unsolved.length})`);
    console.log(`  -------------------|-------------------|---------------------`);
    console.log(`  avgGroupSize       | ${avg(solved.map(r => r.features.avgGroupSize)).toFixed(1).padStart(17)} | ${avg(unsolved.map(r => r.features.avgGroupSize)).toFixed(1).padStart(17)}`);
    console.log(`  maxGroupSize       | ${avg(solved.map(r => r.features.maxGroupSize)).toFixed(1).padStart(17)} | ${avg(unsolved.map(r => r.features.maxGroupSize)).toFixed(1).padStart(17)}`);
    console.log(`  avgDepClosureSize  | ${avg(solved.map(r => r.features.avgDepClosureSize)).toFixed(1).padStart(17)} | ${avg(unsolved.map(r => r.features.avgDepClosureSize)).toFixed(1).padStart(17)}`);
    console.log(`  initialClickable   | ${avg(solved.map(r => r.features.initialClickableCount)).toFixed(1).padStart(17)} | ${avg(unsolved.map(r => r.features.initialClickableCount)).toFixed(1).padStart(17)}`);
    console.log(`  greedyMaxDock      | ${avg(solved.map(r => r.features.greedyMaxDock)).toFixed(1).padStart(17)} | ${avg(unsolved.map(r => r.features.greedyMaxDock)).toFixed(1).padStart(17)}`);
    console.log(`  greedyCostVol      | ${avg(solved.map(r => r.features.greedyCostVolatility)).toFixed(1).padStart(17)} | ${avg(unsolved.map(r => r.features.greedyCostVolatility)).toFixed(1).padStart(17)}`);
    console.log(`  dagMaxChainLength  | ${avg(solved.map(r => r.features.dagMaxChainLength)).toFixed(1).padStart(17)} | ${avg(unsolved.map(r => r.features.dagMaxChainLength)).toFixed(1).padStart(17)}`);
    console.log(`  dagEdgeCount       | ${avg(solved.map(r => r.features.dagEdgeCount)).toFixed(1).padStart(17)} | ${avg(unsolved.map(r => r.features.dagEdgeCount)).toFixed(1).padStart(17)}`);
    console.log(`  dagParallelGroups  | ${avg(solved.map(r => r.features.dagParallelGroups)).toFixed(1).padStart(17)} | ${avg(unsolved.map(r => r.features.dagParallelGroups)).toFixed(1).padStart(17)}`);
    console.log(`  dagAvgDepSetSize   | ${avg(solved.map(r => r.features.dagAvgDepSetSize)).toFixed(1).padStart(17)} | ${avg(unsolved.map(r => r.features.dagAvgDepSetSize)).toFixed(1).padStart(17)}`);
    console.log(`  dfsStatesVisited   | ${avg(solved.map(r => r.features.dfsStatesVisited)).toFixed(0).padStart(17)} | ${avg(unsolved.map(r => r.features.dfsStatesVisited)).toFixed(0).padStart(17)}`);
  }

  // DFS vs Greedy comparison (first 15)
  console.log(`\n═══════════════════════════════════════`);
  console.log(`  DFS vs Greedy (sample)`);
  console.log(`═══════════════════════════════════════`);
  for (const r of results.slice(0, 15)) {
    if (!r.error && r.solvers.dfs && r.solvers.greedy) {
      const d = r.solvers.dfs.win ? '✓' : '✗';
      const g = r.solvers.greedy.win ? '✓' : '✗';
      const wr = r.solvers.random ? `${(r.solvers.random.winRate * 100).toFixed(0)}%` : 'n/a';
      const src = r.board.source === 'reversegen' ? 'RG' : 'RP';
      console.log(`  ${String(r.board.levelResId).padEnd(7)} [${src}] DFS:${d} Greedy:${g} RndWR:${wr}  (${r.features.freeTiles}t ${r.features.colorCount}c)`);
    }
  }
}

// Allow running directly
if (process.argv[1]?.endsWith('batch-runner.ts') || process.argv[1]?.endsWith('batch-runner.js')) {
  runMainBatch();
}
