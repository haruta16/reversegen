/**
 * Quick smoke test — validate solver pipeline on one board.
 * Run: npx tsx test/smoke-test.ts
 */

import { readFileSync } from 'node:fs';
import { loadTerrainFromFile } from '../../src/terrain-loader.js';
import { decodeFromString, getCanonicalTileOrder } from '../../src/replay-serializer.js';
import { createGame, solveDFS, solveGreedy, solveRandomBatch } from '../../src/solver/index.js';
import { TileState } from '../../src/types.js';
import type { TerrainData, TerrainTile } from '../../src/types.js';

const LEVELS_DIR = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
const REPLAYS_DIR = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Replays';

// Pick a simple level
const LEVEL_ID = 100003;

console.log(`=== Smoke Test: Level ${LEVEL_ID} ===\n`);

// Load terrain
const terrainPath = `${LEVELS_DIR}/${LEVEL_ID}.json`;
const terrain: TerrainData = loadTerrainFromFile(terrainPath);
const allTiles = flattenTiles(terrain);
const freeTiles = allTiles.filter(t => !t.isConst);
console.log(`Terrain: ${allTiles.length} total, ${freeTiles.length} free tiles, ${terrain.layers.length} layers`);

// Load replay
const replayPath = `${REPLAYS_DIR}/${LEVEL_ID}.json`;
const replayJson = JSON.parse(readFileSync(replayPath, 'utf-8'));
const grades = Object.keys(replayJson.replayInfoDict || {});
console.log(`Replay grades: ${grades.join(', ')}`);

// Pick first replay
const firstGrade = grades[0];
const entries = replayJson.replayInfoDict[firstGrade];
if (!Array.isArray(entries) || entries.length === 0) {
  console.error('No replay entries found');
  process.exit(1);
}

const entry = entries[0];
console.log(`Using: ${entry.ReplayKey} (${entry.CompletionStatus})\n`);

// Decode
const replayData = decodeFromString(entry.ReplayCode);
if (!replayData) {
  console.error('ReplayCode decode failed');
  process.exit(1);
}
console.log(`ReplayData: ${replayData.instanceArray.length} tiles, ${replayData.elementCount} colors, ${replayData.dockEntries.length} dock`);

// Build canonical mapping
const canonicalOrder = getCanonicalTileOrder(allTiles);
const canIdxToTerrainId = new Map<number, number>();
for (let i = 0; i < canonicalOrder.length; i++) {
  canIdxToTerrainId.set(i, canonicalOrder[i].id);
}

// Extract values
const elementValues = new Map<number, number>();
const initialDock: { tileId: number; element: number }[] = [];
const eliminatedIds = new Set<number>();

for (let i = 0; i < replayData.instanceArray.length; i++) {
  const terrainId = canIdxToTerrainId.get(i);
  if (terrainId === undefined) continue;
  const state = ((replayData.instanceArray[i] >> 6) & 0x3) as TileState;
  const ev = (replayData.instanceArray[i] & 0x3F) + 1;
  elementValues.set(terrainId, ev);
  if (state === TileState.InDock) initialDock.push({ tileId: terrainId, element: ev });
  else if (state === TileState.Eliminated) eliminatedIds.add(terrainId);
}

for (const de of replayData.dockEntries) {
  const terrainId = canIdxToTerrainId.get(de.tileId);
  if (terrainId !== undefined) {
    initialDock.push({ tileId: terrainId, element: de.element });
    elementValues.set(terrainId, de.element);
  }
}

// Verify color parity
const colorCounts = new Map<number, number>();
for (const [, c] of elementValues) colorCounts.set(c, (colorCounts.get(c) ?? 0) + 1);
const parityIssues = [...colorCounts.entries()].filter(([, c]) => c % 3 !== 0);
if (parityIssues.length > 0) {
  console.log(`⚠ Color parity issues: ${parityIssues.map(([k, v]) => `color${k}=${v}`).join(', ')}`);
} else {
  console.log(`✓ Color parity OK: ${colorCounts.size} colors, sizes=${[...colorCounts.values()].join(',')}`);
}

// Create game
console.log(`\n--- Creating OfflineGame ---`);
const game = createGame({ terrainTiles: allTiles, elementValues, initialDock, eliminatedTileIds: eliminatedIds });
console.log(`Desk: ${game.deskTiles.length}, Dock: ${game.dockTiles.length}, Discard: ${game.discardTiles.length}`);
console.log(`Clickable: ${game.clickableTiles.length}, RemainSlots: ${game.remainSlotCount}`);

// Run greedy
console.log(`\n--- Greedy Solver ---`);
const greedyResult = solveGreedy(game);
console.log(`Win: ${greedyResult.win}, Steps: ${greedyResult.stepCount}, Fail: ${greedyResult.failReason}`);
console.log(`Max dock: ${Math.max(...greedyResult.dockLog)}, Avg dock: ${(greedyResult.dockLog.reduce((a,b)=>a+b,0)/greedyResult.dockLog.length).toFixed(1)}`);

// Run DFS
console.log(`\n--- DFS Solver (30s timeout) ---`);
const dfsResult = solveDFS(game, { timeoutMs: 30_000, collectDeadStates: true });
console.log(`Win: ${dfsResult.win}, Steps: ${dfsResult.stepCount}, States: ${dfsResult.statesVisited}`);
console.log(`Dead states: ${dfsResult.deadStates.length}, Elapsed: ${dfsResult.elapsedMs.toFixed(0)}ms`);
if (dfsResult.win) {
  console.log(`Path (first 10): [${dfsResult.picks.slice(0, 10).join(', ')}...]`);
}

// Run random
console.log(`\n--- Random Solver (50 runs) ---`);
const randomResults = solveRandomBatch(game, 50);
console.log(`Win rate: ${(randomResults.winRate * 100).toFixed(1)}% (${randomResults.wins}/50), Avg steps on win: ${randomResults.avgStepsOnWin.toFixed(0)}`);

console.log(`\n=== Done ===`);

function flattenTiles(terrain: TerrainData): TerrainTile[] {
  const tiles: TerrainTile[] = [];
  for (const layer of terrain.layers) for (const tile of layer.tiles) tiles.push(tile);
  return tiles;
}
