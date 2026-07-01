#!/usr/bin/env npx tsx
/**
 * Analyze how selected simulation win-rate columns separate online win-rate.
 *
 * Usage:
 *   npx tsx tools/analyze-sim-separation.ts
 *   npx tsx tools/analyze-sim-separation.ts --columns mistake_0.01,mistake_0.03,mistake_0.05 --bucket-size 10
 *   npx tsx tools/analyze-sim-separation.ts --input output/失误率扫描_精选打点/原始数据.csv --output output/失误率扫描_精选打点/sim分离分析
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

interface Options {
  input: string;
  output: string | null;
  columns: string[];
  onlineColumn: string | null;
  bucketSize: number;
  onlineBucketSize: number;
}

interface Row {
  cells: string[];
}

interface CsvData {
  header: string[];
  rows: Row[];
}

interface BucketStats {
  metric: string;
  bucket: string;
  count: number;
  ratio: number;
  metricMean: number;
  onlineMean: number;
  onlineMedian: number;
  onlineP25: number;
  onlineP75: number;
  onlineLe20: number;
  onlineGe80: number;
  tileMean: number | null;
}

const args = process.argv.slice(2);

function readArg(name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args[index + 1] ?? null;
}

function parseOptions(): Options {
  const inputArg = readArg('--input') ?? 'output/失误率扫描_精选打点/原始数据.csv';
  const outputArg = readArg('--output');
  const columnsArg = readArg('--columns') ?? 'mistake_0.01,mistake_0.03,mistake_0.05';
  const bucketSize = Number(readArg('--bucket-size') ?? 10);
  const onlineBucketSize = Number(readArg('--online-bucket-size') ?? 20);

  if (!Number.isFinite(bucketSize) || bucketSize <= 0 || bucketSize > 100) {
    throw new Error(`Invalid --bucket-size: ${bucketSize}`);
  }
  if (!Number.isFinite(onlineBucketSize) || onlineBucketSize <= 0 || onlineBucketSize > 100) {
    throw new Error(`Invalid --online-bucket-size: ${onlineBucketSize}`);
  }

  const input = resolveInput(inputArg);
  const output = outputArg ? resolvePath(outputArg) : null;
  const columns = columnsArg.split(',').map(s => s.trim()).filter(Boolean);
  if (columns.length === 0) throw new Error('No columns selected');

  return {
    input,
    output,
    columns,
    onlineColumn: readArg('--online-column'),
    bucketSize,
    onlineBucketSize,
  };
}

function resolvePath(p: string): string {
  return isAbsolute(p) ? p : resolve(REPO_ROOT, p);
}

function resolveInput(inputArg: string): string {
  const direct = resolvePath(inputArg);
  if (existsSync(direct)) {
    if (extname(direct).toLowerCase() === '.csv') return direct;
    return join(direct, '原始数据.csv');
  }

  const outputRelative = resolve(REPO_ROOT, 'output', inputArg);
  if (existsSync(outputRelative)) {
    if (extname(outputRelative).toLowerCase() === '.csv') return outputRelative;
    return join(outputRelative, '原始数据.csv');
  }

  return direct;
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

function escapeCSVCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCSV(file: string, rows: unknown[][]): void {
  writeFileSync(file, rows.map(row => row.map(escapeCSVCell).join(',')).join('\n') + '\n');
}

function loadCSV(file: string): CsvData {
  const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 2) throw new Error(`CSV has no data rows: ${file}`);
  const header = parseCSVLine(lines[0]).map(h => h.trim());
  const rows = lines.slice(1)
    .map(line => ({ cells: parseCSVLine(line) }))
    .filter(row => row.cells.length >= header.length);
  return { header, rows };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - index) + sorted[hi] * (index - lo);
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

function toNumber(value: string | undefined): number {
  const n = Number(value ?? '');
  return Number.isFinite(n) ? n : NaN;
}

function formatPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function metricBucket(value: number, bucketSize: number): string {
  if (value === 0) return '0';
  if (value === 100) return '100';
  const lo = Math.floor(value / bucketSize) * bucketSize;
  const hi = Math.min(100, lo + bucketSize);
  return `${lo}-${hi}`;
}

function onlineBucket(value: number, bucketSize: number): string {
  const lo = Math.min(100 - bucketSize, Math.floor(value / bucketSize) * bucketSize);
  const hi = Math.min(100, lo + bucketSize);
  return `${lo}-${hi}`;
}

function bucketSortKey(label: string): number {
  if (label === '0') return -1;
  if (label === '100') return 100;
  return Number(label.split('-')[0]);
}

function getIndex(header: string[], name: string): number {
  const index = header.indexOf(name);
  if (index < 0) throw new Error(`Missing column: ${name}`);
  return index;
}

function pickOnlineColumn(header: string[], preferred: string | null): string {
  if (preferred) {
    if (!header.includes(preferred)) throw new Error(`Missing online column: ${preferred}`);
    return preferred;
  }
  for (const name of ['净胜率(%)', '在线胜率(%)']) {
    if (header.includes(name)) return name;
  }
  throw new Error('Missing online column: 净胜率(%) or 在线胜率(%)');
}

function buildBucketStats(
  metric: string,
  rows: Row[],
  header: string[],
  onlineColumn: string,
  bucketSize: number,
): BucketStats[] {
  const metricIndex = getIndex(header, metric);
  const onlineIndex = getIndex(header, onlineColumn);
  const tileIndex = header.indexOf('地形总牌数');
  const groups = new Map<string, Row[]>();

  for (const row of rows) {
    const value = toNumber(row.cells[metricIndex]);
    const online = toNumber(row.cells[onlineIndex]);
    if (!Number.isFinite(value) || !Number.isFinite(online)) continue;
    const label = metricBucket(value, bucketSize);
    const group = groups.get(label) ?? [];
    group.push(row);
    groups.set(label, group);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => bucketSortKey(a) - bucketSortKey(b))
    .map(([bucket, group]) => {
      const metricValues = group.map(row => toNumber(row.cells[metricIndex])).filter(Number.isFinite);
      const onlineValues = group.map(row => toNumber(row.cells[onlineIndex])).filter(Number.isFinite);
      const tileValues = tileIndex >= 0
        ? group.map(row => toNumber(row.cells[tileIndex])).filter(Number.isFinite)
        : [];
      return {
        metric,
        bucket,
        count: group.length,
        ratio: group.length / rows.length,
        metricMean: mean(metricValues),
        onlineMean: mean(onlineValues),
        onlineMedian: median(onlineValues),
        onlineP25: percentile(onlineValues, 0.25),
        onlineP75: percentile(onlineValues, 0.75),
        onlineLe20: onlineValues.filter(value => value <= 20).length,
        onlineGe80: onlineValues.filter(value => value >= 80).length,
        tileMean: tileValues.length > 0 ? mean(tileValues) : null,
      };
    });
}

function buildCoarseStats(
  metric: string,
  rows: Row[],
  header: string[],
  onlineColumn: string,
): BucketStats[] {
  const metricIndex = getIndex(header, metric);
  const onlineIndex = getIndex(header, onlineColumn);
  const tileIndex = header.indexOf('地形总牌数');
  const groups = new Map<string, Row[]>();
  const labelFor = (value: number) => {
    if (value === 0) return `${metric}=0`;
    if (value === 100) return `${metric}=100`;
    return `0<${metric}<100`;
  };

  for (const row of rows) {
    const value = toNumber(row.cells[metricIndex]);
    const online = toNumber(row.cells[onlineIndex]);
    if (!Number.isFinite(value) || !Number.isFinite(online)) continue;
    const label = labelFor(value);
    const group = groups.get(label) ?? [];
    group.push(row);
    groups.set(label, group);
  }

  const order = [`${metric}=0`, `0<${metric}<100`, `${metric}=100`];
  return order
    .filter(label => groups.has(label))
    .map(label => {
      const group = groups.get(label)!;
      const metricValues = group.map(row => toNumber(row.cells[metricIndex])).filter(Number.isFinite);
      const onlineValues = group.map(row => toNumber(row.cells[onlineIndex])).filter(Number.isFinite);
      const tileValues = tileIndex >= 0
        ? group.map(row => toNumber(row.cells[tileIndex])).filter(Number.isFinite)
        : [];
      return {
        metric,
        bucket: label,
        count: group.length,
        ratio: group.length / rows.length,
        metricMean: mean(metricValues),
        onlineMean: mean(onlineValues),
        onlineMedian: median(onlineValues),
        onlineP25: percentile(onlineValues, 0.25),
        onlineP75: percentile(onlineValues, 0.75),
        onlineLe20: onlineValues.filter(value => value <= 20).length,
        onlineGe80: onlineValues.filter(value => value >= 80).length,
        tileMean: tileValues.length > 0 ? mean(tileValues) : null,
      };
    });
}

function buildCrossRows(
  metric: string,
  rows: Row[],
  header: string[],
  onlineColumn: string,
  bucketSize: number,
  onlineBucketSize: number,
): unknown[][] {
  const metricIndex = getIndex(header, metric);
  const onlineIndex = getIndex(header, onlineColumn);
  const metricLabels = [...new Set(rows
    .map(row => toNumber(row.cells[metricIndex]))
    .filter(Number.isFinite)
    .map(value => metricBucket(value, bucketSize)))]
    .sort((a, b) => bucketSortKey(a) - bucketSortKey(b));
  const onlineLabels = [...new Set(rows
    .map(row => toNumber(row.cells[onlineIndex]))
    .filter(Number.isFinite)
    .map(value => onlineBucket(value, onlineBucketSize)))]
    .sort((a, b) => bucketSortKey(a) - bucketSortKey(b));

  const table = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const metricValue = toNumber(row.cells[metricIndex]);
    const onlineValue = toNumber(row.cells[onlineIndex]);
    if (!Number.isFinite(metricValue) || !Number.isFinite(onlineValue)) continue;
    const metricLabel = metricBucket(metricValue, bucketSize);
    const onlineLabel = onlineBucket(onlineValue, onlineBucketSize);
    const line = table.get(metricLabel) ?? new Map<string, number>();
    line.set(onlineLabel, (line.get(onlineLabel) ?? 0) + 1);
    table.set(metricLabel, line);
  }

  return [
    ['metric', 'metricBucket', ...onlineLabels],
    ...metricLabels.map(metricLabel => [
      metric,
      metricLabel,
      ...onlineLabels.map(onlineLabel => table.get(metricLabel)?.get(onlineLabel) ?? 0),
    ]),
  ];
}

function statsToRows(stats: BucketStats[]): unknown[][] {
  return [
    ['metric', 'bucket', 'count', 'ratio', 'metricMean', 'onlineMean', 'onlineMedian', 'onlineP25', 'onlineP75', 'online<=20', 'online>=80', 'tileMean'],
    ...stats.map(row => [
      row.metric,
      row.bucket,
      row.count,
      (row.ratio * 100).toFixed(2),
      row.metricMean.toFixed(2),
      row.onlineMean.toFixed(2),
      row.onlineMedian.toFixed(2),
      row.onlineP25.toFixed(2),
      row.onlineP75.toFixed(2),
      row.onlineLe20,
      row.onlineGe80,
      row.tileMean == null ? '' : row.tileMean.toFixed(2),
    ]),
  ];
}

function printStats(title: string, stats: BucketStats[]): void {
  console.log(`\n${title}`);
  console.log('bucket,count,ratio,simMean,onlineMean,onlineMedian,onlineP25,onlineP75,online<=20,online>=80,tileMean');
  for (const row of stats) {
    console.log([
      row.bucket,
      row.count,
      formatPct(row.ratio * 100),
      row.metricMean.toFixed(1),
      row.onlineMean.toFixed(1),
      row.onlineMedian.toFixed(1),
      row.onlineP25.toFixed(1),
      row.onlineP75.toFixed(1),
      row.onlineLe20,
      row.onlineGe80,
      row.tileMean == null ? '' : row.tileMean.toFixed(1),
    ].join(','));
  }
}

function main(): void {
  const options = parseOptions();
  const data = loadCSV(options.input);
  const onlineColumn = pickOnlineColumn(data.header, options.onlineColumn);

  console.log(`input: ${options.input}`);
  console.log(`rows: ${data.rows.length}`);
  console.log(`online: ${onlineColumn}`);
  console.log(`columns: ${options.columns.join(', ')}`);

  const outputDir = options.output;
  if (outputDir) mkdirSync(outputDir, { recursive: true });

  const allBucketStats: BucketStats[] = [];
  const allCoarseStats: BucketStats[] = [];

  for (const metric of options.columns) {
    const bucketStats = buildBucketStats(metric, data.rows, data.header, onlineColumn, options.bucketSize);
    const coarseStats = buildCoarseStats(metric, data.rows, data.header, onlineColumn);
    allBucketStats.push(...bucketStats);
    allCoarseStats.push(...coarseStats);

    printStats(`${metric} bucket separation`, bucketStats);
    printStats(`${metric} coarse separation`, coarseStats);

    if (outputDir) {
      writeCSV(join(outputDir, `${metric.replace(/[^\w.-]+/g, '_')}_分桶.csv`), statsToRows(bucketStats));
      writeCSV(join(outputDir, `${metric.replace(/[^\w.-]+/g, '_')}_粗分.csv`), statsToRows(coarseStats));
      writeCSV(
        join(outputDir, `${metric.replace(/[^\w.-]+/g, '_')}_交叉表.csv`),
        buildCrossRows(metric, data.rows, data.header, onlineColumn, options.bucketSize, options.onlineBucketSize),
      );
    }
  }

  if (outputDir) {
    writeCSV(join(outputDir, '全部分桶.csv'), statsToRows(allBucketStats));
    writeCSV(join(outputDir, '全部粗分.csv'), statsToRows(allCoarseStats));
    writeFileSync(join(outputDir, 'summary.json'), JSON.stringify({
      input: options.input,
      rows: data.rows.length,
      onlineColumn,
      columns: options.columns,
      bucketSize: options.bucketSize,
      onlineBucketSize: options.onlineBucketSize,
      bucketStats: allBucketStats,
      coarseStats: allCoarseStats,
    }, null, 2));
    console.log(`\nwritten: ${outputDir}`);
  }
}

main();
