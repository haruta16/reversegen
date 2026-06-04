/**
 * Deep-single-board analysis: trace the exact reason ONE board is unsolvable.
 *
 * Approach: For each color group, identify WHICH specific tiles are blocked
 * by WHICH other colors. Find the minimal set of colors that form an
 * inescapable deadlock.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TerrainData, TerrainTile } from '../src/types.js';
import { TileState } from '../src/types.js';
import { loadTerrainFromFile } from '../src/terrain-loader.js';
import { decodeFromString, getCanonicalTileOrder } from '../src/replay-serializer.js';
import { createGame } from '../src/solver/offline-game.js';
import { buildColorGroupDAG, buildBoardDAG } from '../src/analysis/board-dag.js';
import { computeAllDependencies } from '../src/dependency-graph.js';
import { solveDFS } from '../src/solver/solver-dfs.js';
import { logger, setLogLevel, LogLevel } from '../src/logger.js';
setLogLevel(LogLevel.Error);

// ============================================
// Pick a representative unsolved board
// ============================================
const TARGET = { levelResId: 100006, replayKey: '7-4-5-23-1570404173' };

// Actually pick the first unsolved from cache
const cacheDir = join(process.cwd(), '.reversegen-cache', 'board-results-v2');
const files = readdirSync(cacheDir).filter(f => f.endsWith('.json'));
let targetLevel = 100006;
let targetKey = '';
for (const f of files) {
  try {
    const d = JSON.parse(readFileSync(join(cacheDir, f), 'utf-8'));
    if (!d.error && d.dfs && !d.dfs.win && d.features.cgEdgeCount < 80 && d.features.cgEdgeCount > 40) {
      targetLevel = d.board.levelResId;
      targetKey = d.board.replayKey;
      console.log(`Selected: Level ${targetLevel}, edges: ${d.features.cgEdgeCount}, colors: ${d.features.colorCount}`);
      break;
    }
  } catch {}
}

// ============================================
// Load the board
// ============================================
const LEVELS_DIR = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
const REPLAYS_DIR = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Replays';

const terrain: TerrainData = loadTerrainFromFile(join(LEVELS_DIR, `${targetLevel}.json`));
const allTiles: TerrainTile[] = [];
for (const l of terrain.layers) for (const t of l.tiles) allTiles.push(t);
const freeTiles = allTiles.filter(t => !t.isConst);
const co = getCanonicalTileOrder(allTiles);

const rj = JSON.parse(readFileSync(join(REPLAYS_DIR, `${targetLevel}.json`), 'utf-8'));
let entry: any = null;
for (const [, entries] of Object.entries(rj.replayInfoDict || {})) {
  if (!Array.isArray(entries)) continue;
  for (const e of entries as any[]) { if (e.ReplayKey === targetKey) { entry = e; break; } }
  if (entry) break;
}

const rd = decodeFromString(entry.ReplayCode)!;
const c2t = new Map<number, number>();
for (let i = 0; i < co.length; i++) c2t.set(i, co[i].id);

const suitMap = new Map<number, number>();
for (let i = 0; i < rd.instanceArray.length; i++) {
  const tid = c2t.get(i);
  if (tid !== undefined) suitMap.set(tid, (rd.instanceArray[i] & 0x3F) + 1);
}

// ============================================
// Tile-level blocking analysis
// ============================================

console.log(`\n=== Tile-Level Blocking Analysis: Level ${targetLevel} ===`);
console.log(`Free tiles: ${freeTiles.length}, Colors: ${new Set(suitMap.values()).size}\n`);

// For each pair of colors (A, B): does color A block any tile of color B?
// "Block" = a tile of color A is in the dependencies of a tile of color B

interface ColorPairBlock {
  blocker: number;  // color A
  blocked: number;  // color B
  /** Which specific tiles of A block which specific tiles of B */
  details: { blockerTile: number; blockedTile: number }[];
  /** How many of B's tiles are blocked by A */
  blockedTileCount: number;
  /** How many tiles does B have in total */
  totalTileCount: number;
}

const colorPairBlocks: ColorPairBlock[] = [];
const colors = [...new Set(suitMap.values())].sort((a, b) => a - b);

for (const colorA of colors) {
  const tilesA = freeTiles.filter(t => suitMap.get(t.id) === colorA);
  for (const colorB of colors) {
    if (colorA === colorB) continue;
    const tilesB = freeTiles.filter(t => suitMap.get(t.id) === colorB);
    const details: { blockerTile: number; blockedTile: number }[] = [];

    for (const tb of tilesB) {
      for (const depId of tb.dependencies) {
        if (tilesA.some(ta => ta.id === depId)) {
          details.push({ blockerTile: depId, blockedTile: tb.id });
        }
      }
    }

    if (details.length > 0) {
      colorPairBlocks.push({
        blocker: colorA, blocked: colorB,
        details,
        blockedTileCount: new Set(details.map(d => d.blockedTile)).size,
        totalTileCount: tilesB.length,
      });
    }
  }
}

// Show the blocking structure
console.log('Color blocking matrix (blocker → blocked):');
console.log(`${'Blocker'.padStart(8)} | ${'Blocked'.padStart(8)} | ${'#Tiles blocked'.padStart(14)} | ${'Total tiles'.padStart(11)} | ${'Coverage'.padStart(8)}`);
console.log('-'.repeat(70));

// Sort: most impactful blocks first
colorPairBlocks.sort((a, b) => (b.blockedTileCount / b.totalTileCount) - (a.blockedTileCount / a.totalTileCount));

for (const b of colorPairBlocks.slice(0, 30)) {
  const coverage = (b.blockedTileCount / b.totalTileCount * 100).toFixed(0);
  console.log(`${String(b.blocker).padStart(8)} | ${String(b.blocked).padStart(8)} | ${String(b.blockedTileCount).padStart(14)} | ${String(b.totalTileCount).padStart(11)} | ${coverage.padStart(7)}%`);
}

// ============================================
// Find the deadlock core
// ============================================

console.log(`\n=== Deadlock Core Analysis ===`);

// Find colors with FULL coverage blocking (100% of target's tiles are blocked)
const fullBlockPairs = colorPairBlocks.filter(b => b.blockedTileCount === b.totalTileCount);
console.log(`\nFull-coverage blocks (blocking ALL tiles of target color):`);
for (const b of fullBlockPairs) {
  console.log(`  color ${b.blocker} blocks ALL ${b.totalTileCount} tiles of color ${b.blocked}`);
}

// Find mutual full blocks: A fully blocks B AND B fully blocks A
const mutualFullBlocks: [number, number][] = [];
for (const b1 of fullBlockPairs) {
  for (const b2 of fullBlockPairs) {
    if (b1.blocker === b2.blocked && b1.blocked === b2.blocker) {
      const pair: [number, number] = [Math.min(b1.blocker, b1.blocked), Math.max(b1.blocker, b1.blocked)];
      if (!mutualFullBlocks.some(([a, b]) => a === pair[0] && b === pair[1])) {
        mutualFullBlocks.push(pair);
      }
    }
  }
}

console.log(`\nMutual FULL blocks (A fully blocks B AND B fully blocks A):`);
for (const [a, b] of mutualFullBlocks) {
  console.log(`  color ${a} ↔ color ${b} — DEADLOCK PAIR`);
}

// Find the connected component of full-block pairs
// If the component has no "entry" color (a color that's NOT fully blocked by anyone inside the component),
// then it's a deadlock clique
const fullBlockGraph = new Map<number, Set<number>>();
for (const b of fullBlockPairs) {
  if (!fullBlockGraph.has(b.blocker)) fullBlockGraph.set(b.blocker, new Set());
  fullBlockGraph.get(b.blocker)!.add(b.blocked);
}

// Find components
const visited = new Set<number>();
const components: Set<number>[] = [];

for (const color of colors) {
  if (visited.has(color)) continue;
  if (!fullBlockGraph.has(color)) continue;

  const component = new Set<number>();
  const queue = [color];
  while (queue.length > 0) {
    const c = queue.shift()!;
    if (visited.has(c)) continue;
    visited.add(c);
    component.add(c);
    const targets = fullBlockGraph.get(c);
    if (targets) for (const t of targets) if (!visited.has(t)) queue.push(t);
    // Also go reverse: which colors fully block c?
    for (const b of fullBlockPairs) {
      if (b.blocked === c && !visited.has(b.blocker)) queue.push(b.blocker);
    }
  }

  if (component.size >= 2) components.push(component);
}

console.log(`\nFull-block connected components (size ≥ 2):`);
for (const comp of components) {
  // Check: does every color in the component have at least one incoming full block from within?
  const colorsInComp = [...comp];
  let allFullyBlocked = true;
  for (const c of colorsInComp) {
    const blockedByInside = fullBlockPairs.some(b => b.blocked === c && comp.has(b.blocker));
    if (!blockedByInside) allFullyBlocked = false;
  }

  // Check: does every color also fully block at least one color inside?
  let allBlockSomething = true;
  for (const c of colorsInComp) {
    const blocksInside = fullBlockPairs.some(b => b.blocker === c && comp.has(b.blocked));
    if (!blocksInside) allBlockSomething = false;
  }

  const status = allFullyBlocked && allBlockSomething ? '★ DEADLOCK CLIQUE (no entry, no exit)' :
    allFullyBlocked ? 'ALL blocked (no entry)' :
    allBlockSomething ? 'ALL blocking (no exit)' : 'PARTIAL';

  // Check: is there an entry point from OUTSIDE the component?
  let hasExternalEntry = false;
  for (const c of colorsInComp) {
    const blockedByOutside = fullBlockPairs.some(b => b.blocked === c && !comp.has(b.blocker));
    if (!blockedByOutside) {
      // This color is NOT fully blocked by anyone outside — could be entry from outside
      hasExternalEntry = true;
    }
  }

  const entryStatus = hasExternalEntry ? '(has external entry)' : '(NO EXTERNAL ENTRY)';

  console.log(`  Component: colors [${colorsInComp.join(', ')}] — ${status} ${entryStatus}`);

  // If it's a deadlock clique with no external entry → provably unsolvable!
  if (allFullyBlocked && allBlockSomething && !hasExternalEntry) {
    console.log(`    ★★★ PROVABLY UNSOLVABLE ★★★`);
    console.log(`    Reason: All colors in this clique fully block each other,`);
    console.log(`    and no color from outside can enter to break the cycle.`);
    console.log(`    No tile in the clique can be clicked first.`);
  }
}

// ============================================
// Verify: which colors have ANY clickable tiles at start?
// ============================================
console.log(`\n=== Clickable Tiles at Start ===`);
const game = createGame({
  terrainTiles: allTiles,
  elementValues: suitMap,
  initialDock: [],
  eliminatedTileIds: new Set(),
});

const clickable = game.deskTiles.filter(t => t.isClickable);
const clickableColors = new Set(clickable.map(t => suitMap.get(t.id)!));
console.log(`Clickable tiles: ${clickable.length}/${freeTiles.length}`);
console.log(`Clickable colors: [${[...clickableColors].sort((a,b)=>a-b).join(', ')}]`);

// For each color, count clickable tiles
console.log(`\nPer-color clickable count:`);
for (const color of [...colors].sort((a,b)=>a-b)) {
  const total = freeTiles.filter(t => suitMap.get(t.id) === color).length;
  const clk = clickable.filter(t => suitMap.get(t.id) === color).length;
  const blocked = total - clk;
  console.log(`  color ${String(color).padStart(2)}: ${clk}/${total} clickable, ${blocked} blocked`);
}

// ============================================
// What's the MIMIMUM number of tiles that must be
// collected before any color can complete a triple?
// ============================================
console.log(`\n=== Path to First Triple ===`);
for (const color of colors) {
  const tiles = freeTiles.filter(t => suitMap.get(t.id) === color);
  if (tiles.length < 3) continue;

  // How many tiles of this color need to be collected before 3 same-color accumulate in dock?
  const clickableTiles = tiles.filter(t => game.allTiles.get(t.id)?.isClickable);

  // For non-clickable tiles, trace what blocks them
  const blockedTiles = tiles.filter(t => !game.allTiles.get(t.id)?.isClickable);

  if (clickableTiles.length >= 3) {
    console.log(`  color ${color}: ${clickableTiles.length}/${tiles.length} already clickable → can form triple immediately`);
  } else if (clickableTiles.length > 0) {
    console.log(`  color ${color}: ${clickableTiles.length}/${tiles.length} clickable → need ${3 - clickableTiles.length} more`);
    // Show what blocks the blocked tiles
    for (const bt of blockedTiles.slice(0, 2)) {
      const blockers = bt.dependencies
        .map(d => ({ id: d, color: suitMap.get(d) }))
        .filter(d => d.color !== undefined);
      console.log(`    tile ${bt.id} blocked by: [${blockers.map(b => `${b.id}(c${b.color})`).join(', ')}]`);
    }
  } else {
    console.log(`  color ${color}: 0/${tiles.length} clickable — entirely blocked`);
    for (const bt of blockedTiles.slice(0, 2)) {
      const blockers = bt.dependencies
        .map(d => ({ id: d, color: suitMap.get(d) }))
        .filter(d => d.color !== undefined);
      console.log(`    tile ${bt.id} blocked by: [${blockers.map(b => `${b.id}(c${b.color})`).join(', ')}]`);
    }
  }
}
