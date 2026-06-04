/**
 * Quick batch analysis — 20 boards for validation.
 */
import { runBatch } from '../src/analysis/batch-runner.js';

console.log('Running quick batch...');
const results = runBatch({
  terrainDir: '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels',
  replayDir: '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Replays',
  dfsTimeoutMs: 10_000,
  randomRuns: 20,
  maxBoards: 20,
  includeReversegen: false,
});

const solved = results.filter(r => r.solvers.dfs?.win && !r.error);
const unsolved = results.filter(r => r.solvers.dfs && !r.solvers.dfs.win && !r.error);

console.log('\n=== DAG Correlation ===');
console.log(`Solved: ${solved.length}, Unsolved: ${unsolved.length}`);
const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const features = [
  'dagMaxChainLength', 'dagEdgeCount', 'dagParallelGroups', 'dagAvgDepSetSize',
  'avgGroupSize', 'maxGroupSize', 'avgDepClosureSize', 'greedyMaxDock',
];
for (const f of features) {
  const sv = avg(solved.map((r: any) => r.features[f]));
  const uv = avg(unsolved.map((r: any) => r.features[f]));
  console.log(`${f.padEnd(22)} | Solved: ${sv.toFixed(1).padStart(8)} | Unsolved: ${uv.toFixed(1).padStart(8)}`);
}

// Per-board detail
console.log('\n=== Per-Board ===');
for (const r of results.filter(r => !r.error).slice(0, 10)) {
  const d = r.solvers.dfs?.win ? '✓' : '✗';
  const g = r.solvers.greedy?.win ? '✓' : '✗';
  console.log(`  ${r.board.levelResId} DFS:${d} Greedy:${g} chain:${r.features.dagMaxChainLength} edges:${r.features.dagEdgeCount} par:${r.features.dagParallelGroups}`);
}
