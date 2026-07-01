#!/usr/bin/env npx tsx
/**
 * Full-dimension mistake-rate sweep analysis + calibration.
 *
 * Reads 原始数据.csv from the experiment folder and produces:
 *   1. 全局统计.csv    — mistakeRate vs MAE/RMSE/Pearson
 *   2. 区间明细.csv    — (interval × rate) full matrix with quantiles
 *   3. 校准查表.csv    — simWR bucket → onlineWR distribution
 *   4. 汇总.json       — structured results
 *   5. 分析报告.md      — readable report
 *
 * Usage:
 *   npx tsx tools/analyze-mistake-sweep.ts                        # defaults to output/
 *   npx tsx tools/analyze-mistake-sweep.ts --input 失误率扫描     # reads from output/失误率扫描/
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const inputArg = args.includes('--input')
  ? args[args.indexOf('--input') + 1]
  : null;
const BASE_OUTPUT = resolve(__dirname, '../output');
const OUTPUT_DIR = inputArg ? join(BASE_OUTPUT, inputArg) : BASE_OUTPUT;
const CSV_INPUT = join(OUTPUT_DIR, '原始数据.csv');

// ═══ Types ═══
interface LevelRow {
  replayKey: string;
  terrainId: string;
  onlineWR: number;
  simWRs: number[];       // 15 values, 0-100
}

interface GlobalStats {
  mistakeRate: number;
  mae: number;
  rmse: number;
  pearsonR: number;
  spearmanRho: number;
  bias: number;
  simMean: number;
  onlineMean: number;
  within5pct: number;
  within10pct: number;
}

interface IntervalStats {
  label: string;
  range: [number, number];
  count: number;
  onlineMean: number;
  simMeans: number[];
  maes: number[];
  bestIdx: number;
  bestMae: number;
}

interface IntervalDetailRow {
  intervalLabel: string;
  mistakeRate: number;
  count: number;
  onlineMean: number;
  onlineP10: number;
  onlineP25: number;
  onlineP50: number;
  onlineP75: number;
  onlineP90: number;
  simMean: number;
  simP10: number;
  simP25: number;
  simP50: number;
  simP75: number;
  simP90: number;
  bias: number;
  mae: number;
  rmse: number;
  within10pct: number;
  within10pctRatio: number;
  within20pct: number;
  within20pctRatio: number;
  overestimates: number;
  underestimates: number;
  roughlyMatch: number;
}

interface DiffDistRow {
  intervalLabel: string;
  mistakeRate: number;
  count: number;
  /** |diff| in [0,5)% */
  d0_5: number;
  /** |diff| in [5,10)% */
  d5_10: number;
  /** |diff| in [10,20)% */
  d10_20: number;
  /** |diff| in [20,30)% */
  d20_30: number;
  /** |diff| in [30,50)% */
  d30_50: number;
  /** |diff| >= 50% */
  d50p: number;
}

interface CalibrationRow {
  simBucket: string;
  simRange: [number, number];
  count: number;
  onlineMean: number;
  onlineMedian: number;
  onlineStd: number;
  onlineP5: number;
  onlineP10: number;
  onlineP25: number;
  onlineP75: number;
  onlineP90: number;
  onlineP95: number;
  ci80Width: number;
}

// ═══ Config ═══
let MISTAKE_RATES: number[] = [];

const INTERVALS: { label: string; range: [number, number] }[] = [
  { label: '0-10%', range: [0, 10] },
  { label: '10-20%', range: [10, 20] },
  { label: '20-30%', range: [20, 30] },
  { label: '30-40%', range: [30, 40] },
  { label: '40-50%', range: [40, 50] },
  { label: '50-60%', range: [50, 60] },
  { label: '60-70%', range: [60, 70] },
  { label: '70-80%', range: [70, 80] },
  { label: '80-90%', range: [80, 90] },
  { label: '90-100%', range: [90, 101] },
];

const SIM_BUCKETS: { label: string; range: [number, number] }[] = [
  { label: '0-10%', range: [0, 10] },
  { label: '10-20%', range: [10, 20] },
  { label: '20-30%', range: [20, 30] },
  { label: '30-40%', range: [30, 40] },
  { label: '40-50%', range: [40, 50] },
  { label: '50-60%', range: [50, 60] },
  { label: '60-70%', range: [60, 70] },
  { label: '70-80%', range: [70, 80] },
  { label: '80-90%', range: [80, 90] },
  { label: '90-100%', range: [90, 101] },
];

// ═══ Statistics helpers ═══
function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - idx) + sorted[hi] * (idx - lo);
}

function parseCSVLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuote = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === ',' && !inQuote) {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

function rateIndex(rate: number): number {
  return MISTAKE_RATES.findIndex(r => Math.abs(r - rate) < 0.000001);
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
  return sx === 0 || sy === 0 ? 0 : cov / Math.sqrt(sx * sy);
}

function spearmanRho(xs: number[], ys: number[]): number {
  const rank = (arr: number[]) => {
    const indexed = arr.map((v, i) => ({ v, i }));
    indexed.sort((a, b) => a.v - b.v);
    const ranks = new Array(arr.length);
    for (let i = 0; i < indexed.length; i++) ranks[indexed[i].i] = i + 1;
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

// ═══ Load data ═══
function loadData(): LevelRow[] {
  console.log(`Reading: ${CSV_INPUT}`);
  const raw = readFileSync(CSV_INPUT, 'utf-8').replace(/^\uFEFF/, '');
  const lines = raw.trim().split(/\r?\n/);
  if (lines.length < 2) {
    console.error('CSV is empty or has only header');
    process.exit(1);
  }

  const header = parseCSVLine(lines[0]).map(h => h.trim());
  const mistakeColumns = header
    .map((name, index) => {
      const m = /^mistake_(\d+(?:\.\d+)?)$/.exec(name);
      return m ? { index, rate: Number(m[1]) } : null;
    })
    .filter((item): item is { index: number; rate: number } => item != null)
    .sort((a, b) => a.rate - b.rate);

  if (mistakeColumns.length === 0) {
    console.error('Unexpected CSV format: no mistake_* columns found');
    process.exit(1);
  }
  MISTAKE_RATES = mistakeColumns.map(c => c.rate);

  const keyIndex = header.indexOf('关卡牌局代码');
  const terrainIndex = header.indexOf('地形编号');
  const onlineIndex = header.includes('在线胜率(%)')
    ? header.indexOf('在线胜率(%)')
    : header.indexOf('净胜率(%)');

  if (keyIndex < 0 || terrainIndex < 0 || onlineIndex < 0) {
    console.error('Unexpected CSV format: missing 关卡牌局代码/地形编号/在线胜率(%)');
    process.exit(1);
  }

  const rows: LevelRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = parseCSVLine(line);
    if (parts.length < header.length) continue;

    rows.push({
      replayKey: parts[keyIndex],
      terrainId: parts[terrainIndex],
      onlineWR: parseFloat(parts[onlineIndex]) || 0,
      simWRs: mistakeColumns.map(c => parseFloat(parts[c.index]) || 0),
    });
  }

  console.log(`  Loaded ${rows.length} levels`);
  console.log(`  Mistake rates: ${MISTAKE_RATES.map(r => `${(r * 100).toFixed(0)}%`).join(', ')}`);
  return rows;
}

// ═══ 1. Global analysis ═══
function computeGlobal(data: LevelRow[]): GlobalStats[] {
  const onlineWRs = data.map(d => d.onlineWR);

  return MISTAKE_RATES.map((rate, idx) => {
    const simWRs = data.map(d => d.simWRs[idx]);
    const diffs = simWRs.map((s, i) => s - onlineWRs[i]);
    const absDiffs = diffs.map(d => Math.abs(d));

    let within5 = 0, within10 = 0;
    for (const d of absDiffs) {
      if (d <= 5) within5++;
      if (d <= 10) within10++;
    }

    return {
      mistakeRate: rate,
      mae: mean(absDiffs),
      rmse: Math.sqrt(mean(diffs.map(d => d * d))),
      pearsonR: pearsonR(onlineWRs, simWRs),
      spearmanRho: spearmanRho(onlineWRs, simWRs),
      bias: mean(diffs),
      simMean: mean(simWRs),
      onlineMean: mean(onlineWRs),
      within5pct: within5,
      within10pct: within10,
    };
  });
}

// ═══ 2. Interval × Rate full detail matrix ═══
function computeIntervalDetails(data: LevelRow[]): IntervalDetailRow[] {
  const rows: IntervalDetailRow[] = [];

  for (const iv of INTERVALS) {
    const subset = data.filter(d => d.onlineWR >= iv.range[0] && d.onlineWR < iv.range[1]);

    if (subset.length < 3) continue;

    const ox = subset.map(d => d.onlineWR);
    const oxSorted = [...ox].sort((a, b) => a - b);

    for (let ri = 0; ri < MISTAKE_RATES.length; ri++) {
      const sx = subset.map(d => d.simWRs[ri]);
      const sxSorted = [...sx].sort((a, b) => a - b);
      const diffs = sx.map((s, i) => s - ox[i]);
      const absDiffs = diffs.map(d => Math.abs(d));

      let within10 = 0, within20 = 0, over = 0, under = 0, match = 0;
      for (const d of absDiffs) {
        if (d <= 10) within10++;
        if (d <= 20) within20++;
      }
      for (let i = 0; i < diffs.length; i++) {
        if (diffs[i] > 5) over++;
        else if (diffs[i] < -5) under++;
        else match++;
      }

      rows.push({
        intervalLabel: iv.label,
        mistakeRate: MISTAKE_RATES[ri],
        count: subset.length,
        onlineMean: mean(ox),
        onlineP10: percentile(oxSorted, 0.1),
        onlineP25: percentile(oxSorted, 0.25),
        onlineP50: percentile(oxSorted, 0.5),
        onlineP75: percentile(oxSorted, 0.75),
        onlineP90: percentile(oxSorted, 0.9),
        simMean: mean(sx),
        simP10: percentile(sxSorted, 0.1),
        simP25: percentile(sxSorted, 0.25),
        simP50: percentile(sxSorted, 0.5),
        simP75: percentile(sxSorted, 0.75),
        simP90: percentile(sxSorted, 0.9),
        bias: mean(diffs),
        mae: mean(absDiffs),
        rmse: Math.sqrt(mean(diffs.map(d => d * d))),
        within10pct: within10,
        within10pctRatio: within10 / subset.length,
        within20pct: within20,
        within20pctRatio: within20 / subset.length,
        overestimates: over,
        underestimates: under,
        roughlyMatch: match,
      });
    }
  }

  return rows;
}

// ═══ 2b. Diff distribution per interval × rate ═══
function computeDiffDistributions(data: LevelRow[], intervals: { label: string; range: [number, number] }[]): DiffDistRow[] {
  const rows: DiffDistRow[] = [];

  // Global row for each rate
  for (let ri = 0; ri < MISTAKE_RATES.length; ri++) {
    const diffs = data.map(d => Math.abs(d.simWRs[ri] - d.onlineWR));
    rows.push(buildDiffRow('全部关卡', MISTAKE_RATES[ri], diffs));
  }

  // Per-interval rows
  for (const iv of intervals) {
    const subset = data.filter(d => d.onlineWR >= iv.range[0] && d.onlineWR < iv.range[1]);
    if (subset.length < 3) continue;
    for (let ri = 0; ri < MISTAKE_RATES.length; ri++) {
      const diffs = subset.map(d => Math.abs(d.simWRs[ri] - d.onlineWR));
      rows.push(buildDiffRow(iv.label, MISTAKE_RATES[ri], diffs));
    }
  }

  return rows;
}

function buildDiffRow(label: string, rate: number, diffs: number[]): DiffDistRow {
  let d0_5 = 0, d5_10 = 0, d10_20 = 0, d20_30 = 0, d30_50 = 0, d50p = 0;
  for (const d of diffs) {
    if (d < 5) d0_5++;
    else if (d < 10) d5_10++;
    else if (d < 20) d10_20++;
    else if (d < 30) d20_30++;
    else if (d < 50) d30_50++;
    else d50p++;
  }
  return {
    intervalLabel: label,
    mistakeRate: rate,
    count: diffs.length,
    d0_5, d5_10, d10_20, d20_30, d30_50, d50p,
  };
}

// ═══ 3. Calibration lookup ═══
function computeCalibration(data: LevelRow[], bestRateIdx: number): CalibrationRow[] {
  const rows: CalibrationRow[] = [];

  for (const bucket of SIM_BUCKETS) {
    const subset = data.filter(d => {
      const s = d.simWRs[bestRateIdx];
      return s >= bucket.range[0] && s < bucket.range[1];
    });

    if (subset.length < 3) {
      rows.push({
        simBucket: bucket.label,
        simRange: bucket.range,
        count: subset.length,
        onlineMean: 0, onlineMedian: 0, onlineStd: 0,
        onlineP5: 0, onlineP10: 0, onlineP25: 0, onlineP75: 0, onlineP90: 0, onlineP95: 0,
        ci80Width: 0,
      });
      continue;
    }

    const ox = subset.map(d => d.onlineWR);
    const oxSorted = [...ox].sort((a, b) => a - b);
    const onlineMeanVal = mean(ox);
    const onlineStdVal = Math.sqrt(mean(ox.map(v => (v - onlineMeanVal) ** 2)));

    rows.push({
      simBucket: bucket.label,
      simRange: bucket.range,
      count: subset.length,
      onlineMean: onlineMeanVal,
      onlineMedian: percentile(oxSorted, 0.5),
      onlineStd: onlineStdVal,
      onlineP5: percentile(oxSorted, 0.05),
      onlineP10: percentile(oxSorted, 0.1),
      onlineP25: percentile(oxSorted, 0.25),
      onlineP75: percentile(oxSorted, 0.75),
      onlineP90: percentile(oxSorted, 0.9),
      onlineP95: percentile(oxSorted, 0.95),
      ci80Width: percentile(oxSorted, 0.9) - percentile(oxSorted, 0.1),
    });
  }

  return rows;
}

// ═══ Interval summary (existing, kept for report) ═══
function computeIntervals(data: LevelRow[]): IntervalStats[] {
  return INTERVALS.map(({ label, range }) => {
    const subset = data.filter(d => d.onlineWR >= range[0] && d.onlineWR < range[1]);

    if (subset.length < 3) {
      return { label, range, count: subset.length, onlineMean: 0,
        simMeans: MISTAKE_RATES.map(() => 0), maes: MISTAKE_RATES.map(() => 0), bestIdx: 0, bestMae: Infinity };
    }

    const ox = subset.map(d => d.onlineWR);
    const simMeans: number[] = [];
    const maes: number[] = [];

    for (let idx = 0; idx < MISTAKE_RATES.length; idx++) {
      const sx = subset.map(d => d.simWRs[idx]);
      simMeans.push(mean(sx));
      maes.push(mean(sx.map((s, i) => Math.abs(s - ox[i]))));
    }

    let bestIdx = 0, bestMae = Infinity;
    for (let i = 0; i < maes.length; i++) {
      if (maes[i] < bestMae) { bestMae = maes[i]; bestIdx = i; }
    }

    return { label, range, count: subset.length, onlineMean: mean(ox), simMeans, maes, bestIdx, bestMae };
  });
}

// ═══ Exports ═══

function exportGlobalCSV(stats: GlobalStats[], data: LevelRow[]): void {
  const header = [
    '失误率', 'MAE(%)', 'RMSE(%)', 'Pearson_r', 'Spearman_rho',
    '模拟均值(%)', '在线均值(%)', '偏差(%)',
    '|差|≤5%', '|差|≤5%占比', '|差|≤10%', '|差|≤10%占比',
  ].join(',');

  const lines = stats.map(s => [
    s.mistakeRate.toFixed(2),
    s.mae.toFixed(2), s.rmse.toFixed(2),
    s.pearsonR.toFixed(4), s.spearmanRho.toFixed(4),
    s.simMean.toFixed(2), s.onlineMean.toFixed(2), s.bias.toFixed(2),
    s.within5pct, ((s.within5pct / data.length) * 100).toFixed(1),
    s.within10pct, ((s.within10pct / data.length) * 100).toFixed(1),
  ].join(','));

  writeFileSync(join(OUTPUT_DIR, '全局统计.csv'), [header, ...lines].join('\n'), 'utf-8');
  console.log('Saved: 全局统计.csv');
}

function exportIntervalDetailCSV(details: IntervalDetailRow[]): void {
  const header = [
    '在线胜率区间', '失误率', '关卡数',
    '在线均值(%)', '在线P10', '在线P25', '在线P50', '在线P75', '在线P90',
    '模拟均值(%)', '模拟P10', '模拟P25', '模拟P50', '模拟P75', '模拟P90',
    '偏差(%)', 'MAE(%)', 'RMSE(%)',
    '|差|≤10%数', '|差|≤10%占比', '|差|≤20%数', '|差|≤20%占比',
    '高估数(>5%)', '低估数(<-5%)', '吻合数(|≤5%)',
  ].join(',');

  const lines = details.map(d => [
    d.intervalLabel, d.mistakeRate.toFixed(2), d.count,
    d.onlineMean.toFixed(1),
    d.onlineP10.toFixed(1), d.onlineP25.toFixed(1), d.onlineP50.toFixed(1),
    d.onlineP75.toFixed(1), d.onlineP90.toFixed(1),
    d.simMean.toFixed(1),
    d.simP10.toFixed(1), d.simP25.toFixed(1), d.simP50.toFixed(1),
    d.simP75.toFixed(1), d.simP90.toFixed(1),
    d.bias.toFixed(2), d.mae.toFixed(2), d.rmse.toFixed(2),
    d.within10pct, (d.within10pctRatio * 100).toFixed(1),
    d.within20pct, (d.within20pctRatio * 100).toFixed(1),
    d.overestimates, d.underestimates, d.roughlyMatch,
  ].join(','));

  writeFileSync(join(OUTPUT_DIR, '区间明细.csv'), [header, ...lines].join('\n'), 'utf-8');
  console.log(`Saved: 区间明细.csv (${lines.length} rows)`);
}

function exportCalibrationCSV(cal: CalibrationRow[]): void {
  const header = [
    'simWR桶', '关卡数',
    '在线均值(%)', '在线中位数(%)', '在线Std',
    'P5', 'P10', 'P25', 'P75', 'P90', 'P95',
    '80%CI宽度',
  ].join(',');

  const lines = cal.map(c => {
    if (c.count < 3) return [c.simBucket, c.count, ...Array(10).fill('-')].join(',');
    return [
      c.simBucket, c.count,
      c.onlineMean.toFixed(1), c.onlineMedian.toFixed(1), c.onlineStd.toFixed(1),
      c.onlineP5.toFixed(1), c.onlineP10.toFixed(1), c.onlineP25.toFixed(1),
      c.onlineP75.toFixed(1), c.onlineP90.toFixed(1), c.onlineP95.toFixed(1),
      c.ci80Width.toFixed(1),
    ].join(',');
  });

  writeFileSync(join(OUTPUT_DIR, '校准查表.csv'), [header, ...lines].join('\n'), 'utf-8');
  console.log('Saved: 校准查表.csv');
}

function exportSummaryJSON(
  globalStats: GlobalStats[], intervals: IntervalStats[],
  details: IntervalDetailRow[], cal: CalibrationRow[], data: LevelRow[],
  bestIdx: number,
): void {
  const summary = {
    dataCount: data.length,
    mistakeRates: MISTAKE_RATES,
    globalBest: {
      mistakeRate: MISTAKE_RATES[bestIdx],
      fullStats: globalStats[bestIdx],
    },
    allGlobalStats: globalStats,
    intervalBestSummary: intervals.filter(iv => iv.count >= 3).map(iv => ({
      label: iv.label, count: iv.count, onlineMean: iv.onlineMean,
      bestMistakeRate: MISTAKE_RATES[iv.bestIdx], bestMae: iv.bestMae,
      simAtBest: iv.simMeans[iv.bestIdx],
    })),
    calibration: cal,
    // Include a compact version of the detail matrix in JSON
    detailMatrixCompact: details.map(d => ({
      interval: d.intervalLabel,
      rate: d.mistakeRate,
      count: d.count,
      onlineMean: d.onlineMean,
      simMean: d.simMean,
      bias: d.bias,
      mae: d.mae,
      within10pctRatio: d.within10pctRatio,
    })),
  };

  writeFileSync(join(OUTPUT_DIR, '汇总.json'), JSON.stringify(summary, null, 2), 'utf-8');
  console.log('Saved: 汇总.json');
}

function exportDiffDistCSV(rows: DiffDistRow[]): void {
  const header = [
    '在线胜率区间', '失误率', '关卡数',
    '|差|0-5%', '|差|0-5%占比', '|差|5-10%', '|差|5-10%占比',
    '|差|10-20%', '|差|10-20%占比', '|差|20-30%', '|差|20-30%占比',
    '|差|30-50%', '|差|30-50%占比', '|差|>50%', '|差|>50%占比',
  ].join(',');

  const lines = rows.map(d => {
    const n = d.count || 1;
    return [
      d.intervalLabel, d.mistakeRate.toFixed(2), d.count,
      d.d0_5, (d.d0_5 / n * 100).toFixed(1),
      d.d5_10, (d.d5_10 / n * 100).toFixed(1),
      d.d10_20, (d.d10_20 / n * 100).toFixed(1),
      d.d20_30, (d.d20_30 / n * 100).toFixed(1),
      d.d30_50, (d.d30_50 / n * 100).toFixed(1),
      d.d50p, (d.d50p / n * 100).toFixed(1),
    ].join(',');
  });

  writeFileSync(join(OUTPUT_DIR, '差值分布.csv'), [header, ...lines].join('\n'), 'utf-8');
  console.log(`Saved: 差值分布.csv (${lines.length} rows)`);
}

// ═══ Report ═══
function generateReport(
  globalStats: GlobalStats[], intervals: IntervalStats[],
  cal: CalibrationRow[], data: LevelRow[], bestIdx: number,
  diffDists: DiffDistRow[],
): string {
  const best = globalStats[bestIdx];
  const total = data.length;
  const reportRates = [0, 0.01, 0.05, 0.10, 0.15]
    .map(rate => ({ rate, idx: rateIndex(rate) }))
    .filter(item => item.idx >= 0);
  let r = '';

  r += '# 失误率扫描全维度分析报告\n\n';
  r += `**数据量**: ${total} 个关卡  |  **最优失误率**: ${(best.mistakeRate * 100).toFixed(0)}%  |  **MAE**: ${best.mae.toFixed(2)}%\n\n`;

  // Section 1: Global
  r += '## 1. 全局统计\n\n';
  r += '| 失误率 | MAE(%) | RMSE(%) | Pearson r | Spearman ρ | 偏差(%) | ≤10%占比 |\n';
  r += '|--------|--------|---------|-----------|------------|---------|----------|\n';
  for (const s of globalStats) {
    const mark = MISTAKE_RATES.indexOf(s.mistakeRate) === bestIdx ? '**' : '';
    r += `| ${mark}${(s.mistakeRate * 100).toFixed(0)}%${mark} | ${s.mae.toFixed(2)} | ${s.rmse.toFixed(2)} | ${s.pearsonR.toFixed(4)} | ${s.spearmanRho.toFixed(4)} | ${s.bias > 0 ? '+' : ''}${s.bias.toFixed(2)} | ${((s.within10pct / total) * 100).toFixed(1)}% |\n`;
  }

  // Section 2: Interval summary
  r += '\n## 2. 在线胜率区间 × 最优失误率\n\n';
  r += `| 区间 | 关卡数 | 在线均值 | 最优Rate | MAE | sim(最优)${reportRates.map(item => ` | sim(${(item.rate * 100).toFixed(0)}%)`).join('')} |\n`;
  r += `|------|--------|----------|----------|-----|-----------${reportRates.map(() => '|---------').join('')}|\n`;
  for (const iv of intervals) {
    if (iv.count < 3) continue;
    r += `| ${iv.label} | ${iv.count} | ${iv.onlineMean.toFixed(1)}% | ${(MISTAKE_RATES[iv.bestIdx] * 100).toFixed(0)}% | ${iv.bestMae.toFixed(2)}% | ${iv.simMeans[iv.bestIdx].toFixed(1)}%${reportRates.map(item => ` | ${iv.simMeans[item.idx].toFixed(1)}%`).join('')} |\n`;
  }

  // Section 3: Calibration
  r += '\n## 3. 胜率校准查表\n\n';
  r += `> 以 **${(best.mistakeRate * 100).toFixed(0)}%** 失误率的 simWR 为索引。对新关卡：跑失误率扫描 → 查 simWR 所在桶 → 得到在线胜率预测区间。\n\n`;
  r += '| simWR桶 | 关卡数 | 在线均值 | 中位数 | P10 | P90 | 80%CI宽 |\n';
  r += '|---------|--------|----------|--------|-----|------|--------|\n';
  for (const c of cal) {
    if (c.count < 3) continue;
    r += `| ${c.simBucket} | ${c.count} | ${c.onlineMean.toFixed(1)}% | ${c.onlineMedian.toFixed(1)}% | ${c.onlineP10.toFixed(1)}% | ${c.onlineP90.toFixed(1)}% | ${c.ci80Width.toFixed(1)}% |\n`;
  }

  // Section 4: Key insights
  r += '\n## 4. 关键结论\n\n';

  // Bias crosses zero
  let zeroCross = -1;
  for (let i = 1; i < globalStats.length; i++) {
    if (globalStats[i - 1].bias > 0 && globalStats[i].bias <= 0) { zeroCross = i; break; }
    if (globalStats[i - 1].bias < 0 && globalStats[i].bias >= 0) { zeroCross = i; break; }
  }
  if (zeroCross > 0) {
    r += `- **偏差归零**: 约 ${(MISTAKE_RATES[zeroCross] * 100).toFixed(0)}% 失误率时偏差接近零，模拟与在线胜率均值一致\n`;
  }

  r += `- **MAE 改善**: 引入失误模型后，MAE 从纯 Player(~40%) 降至 **${best.mae.toFixed(2)}%**（${(best.mistakeRate * 100).toFixed(0)}% 失误率）\n`;

  // Interval trend
  const sortedIntervals = intervals.filter(iv => iv.count >= 3);
  if (sortedIntervals.length >= 2) {
    const first = sortedIntervals[0];
    const last = sortedIntervals[sortedIntervals.length - 1];
    if (MISTAKE_RATES[first.bestIdx] > MISTAKE_RATES[last.bestIdx]) {
      r += `- **难度与失误**: 困难关卡需要更高失误率（${(MISTAKE_RATES[first.bestIdx] * 100).toFixed(0)}% → ${(MISTAKE_RATES[last.bestIdx] * 100).toFixed(0)}%），符合"困难关卡玩家易失误"直觉\n`;
    }
  }

  // Calibration CI width pattern
  const calWithData = cal.filter(c => c.count >= 10);
  if (calWithData.length >= 2) {
    const mid = calWithData[Math.floor(calWithData.length / 2)];
    r += `- **预测不确定性**: 中等难度关卡（simWR≈${mid.simBucket}）的 80%CI 宽度约 ${mid.ci80Width.toFixed(0)}%，极端难度两端更窄\n`;
  }

  // ── Section 5: Global diff distribution per mistake rate ──
  r += '\n## 5. 全局绝对差值分布（分桶 + 累计）\n\n';
  r += '| 失误率 | 0~5% | 5~10% | 10~20% | 20~30% | 30~50% | >50% | ≤10%累计 | ≤20%累计 | ≤30%累计 | MAE |\n';
  r += '|--------|------|-------|--------|--------|--------|------|-----------|-----------|-----------|-----|\n';
  const globalDiffs = diffDists.filter(d => d.intervalLabel === '全部关卡');
  for (const d of globalDiffs) {
    const n = d.count;
    const cum10 = ((d.d0_5 + d.d5_10) / n * 100).toFixed(1);
    const cum20 = ((d.d0_5 + d.d5_10 + d.d10_20) / n * 100).toFixed(1);
    const cum30 = ((d.d0_5 + d.d5_10 + d.d10_20 + d.d20_30) / n * 100).toFixed(1);
    const mark = d.mistakeRate === best.mistakeRate ? '**' : '';
    r += `| ${mark}${(d.mistakeRate * 100).toFixed(0)}%${mark} | ${(d.d0_5 / n * 100).toFixed(1)}% | ${(d.d5_10 / n * 100).toFixed(1)}% | ${(d.d10_20 / n * 100).toFixed(1)}% | ${(d.d20_30 / n * 100).toFixed(1)}% | ${(d.d30_50 / n * 100).toFixed(1)}% | ${(d.d50p / n * 100).toFixed(1)}% | ${cum10}% | ${cum20}% | ${cum30}% | ${(globalStats.find(s => s.mistakeRate === d.mistakeRate)?.mae.toFixed(2) || '-')}% |\n`;
  }

  // ── Section 6: Per-interval diff distribution at best rate ──
  r += `\n## 6. 各在线胜率区间在最优失误率(${(best.mistakeRate * 100).toFixed(0)}%)下的差值分布\n\n`;
  r += '| 区间 | 关卡数 | 0~5% | 5~10% | 10~20% | 20~30% | 30~50% | >50% | ≤10%累计 | ≤20%累计 | ≤30%累计 |\n';
  r += '|------|--------|------|-------|--------|--------|--------|------|-----------|-----------|----------|\n';
  for (const iv of intervals) {
    const d = diffDists.find(dd => dd.intervalLabel === iv.label && dd.mistakeRate === best.mistakeRate);
    if (!d || d.count < 3) continue;
    const n = d.count;
    const cum10 = ((d.d0_5 + d.d5_10) / n * 100).toFixed(1);
    const cum20 = ((d.d0_5 + d.d5_10 + d.d10_20) / n * 100).toFixed(1);
    const cum30 = ((d.d0_5 + d.d5_10 + d.d10_20 + d.d20_30) / n * 100).toFixed(1);
    r += `| ${iv.label} | ${d.count} | ${(d.d0_5 / n * 100).toFixed(1)}% | ${(d.d5_10 / n * 100).toFixed(1)}% | ${(d.d10_20 / n * 100).toFixed(1)}% | ${(d.d20_30 / n * 100).toFixed(1)}% | ${(d.d30_50 / n * 100).toFixed(1)}% | ${(d.d50p / n * 100).toFixed(1)}% | ${cum10}% | ${cum20}% | ${cum30}% |\n`;
  }

  // ── Section 7: Per-interval best rate diff summary ──
  r += '\n## 7. 各区间在其最优失误率下的差值汇总\n\n';
  r += '| 区间 | 最优Rate | MAE | ≤10%占比 | ≤20%占比 | >50%占比 |\n';
  r += '|------|----------|-----|----------|----------|----------|\n';
  for (const iv of intervals) {
    if (iv.count < 3) continue;
    const bestRate = MISTAKE_RATES[iv.bestIdx];
    const d = diffDists.find(dd => dd.intervalLabel === iv.label && dd.mistakeRate === bestRate);
    if (!d) continue;
    const n = d.count;
    r += `| ${iv.label} | ${(bestRate * 100).toFixed(0)}% | ${iv.bestMae.toFixed(2)}% | ${((d.d0_5 + d.d5_10) / n * 100).toFixed(1)}% | ${((d.d0_5 + d.d5_10 + d.d10_20) / n * 100).toFixed(1)}% | ${(d.d50p / n * 100).toFixed(1)}% |\n`;
  }

  return r;
}

// ═══ Console output ═══
function printSummary(globalStats: GlobalStats[], intervals: IntervalStats[], cal: CalibrationRow[], data: LevelRow[]): void {
  let bestIdx = 0, bestMae = Infinity;
  globalStats.forEach((s, i) => { if (s.mae < bestMae) { bestMae = s.mae; bestIdx = i; } });

  const total = data.length;
  const best = globalStats[bestIdx];

  console.log('\n══════════════════════════════════════════════════════');
  console.log('  失误率扫描全维度分析');
  console.log(`  关卡数: ${total}  |  最优失误率: ${(best.mistakeRate * 100).toFixed(0)}%  |  MAE: ${best.mae.toFixed(2)}%`);
  console.log('══════════════════════════════════════════════════════\n');

  // Global table
  console.log('── 全局统计 ──');
  console.log(`  ${'Rate'.padEnd(6)} ${'MAE'.padStart(7)} ${'RMSE'.padStart(7)} ${'r'.padStart(7)} ${'ρ'.padStart(7)} ${'Bias'.padStart(7)} ${'≤10%'.padStart(7)}`);
  for (const s of globalStats) {
    const mark = globalStats.indexOf(s) === bestIdx ? ' ★' : '  ';
    console.log(
      `${((s.mistakeRate * 100).toFixed(0) + '%').padEnd(6)} ` +
      `${s.mae.toFixed(2)}%`.padStart(7) +
      `${s.rmse.toFixed(2)}%`.padStart(7) +
      `${s.pearsonR.toFixed(3)}`.padStart(7) +
      `${s.spearmanRho.toFixed(3)}`.padStart(7) +
      `${(s.bias > 0 ? '+' : '') + s.bias.toFixed(1)}%`.padStart(7) +
      `${((s.within10pct / total) * 100).toFixed(0)}%`.padStart(7) +
      mark,
    );
  }

  // Interval summary
  console.log('\n── 在线胜率区间 × 最优失误率 ──');
  console.log(`  ${'区间'.padEnd(12)} ${'数量'.padStart(5)} ${'在线均值'.padStart(9)} ${'最优Rate'.padStart(9)} ${'MAE'.padStart(7)} ${'sim'.padStart(8)}`);
  for (const iv of intervals) {
    if (iv.count < 3) continue;
    console.log(
      `  ${iv.label.padEnd(12)} ${String(iv.count).padStart(5)} ` +
      `${iv.onlineMean.toFixed(1)}%`.padStart(9) +
      `${(MISTAKE_RATES[iv.bestIdx] * 100).toFixed(0)}%`.padStart(9) +
      `${iv.bestMae.toFixed(2)}%`.padStart(7) +
      `${iv.simMeans[iv.bestIdx].toFixed(1)}%`.padStart(8),
    );
  }

  // Calibration preview
  console.log('\n── 校准查表预览（simWR桶 → 在线胜率分布）──');
  console.log(`  ${'simWR桶'.padEnd(10)} ${'数量'.padStart(5)} ${'均值'.padStart(7)} ${'P10'.padStart(7)} ${'P90'.padStart(7)} ${'80%CI'.padStart(7)}`);
  for (const c of cal) {
    if (c.count < 3) continue;
    console.log(
      `  ${c.simBucket.padEnd(10)} ${String(c.count).padStart(5)} ` +
      `${c.onlineMean.toFixed(1)}%`.padStart(7) +
      `${c.onlineP10.toFixed(1)}%`.padStart(7) +
      `${c.onlineP90.toFixed(1)}%`.padStart(7) +
      `${c.ci80Width.toFixed(1)}%`.padStart(7),
    );
  }

  console.log('\n══════════════════════════════════════════════════════\n');
}

// ═══ Main ═══
function main() {
  if (!existsSync(CSV_INPUT)) {
    console.error(`Input not found: ${CSV_INPUT}`);
    console.error('Run the sweep first: npx tsx tools/batch-sim-all.ts --mistake-only --output <name>');
    process.exit(1);
  }

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  const data = loadData();
  if (data.length === 0) { console.error('No data to analyze'); process.exit(1); }

  // 1. Global
  const globalStats = computeGlobal(data);
  let bestIdx = 0, bestMae = Infinity;
  globalStats.forEach((s, i) => { if (s.mae < bestMae) { bestMae = s.mae; bestIdx = i; } });

  // 2. Interval detail
  const details = computeIntervalDetails(data);

  // 3. Interval summary
  const intervals = computeIntervals(data);

  // 4. Calibration
  const cal = computeCalibration(data, bestIdx);

  // 5. Diff distributions
  const diffDists = computeDiffDistributions(data, INTERVALS);

  // Console
  printSummary(globalStats, intervals, cal, data);

  // Exports
  exportGlobalCSV(globalStats, data);
  exportIntervalDetailCSV(details);
  exportCalibrationCSV(cal);
  exportDiffDistCSV(diffDists);
  exportSummaryJSON(globalStats, intervals, details, cal, data, bestIdx);

  const report = generateReport(globalStats, intervals, cal, data, bestIdx, diffDists);
  writeFileSync(join(OUTPUT_DIR, '分析报告.md'), report, 'utf-8');
  console.log('Saved: 分析报告.md');

  console.log('\nDone.');
}

main();
