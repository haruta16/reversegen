/**
 * Verify DFS solver correctness: compare against known board properties.
 */
import { readFileSync } from 'fs';
import { loadTerrainFromFile } from '../src/terrain-loader.js';
import { decodeFromString, getCanonicalTileOrder } from '../src/replay-serializer.js';
import { createGame } from '../src/solver/offline-game.js';
import { solveDFS } from '../src/solver/solver-dfs.js';
import { solveGreedy } from '../src/solver/solver-greedy.js';
import { TileState } from '../src/types.js';
import type { TerrainData, TerrainTile } from '../src/types.js';
import { logger, setLogLevel, LogLevel } from '../src/logger.js';
setLogLevel(LogLevel.Error);

function flattenTiles(t: TerrainData): TerrainTile[] {
  const r: TerrainTile[] = [];
  for (const l of t.layers) for (const tile of l.tiles) r.push(tile);
  return r;
}

function analyzeOne(levelId: number, replayCode: string) {
  const terrain = loadTerrainFromFile(`/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels/${levelId}.json`);
  const allTiles = flattenTiles(terrain);
  const freeTiles = allTiles.filter(t => !t.isConst);
  const co = getCanonicalTileOrder(allTiles);
  const rd = decodeFromString(replayCode)!;

  const canIdxToTerr = new Map<number, number>();
  for (let i = 0; i < co.length; i++) canIdxToTerr.set(i, co[i].id);

  const ev = new Map<number, number>();
  const dock: { tileId: number; element: number }[] = [];
  const elim = new Set<number>();

  for (let i = 0; i < rd.instanceArray.length; i++) {
    const tid = canIdxToTerr.get(i);
    if (tid === undefined) continue;
    const val = (rd.instanceArray[i] & 0x3F) + 1;
    ev.set(tid, val);
    const st = ((rd.instanceArray[i] >> 6) & 0x3) as TileState;
    if (st === TileState.InDock) dock.push({ tileId: tid, element: val });
    else if (st === TileState.Eliminated) elim.add(tid);
  }
  for (const de of rd.dockEntries) {
    const tid = canIdxToTerr.get(de.tileId);
    if (tid !== undefined) { dock.push({ tileId: tid, element: de.element }); ev.set(tid, de.element); }
  }

  const game = createGame({ terrainTiles: allTiles, elementValues: ev, initialDock: dock, eliminatedTileIds: elim });

  const dfsResult = solveDFS(game, { timeoutMs: 30_000 });
  const greedyResult = solveGreedy(game);

  // Verify: if DFS found a path, replay it to confirm it's valid
  let replayValid = false;
  if (dfsResult.win) {
    const replayGame = createGame({ terrainTiles: allTiles, elementValues: ev, initialDock: dock, eliminatedTileIds: elim });
    try {
      for (const tid of dfsResult.picks) {
        const tile = replayGame.allTiles.get(tid);
        if (!tile || !tile.isClickable) throw new Error(`Tile ${tid} not clickable`);
        replayGame.collect(tile);
      }
      replayValid = replayGame.isWin;
    } catch (e: any) {
      console.log(`  ⚠ Replay verification FAILED: ${e.message}`);
    }
  }

  // Verify greedy path
  let greedyReplayValid = false;
  if (greedyResult.win) {
    const grGame = createGame({ terrainTiles: allTiles, elementValues: ev, initialDock: dock, eliminatedTileIds: elim });
    try {
      for (const tid of greedyResult.picks) {
        const tile = grGame.allTiles.get(tid);
        if (!tile || !tile.isClickable) throw new Error(`Tile ${tid} not clickable`);
        grGame.collect(tile);
      }
      greedyReplayValid = grGame.isWin;
    } catch {}
  }

  return {
    levelId, freeTiles: freeTiles.length,
    dfsWin: dfsResult.win, dfsSteps: dfsResult.stepCount, dfsStates: dfsResult.statesVisited,
    dfsMs: dfsResult.elapsedMs, dfsReplayValid: replayValid,
    greedyWin: greedyResult.win, greedySteps: greedyResult.stepCount,
    greedyReplayValid,
  };
}

// Test a few boards and verify
const testCases = [
  { id: 100003, code: null },
  { id: 100005, code: null },
  { id: 100010, code: null },
  { id: 100020, code: null },
  { id: 100050, code: null },
];

console.log('=== DFS Solver Verification ===\n');
console.log('Level   | Tiles | DFS Win | Steps | States | Time(ms) | Replay OK | Greedy Win | Greedy OK');
console.log('-'.repeat(95));

for (const tc of testCases) {
  const rj = JSON.parse(readFileSync(`/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Replays/${tc.id}.json`, 'utf-8'));
  const entry = rj.replayInfoDict?.[Object.keys(rj.replayInfoDict)[0]]?.[0];
  if (!entry) { console.log(`  ${tc.id} — no replay entry`); continue; }

  const r = analyzeOne(tc.id, entry.ReplayCode);
  console.log(
    `${String(r.levelId).padEnd(8)} | ${String(r.freeTiles).padStart(5)} | ${r.dfsWin ? '✓'.padStart(7) : '✗'.padStart(7)} | ` +
    `${String(r.dfsSteps).padStart(5)} | ${String(r.dfsStates).padStart(6)} | ${r.dfsMs.toFixed(1).padStart(8)} | ` +
    `${r.dfsReplayValid ? '✓'.padStart(9) : '✗'.padStart(9)} | ${r.greedyWin ? '✓'.padStart(10) : '✗'.padStart(10)} | ` +
    `${r.greedyReplayValid ? '✓'.padStart(8) : '-'.padStart(8)}`
  );
}

// Also test a known case: board with 48 tiles, unique colors (ReverseGen style)
console.log(`\n=== Self-consistency test: unique-color board ===`);
import { generateBoard } from '../src/index.js';
const terrain100003 = loadTerrainFromFile('/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels/100003.json');
const allT = flattenTiles(terrain100003);
const freeT = allT.filter(t => !t.isConst);
const steps = Math.floor(freeT.length / 3);
try {
  const gen = generateBoard({ terrain: terrain100003, costArray: Array(steps).fill(1), colorCount: steps });
  const rd2 = decodeFromString(gen.replayCode)!;
  const co2 = getCanonicalTileOrder(allT);
  const c2t = new Map<number, number>();
  for (let i = 0; i < co2.length; i++) c2t.set(i, co2[i].id);
  const ev2 = new Map<number, number>();
  for (let i = 0; i < rd2.instanceArray.length; i++) {
    const tid = c2t.get(i);
    if (tid !== undefined) ev2.set(tid, (rd2.instanceArray[i] & 0x3F) + 1);
  }
  const game2 = createGame({ terrainTiles: allT, elementValues: ev2 });

  const dfs2 = solveDFS(game2, { timeoutMs: 30_000 });
  const greedy2 = solveGreedy(game2);

  // Replay verify
  const rg2 = createGame({ terrainTiles: allT, elementValues: ev2 });
  if (dfs2.win) {
    for (const tid of dfs2.picks) rg2.collect(rg2.allTiles.get(tid)!);
    console.log(`DFS: ${dfs2.win ? 'win' : 'lose'} | steps: ${dfs2.stepCount} | states: ${dfs2.statesVisited} | ` +
      `replay valid: ${rg2.isWin} | ${dfs2.elapsedMs.toFixed(1)}ms`);
  }
  const gg2 = createGame({ terrainTiles: allT, elementValues: ev2 });
  if (greedy2.win) {
    for (const tid of greedy2.picks) gg2.collect(gg2.allTiles.get(tid)!);
  }
  console.log(`Greedy: ${greedy2.win ? 'win' : 'lose'} | steps: ${greedy2.stepCount} | ` +
    `replay valid: ${gg2.isWin}`);
} catch (e: any) {
  console.log(`ReverseGen board test failed: ${e.message}`);
}
