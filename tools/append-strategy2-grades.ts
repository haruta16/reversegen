#!/usr/bin/env npx tsx
/** Append Strategy 2 grading columns while preserving every original CSV column. */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeStrategy2, type SimResult, type SimSnapshot } from '../src/grader.js';

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

function simResult(winRate: number): SimResult {
  return { winRate, wins: 0, losses: 0, runs: 0, elapsedMs: 0 };
}

const input = absolute(arg('--input', 'output/失误率扫描_精选打点/原始数据.csv'));
const output = absolute(arg('--output', 'output/失误率扫描_精选打点_策略2分档.csv'));
if (!existsSync(input)) throw new Error(`Input not found: ${input}`);

const raw = readFileSync(input, 'utf8').replace(/^\uFEFF/, '');
const lines = raw.split(/\r?\n/).filter(line => line.length > 0);
if (lines.length < 2) throw new Error(`CSV has no data: ${input}`);

const header = parseLine(lines[0]);
const indexOf = (name: string): number => {
  const index = header.indexOf(name);
  if (index < 0) throw new Error(`Missing column: ${name}`);
  return index;
};
const sim1Index = indexOf('mistake_0.01');
const sim5Index = indexOf('mistake_0.05');
const sim15Index = indexOf('mistake_0.15');
const appendedHeaders = ['策略2估计通过率(%)', '策略2档位', '策略2标签', '策略2目标区间', '策略2公式'];
const outputLines = [`${lines[0]},${appendedHeaders.join(',')}`];
const gradeCounts = new Map<number, number>();

for (let rowIndex = 1; rowIndex < lines.length; rowIndex++) {
  const cells = parseLine(lines[rowIndex]);
  const rates = [sim1Index, sim5Index, sim15Index].map(index => Number(cells[index]) / 100);
  if (rates.some(rate => !Number.isFinite(rate))) {
    throw new Error(`Invalid sim rate at CSV row ${rowIndex + 1}`);
  }
  const snapshot: SimSnapshot = {
    sim1: simResult(rates[0]),
    sim5: simResult(rates[1]),
    sim15: simResult(rates[2]),
  };
  const result = gradeStrategy2(snapshot);
  gradeCounts.set(result.grade, (gradeCounts.get(result.grade) ?? 0) + 1);
  const appended = [
    ((result.passrate ?? 0) * 100).toFixed(2),
    result.grade,
    result.label,
    result.targetRate,
    result.formula,
  ].map(csvCell);
  outputLines.push(`${lines[rowIndex]},${appended.join(',')}`);
}

writeFileSync(output, `\uFEFF${outputLines.join('\n')}\n`, 'utf8');
console.log(`rows: ${lines.length - 1}`);
console.log(`grades: ${[0, 1, 2, 3, 4, 5].map(grade => `G${grade}=${gradeCounts.get(grade) ?? 0}`).join(' ')}`);
console.log(`written: ${output}`);
