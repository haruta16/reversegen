/**
 * Release Concentration Analysis
 *
 * Core hypothesis: death depth = max chain length in the "concentrated dependency" graph.
 *
 * For each triple: after elimination, which colors receive freed tiles?
 * If freed tiles concentrate into ONE color → chain continues.
 * If freed tiles scatter across many colors → chain breaks.
 *
 * This tool computes the "concentration matrix" and predicts death depth.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadTerrainFromFile } from '../src/terrain-loader.js';
import { decodeFromString, getCanonicalTileOrder } from '../src/replay-serializer.js';
import { createGame, OfflineGame } from '../src/solver/offline-game.js';
import { computeAllDependencies } from '../src/dependency-graph.js';
import { logger, setLogLevel, LogLevel } from '../src/logger.js';
setLogLevel(LogLevel.Error);

const LEVELS_DIR = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
const REPLAYS_DIR = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Replays';
const cacheDir = join(process.cwd(), '.reversegen-cache', 'board-results-v2');

// ============================================
// Concentration Matrix
// ============================================

interface ConcentrationMatrix {
  /** color A → color B → how many of B's tiles are blocked by ANY tile of A */
  blockerToBlocked: Map<number, Map<number, number>>;
  /** For each color, how many tiles does it have */
  colorTileCounts: Map<number, number>;
  /** For each color, how many clickable tiles at start */
  colorClickable: Map<number, number>;
  /** For each color A, which colors does it "mostly" block (≥50% of target's tiles) */
  primaryTargets: Map<number, number[]>;
  /** For each color A, concentration score = max(blocked_count / target_total) */
  concentration: Map<number, { target: number; ratio: number }>;
}

function buildConcentrationMatrix(
  freeTiles: any[],
  suitMap: Map<number, number>,
  game: OfflineGame,
): ConcentrationMatrix {
  const colors = [...new Set(suitMap.values())].sort((a, b) => a - b);

  // Count tiles per color
  const colorTileCounts = new Map<number, number>();
  for (const [, c] of suitMap) {
    colorTileCounts.set(c, (colorTileCounts.get(c) ?? 0) + 1);
  }

  // Initial clickable
  const clickable = game.deskTiles.filter(t => t.isClickable);
  const colorClickable = new Map<number, number>();
  for (const c of colors) colorClickable.set(c, 0);
  for (const t of clickable) {
    const c = suitMap.get(t.id)!;
    colorClickable.set(c, (colorClickable.get(c)! + 1));
  }

  // Build blocker→blocked matrix
  const blockerToBlocked = new Map<number, Map<number, number>>();
  for (const c of colors) {
    blockerToBlocked.set(c, new Map());
    for (const c2 of colors) {
      blockerToBlocked.get(c)!.set(c2, 0);
    }
  }

  for (const tile of freeTiles) {
    const tileColor = suitMap.get(tile.id)!;
    for (const depId of tile.dependencies) {
      const blockerColor = suitMap.get(depId);
      if (blockerColor !== undefined && blockerColor !== tileColor) {
        const inner = blockerToBlocked.get(blockerColor)!;
        inner.set(tileColor, (inner.get(tileColor) ?? 0) + 1);
      }
    }
  }

  // Compute concentration: for each blocker color, which target gets the most attention?
  const concentration = new Map<number, { target: number; ratio: number }>();
  const primaryTargets = new Map<number, number[]>();

  for (const [blocker, targets] of blockerToBlocked) {
    let bestTarget = 0, bestRatio = 0;
    const primaries: number[] = [];

    for (const [target, count] of targets) {
      const total = colorTileCounts.get(target) ?? 1;
      const ratio = count / total;
      if (ratio > bestRatio) { bestRatio = ratio; bestTarget = target; }
      if (ratio >= 0.5) primaries.push(target);
    }

    concentration.set(blocker, { target: bestTarget, ratio: bestRatio });
    primaryTargets.set(blocker, primaries);
  }

  return { blockerToBlocked, colorTileCounts, colorClickable, primaryTargets, concentration };
}

// ============================================
// Chain prediction
// ============================================

function predictChainLength(matrix: ConcentrationMatrix, maxLen: number = 15): {
  maxDepth: number;
  chains: number[][];
  reason: string;
} {
  const { colorClickable, primaryTargets, concentration, colorTileCounts } = matrix;

  // Starting colors: those with ≥3 clickable
  const startColors = [...colorClickable.entries()]
    .filter(([, n]) => n >= 3)
    .map(([c]) => c);

  if (startColors.length === 0) {
    return { maxDepth: 0, chains: [], reason: 'No color has ≥3 clickable at start' };
  }

  // Build dependency graph: A → B if A is a primary blocker of B (blocks ≥50% of B's tiles)
  // The chain continues if eliminating A's triple frees enough of B's tiles
  // Simplified: if A blocks ≥50% of B, then eliminating 3 tiles of A frees ≥proportion of B

  // DFS to find all chains starting from startColors
  const allChains: number[][] = [];

  function dfs(current: number, visited: Set<number>, chain: number[]): void {
    if (chain.length > maxLen) return;
    allChains.push([...chain]);

    const primaries = primaryTargets.get(current) ?? [];
    // Also check: can current color continue? It needs to have remaining tiles
    // Its OWN tiles might be blocked by itself or others
    for (const target of primaries) {
      if (visited.has(target)) continue; // avoid cycles
      if (target === current) continue;

      // Check: does target have enough tiles?
      const targetTotal = colorTileCounts.get(target) ?? 0;
      if (targetTotal < 3) continue;

      const newVisited = new Set(visited);
      newVisited.add(target);
      dfs(target, newVisited, [...chain, target]);
    }

    // Also: current color itself might be able to continue if it has multiple triples
    const ownTotal = colorTileCounts.get(current) ?? 0;
    if (ownTotal >= 6 && !visited.has(-current)) {
      // Same color, next triple
      const newVisited = new Set(visited);
      newVisited.add(-current);
      dfs(current, newVisited, [...chain, current]);
    }
  }

  for (const start of startColors) {
    dfs(start, new Set([start]), [start]);
  }

  // Find longest chain
  const maxDepth = allChains.reduce((max, c) => Math.max(max, c.length), 0);

  // Filter to chains of max length
  const longestChains = allChains.filter(c => c.length === maxDepth).slice(0, 3);

  let reason = '';
  if (maxDepth === 0) {
    reason = 'No initial triple possible';
  } else {
    // Show the longest chain
    const chain = longestChains[0];
    reason = chain.map((c, i) => {
      if (i < chain.length - 1) {
        const con = concentration.get(c)!;
        return `c${c}→(blocks ${con.target}@${(con.ratio*100).toFixed(0)}%)`;
      }
      return `c${c}(end)`;
    }).join(' → ');
  }

  return { maxDepth, chains: longestChains, reason };
}

// ============================================
// Actual death depth (from simulation)
// ============================================

function actualDeathDepth(
  game: OfflineGame,
  suitMap: Map<number, number>,
  freeTiles: any[],
  maxSteps: number = 20,
): { depth: number; path: number[] } {
  // Use greedy elimination: at each step, pick a triple if exists, else dead
  const sim = game.clone();
  const path: number[] = [];
  let depth = 0;

  for (let step = 0; step < maxSteps; step++) {
    const clickable = sim.deskTiles.filter(t => t.isClickable);
    const cc = new Map<number, number[]>();
    for (const t of clickable) {
      const c = suitMap.get(t.id)!;
      if (!cc.has(c)) cc.set(c, []);
      cc.get(c)!.push(t.id);
    }

    const tripleColors = [...cc.entries()].filter(([, ts]) => ts.length >= 3);
    if (tripleColors.length === 0) break;

    // Pick first available color (deterministic for consistent results)
    const color = tripleColors[0][0];
    path.push(color);

    const tiles = cc.get(color)!.slice(0, 3).map(tid => sim.allTiles.get(tid)!).filter(Boolean);
    if (tiles.length < 3) break;

    for (const t of tiles) {
      try { sim.collect(t); } catch { break; }
    }
    depth++;
  }

  return { depth, path };
}

// ============================================
// Main
// ============================================

function main() {
  const files = readdirSync(cacheDir).filter(f => f.endsWith('.json'));
  const unsolved: any[] = [];
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(join(cacheDir, f), 'utf-8'));
      if (!d.error && d.dfs && !d.dfs.win) unsolved.push(d);
    } catch {}
  }

  console.log(`Analyzing release concentration for ${unsolved.length} unsolved boards...\n`);

  interface BoardResult {
    levelResId: number;
    freeTiles: number;
    colors: number;
    actualDepth: number;
    actualPath: number[];
    predictedDepth: number;
    predictedChain: string;
    concentration: Map<number, { target: number; ratio: number }>;
  }

  const results: BoardResult[] = [];
  let done = 0;

  for (const b of unsolved) {
    try {
      const terrain = loadTerrainFromFile(join(LEVELS_DIR, `${b.board.levelResId}.json`));
      const allTiles: any[] = [];
      for (const l of terrain.layers) for (const t of l.tiles) allTiles.push(t);
      const freeTiles = allTiles.filter((t: any) => !t.isConst);
      const co = getCanonicalTileOrder(allTiles);

      const rj = JSON.parse(readFileSync(join(REPLAYS_DIR, `${b.board.levelResId}.json`), 'utf-8'));
      let entry: any = null;
      for (const [, entries] of Object.entries(rj.replayInfoDict || {})) {
        if (!Array.isArray(entries)) continue;
        for (const e of entries as any[]) { if (e.ReplayKey === b.board.replayKey) { entry = e; break; } }
        if (entry) break;
      }
      if (!entry) continue;

      const rd = decodeFromString(entry.ReplayCode)!;
      const c2t = new Map<number, number>();
      for (let i = 0; i < co.length; i++) c2t.set(i, co[i].id);
      const suitMap = new Map<number, number>();
      for (let i = 0; i < rd.instanceArray.length; i++) {
        const tid = c2t.get(i);
        if (tid !== undefined) suitMap.set(tid, (rd.instanceArray[i] & 0x3F) + 1);
      }

      const game = createGame({ terrainTiles: allTiles, elementValues: suitMap, initialDock: [], eliminatedTileIds: new Set() });

      // Build concentration matrix
      const matrix = buildConcentrationMatrix(freeTiles, suitMap, game);

      // Predict chain length
      const prediction = predictChainLength(matrix);

      // Actual death depth
      const actual = actualDeathDepth(game, suitMap, freeTiles);

      results.push({
        levelResId: b.board.levelResId,
        freeTiles: freeTiles.length,
        colors: matrix.colorTileCounts.size,
        actualDepth: actual.depth,
        actualPath: actual.path,
        predictedDepth: prediction.maxDepth,
        predictedChain: prediction.reason,
        concentration: matrix.concentration,
      });
    } catch { /* skip */ }
    done++;
    if (done % 20 === 0) console.log(`  ... ${done}/${unsolved.length}`);
  }

  // ── Comparison ──
  console.log(`\n${'═'.repeat(90)}`);
  console.log(`  PREDICTED vs ACTUAL DEATH DEPTH`);
  console.log(`${'═'.repeat(90)}`);

  const correct = results.filter(r => r.actualDepth === r.predictedDepth);
  const offByOne = results.filter(r => Math.abs(r.actualDepth - r.predictedDepth) === 1);
  const offByMore = results.filter(r => Math.abs(r.actualDepth - r.predictedDepth) > 1);

  console.log(`\n  Exact match:       ${correct.length}/${results.length} (${(correct.length/results.length*100).toFixed(0)}%)`);
  console.log(`  Off by 1:          ${offByOne.length}/${results.length}`);
  console.log(`  Off by >1:         ${offByMore.length}/${results.length}`);

  // Show mismatches
  console.log(`\n  Mismatch details (>1 off):`);
  for (const r of offByMore.slice(0, 10)) {
    console.log(`    Lv${r.levelResId}: actual=${r.actualDepth} predicted=${r.predictedDepth}  actualPath=[${r.actualPath.join(',')}]  predicted=${r.predictedChain}`);
  }

  // ── Concentration analysis ──
  console.log(`\n${'═'.repeat(90)}`);
  console.log(`  CONCENTRATION BY ACTUAL DEATH DEPTH`);
  console.log(`${'═'.repeat(90)}`);

  const byDepth = new Map<number, BoardResult[]>();
  for (const r of results) {
    const d = r.actualDepth;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(r);
  }

  console.log(`\n  Depth | Boards | Avg colors | Top concentration colors`);
  console.log(`  ------|--------|------------|---------------------------`);
  for (const [depth, boards] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    const avgCol = boards.reduce((s, r) => s + r.colors, 0) / boards.length;

    // Find colors with highest concentration
    const allConcentrations: { color: number; ratio: number }[] = [];
    for (const r of boards) {
      for (const [c, info] of r.concentration) {
        allConcentrations.push({ color: c, ratio: info.ratio });
      }
    }
    const top3 = allConcentrations
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 3)
      .map(x => `c${x.color}:${(x.ratio*100).toFixed(0)}%`)
      .join(' ');

    console.log(`  ${String(depth).padStart(5)} | ${String(boards.length).padStart(6)} | ${avgCol.toFixed(0).padStart(10)} | ${top3}`);
  }

  // ── Key insight ──
  console.log(`\n${'═'.repeat(90)}`);
  console.log(`  CHAIN MECHANISM INSIGHT`);
  console.log(`${'═'.repeat(90)}`);

  // For each actual path, show the concentration ratios
  console.log(`\n  Chain continuation requires: blocker → blocked with high concentration ratio`);
  console.log(`  Sample chains:`);
  for (const r of results.filter(r => r.actualDepth >= 3).slice(0, 5)) {
    console.log(`\n  Lv${r.levelResId} (depth ${r.actualDepth}):`);
    console.log(`    Path: [${r.actualPath.join(' → ')}]`);
    for (let i = 0; i < r.actualPath.length - 1; i++) {
      const from = r.actualPath[i];
      const to = r.actualPath[i + 1];
      const con = r.concentration.get(from);
      console.log(`      c${from} → c${to}: concentration ${con ? (con.ratio*100).toFixed(0) : '?'}%`);
    }
    // Show why chain broke
    const lastColor = r.actualPath[r.actualPath.length - 1];
    const lastCon = r.concentration.get(lastColor);
    console.log(`      c${lastColor} (last): primary target c${lastCon?.target} @${lastCon ? (lastCon.ratio*100).toFixed(0) : '?'}% — ${lastCon && lastCon.ratio < 0.5 ? 'TOO SCATTERED' : 'chain end'}`);
  }
}

main();
