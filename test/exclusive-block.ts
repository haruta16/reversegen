/**
 * Exclusive Blocking Analysis
 *
 * Refines the death chain prediction by adding:
 *   1. Concentration (blocker→blocked ratio ≥50%)
 *   2. Exclusive blocking: A is the SOLE blocker for B's tiles
 *   3. Multi-blocker: tiles blocked by 2+ colors simultaneously
 *
 * Hypothesis:
 *   Chain dies at step K when the K-th step's target color has <3 tiles
 *   that are "exclusively blocked" by the current color (not shared with others).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadTerrainFromFile } from '../src/terrain-loader.js';
import { decodeFromString, getCanonicalTileOrder } from '../src/replay-serializer.js';
import { createGame, OfflineGame } from '../src/solver/offline-game.js';
import { logger, setLogLevel, LogLevel } from '../src/logger.js';
setLogLevel(LogLevel.Error);

const LEVELS_DIR = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
const REPLAYS_DIR = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Replays';
const cacheDir = join(process.cwd(), '.reversegen-cache', 'board-results-v2');

// ============================================
// Exclusive Blocking Matrix
// ============================================

interface ExclusiveBlockMatrix {
  /** For each tile, which colors block it */
  tileBlockers: Map<number, Set<number>>;
  /** For each color, how many tiles does it have */
  colorTileCounts: Map<number, number>;
  /** Initial clickable per color */
  colorClickable: Map<number, number>;
  /** For color A → color B: how many of B's tiles are blocked by A as THE ONLY blocker? */
  exclusiveBlocks: Map<number, Map<number, number>>;
  /** For color A → color B: how many of B's tiles are blocked by A (any count)? */
  totalBlocks: Map<number, Map<number, number>>;
  /** For color A → color B: how many of B's tiles are blocked by A AND also by other colors? */
  sharedBlocks: Map<number, Map<number, number>>;
}

function buildExclusiveMatrix(
  freeTiles: any[],
  suitMap: Map<number, number>,
  game: OfflineGame,
): ExclusiveBlockMatrix {
  const colors = [...new Set(suitMap.values())].sort((a, b) => a - b);

  // Color tile counts
  const colorTileCounts = new Map<number, number>();
  for (const [, c] of suitMap) {
    colorTileCounts.set(c, (colorTileCounts.get(c) ?? 0) + 1);
  }

  // Initial clickable
  const clickable = game.deskTiles.filter(t => t.isClickable);
  const colorClickable = new Map<number, number>();
  for (const c of colors) colorClickable.set(c, 0);
  for (const t of clickable) {
    colorClickable.set(suitMap.get(t.id)!, (colorClickable.get(suitMap.get(t.id)!)! + 1));
  }

  // Per-tile blocker colors
  const tileBlockers = new Map<number, Set<number>>();
  for (const tile of freeTiles) {
    const blockers = new Set<number>();
    for (const depId of tile.dependencies) {
      const bc = suitMap.get(depId);
      if (bc !== undefined && bc !== suitMap.get(tile.id)) {
        blockers.add(bc);
      }
    }
    tileBlockers.set(tile.id, blockers);
  }

  // Total blocks: for each (blocker, blocked) pair, count tiles
  const totalBlocks = new Map<number, Map<number, number>>();
  for (const c of colors) {
    totalBlocks.set(c, new Map());
    for (const c2 of colors) totalBlocks.get(c)!.set(c2, 0);
  }
  for (const [tid, blockers] of tileBlockers) {
    const tileColor = suitMap.get(tid)!;
    for (const bc of blockers) {
      totalBlocks.get(bc)!.set(tileColor, (totalBlocks.get(bc)!.get(tileColor) ?? 0) + 1);
    }
  }

  // Exclusive blocks: blocker is the ONLY blocker for this tile
  const exclusiveBlocks = new Map<number, Map<number, number>>();
  for (const c of colors) {
    exclusiveBlocks.set(c, new Map());
    for (const c2 of colors) exclusiveBlocks.get(c)!.set(c2, 0);
  }
  for (const [tid, blockers] of tileBlockers) {
    if (blockers.size === 1) {
      const soleBlocker = [...blockers][0];
      const tileColor = suitMap.get(tid)!;
      exclusiveBlocks.get(soleBlocker)!.set(tileColor, (exclusiveBlocks.get(soleBlocker)!.get(tileColor) ?? 0) + 1);
    }
  }

  // Shared blocks: total - exclusive
  const sharedBlocks = new Map<number, Map<number, number>>();
  for (const c of colors) {
    sharedBlocks.set(c, new Map());
    for (const c2 of colors) {
      const total = totalBlocks.get(c)!.get(c2) ?? 0;
      const excl = exclusiveBlocks.get(c)!.get(c2) ?? 0;
      sharedBlocks.get(c)!.set(c2, total - excl);
    }
  }

  return { tileBlockers, colorTileCounts, colorClickable, exclusiveBlocks, totalBlocks, sharedBlocks };
}

// ============================================
// Refined death depth prediction
// ============================================

function predictDeathDepth(matrix: ExclusiveBlockMatrix): {
  depth: number;
  chain: { from: number; to: number; exclCount: number; sharedCount: number }[];
  reason: string;
} {
  const { colorClickable, colorTileCounts, exclusiveBlocks, totalBlocks, sharedBlocks } = matrix;

  const startColors = [...colorClickable.entries()]
    .filter(([, n]) => n >= 3)
    .map(([c]) => c);

  if (startColors.length === 0) {
    return { depth: 0, chain: [], reason: 'No initial triple possible (all colors <3 clickable)' };
  }

  // Simulate the chain using greedy first-available triple
  // At each step: eliminate a triple of current color
  // Released tiles = those exclusively blocked by current color
  // PLUS a proportion of shared-blocked tiles (simplify: count exclusive + partial shared)

  // Track per-color "available pools"
  const pools = new Map<number, number>(); // color → available tiles (clickable + releasable)
  for (const [c, n] of colorClickable) {
    pools.set(c, n);
  }

  // Track which colors have been "unlocked" by previous steps
  const unlocked = new Set<number>();

  const chain: { from: number; to: number; exclCount: number; sharedCount: number }[] = [];
  let depth = 0;
  let currentColor: number | null = startColors[0]; // greedy: pick first

  while (currentColor !== null && depth < 20) {
    // Eliminate 3 tiles of current color
    // This releases tiles that were blocked by these 3 tiles

    // How many tiles does current color exclusively block from each target?
    const exclTargets = exclusiveBlocks.get(currentColor)!;
    const sharedTargets = sharedBlocks.get(currentColor)!;
    const totalTargets = totalBlocks.get(currentColor)!;

    // Find the best next color: max (exclusive + partial shared that gets released)
    // Simplified: 3 tiles eliminated release ~(3/colorTileCount) of the blocked tiles
    const ownTiles = colorTileCounts.get(currentColor) ?? 3;
    const releaseRatio = Math.min(3 / ownTiles, 1.0);

    let bestNext: number | null = null;
    let bestGain = 0;
    let bestExcl = 0, bestShared = 0;

    for (const [target, excl] of exclTargets) {
      if (target === currentColor) continue;
      if (excl === 0) continue;

      const shared = sharedTargets.get(target) ?? 0;
      // Exclusive tiles ALL get released when current color's tiles are collected
      // Shared tiles get PARTIALLY released (proportional to releaseRatio)
      const gain = excl * releaseRatio + shared * releaseRatio * 0.5; // 0.5 fudge for multi-blocker

      const currentPool = pools.get(target) ?? 0;
      const newPool = currentPool + Math.floor(gain);

      if (newPool >= 3 && gain > bestGain) {
        bestGain = gain;
        bestNext = target;
        bestExcl = excl;
        bestShared = shared;
      }

      // Update pool even if not best
      pools.set(target, newPool);
    }

    if (bestNext !== null) {
      chain.push({ from: currentColor, to: bestNext, exclCount: bestExcl, sharedCount: bestShared });
      currentColor = bestNext;
      depth++;
    } else {
      // No target can reach 3 — chain breaks
      const targets = [...exclTargets.entries()]
        .filter(([, n]) => n > 0)
        .map(([c, n]) => {
          const pool = pools.get(c) ?? 0;
          return `c${c}:excl${n}/pool${pool}`;
        })
        .slice(0, 5);

      chain.push({ from: currentColor!, to: -1, exclCount: 0, sharedCount: 0 });
      return {
        depth: depth + 1,
        chain,
        reason: `c${currentColor} has no target reaching ≥3. Closest targets: ${targets.join(', ')}`,
      };
    }

    // Reduce current color's pool (consumed 3)
    predictedDepth: number;
    predictedChain: { from: number; to: number; exclCount: number; sharedCount: number }[];
    predictedReason: string;
  }

  const results: Result[] = [];
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

      const matrix = buildExclusiveMatrix(freeTiles, suitMap, game);
      const prediction = predictDeathDepth(matrix);
      const actual = actualDeathDepth(game, suitMap);

      results.push({
        levelResId: b.board.levelResId, freeTiles: freeTiles.length,
        colors: matrix.colorTileCounts.size,
        actualDepth: actual.depth, actualPath: actual.path,
        predictedDepth: prediction.depth, predictedChain: prediction.chain,
        predictedReason: prediction.reason,
      });
    } catch { /* skip */ }
    done++;
  }
  // Don't log progress to keep output clean

  // ── Results ──
  console.log(`${'═'.repeat(90)}`);
  console.log(`  REFINED PREDICTION (exclusive + shared blocking)`);
  console.log(`${'═'.repeat(90)}`);

  const exact = results.filter(r => r.actualDepth === r.predictedDepth);
  const off1 = results.filter(r => Math.abs(r.actualDepth - r.predictedDepth) === 1);
  const offMore = results.filter(r => Math.abs(r.actualDepth - r.predictedDepth) > 1);

  console.log(`\n  Exact:  ${exact.length}/${results.length} (${(exact.length/results.length*100).toFixed(0)}%)`);
  console.log(`  Off 1:  ${off1.length}/${results.length}`);
  console.log(`  Off >1: ${offMore.length}/${results.length}`);

  // ── Detail: off-by-more ──
  console.log(`\n  Mismatches (>1):`);
  for (const r of offMore.slice(0, 8)) {
    console.log(`\n  Lv${r.levelResId} (tiles:${r.freeTiles} colors:${r.colors}) actual=${r.actualDepth} pred=${r.predictedDepth}`);
    console.log(`    Actual:   [${r.actualPath.join('→')}]`);
    const chainDesc = r.predictedChain.map(c => c.to === -1 ? `c${c.from}(DEAD)` : `c${c.from}→c${c.to}[excl:${c.exclCount} shr:${c.sharedCount}]`);
    console.log(`    Predicted: ${chainDesc.join(' → ')}`);
    console.log(`    Reason: ${r.predictedReason}`);
  }

  // ── Correct predictions ──
  console.log(`\n${'═'.repeat(90)}`);
  console.log(`  CORRECT PREDICTIONS (sample)`);
  console.log(`${'═'.repeat(90)}`);

  for (const r of exact.filter(r => r.actualDepth >= 2).slice(0, 5)) {
    console.log(`\n  Lv${r.levelResId} (depth ${r.actualDepth}): [${r.actualPath.join('→')}]`);
    for (const c of r.predictedChain.slice(0, r.actualDepth)) {
      const marker = c.to === r.actualPath[r.predictedChain.indexOf(c) + 1] ? '✓' : '?';
      console.log(`    ${marker} c${c.from}→c${c.to}: excl=${c.exclCount} shared=${c.sharedCount}`);
    }
  }

  // ── Deep insight ──
  console.log(`\n${'═'.repeat(90)}`);
  console.log(`  DEATH MECHANISM SUMMARY`);
  console.log(`${'═'.repeat(90)}`);

  // For each actual death, show the exclusive count at the last step
  console.log(`\n  At death step: exclusive blocks on best target`);
  for (const r of results.filter(r => r.actualDepth >= 1).slice(0, 10)) {
    const lastColor = r.actualPath[r.actualDepth - 1];
    // Find what exclusive blocks existed at this step
    const matrix = buildExclusiveMatrix(
      (() => {
        const t = loadTerrainFromFile(join(LEVELS_DIR, `${r.levelResId}.json`));
        const at: any[] = [];
        for (const l of t.layers) for (const tile of l.tiles) at.push(tile);
        return at.filter((t: any) => !t.isConst);
      })(),
      (() => {
        const t = loadTerrainFromFile(join(LEVELS_DIR, `${r.levelResId}.json`));
        const at: any[] = [];
        for (const l of t.layers) for (const tile of l.tiles) at.push(tile);
        const co2 = getCanonicalTileOrder(at);
        const rj2 = JSON.parse(readFileSync(join(REPLAYS_DIR, `${r.levelResId}.json`), 'utf-8'));
        let e2: any = null;
        for (const [, entries] of Object.entries(rj2.replayInfoDict || {})) {
          if (!Array.isArray(entries)) continue;
          for (const ee of entries as any[]) { if (ee.ReplayKey === b.board?.replayKey) { e2 = ee; break; } }
          if (e2) break;
        }
        const rd2 = decodeFromString(e2?.ReplayCode ?? '')!;
        const c2t2 = new Map<number, number>();
        for (let i = 0; i < co2.length; i++) c2t2.set(i, co2[i].id);
        const sm2 = new Map<number, number>();
        for (let i = 0; i < rd2.instanceArray.length; i++) {
          const tid = c2t2.get(i);
          if (tid !== undefined) sm2.set(tid, (rd2.instanceArray[i] & 0x3F) + 1);
        }
        return sm2;
      })(),
      undefined as any,
    );
    const excl = matrix.exclusiveBlocks.get(lastColor)!;
    const best = [...excl.entries()].sort((a, b) => b[1] - a[1])[0];
    console.log(`    Lv${r.levelResId} depth ${r.actualDepth}: c${lastColor} best excl target c${best[0]}=${best[1]} tiles`);
  }
}

main();
