/**
 * Test Generation v3 across multiple terrains with varied parameters.
 */
import { loadTerrainFromFile } from '../src/terrain-loader.js';
import { generateV3, type GenV3Input } from '../src/generate-v3.js';
import { createGame } from '../src/solver/offline-game.js';
import { solveDFS } from '../src/solver/solver-dfs.js';
import { solveGreedy } from '../src/solver/solver-greedy.js';
import { solveRandomBatch } from '../src/solver/solver-random.js';
import { buildColorGroupDAG } from '../src/analysis/board-dag.js';
import { logger, setLogLevel, LogLevel } from '../src/logger.js';
setLogLevel(LogLevel.Error);

const L = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';

// Test terrains of varying sizes
const testTerrains = [100003, 100005, 100010, 100020, 100050, 100075];

interface TestResult {
  terrain: number;
  tiles: number;
  triples: number;
  config: string;
  solvable: boolean;
  actualDeath: number;
  freedomLog: number[];
  dfsSolved: boolean;
  dfsStates: number;
  dfsTime: number;
  greedySolved: boolean;
  randomWR: number;
  cgEdges: number;
  cgNodes: number;
  colorCount: number;
}

async function main() {
  const results: TestResult[] = [];

  for (const tid of testTerrains) {
    const terrain = loadTerrainFromFile(`${L}/${tid}.json`);
    const allTiles: any[] = [];
    for (const l of terrain.layers) for (const t of l.tiles) allTiles.push(t);
    const freeTiles = allTiles.filter((t: any) => !t.isConst);
    const totalTriples = Math.floor(freeTiles.length / 3);

    // Test configurations
    const configs: { label: string; input: Partial<GenV3Input> }[] = [
      { label: 'single-path', input: { solvable: true, freedom: 1 } },
      { label: 'wide-2', input: { solvable: true, freedom: 2 } },
      { label: 'wide-3', input: { solvable: true, freedom: 3 } },
      { label: 'death-0', input: { solvable: false, deathStep: 0 } },
    ];

    for (const cfg of configs) {
      try {
        const genInput: GenV3Input = { terrain, ...cfg.input };
        const genOutput = generateV3(genInput);

        // Create game and verify
        const game = createGame({
          terrainTiles: allTiles,
          elementValues: genOutput.assignments,
          initialDock: [],
          eliminatedTileIds: new Set(),
        });

        const dfsResult = solveDFS(game, { timeoutMs: 10_000 });
        const greedyResult = solveGreedy(game);
        const randomResult = solveRandomBatch(game, 30);

        const cgDAG = buildColorGroupDAG(
          allTiles.filter((t: any) => !t.isConst),
          genOutput.assignments,
        );

        results.push({
          terrain: tid,
          tiles: freeTiles.length,
          triples: totalTriples,
          config: cfg.label,
          solvable: genOutput.solvable,
          actualDeath: genOutput.deathStep,
          freedomLog: genOutput.branchLog || [],
          dfsSolved: dfsResult.win,
          dfsStates: dfsResult.statesVisited,
          dfsTime: dfsResult.elapsedMs,
          greedySolved: greedyResult.win,
          randomWR: randomResult.winRate,
          cgEdges: cgDAG.edges.length,
          cgNodes: cgDAG.nodes.length,
          colorCount: genOutput.colorCount,
        });

      } catch (e: any) {
        console.log(`  ${tid}/${cfg.label}: ERROR ${e.message}`);
      }
    }
  }

  // ── Print results ──
  console.log(`${'═'.repeat(100)}`);
  console.log(`  GENERATION V3 TEST RESULTS (${results.length} boards)`);
  console.log(`${'═'.repeat(100)}`);
  console.log();
  console.log(`${'Terrain'.padEnd(9)} ${'Config'.padEnd(13)} ${'Tiles'.padStart(5)} ${'S?'.padStart(3)} ${'DFS?'.padStart(5)} ${'Greedy?'.padStart(7)} ${'RndWR'.padStart(6)} ${'Colors'.padStart(6)} ${'cgE'.padStart(4)} ${'DFSSt'.padStart(7)} ${'DFSTime'.padStart(8)} ${'Freedom'.padStart(30)}`);
  console.log('-'.repeat(100));

  for (const r of results) {
    const dOk = r.dfsSolved ? '✓' : '✗';
    const gOk = r.greedySolved ? '✓' : '✗';
    console.log(
      `${String(r.terrain).padEnd(9)} ${r.config.padEnd(13)} ${String(r.tiles).padStart(5)} ${r.solvable ? 'Y'.padStart(3) : 'N'.padStart(3)} ` +
      `${dOk.padStart(5)} ${gOk.padStart(7)} ${(r.randomWR*100).toFixed(0).padStart(5)}% ${String(r.colorCount).padStart(6)} ` +
      `${String(r.cgEdges).padStart(4)} ${String(r.dfsStates).padStart(7)} ${r.dfsTime.toFixed(1).padStart(7)}ms ` +
      `[${r.freedomLog.slice(0, 10).join(',')}${r.freedomLog.length > 10 ? '...' : ''}]`.padStart(0)
    );
  }

  // ── Summary ──
  const dfsSolved = results.filter(r => r.dfsSolved);
  const matchedExpectation = results.filter(r => r.solvable === r.dfsSolved);
  console.log(`\nDFS solved: ${dfsSolved.length}/${results.length}`);
  console.log(`Matches expectation (solvable ↔ DFS solved): ${matchedExpectation.length}/${results.length}`);

  const mismatch = results.filter(r => r.solvable !== r.dfsSolved);
  if (mismatch.length > 0) {
    console.log(`Mismatches:`);
    for (const m of mismatch) {
      console.log(`  ${m.terrain}/${m.config}: expected solvable=${m.solvable} but dfs=${m.dfsSolved}`);
    }
  }
}

main();
