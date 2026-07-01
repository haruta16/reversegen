#!/usr/bin/env npx tsx
/** Summarize online and simulation win rates into fixed percentage buckets. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function arg(name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
}

function absolute(path: string): string {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

function parseLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      cells.push(cell);
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const input = absolute(arg('--input', 'output/失误率扫描_精选打点/原始数据.csv'));
const output = absolute(arg('--output', 'output/失误率扫描_精选打点/全量分布统计.csv'));
const bucketSize = Number(arg('--bucket-size', '10'));
if (!existsSync(input)) throw new Error(`Input not found: ${input}`);
if (!Number.isFinite(bucketSize) || bucketSize <= 0 || bucketSize > 100 || 100 % bucketSize !== 0) {
  throw new Error(`--bucket-size must divide 100: ${bucketSize}`);
}

const lines = readFileSync(input, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
const header = parseLine(lines[0]);
const rows = lines.slice(1).map(parseLine).filter(row => row.length >= header.length);
const defaultColumns = [
  '净胜率(%)',
  'mistake_0.00', 'mistake_0.01', 'mistake_0.02', 'mistake_0.03', 'mistake_0.04',
  'mistake_0.05', 'mistake_0.07', 'mistake_0.10', 'mistake_0.15',
  'optimal_winRate', 'sim0_winRate', 'sim5_winRate',
];
const requested = arg('--columns', defaultColumns.join(',')).split(',').map(value => value.trim()).filter(Boolean);
const names: Record<string, string> = {
  '净胜率(%)': '线上通过率',
  'mistake_0.00': 'sim0',
  'mistake_0.01': 'sim1',
  'mistake_0.02': 'sim2',
  'mistake_0.03': 'sim3',
  'mistake_0.04': 'sim4',
  'mistake_0.05': 'sim5',
  'mistake_0.07': 'sim7',
  'mistake_0.10': 'sim10',
  'mistake_0.15': 'sim15',
  optimal_winRate: 'optimal打点',
  sim0_winRate: 'sim0打点',
  sim5_winRate: 'sim5打点',
};

const result: unknown[][] = [['指标', '原始列', '区间', '数量', '占比', '区间内均值']];
for (const column of requested) {
  const index = header.indexOf(column);
  if (index < 0) throw new Error(`Missing column: ${column}`);
  const values = rows.map(row => Number(row[index])).filter(value => Number.isFinite(value) && value >= 0 && value <= 100);
  for (let lower = 0; lower < 100; lower += bucketSize) {
    const upper = lower + bucketSize;
    const bucket = values.filter(value => value >= lower && (upper === 100 ? value <= upper : value < upper));
    const average = bucket.length ? bucket.reduce((sum, value) => sum + value, 0) / bucket.length : 0;
    result.push([
      names[column] ?? column,
      column,
      `${lower}-${upper}%`,
      bucket.length,
      values.length ? `${(bucket.length / values.length * 100).toFixed(2)}%` : '0.00%',
      average.toFixed(2),
    ]);
  }
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, result.map(row => row.map(csvCell).join(',')).join('\n') + '\n');
console.log(`rows: ${rows.length}`);
console.log(`written: ${output}`);
