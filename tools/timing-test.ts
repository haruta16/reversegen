/**
 * Quick timing benchmark: test 200 sims on sample replaykeys.
 * Usage: npx tsx tools/timing-test.ts
 */
import {
  loadTerrainFromFile, getAllTiles, decodeFromString, getCanonicalTileOrder,
} from '../src/index.js';
import { createGame, solvePlayerBatch } from '../src/solver/index.js';
import { readFileSync } from 'node:fs';

const LEVELS = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
const map = JSON.parse(readFileSync('output/replaykey_code_map.json', 'utf8'));

// Pick diverse entries: different terrain sizes
const testKeys = [
  '5-2-2-9-56717259',     // simple
  '7-3-7-13-1627787459',  // medium
  '9-5-9-12-852990572',   // medium-large
  '3-8-9-12-73570277',    // medium
  '9-9-5-14-476160617',   // hard (22% online win rate)
  '6-2-6-14-1637285911',  // very hard (11% online)
  '9-3-6-11-1601603057',  // extreme (11% online)
];

for (const key of testKeys) {
  const entry = map[key];
  if (!entry) { console.log(`${key} → NOT FOUND`); continue; }

  const terrain = loadTerrainFromFile(`${LEVELS}/${entry.terrainId}.json`);
  const tiles = getAllTiles(terrain);
  const replayData = decodeFromString(entry.replayCode)!;
  if (!replayData) { console.log(`${key} → DECODE FAILED`); continue; }

  const ordered = getCanonicalTileOrder(tiles);
  const elementValues = new Map<number, number>();
  const initialDock: { tileId: number; element: number }[] = [];
  const eliminated = new Set<number>();

  for (let i = 0; i < ordered.length && i < replayData.instanceArray.length; i++) {
    const byte = replayData.instanceArray[i];
    const state = (byte >> 6) & 3;
    const ev = (byte & 0x3F) + 1;
    elementValues.set(ordered[i].id, ev);
    if (state === 1) eliminated.add(ordered[i].id);
    else if (state === 2) initialDock.push({ tileId: ordered[i].id, element: ev });
  }

  const game = createGame({ terrainTiles: tiles, elementValues, initialDock, eliminatedTileIds: eliminated });

  // Warmup
  solvePlayerBatch(game, 5);

  // 100 sim test
  const t0 = performance.now();
  const result = solvePlayerBatch(game, 100);
  const elapsed = performance.now() - t0;

  console.log(
    `${key.padEnd(28)} | tiles=${String(tiles.length).padStart(3)} | ` +
    `wins=${String(result.wins).padStart(3)}/${result.wins + result.losses} ` +
    `(${(result.winRate * 100).toFixed(1)}%) | ` +
    `${elapsed.toFixed(0)}ms (${(elapsed / 100).toFixed(1)}ms/sim)`,
  );

  // 200 sim test
  if (elapsed < 1000) {
    const t1 = performance.now();
    const r2 = solvePlayerBatch(game, 200);
    const e2 = performance.now() - t1;
    console.log(`  → 200: ${(r2.winRate*100).toFixed(1)}%, ${e2.toFixed(0)}ms total, ${(e2/200).toFixed(1)}ms/sim`);
  }
}
