/**
 * Aggregate analysis — reads all cached board results and produces
 * correlation reports, feature importance rankings, and rule candidates.
 *
 * Run: npx tsx src/analysis/aggregate.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CACHE_DIR = join(process.cwd(), '.reversegen-cache', 'board-results-v2');
const REPORT_DIR = join(process.cwd(), '.reversegen-cache');

interface CachedResult {
  board: {
    levelResId: number;
    replayKey: string;
    grade: string;
    completionStatus: string;
    terrainHash: string;
    freeTiles: number;
    totalTiles: number;
  };
  dfs: { win: boolean; failReason: string | null; stepCount: number; statesVisited: number; deadStateCount: number; elapsedMs: number; picks: number[] } | null;
  greedy: { win: boolean; failReason: string | null; stepCount: number; elapsedMs: number; picks: number[]; costLog: number[]; dockLog: number[] } | null;
  random: { runs: number; wins: number; winRate: number; avgStepsOnWin: number } | null;
  features: Record<string, number | number[] | boolean>;
  error?: string;
}

// ═══════════════════════════════════════════════════

function main() {
  if (!existsSync(CACHE_DIR)) {
    console.error('Cache dir not found. Run batch-v2 first.');
    return;
  }

  const files = readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
  console.log(`Loading ${files.length} cached board results...`);

  const boards: CachedResult[] = [];
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(CACHE_DIR, file), 'utf-8')) as CachedResult;
      if (!data.error) boards.push(data);
    } catch {}
  }

  console.log(`Loaded ${boards.length} valid boards\n`);

  // ── Split into groups ──
  const dfsSolved = boards.filter(b => b.dfs?.win);
  const dfsUnsolved = boards.filter(b => b.dfs && !b.dfs.win);
  const dfsTimeout = boards.filter(b => b.dfs && !b.dfs.win && (b.dfs.failReason?.includes('timeout') ?? false));
  const greedySolved = boards.filter(b => b.greedy?.win);
  const greedyFailsDfsWins = boards.filter(b => !b.greedy?.win && b.dfs?.win);

  // ── Summary ──
  console.log('═══════════════════════════════════════');
  console.log('  MACROSCOPIC SUMMARY');
  console.log('═══════════════════════════════════════');
  console.log(`  Total boards:            ${boards.length}`);
  console.log(`  DFS Solved:              ${dfsSolved.length} (${pct(dfsSolved.length, boards.length)})`);
  console.log(`  DFS Unsolved:            ${dfsUnsolved.length} (${pct(dfsUnsolved.length, boards.length)})`);
  console.log(`  DFS Timeout:             ${dfsTimeout.length}`);
  console.log(`  Greedy Solved:           ${greedySolved.length} (${pct(greedySolved.length, boards.length)})`);
  console.log(`  Greedy Fails, DFS Wins:  ${greedyFailsDfsWins.length} (${pct(greedyFailsDfsWins.length, boards.length)})`);
  console.log();

  // ── Feature Statistics ──
  const numericFeatures = getNumericFeatureNames(boards);

  console.log('═══════════════════════════════════════');
  console.log('  DFS-SOLVABLE vs DFS-UNSOLVABLE');
  console.log('═══════════════════════════════════════');
  printFeatureTable(dfsSolved, dfsUnsolved, numericFeatures);
  console.log();

  console.log('═══════════════════════════════════════');
  console.log('  GREEDY FAILS (DFS WINS) vs GREEDY WINS');
  console.log('═══════════════════════════════════════');
  printFeatureTable(greedyFailsDfsWins, greedySolved, numericFeatures);
  console.log();

  // ── Random WR distribution ──
  console.log('═══════════════════════════════════════');
  console.log('  RANDOM WIN RATE DISTRIBUTION');
  console.log('═══════════════════════════════════════');
  const wrBrackets = [
    { lo: 0, hi: 0.001, label: '0%' },
    { lo: 0.001, hi: 0.1, label: '0.1%-10%' },
    { lo: 0.1, hi: 0.3, label: '10%-30%' },
    { lo: 0.3, hi: 0.6, label: '30%-60%' },
    { lo: 0.6, hi: 0.9, label: '60%-90%' },
    { lo: 0.9, hi: 1.01, label: '90%-100%' },
  ];
  for (const { lo, hi, label } of wrBrackets) {
    const cnt = boards.filter(b => b.random && b.random.winRate >= lo && b.random.winRate < hi).length;
    console.log(`  ${label.padEnd(12)}: ${cnt} boards`);
  }
  console.log();

  // ── DFS state complexity tiers ──
  console.log('═══════════════════════════════════════');
  console.log('  DFS COMPLEXITY TIERS');
  console.log('═══════════════════════════════════════');
  const tiers = [
    { label: 'Trivial    (<100 states)', lo: 0, hi: 100 },
    { label: 'Easy       (100-1K)', lo: 100, hi: 1000 },
    { label: 'Medium     (1K-10K)', lo: 1000, hi: 10000 },
    { label: 'Hard       (10K-100K)', lo: 10000, hi: 100000 },
    { label: 'Very Hard  (>100K)', lo: 100000, hi: Infinity },
  ];
  for (const { label, lo, hi } of tiers) {
    const cnt = dfsSolved.filter(b => b.dfs && b.dfs.statesVisited >= lo && b.dfs.statesVisited < hi).length;
    console.log(`  ${label}: ${cnt} boards`);
  }
  console.log();

  // ── Deterministic rules candidates ──
  console.log('═══════════════════════════════════════');
  console.log('  DETERMINISTIC RULE CANDIDATES');
  console.log('═══════════════════════════════════════');

  // Rule 1: If color parity fails → always unsolvable
  const parityBad = boards.filter(b => !b.features.colorParityOk);
  const parityBadUnsolved = parityBad.filter(b => b.dfs && !b.dfs.win);
  console.log(`\n  Rule: colorParityOk = false → DFS unsolvable`);
  console.log(`    Found: ${parityBad.length} boards with parity issues`);
  console.log(`    Unsolved: ${parityBadUnsolved.length}/${parityBad.length} (${pct(parityBadUnsolved.length, parityBad.length)})`);

  // Rule 2: If cgMaxDepSetSize > X → greedy fails
  findThresholdRule(
    boards,
    'cgMaxDepSetSize',
    (b, threshold) => b.features.cgMaxDepSetSize > threshold,
    (b) => !b.greedy?.win && b.dfs?.win,
    'cgMaxDepSetSize > X → Greedy Fails (DFS Wins)',
  );

  // Rule 3: If tdagDepthMax > X → greedy fails
  findThresholdRule(
    boards,
    'tdagDepthMax',
    (b, threshold) => b.features.tdagDepthMax > threshold,
    (b) => !b.greedy?.win && b.dfs?.win,
    'tdagDepthMax > X → Greedy Fails (DFS Wins)',
  );

  // Rule 4: If cgEdgeCount > X → greedy fails
  findThresholdRule(
    boards,
    'cgEdgeCount',
    (b, threshold) => b.features.cgEdgeCount > threshold,
    (b) => !b.greedy?.win && b.dfs?.win,
    'cgEdgeCount > X → Greedy Fails (DFS Wins)',
  );

  // Rule 5: If tdagCrossColorEdgeRatio > X → narrow solution
  findThresholdRule(
    boards,
    'tdagCrossColorEdgeRatio',
    (b, threshold) => b.features.tdagCrossColorEdgeRatio > threshold,
    (b) => b.random && b.random.winRate === 0,
    'tdagCrossColorEdgeRatio > X → Random WR = 0%',
  );

  // Rule 6: If cgParallelSources === 0 and cgMaxChainLength > X → unsolvable
  const noParallel = boards.filter(b => b.features.cgParallelSources === 0);
  const noParallelUnsolved = noParallel.filter(b => b.dfs && !b.dfs.win);
  console.log(`\n  Rule: cgParallelSources === 0 AND cgMaxChainLength > threshold → DFS unsolvable`);
  console.log(`    Boards with 0 parallel sources: ${noParallel.length}`);
  console.log(`    Unsolved: ${noParallelUnsolved.length}/${noParallel.length} (${pct(noParallelUnsolved.length, noParallel.length)})`);

  // ── Write report ──
  const reportPath = join(REPORT_DIR, 'aggregate-report-v2.json');
  const report = {
    totalBoards: boards.length,
    dfsSolved: dfsSolved.length,
    dfsUnsolved: dfsUnsolved.length,
    greedySolved: greedySolved.length,
    greedyFailsDfsWins: greedyFailsDfsWins.length,
    featureAverages: {
      dfsSolved: computeFeatureAverages(dfsSolved, numericFeatures),
      dfsUnsolved: computeFeatureAverages(dfsUnsolved, numericFeatures),
      greedyWins: computeFeatureAverages(greedySolved, numericFeatures),
      greedyFailsDfsWins: computeFeatureAverages(greedyFailsDfsWins, numericFeatures),
    },
    randomWRDistribution: wrBrackets.map(({ lo, hi, label }) => ({
      label,
      count: boards.filter(b => b.random && b.random.winRate >= lo && b.random.winRate < hi).length,
    })),
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n  Aggregate report written to: ${reportPath}`);
}

main();

// ═══════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════

function pct(part: number, total: number): string {
  if (total === 0) return '0.0%';
  return (part * 100 / total).toFixed(1) + '%';
}

function getNumericFeatureNames(boards: CachedResult[]): string[] {
  if (boards.length === 0) return [];
  const first = boards[0].features;
  return Object.keys(first).filter(k => typeof first[k] === 'number');
}

function computeFeatureAverages(boards: CachedResult[], featureNames: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const name of featureNames) {
    const vals = boards.map(b => b.features[name] as number).filter(v => typeof v === 'number');
    result[name] = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  return result;
}

function printFeatureTable(groupA: CachedResult[], groupB: CachedResult[], featureNames: string[]) {
  if (groupA.length === 0 || groupB.length === 0) {
    console.log('  (one group is empty, skipping comparison)');
    return;
  }

  const avgA = computeFeatureAverages(groupA, featureNames);
  const avgB = computeFeatureAverages(groupB, featureNames);

  console.log(`  ${'Feature'.padEnd(28)} | ${'A (n='.padEnd(6)}${String(groupA.length).padEnd(5)}) | ${'B (n='.padEnd(6)}${String(groupB.length).padEnd(5)}) | Ratio`);
  console.log(`  ${'-'.repeat(28)}-|-${'-'.repeat(16)}-|-${'-'.repeat(16)}-|------`);

  // Sort by ratio (most differentiating first)
  const sorted = featureNames
    .map(name => ({ name, avgA: avgA[name] ?? 0, avgB: avgB[name] ?? 0 }))
    .filter(f => f.avgA > 0 || f.avgB > 0)
    .sort((a, b) => {
      const ratioA = a.avgB > 0 ? Math.abs(a.avgA / a.avgB - 1) : 0;
      const ratioB = b.avgB > 0 ? Math.abs(b.avgA / b.avgB - 1) : 0;
      return ratioB - ratioA;
    });

  for (const { name, avgA: a, avgB: b } of sorted) {
    const ratio = b > 0 ? (a / b).toFixed(2) : '∞';
    console.log(`  ${name.padEnd(28)} | ${a.toFixed(1).padStart(14)} | ${b.toFixed(1).padStart(14)} | ${ratio}`);
  }
}

function findThresholdRule(
  boards: CachedResult[],
  featureName: string,
  condition: (b: CachedResult, threshold: number) => boolean,
  targetGroup: (b: CachedResult) => boolean,
  ruleName: string,
) {
  const values = boards.map(b => b.features[featureName] as number).filter(v => typeof v === 'number');
  if (values.length === 0) return;

  values.sort((a, b) => a - b);

  // Try percentiles as thresholds
  const percentiles = [50, 75, 90, 95];
  let bestPrecision = 0;
  let bestThreshold = 0;
  let bestRecall = 0;

  for (const p of percentiles) {
    const threshold = values[Math.floor(values.length * p / 100)];
    const above = boards.filter(b => condition(b, threshold));
    const tp = above.filter(b => targetGroup(b)).length;
    const precision = above.length > 0 ? tp / above.length : 0;
    const allTarget = boards.filter(b => targetGroup(b)).length;
    const recall = allTarget > 0 ? tp / allTarget : 0;

    if (precision > bestPrecision) {
      bestPrecision = precision;
      bestThreshold = threshold;
      bestRecall = recall;
    }
  }

  const above = boards.filter(b => condition(b, bestThreshold));
  const tp = above.filter(b => targetGroup(b)).length;
  console.log(`\n  Rule: ${ruleName}`);
  console.log(`    Best threshold: ${bestThreshold.toFixed(1)}`);
  console.log(`    Precision: ${pct(tp, above.length)} (${tp}/${above.length})`);
  const allTarget = boards.filter(b => targetGroup(b)).length;
  console.log(`    Recall:    ${pct(tp, allTarget)} (${tp}/${allTarget})`);
}
