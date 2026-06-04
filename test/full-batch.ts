/**
 * Full batch analysis — run solvers + extract DAG features across many boards.
 */
import { runBatch } from '../src/analysis/batch-runner.js';
import { logger, setLogLevel, LogLevel } from '../src/logger.js';

// Suppress logger noise
setLogLevel(LogLevel.Error);

console.log('=== Full Batch Analysis ===\n');

const results = runBatch({
  terrainDir: '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels',
  replayDir: '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Replays',
  dfsTimeoutMs: 10_000,
  randomRuns: 50,
  maxBoards: 200,
  includeReversegen: true,
  reversegenCount: 1,
});

// ── Analysis ──
const valid = results.filter(r => !r.error);
const solved = valid.filter(r => r.solvers.dfs?.win);
const unsolved = valid.filter(r => r.solvers.dfs && !r.solvers.dfs.win);
const greedySolved = valid.filter(r => r.solvers.greedy?.win);
const greedyUnsolvedButDFSSolved = valid.filter(r => !r.solvers.greedy?.win && r.solvers.dfs?.win);
const replayBoards = valid.filter(r => r.board.source === 'replay-file');
const rgBoards = valid.filter(r => r.board.source === 'reversegen');

const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

console.log(`\n═══════════════════════════════════════`);
console.log(`  Summary`);
console.log(`═══════════════════════════════════════`);
console.log(`  Total boards:       ${results.length}`);
console.log(`  Valid (no errors):  ${valid.length}`);
console.log(`  Errors:             ${results.length - valid.length}`);
console.log(`  Replay boards:      ${replayBoards.length}`);
console.log(`  ReverseGen boards:  ${rgBoards.length}`);
console.log(`  DFS solved:         ${solved.length}/${valid.length} (${(solved.length/valid.length*100).toFixed(1)}%)`);
console.log(`  Greedy solved:      ${greedySolved.length}/${valid.length} (${(greedySolved.length/valid.length*100).toFixed(1)}%)`);
console.log(`  Greedy fails, DFS wins: ${greedyUnsolvedButDFSSolved.length} — ReverseGen gap!`);

// Random solver
const randomData = valid.filter(r => r.solvers.random);
const avgWR = avg(randomData.map(r => r.solvers.random!.winRate));
console.log(`  Avg random win rate: ${(avgWR * 100).toFixed(1)}%`);

// ── Feature definitions ──
type BoardRef = typeof valid[0];
const feats: [string, (r: BoardRef) => number][] = [
  ['colorCount', r => r.features.colorCount],
  ['avgGroupSize', r => r.features.avgGroupSize],
  ['maxGroupSize', r => r.features.maxGroupSize],
  ['initialClickable', r => r.features.initialClickableCount],
  ['avgDepClosureSize', r => r.features.avgDepClosureSize],
  ['greedyMaxDock', r => r.features.greedyMaxDock],
  ['greedyAvgDock', r => r.features.greedyAvgDock],
  ['greedyCostVol', r => r.features.greedyCostVolatility],
  ['dagColorGroups', r => r.features.dagColorGroups],
  ['dagMaxChainLength', r => r.features.dagMaxChainLength],
  ['dagEdgeCount', r => r.features.dagEdgeCount],
  ['dagParallelGroups', r => r.features.dagParallelGroups],
  ['dagAvgDepSetSize', r => r.features.dagAvgDepSetSize],
  ['dfsStatesVisited', r => r.features.dfsStatesVisited],
];

// ── DAG Features: Solved vs Unsolved ──
console.log(`\n═══════════════════════════════════════`);
console.log(`  Feature Comparison: DFS-Solvable vs DFS-Unsolvable`);
console.log(`═══════════════════════════════════════`);

if (solved.length > 0 && unsolved.length > 0) {
  console.log(`${'Feature'.padEnd(24)} | ${'Solved (n='.padEnd(8)}${String(solved.length).padEnd(4)}) | ${'Unsolved (n='.padEnd(8)}${String(unsolved.length).padEnd(4)}) | Ratio`);
  console.log(`${'-'.repeat(24)}-|-${'-'.repeat(16)}-|-${'-'.repeat(16)}-|------`);

  for (const [name, fn] of feats) {
    const sv = avg(solved.map(fn));
    const uv = avg(unsolved.map(fn));
    const ratio = uv > 0 ? (sv / uv) : Infinity;
    console.log(`${name.padEnd(24)} | ${sv.toFixed(1).padStart(14)} | ${uv.toFixed(1).padStart(14)} | ${ratio.toFixed(2)}`);
  }
}

// ── Greedy fails but DFS wins — what's different? ──
const greedyFails = valid.filter(r => !r.solvers.greedy?.win && r.solvers.dfs?.win);
const greedyWins = valid.filter(r => r.solvers.greedy?.win && r.solvers.dfs?.win);

if (greedyFails.length > 0 && greedyWins.length > 0) {
  console.log(`\n═══════════════════════════════════════`);
  console.log(`  Greedy Fails but DFS Wins (n=${greedyFails.length}) vs Both Win (n=${greedyWins.length})`);
  console.log(`═══════════════════════════════════════`);
  console.log(`${'Feature'.padEnd(24)} | ${'Greedy Fails'.padEnd(14)} | ${'Both Win'.padEnd(14)} | Ratio`);
  console.log(`${'-'.repeat(24)}-|-${'-'.repeat(14)}-|-${'-'.repeat(14)}-|------`);

  for (const [name, fn] of feats) {
    const gf = avg(greedyFails.map(fn));
    const gw = avg(greedyWins.map(fn));
    const ratio = gw > 0 ? (gf / gw) : Infinity;
    console.log(`${name.padEnd(24)} | ${gf.toFixed(1).padStart(12)} | ${gw.toFixed(1).padStart(12)} | ${ratio.toFixed(2)}`);
  }
}

// ── Random WR distribution ──
const wrBrackets = [0, 0.01, 0.2, 0.5, 0.8, 1.0];
console.log(`\n═══════════════════════════════════════`);
console.log(`  Random Win Rate Distribution`);
console.log(`═══════════════════════════════════════`);
for (let i = 0; i < wrBrackets.length - 1; i++) {
  const lo = wrBrackets[i], hi = wrBrackets[i + 1];
  const count = randomData.filter(r => r.solvers.random!.winRate >= lo && r.solvers.random!.winRate < hi).length;
  console.log(`  ${(lo*100).toFixed(0)}%-${((hi-0.01)*100).toFixed(0)}%: ${count} boards`);
}
const wr100 = randomData.filter(r => r.solvers.random!.winRate >= 1.0).length;
console.log(`  100%: ${wr100} boards`);

console.log(`\n=== Done ===`);
