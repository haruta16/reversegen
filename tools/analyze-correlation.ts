/**
 * Deep correlation & fit analysis between online and simulated win rates.
 *
 * Usage: npx tsx tools/analyze-correlation.ts [--plot]
 *
 * Outputs:
 *   1. Console summary with key statistics
 *   2. output/analysis_detail.csv — per-entry analysis
 *   3. output/analysis_summary.json — structured results
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(__dirname, '../output');
const CSV_INPUT = join(OUTPUT_DIR, 'sim_results.csv');

// ═══ Load data ═══
interface DataPoint {
  replayKey: string;
  terrainId: string;
  starts: number;
  clears: number;
  onlineWR: number;   // 0-100
  replayCode: string;
  simWins: number;
  simLosses: number;
  simWR: number;      // 0-100
  simAvgSteps: number;
  elapsedMs: number;
  totalTiles: number;
}

function loadData(): DataPoint[] {
  const raw = readFileSync(CSV_INPUT, 'utf-8');
  const lines = raw.trim().split('\n');
  const data: DataPoint[] = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].replace(/"/g, '').split(',');
    if (parts.length < 12) continue;

    data.push({
      replayKey: parts[0],
      terrainId: parts[1],
      starts: parseInt(parts[2], 10),
      clears: parseInt(parts[3], 10),
      onlineWR: parseFloat(parts[4]),
      replayCode: parts[5],
      simWins: parseInt(parts[6], 10),
      simLosses: parseInt(parts[7], 10),
      simWR: parseFloat(parts[8]),
      simAvgSteps: parseFloat(parts[9]),
      elapsedMs: parseFloat(parts[10]),
      totalTiles: parseInt(parts[11], 10),
    });
  }
  return data;
}

// ═══ Statistics helpers ═══
function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr: number[], m?: number): number {
  const avg = m ?? mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - avg) ** 2, 0) / (arr.length - 1));
}

function pearsonR(xs: number[], ys: number[]): number {
  const mx = mean(xs), my = mean(ys);
  let cov = 0, sx = 0, sy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    cov += dx * dy;
    sx += dx * dx;
    sy += dy * dy;
  }
  return cov / Math.sqrt(sx * sy);
}

function spearmanRho(xs: number[], ys: number[]): number {
  // Rank transform
  const rank = (arr: number[]) => {
    const indexed = arr.map((v, i) => ({ v, i }));
    indexed.sort((a, b) => a.v - b.v);
    const ranks = new Array(arr.length);
    for (let i = 0; i < indexed.length; i++) {
      ranks[indexed[i].i] = i + 1;
    }
    // Handle ties: average rank
    for (let i = 0; i < indexed.length;) {
      let j = i + 1;
      while (j < indexed.length && indexed[j].v === indexed[i].v) j++;
      if (j > i + 1) {
        const avgRank = (i + 1 + j) / 2;
        for (let k = i; k < j; k++) ranks[indexed[k].i] = avgRank;
      }
      i = j;
    }
    return ranks;
  };
  return pearsonR(rank(xs), rank(ys));
}

// Linear regression: y = slope * x + intercept
function linearRegression(xs: number[], ys: number[]): { slope: number; intercept: number; r2: number } {
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = num / den;
  const intercept = my - slope * mx;

  // R²
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < xs.length; i++) {
    const pred = slope * xs[i] + intercept;
    ssRes += (ys[i] - pred) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }
  const r2 = 1 - ssRes / ssTot;

  return { slope, intercept, r2 };
}

// ═══ Analysis ═══
interface AnalysisResult {
  // Overall stats
  count: number;
  pearsonR: number;
  spearmanRho: number;
  linearFit: { slope: number; intercept: number; r2: number };
  mae: number;
  rmse: number;
  bias: number; // mean(simWR - onlineWR)
  biasPct: number;

  // Distribution stats
  onlineMean: number;
  onlineStd: number;
  simMean: number;
  simStd: number;

  // Agreement tiers
  within5pct: number;   // |diff| < 5%
  within10pct: number;  // |diff| < 10%
  within20pct: number;  // |diff| < 20%
  simOverestimates: number;  // sim > online by >5%
  simUnderestimates: number; // sim < online by >5%
  roughlyMatch: number;      // |diff| ≤ 5%

  // By difficulty tier (based on online WR)
  tiers: TierAnalysis[];

  // By terrain size
  byTileCount: TileCountAnalysis[];

  // Top outliers
  topOverestimates: DataPoint[];  // sim >> online
  topUnderestimates: DataPoint[]; // sim << online
}

interface TierAnalysis {
  label: string;
  range: [number, number];
  count: number;
  onlineMean: number;
  simMean: number;
  pearsonR: number;
  mae: number;
  bias: number;
}

interface TileCountAnalysis {
  label: string;
  range: [number, number];
  count: number;
  onlineMean: number;
  simMean: number;
  pearsonR: number;
  mae: number;
}

function analyze(data: DataPoint[]): AnalysisResult {
  const onlineWRs = data.map(d => d.onlineWR);
  const simWRs = data.map(d => d.simWR);
  const diffs = data.map(d => d.simWR - d.onlineWR);
  const absDiffs = diffs.map(d => Math.abs(d));

  const pr = pearsonR(onlineWRs, simWRs);
  const sr = spearmanRho(onlineWRs, simWRs);
  const lr = linearRegression(onlineWRs, simWRs);
  const maeVal = mean(absDiffs);
  const rmseVal = Math.sqrt(mean(diffs.map(d => d * d)));
  const biasVal = mean(diffs);

  // Agreement counts
  let within5 = 0, within10 = 0, within20 = 0, over = 0, under = 0, match = 0;
  for (const d of absDiffs) {
    if (d <= 5) { within5++; match++; }
    else if (d <= 10) within10++;
    else if (d <= 20) within20++;
  }
  for (let i = 0; i < diffs.length; i++) {
    if (diffs[i] > 5) over++;
    else if (diffs[i] < -5) under++;
  }

  // Difficulty tiers
  const tierDefs: { label: string; range: [number, number] }[] = [
    { label: '极难 (0-30%)', range: [0, 30] },
    { label: '困难 (30-50%)', range: [30, 50] },
    { label: '中等 (50-70%)', range: [50, 70] },
    { label: '较易 (70-85%)', range: [70, 85] },
    { label: '极易 (85-100%)', range: [85, 100] },
  ];

  const tiers: TierAnalysis[] = tierDefs.map(td => {
    const subset = data.filter(d => d.onlineWR >= td.range[0] && d.onlineWR < td.range[1]);
    if (subset.length < 3) {
      return { label: td.label, range: td.range, count: subset.length,
        onlineMean: 0, simMean: 0, pearsonR: 0, mae: 0, bias: 0 };
    }
    const ox = subset.map(d => d.onlineWR);
    const sx = subset.map(d => d.simWR);
    const dx = subset.map(d => d.simWR - d.onlineWR);
    return {
      label: td.label,
      range: td.range,
      count: subset.length,
      onlineMean: mean(ox),
      simMean: mean(sx),
      pearsonR: subset.length >= 5 ? pearsonR(ox, sx) : 0,
      mae: mean(dx.map(d => Math.abs(d))),
      bias: mean(dx),
    };
  });

  // By tile count
  const tileGroups: { label: string; range: [number, number] }[] = [
    { label: '极小 (<40)', range: [0, 40] },
    { label: '小 (40-55)', range: [40, 55] },
    { label: '中 (55-70)', range: [55, 70] },
    { label: '大 (70-85)', range: [70, 85] },
    { label: '超大 (85+)', range: [85, Infinity] },
  ];

  const byTile = tileGroups.map(tg => {
    const subset = data.filter(d => d.totalTiles >= tg.range[0] && d.totalTiles < tg.range[1]);
    if (subset.length < 3) {
      return { label: tg.label, range: tg.range, count: subset.length,
        onlineMean: 0, simMean: 0, pearsonR: 0, mae: 0 };
    }
    const ox = subset.map(d => d.onlineWR);
    const sx = subset.map(d => d.simWR);
    return {
      label: tg.label,
      range: tg.range as [number, number],
      count: subset.length,
      onlineMean: mean(ox),
      simMean: mean(sx),
      pearsonR: subset.length >= 5 ? pearsonR(ox, sx) : 0,
      mae: mean(sx.map((s, i) => Math.abs(s - ox[i]))),
    };
  });

  // Top outliers
  const withDiff = data.map((d, i) => ({ ...d, diff: diffs[i], absDiff: absDiffs[i] }));
  withDiff.sort((a, b) => b.diff - a.diff);
  const topOver = withDiff.slice(0, 15);
  withDiff.sort((a, b) => a.diff - b.diff);
  const topUnder = withDiff.slice(0, 15);

  return {
    count: data.length,
    pearsonR: pr,
    spearmanRho: sr,
    linearFit: lr,
    mae: maeVal,
    rmse: rmseVal,
    bias: biasVal,
    biasPct: (biasVal / mean(onlineWRs)) * 100,
    onlineMean: mean(onlineWRs),
    onlineStd: std(onlineWRs),
    simMean: mean(simWRs),
    simStd: std(simWRs),
    within5pct: within5,
    within10pct: within5 + within10,
    within20pct: within5 + within10 + within20,
    simOverestimates: over,
    simUnderestimates: under,
    roughlyMatch: match,
    tiers,
    byTileCount: byTile,
    topOverestimates: topOver,
    topUnderestimates: topUnder,
  };
}

// ═══ Print summary ═══
function printSummary(r: AnalysisResult): void {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  深度分析：在线胜率 vs 玩家模拟胜率');
  console.log('══════════════════════════════════════════════════════\n');

  console.log(`📊 样本量: ${r.count} 个关卡`);

  console.log(`\n── 整体分布 ──`);
  console.log(`  在线胜率: 均值=${r.onlineMean.toFixed(2)}%  标准差=${r.onlineStd.toFixed(2)}%`);
  console.log(`  模拟胜率: 均值=${r.simMean.toFixed(2)}%  标准差=${r.simStd.toFixed(2)}%`);

  console.log(`\n── 相关性 ──`);
  console.log(`  Pearson r  = ${r.pearsonR.toFixed(4)}  ${interpretR(r.pearsonR)}`);
  console.log(`  Spearman ρ = ${r.spearmanRho.toFixed(4)}  ${interpretR(r.spearmanRho)}`);

  console.log(`\n── 线性回归: simWR = ${r.linearFit.slope.toFixed(4)} × onlineWR + ${r.linearFit.intercept.toFixed(2)} ──`);
  console.log(`  R² = ${r.linearFit.r2.toFixed(4)}  (${(r.linearFit.r2 * 100).toFixed(1)}% 方差可解释)`);
  console.log(`  ${interpretR2(r.linearFit.r2)}`);

  console.log(`\n── 误差分析 ──`);
  console.log(`  MAE  (平均绝对误差): ${r.mae.toFixed(2)}%`);
  console.log(`  RMSE (均方根误差):   ${r.rmse.toFixed(2)}%`);
  console.log(`  偏差 (sim - online):  ${r.bias > 0 ? '+' : ''}${r.bias.toFixed(2)}%  (${r.bias > 0 ? '模拟偏高' : '模拟偏低'})`);

  console.log(`\n── 一致性 ──`);
  console.log(`  |差值| ≤ 5%:   ${r.within5pct} 个 (${(r.within5pct / r.count * 100).toFixed(1)}%)`);
  console.log(`  |差值| ≤ 10%:  ${r.within10pct} 个 (${(r.within10pct / r.count * 100).toFixed(1)}%)`);
  console.log(`  |差值| ≤ 20%:  ${r.within20pct} 个 (${(r.within20pct / r.count * 100).toFixed(1)}%)`);
  console.log(`  模拟显著高估 (>5%): ${r.simOverestimates} 个 (${(r.simOverestimates / r.count * 100).toFixed(1)}%)`);
  console.log(`  模拟显著低估 (>5%): ${r.simUnderestimates} 个 (${(r.simUnderestimates / r.count * 100).toFixed(1)}%)`);
  console.log(`  大致吻合 (≤5%):     ${r.roughlyMatch} 个 (${(r.roughlyMatch / r.count * 100).toFixed(1)}%)`);

  // Tiers
  console.log(`\n── 按在线胜率分层 ──`);
  console.log(`  ${'层级'.padEnd(18)} ${'数量'.padStart(5)} ${'在线均值'.padStart(8)} ${'模拟均值'.padStart(8)} ${'偏差'.padStart(8)} ${'MAE'.padStart(6)} ${'r'.padStart(7)}`);
  console.log(`  ${'─'.repeat(70)}`);
  for (const t of r.tiers) {
    if (t.count === 0) continue;
    console.log(
      `  ${t.label.padEnd(18)} ${String(t.count).padStart(5)} ` +
      `${t.onlineMean.toFixed(1)}%`.padStart(8) +
      `${t.simMean.toFixed(1)}%`.padStart(8) +
      `${(t.bias > 0 ? '+' : '') + t.bias.toFixed(1)}%`.padStart(8) +
      `${t.mae.toFixed(1)}%`.padStart(6) +
      `${t.pearsonR.toFixed(3)}`.padStart(7),
    );
  }

  // By tile count
  console.log(`\n── 按地形大小分层 ──`);
  console.log(`  ${'大小'.padEnd(14)} ${'数量'.padStart(5)} ${'在线均值'.padStart(8)} ${'模拟均值'.padStart(8)} ${'MAE'.padStart(6)} ${'r'.padStart(7)}`);
  console.log(`  ${'─'.repeat(55)}`);
  for (const t of r.byTileCount) {
    if (t.count === 0) continue;
    console.log(
      `  ${t.label.padEnd(14)} ${String(t.count).padStart(5)} ` +
      `${t.onlineMean.toFixed(1)}%`.padStart(8) +
      `${t.simMean.toFixed(1)}%`.padStart(8) +
      `${t.mae.toFixed(1)}%`.padStart(6) +
      `${t.pearsonR.toFixed(3)}`.padStart(7),
    );
  }

  // Outliers
  console.log(`\n── 模拟显著高估 Top 10 (sim ≫ online) ──`);
  for (const d of r.topOverestimates.slice(0, 10)) {
    console.log(`  ${d.replayKey.padEnd(28)} online=${d.onlineWR.toFixed(1)}% sim=${d.simWR.toFixed(1)}% diff=+${(d.simWR - d.onlineWR).toFixed(1)}% tiles=${d.totalTiles}`);
  }

  console.log(`\n── 模拟显著低估 Top 10 (sim ≪ online) ──`);
  for (const d of r.topUnderestimates.slice(0, 10)) {
    console.log(`  ${d.replayKey.padEnd(28)} online=${d.onlineWR.toFixed(1)}% sim=${d.simWR.toFixed(1)}% diff=${(d.simWR - d.onlineWR).toFixed(1)}% tiles=${d.totalTiles}`);
  }

  console.log(`\n══════════════════════════════════════════════════════\n`);
}

function interpretR(r: number): string {
  const abs = Math.abs(r);
  if (abs >= 0.9) return '🔴 极强相关';
  if (abs >= 0.7) return '🟠 强相关';
  if (abs >= 0.5) return '🟡 中等相关';
  if (abs >= 0.3) return '🟢 弱相关';
  return '⚪ 几乎无相关';
}

function interpretR2(r2: number): string {
  if (r2 >= 0.8) return '  模型非常好地解释了在线胜率的方差';
  if (r2 >= 0.5) return '  模型较好地解释了在线胜率的方差';
  if (r2 >= 0.3) return '  模型有一定解释力，但存在较大偏差';
  if (r2 >= 0.1) return '  模型解释力较弱，其他因素影响较大';
  return '  模型几乎不能解释在线胜率，需考虑其他变量';
}

// ═══ Export detail CSV ═══
function exportDetailCSV(data: DataPoint[]): void {
  const header = [
    '关卡牌局代码', '地形编号', '开始次数', '净过关次数',
    '在线胜率(%)', '模拟胜率(%)', '差值(sim-online)', '绝对差值',
    '模拟胜利', '模拟失败', '模拟平均步数', '耗时ms', '地形总牌数',
  ].join(',');

  const lines = data.map(d => [
    d.replayKey, d.terrainId, d.starts, d.clears,
    d.onlineWR.toFixed(2), d.simWR.toFixed(2),
    (d.simWR - d.onlineWR).toFixed(2),
    Math.abs(d.simWR - d.onlineWR).toFixed(2),
    d.simWins, d.simLosses,
    d.simAvgSteps.toFixed(1),
    Math.round(d.elapsedMs), d.totalTiles,
  ].join(','));

  writeFileSync(join(OUTPUT_DIR, 'analysis_detail.csv'), [header, ...lines].join('\n'), 'utf-8');
  console.log(`📁 详细数据已导出: output/analysis_detail.csv`);
}

function exportSummaryJSON(r: AnalysisResult): void {
  // Remove massive data arrays for JSON
  const summary = {
    ...r,
    topOverestimates: r.topOverestimates.map(d => ({
      replayKey: d.replayKey, terrainId: d.terrainId, onlineWR: d.onlineWR,
      simWR: d.simWR, diff: d.simWR - d.onlineWR, totalTiles: d.totalTiles,
    })),
    topUnderestimates: r.topUnderestimates.map(d => ({
      replayKey: d.replayKey, terrainId: d.terrainId, onlineWR: d.onlineWR,
      simWR: d.simWR, diff: d.simWR - d.onlineWR, totalTiles: d.totalTiles,
    })),
  };
  writeFileSync(join(OUTPUT_DIR, 'analysis_summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
  console.log(`📁 结构化摘要已导出: output/analysis_summary.json`);
}

// ═══ Main ═══
function main() {
  if (!existsSync(CSV_INPUT)) {
    console.error(`❌ 找不到输入文件: ${CSV_INPUT}`);
    console.error('   请先运行 batch-sim.ts');
    process.exit(1);
  }

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('📖 加载模拟结果...');
  const data = loadData();
  console.log(`   加载了 ${data.length} 条数据`);

  if (data.length === 0) {
    console.error('❌ 无数据可分析');
    process.exit(1);
  }

  const result = analyze(data);
  printSummary(result);

  // Export
  exportDetailCSV(data);
  exportSummaryJSON(result);

  console.log('✅ 分析完成');
}

main();
