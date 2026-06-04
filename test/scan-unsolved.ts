import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadTerrainFromFile } from '../src/terrain-loader.js';
import { decodeFromString, getCanonicalTileOrder } from '../src/replay-serializer.js';
import { createGame } from '../src/solver/offline-game.js';
import { logger, setLogLevel, LogLevel } from '../src/logger.js';
setLogLevel(LogLevel.Error);

const cacheDir = join(process.cwd(), '.reversegen-cache', 'board-results-v2');
const files = readdirSync(cacheDir).filter(f => f.endsWith('.json'));

const unsolved: any[] = [];
for (const f of files) {
  try {
    const d = JSON.parse(readFileSync(join(cacheDir, f), 'utf-8'));
    if (!d.error && d.dfs && !d.dfs.win) unsolved.push(d);
  } catch {}
}

console.log(`Analyzing ${unsolved.length} unsolved boards...\n`);

const LEVELS_DIR = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
const REPLAYS_DIR = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Replays';

const stats: any[] = [];
let errors = 0;

for (const b of unsolved) {
  try {
    const terrain = loadTerrainFromFile(join(LEVELS_DIR, `${b.board.levelResId}.json`));
    const allTiles: any[] = [];
    for (const l of terrain.layers) for (const t of l.tiles) allTiles.push(t);
    const co = getCanonicalTileOrder(allTiles);

    const rj = JSON.parse(readFileSync(join(REPLAYS_DIR, `${b.board.levelResId}.json`), 'utf-8'));
    let entry: any = null;
    for (const [, entries] of Object.entries(rj.replayInfoDict || {})) {
      if (!Array.isArray(entries)) continue;
      for (const e of entries as any[]) { if (e.ReplayKey === b.board.replayKey) { entry = e; break; } }
      if (entry) break;
    }
    if (!entry) continue;

    const rd = decodeFromString(entry.ReplayCode);
    if (!rd) continue;

    const c2t = new Map<number, number>();
    for (let i = 0; i < co.length; i++) c2t.set(i, co[i].id);
    const suitMap = new Map<number, number>();
    for (let i = 0; i < rd.instanceArray.length; i++) {
      const tid = c2t.get(i);
      if (tid !== undefined) suitMap.set(tid, (rd.instanceArray[i] & 0x3F) + 1);
    }

    const game = createGame({ terrainTiles: allTiles, elementValues: suitMap, initialDock: [], eliminatedTileIds: new Set() });
    const clickable = game.deskTiles.filter(t => t.isClickable);
    const freeTiles = allTiles.filter(t => !t.isConst);

    const colorClickable = new Map<number, number>();
    for (const [, c] of suitMap) { if (!colorClickable.has(c)) colorClickable.set(c, 0); }
    for (const t of clickable) { const c = suitMap.get(t.id)!; colorClickable.set(c, (colorClickable.get(c) ?? 0) + 1); }
    const zeroClk = [...colorClickable.values()].filter(c => c === 0).length;
    const canTriple = [...colorClickable.entries()].some(([, c]) => c >= 3);
    const maxPerColor = Math.max(...colorClickable.values());

    stats.push({
      level: b.board.levelResId,
      colors: colorClickable.size,
      tiles: freeTiles.length,
      clickable: clickable.length,
      zeroClkColors: zeroClk,
      canTriple,
      maxPerColor,
      cgEdges: b.features.cgEdgeCount,
    });
  } catch { errors++; }
}

// Sort
stats.sort((a, b) => a.zeroClkColors - b.zeroClkColors);

console.log('Level   | Colors | Tiles | Clickable | ZeroClkClr | CanTriple | Max/Clr | cgEdges');
console.log('-'.repeat(92));
for (const s of stats) {
  console.log(
    String(s.level).padEnd(7), '|', String(s.colors).padStart(6), '|',
    String(s.tiles).padStart(5), '|', String(s.clickable).padStart(9), '|',
    String(s.zeroClkColors).padStart(10), '|', String(s.canTriple).padStart(9), '|',
    String(s.maxPerColor).padStart(7), '|', String(s.cgEdges).padStart(7)
  );
}

// Distribution
console.log('\n=== Zero-clickable colors distribution ===');
const zcCounts = new Map<number, number>();
for (const s of stats) zcCounts.set(s.zeroClkColors, (zcCounts.get(s.zeroClkColors) ?? 0) + 1);
for (const [k, v] of [...zcCounts.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${k} zero-click colors: ${v} boards`);
}

// Key question: do ALL unsolved boards have CanTriple=false?
const noTriple = stats.filter(s => !s.canTriple);
console.log(`\n=== CanTriple = FALSE: ${noTriple.length}/${stats.length} boards ===`);
console.log(`  These boards have no color with ≥3 clickable tiles at start`);
if (noTriple.length === stats.length) {
  console.log(`  ★ DETERMINISTIC: ALL unsolved boards have CanTriple = FALSE`);
} else {
  console.log(`  ⚠ NOT all unsolved boards have CanTriple = FALSE`);
  for (const s of stats.filter(s => s.canTriple)) {
    console.log(`    ${s.level}: maxPerColor=${s.maxPerColor}`);
  }
}

// Combined rule: CanTriple=false AND maxPerColor < 3
const noTripleAndLow = stats.filter(s => !s.canTriple && s.maxPerColor < 3 && s.zeroClkColors > 2);
console.log(`\n=== Rule: CanTriple=F AND maxPerColor<3 AND zeroClkColors>2: ${noTripleAndLow.length}/${stats.length} ===`);

console.log(`\nErrors: ${errors}`);
