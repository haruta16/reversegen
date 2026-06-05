/**
 * Full generation test — comprehensive coverage.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadTerrainFromFile } from '../src/terrain-loader.js';
import { generateV3 } from '../src/generate-v3.js';
import { createGame } from '../src/solver/offline-game.js';
import { solveDFS } from '../src/solver/solver-dfs.js';
import { solveGreedy } from '../src/solver/solver-greedy.js';
import { solveRandomBatch } from '../src/solver/solver-random.js';
import { buildColorGroupDAG } from '../src/analysis/board-dag.js';
import { logger, setLogLevel, LogLevel } from '../src/logger.js';
setLogLevel(LogLevel.Error);

const L = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';

// Diverse terrain selection
const TERRAINS = [100003,100005,100008,100010,100015,100020,100030,100040,100050,100060,100070,100075];

function run() {
  interface R {
    terrain: number; tiles: number; triples: number; config: string;
    expectedSolvable: boolean; expectedDeath: number;
    dfsWin: boolean; dfsStates: number; dfsMs: number;
    greedyWin: boolean; randomWR: number;
    colors: number; cgEdges: number; branchFirst: number; branchLast: number;
    actualSolvable: boolean; actualDeath: number;
  }
  const results: R[] = [];

  for (const tid of TERRAINS) {
    const terrain = loadTerrainFromFile(`${L}/${tid}.json`);
    const at: any[] = []; for (const l of terrain.layers) for (const t of l.tiles) at.push(t);
    const ft = at.filter((t:any)=>!t.isConst);
    const totalTriples = Math.floor(ft.length / 3);

    // Generate multiple configs per terrain
    const configs: { label: string; solvable: boolean; deathStep: number }[] = [
      { label: 'SOLVABLE', solvable: true, deathStep: -1 },
    ];

    // Add death configs at various steps
    if (totalTriples >= 4) {
      configs.push({ label: 'DEATH-0', solvable: false, deathStep: 0 });
      configs.push({ label: `DEATH-1`, solvable: false, deathStep: 1 });
      if (totalTriples >= 5) configs.push({ label: `DEATH-2`, solvable: false, deathStep: 2 });
      if (totalTriples >= 8) configs.push({ label: `DEATH-${Math.floor(totalTriples/2)}`, solvable: false, deathStep: Math.floor(totalTriples/2) });
      configs.push({ label: `DEATH-${totalTriples-1}`, solvable: false, deathStep: totalTriples - 1 });
    }

    for (const cfg of configs) {
      try {
        const out = generateV3({ terrain, solvable: cfg.solvable, deathStep: cfg.deathStep });
        const game = createGame({ terrainTiles: at, elementValues: out.assignments, initialDock: [], eliminatedTileIds: new Set() });

        const dfsR = solveDFS(game, { timeoutMs: 15_000 });
        const greedyR = solveGreedy(game);
        const randR = solveRandomBatch(game, 30);

        const cg = buildColorGroupDAG(ft, out.assignments);

        results.push({
          terrain: tid, tiles: ft.length, triples: totalTriples,
          config: cfg.label,
          expectedSolvable: cfg.solvable, expectedDeath: cfg.deathStep,
          dfsWin: dfsR.win, dfsStates: dfsR.statesVisited, dfsMs: dfsR.elapsedMs,
          greedyWin: greedyR.win, randomWR: randR.winRate,
          colors: out.colorCount, cgEdges: cg.edges.length,
          branchFirst: out.branchLog[0] ?? 0, branchLast: out.branchLog[out.branchLog.length-1] ?? 0,
          actualSolvable: out.solvable, actualDeath: out.deathStep,
        });
      } catch (e: any) {
        results.push({
          terrain: tid, tiles: ft.length, triples: totalTriples,
          config: cfg.label + ' ERR',
          expectedSolvable: cfg.solvable, expectedDeath: cfg.deathStep,
          dfsWin: false, dfsStates: 0, dfsMs: 0,
          greedyWin: false, randomWR: 0,
          colors: 0, cgEdges: 0, branchFirst: 0, branchLast: 0,
          actualSolvable: false, actualDeath: -2,
        });
      }
    }
  }

  // ── Print ──
  console.log(`\n${'═'.repeat(120)}`);
  console.log(`  FULL GENERATION TEST (${results.length} boards across ${TERRAINS.length} terrains)`);
  console.log(`${'═'.repeat(120)}`);
  console.log(`  ${'Terrain'.padEnd(8)} ${'Config'.padEnd(12)} ${'Tiles'.padStart(5)} ${'ExpS?'.padStart(5)} ${'DFS?'.padStart(5)} ${'Match'.padStart(5)} ${'Colors'.padStart(6)} ${'cgE'.padStart(4)} ${'DFSSt'.padStart(8)} ${'DFSTime'.padStart(8)} ${'Branch[0]'.padStart(9)} ${'Br[last]'.padStart(8)}`);
  console.log(`  ${'-'.repeat(110)}`);

  let matches = 0, mismatches = 0;
  for (const r of results) {
    const match = r.expectedSolvable === r.dfsWin;
    if (match) matches++; else mismatches++;

    const matchStr = match ? '✓' : '✗';
    const dfsStr = r.dfsWin ? '✓' : '✗';
    const expStr = r.expectedSolvable ? 'Y' : 'N';

    console.log(
      `  ${String(r.terrain).padEnd(8)} ${r.config.padEnd(12)} ${String(r.tiles).padStart(5)} ${expStr.padStart(5)} ${dfsStr.padStart(5)} ${matchStr.padStart(5)} ` +
      `${String(r.colors).padStart(6)} ${String(r.cgEdges).padStart(4)} ${String(r.dfsStates).padStart(8)} ${r.dfsMs.toFixed(0).padStart(7)}ms ` +
      `${String(r.branchFirst).padStart(9)} ${String(r.branchLast).padStart(8)}`
    );
  }

  console.log(`\n  Matches: ${matches}/${results.length} (${(matches/results.length*100).toFixed(0)}%)`);
  if (mismatches > 0) {
    console.log(`  Mismatches:`);
    for (const r of results.filter(r => r.expectedSolvable !== r.dfsWin)) {
      console.log(`    ${r.terrain}/${r.config}: expected=${r.expectedSolvable} dfs=${r.dfsWin} deathAt=${r.actualDeath}`);
    }
  }

  // Summary by config type
  console.log(`\n  By config type:`);
  const byConfig = new Map<string, R[]>();
  for (const r of results) { const k=r.config; if(!byConfig.has(k))byConfig.set(k,[]); byConfig.get(k)!.push(r); }
  for (const [cfg, rs] of [...byConfig.entries()].sort()) {
    const ok = rs.filter(r=>r.expectedSolvable===r.dfsWin).length;
    console.log(`    ${cfg.padEnd(12)}: ${ok}/${rs.length} correct`);
  }
}

run();
