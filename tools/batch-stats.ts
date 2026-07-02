#!/usr/bin/env npx tsx
/**
 * Progress report for a batch generation output CSV.
 *
 * Usage:
 *   npx tsx tools/batch-stats.ts --input output/batch.csv [--target 10] [--grades 1,2,3,4,5]
 *
 * Reads an existing batch CSV and prints per-terrain per-grade completion status.
 * Extracts targets from the file's command.sh if --run-dir is provided.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

interface StatsOptions {
  input: string;
  target: number;
  grades: number[];
  runDir?: string;
}

function parseArgs(argv: string[]): StatsOptions {
  const opts: StatsOptions = { input: '', target: 10, grades: [1, 2, 3, 4, 5] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--input' || arg === '-i') opts.input = next() ?? '';
    else if (arg === '--target' || arg === '-t') opts.target = Math.floor(Number(next() ?? '10'));
    else if (arg === '--grades' || arg === '-g') opts.grades = (next() ?? '1,2,3,4,5').split(',').map(Number).filter(Number.isInteger);
    else if (arg === '--run-dir' || arg === '-r') opts.runDir = next();
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
  }
  if (!opts.input && opts.runDir) {
    opts.input = join(opts.runDir, '01_generation', 'batch.csv');
  }
  if (!opts.input) throw new Error('请通过 --input 或 --run-dir 指定输入');
  if (!existsSync(opts.input)) throw new Error(`文件不存在: ${opts.input}`);
  return opts;
}

function printHelp(): void {
  console.log(`Usage:
  npx tsx tools/batch-stats.ts --input output/batch.csv [options]
  npx tsx tools/batch-stats.ts --run-dir output/generation_feature/runs/different_exp_1 [options]

Options:
  --input, -i <csv>    Input batch CSV. Required unless --run-dir is set.
  --run-dir, -r <dir>  Run directory (reads batch.csv from 01_generation/).
  --target, -t <n>     Target rows per grade per terrain. Default: 10.
  --grades, -g <list>  Comma-separated grades to check. Default: 1,2,3,4,5.
`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const text = readFileSync(opts.input, 'utf8').replace(/^[﻿﻿]/, '');
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    console.log(`文件为空或只有表头: ${opts.input}`);
    return;
  }

  const header = lines[0].split(',');
  const levelIdx = header.indexOf('levelResId');
  const gradeIdx = header.indexOf('grade');

  // Count per (level, grade)
  const counts = new Map<string, { level: string; grades: Record<number, number> }>();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const level = levelIdx >= 0 ? cols[levelIdx].trim() : '?';
    const grade = gradeIdx >= 0 ? Number(cols[gradeIdx]) : -1;
    if (!level) continue;

    let entry = counts.get(level);
    if (!entry) {
      entry = { level, grades: {} };
      for (const g of opts.grades) entry.grades[g] = 0;
      counts.set(level, entry);
    }
    if (opts.grades.includes(grade)) {
      entry.grades[grade] = (entry.grades[grade] ?? 0) + 1;
    }
  }

  // Print report
  const levels = [...counts.values()].sort((a, b) => a.level.localeCompare(b.level));
  const headers = ['地形', ...opts.grades.map(g => `G${g}`), '完成', '状态'];
  const colWidths = [8, ...opts.grades.map(() => 6), 5, 8];

  const pad = (s: string, w: number) => s.padStart(w);
  console.log(headers.map((h, i) => pad(h, colWidths[i])).join('  '));
  console.log('─'.repeat(colWidths.reduce((a, b) => a + b, 0) + (colWidths.length - 1) * 2));

  let fullComplete = 0;
  let partial = 0;
  let empty = 0;
  const gradeTotals: Record<number, { complete: number; partial: number; empty: number }> = {};
  for (const g of opts.grades) gradeTotals[g] = { complete: 0, partial: 0, empty: 0 };

  for (const entry of levels) {
    const row: string[] = [pad(entry.level, colWidths[0])];
    let completeCount = 0;
    let status = '';
    for (let gi = 0; gi < opts.grades.length; gi++) {
      const g = opts.grades[gi];
      const cnt = entry.grades[g] ?? 0;
      const target = opts.target;
      const mark = cnt >= target ? '✓' : cnt > 0 ? '○' : '✗';
      const display = cnt > target ? `${mark}${target}+` : `${mark}${cnt}`;
      row.push(pad(display, colWidths[gi + 1]));

      if (cnt >= target) {
        completeCount++;
        gradeTotals[g].complete++;
      } else if (cnt > 0) {
        gradeTotals[g].partial++;
      } else {
        gradeTotals[g].empty++;
      }
    }
    row.push(pad(`${completeCount}/${opts.grades.length}`, colWidths[opts.grades.length + 1]));

    if (completeCount === opts.grades.length) {
      status = '✓ 完成';
      fullComplete++;
    } else if (completeCount > 0) {
      status = '△ 部分';
      partial++;
    } else {
      status = '✗ 空';
      empty++;
    }
    row.push(pad(status, colWidths[opts.grades.length + 2]));

    console.log(row.join('  '));
  }

  // Summary
  console.log(`\n地形: ${levels.length} | 完成: ${fullComplete} | 部分: ${partial} | 空: ${empty}`);
  const totalNeeded = levels.length * opts.grades.length * opts.target;
  const totalHave = levels.reduce((sum, e) => sum + opts.grades.reduce((s, g) => s + Math.min(opts.target, e.grades[g] ?? 0), 0), 0);
  console.log(`命中: ${totalHave}/${totalNeeded} | 缺口: ${totalNeeded - totalHave}`);

  // Per-grade summary
  console.log(`\n各档位:`);
  for (const g of opts.grades) {
    const t = gradeTotals[g];
    console.log(`  G${g}: ✓${t.complete} ○${t.partial} ✗${t.empty}`);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
