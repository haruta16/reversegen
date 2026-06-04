/**
 * Structural Rule Validation — checks provable rules against ALL 2507 cached boards.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

interface CachedResult {
  board: { levelResId: number; replayKey: string; grade: string };
  dfs: { win: boolean; failReason: string | null; statesVisited: number } | null;
  greedy: { win: boolean } | null;
  random: { winRate: number } | null;
  features: Record<string, number | number[] | boolean>;
}

function main() {
  const cacheDir = join(process.cwd(), '.reversegen-cache', 'board-results-v2');
  const files = readdirSync(cacheDir).filter(f => f.endsWith('.json'));

  const boards: CachedResult[] = [];
  for (const f of files) {
    try { const d = JSON.parse(readFileSync(join(cacheDir, f), 'utf-8')); if (!d.error) boards.push(d); } catch {}
  }
  console.log(`Loaded ${boards.length} boards\n`);

  const getN = (b: CachedResult, key: string) => (b.features[key] as number) ?? 0;

  // Define rules with precise thresholds
  const rules: { name: string; description: string; check: (b: CachedResult) => boolean }[] = [];

  // R1: cgEdgeCount tiers
  for (const [lo, hi, label] of [[0, 30, 'cgEdge 0-30'], [30, 70, 'cgEdge 30-70'], [70, 120, 'cgEdge 70-120'], [120, 180, 'cgEdge 120-180'], [180, 999, 'cgEdge 180+']] as [number, number, string][]) {
    rules.push({
      name: `CGEDGE_${lo}_${hi}`,
      description: `cgEdgeCount in [${lo}, ${hi})`,
      check: b => getN(b, 'cgEdgeCount') >= lo && getN(b, 'cgEdgeCount') < hi,
    });
  }

  // R2: Zero parallel sources
  rules.push({ name: 'NO_PARALLEL', check: b => getN(b, 'cgParallelSources') === 0, description: '' });

  // R3: Zero sinks
  rules.push({
    name: 'NO_SINKS',
    check: b => getN(b, 'cgSinkCount') === 0 && getN(b, 'cgNodeCount') > 0,
    description: '',
  });

  // R4: Deadlock (no source AND no sink)
  rules.push({
    name: 'DEADLOCK',
    check: b => getN(b, 'cgParallelSources') === 0 && getN(b, 'cgSinkCount') === 0 && getN(b, 'cgNodeCount') > 0,
    description: '',
  });

  // R5: Triple DAG depth
  for (const [lo, hi, label] of [[0, 3, 'tdagDepth 0-2'], [3, 5, 'tdagDepth 3-4'], [5, 99, 'tdagDepth 5+']] as [number, number, string][]) {
    rules.push({
      name: `TDAG_DEPTH_${lo}_${hi}`,
      description: `tdagDepthMax in [${lo}, ${hi})`,
      check: b => getN(b, 'tdagDepthMax') >= lo && getN(b, 'tdagDepthMax') < hi,
    });
  }

  // R6: Cross-color ratio 100%
  rules.push({ name: 'CROSS_COLOR_100', check: b => getN(b, 'tdagCrossColorEdgeRatio') >= 0.99, description: '' });

  // R7: Color count tiers
  for (const [lo, hi] of [[0, 8], [8, 14], [14, 20], [20, 99]]) {
    rules.push({
      name: `COLORS_${lo}_${hi}`,
      check: b => getN(b, 'colorCount') >= lo && getN(b, 'colorCount') < hi,
      description: '',
    });
  }

  // R8: Combined rules (AND)
  rules.push({
    name: 'DEADLOCK_AND_DEEP',
    check: b => getN(b, 'cgParallelSources') === 0 && getN(b, 'cgSinkCount') === 0
      && getN(b, 'cgNodeCount') > 0 && getN(b, 'tdagDepthMax') >= 3,
    description: 'DEADLOCK ∧ tdagDepth ≥ 3',
  });

  rules.push({
    name: 'CROSS100_AND_HIGH_EDGE',
    check: b => getN(b, 'tdagCrossColorEdgeRatio') >= 0.99 && getN(b, 'cgEdgeCount') >= 150,
    description: 'CrossColor100% ∧ cgEdgeCount ≥ 150',
  });

  rules.push({
    name: 'DEADLOCK_AND_CROSS100',
    check: b => getN(b, 'cgParallelSources') === 0 && getN(b, 'cgSinkCount') === 0
      && getN(b, 'cgNodeCount') > 0 && getN(b, 'tdagCrossColorEdgeRatio') >= 0.99,
    description: 'DEADLOCK ∧ CrossColor100%',
  });

  // ── Evaluate ──
  console.log(`${'Rule'.padEnd(30)} | ${'Total'.padStart(6)} | ${'Unsol%'.padStart(6)} | ${'GreedyFail%'.padStart(11)} | ${'Random0%'.padStart(8)} | ${'DFS States'.padStart(12)}`);
  console.log('-'.repeat(30) + '-|' + '-'.repeat(6) + '-|' + '-'.repeat(6) + '-|' + '-'.repeat(11) + '-|' + '-'.repeat(8) + '-|' + '-'.repeat(12));

  const summary: any[] = [];

  for (const rule of rules) {
    const hits = boards.filter(rule.check);
    if (hits.length === 0) continue;

    const unsolvable = hits.filter(b => !b.dfs?.win).length;
    const greedyFail = hits.filter(b => !b.greedy?.win).length;
    const randZero = hits.filter(b => (b.random?.winRate ?? 0) === 0).length;
    const dfsAvgStates = hits.filter(b => b.dfs).reduce((s, b) => s + (b.dfs?.statesVisited ?? 0), 0) / Math.max(hits.length, 1);

    const marker = unsolvable === hits.length && hits.length >= 5 ? ' ★DET' :
      unsolvable === 0 ? ' ALL_SOL' :
      unsolvable / hits.length > 0.5 ? ' MOST_UNSOL' : '';

    console.log(
      `${rule.name.padEnd(30)} | ${String(hits.length).padStart(6)} | ${(unsolvable/hits.length*100).toFixed(1).padStart(5)}% | ` +
      `${(greedyFail/hits.length*100).toFixed(1).padStart(10)}% | ${(randZero/hits.length*100).toFixed(0).padStart(7)}% | ` +
      `${Math.round(dfsAvgStates).toString().padStart(12)} ${marker}`
    );

    summary.push({ rule: rule.name, total: hits.length, unsolvable, unsolvableRate: unsolvable / hits.length, greedyFailRate: greedyFail / hits.length });
  }

  // ── Per-board detail for unsolved boards ──
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  UNSOLVED BOARDS DETAIL (${boards.filter(b => !b.dfs?.win).length})`);
  console.log(`${'='.repeat(80)}`);

  const unsolved = boards.filter(b => !b.dfs?.win);
  console.log(`${'Level'.padEnd(8)} | ${'cgEdges'.padStart(7)} | ${'cgNodes'.padStart(7)} | ${'parSrc'.padStart(6)} | ${'sinks'.padStart(5)} | ${'chain'.padStart(5)} | ${'depth'.padStart(5)} | ${'xDAG nodes'.padStart(10)} | ${'DFS states'.padStart(10)}`);

  for (const b of unsolved.slice(0, 62)) {
    console.log(
      `${String(b.board.levelResId).padEnd(8)} | ${String(getN(b,'cgEdgeCount')).padStart(7)} | ${String(getN(b,'cgNodeCount')).padStart(7)} | ` +
      `${String(getN(b,'cgParallelSources')).padStart(6)} | ${String(getN(b,'cgSinkCount')).padStart(5)} | ${String(getN(b,'cgMaxChainLength')).padStart(5)} | ` +
      `${String(getN(b,'tdagDepthMax')).padStart(5)} | ${String(getN(b,'tdagTripleCount')).padStart(10)} | ${String(b.dfs?.statesVisited ?? 0).padStart(10)}`
    );
  }

  // ── Comparison: unsolved vs solved with similar edge counts ──
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  UNSOLVED vs SOLVED (matched by cgEdgeCount range)`);
  console.log(`${'='.repeat(80)}`);

  const avg = (arr: number[]) => arr.reduce((a,b)=>a+b,0)/arr.length;
  for (const [lo, hi] of [[100, 150], [150, 200], [200, 500]]) {
    const unsInRange = boards.filter(b => !b.dfs?.win && getN(b,'cgEdgeCount') >= lo && getN(b,'cgEdgeCount') < hi);
    const solInRange = boards.filter(b => b.dfs?.win && getN(b,'cgEdgeCount') >= lo && getN(b,'cgEdgeCount') < hi);
    if (unsInRange.length === 0 || solInRange.length === 0) continue;

    console.log(`\n  cgEdgeCount [${lo}, ${hi}):`);
    console.log(`    Unsolved (n=${unsInRange.length}): avg cgNodes=${avg(unsInRange.map(b=>getN(b,'cgNodeCount'))).toFixed(1)} avg depth=${avg(unsInRange.map(b=>getN(b,'tdagDepthMax'))).toFixed(1)} avg xDAG=${avg(unsInRange.map(b=>getN(b,'tdagTripleCount'))).toFixed(1)}`);
    console.log(`    Solved   (n=${solInRange.length}): avg cgNodes=${avg(solInRange.map(b=>getN(b,'cgNodeCount'))).toFixed(1)} avg depth=${avg(solInRange.map(b=>getN(b,'tdagDepthMax'))).toFixed(1)} avg xDAG=${avg(solInRange.map(b=>getN(b,'tdagTripleCount'))).toFixed(1)}`);
  }

  writeFileSync(join(process.cwd(), '.reversegen-cache', 'rule-check.json'), JSON.stringify(summary, null, 2));
}

main();
