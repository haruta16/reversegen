#!/usr/bin/env npx tsx
/**
 * Search one reference sample for still-missing lower grades (v2).
 *
 * Same coverage baseline as v1, but uses per-grade adaptive parameter
 * ranges so the random search targets each missing difficulty band.
 *
 * Grade → colorRatio range:
 *   G0  [0.25, 0.40]
 *   G1  [0.30, 0.50]
 *   G2+ [0.40, 0.60]
 *
 * Lower grades also get higher closeRates (easier boards).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import {
  BATCH_CSV_HEADERS,
  colorCountFromRatio,
  generateAndEvaluateOne,
  serializeBatchRow,
  type BatchRow,
  type GenerationParams,
} from '../src/batch-generator.js';
import {
  computeDependencyDepth,
  getAllTiles,
  loadTerrainFromFile,
  LogLevel,
  setLogLevel,
} from '../src/index.js';
import { mulberry32 } from '../src/random-utils.js';
import type { TerrainData } from '../src/types.js';

setLogLevel(LogLevel.Silent);

// ── Per-grade adaptive ranges ──────────────────────────────────────

interface GradeRange {
  colorRatioMin: number;
  colorRatioMax: number;
  closeRateMin: number;
  closeRateMax: number;
  minColorCount: number;
}

function gradeRange(grade: number): GradeRange {
  if (grade === 0) return { colorRatioMin: 0.25, colorRatioMax: 0.40, closeRateMin: 0.40, closeRateMax: 0.90, minColorCount: 8 };
  if (grade === 1) return { colorRatioMin: 0.30, colorRatioMax: 0.50, closeRateMin: 0.30, closeRateMax: 0.80, minColorCount: 8 };
  return { colorRatioMin: 0.40, colorRatioMax: 0.60, closeRateMin: 0.00, closeRateMax: 1.00, minColorCount: 8 };
}

// ── Types ──────────────────────────────────────────────────────────

interface Options {
  initial: string;
  firstBackfill: string;
  latestBackfill: string;
  output: string;
  plan: string;
  status: string;
  attemptsPerTarget: number;
  simRuns: number;
  concurrency: number;
  excludeLevels: Set<string>;
  resume: boolean;
  run: boolean;
}

interface CsvRow {
  [key: string]: string;
}

/** One search target: a specific terrain + a specific missing grade. */
interface TargetJob {
  levelResId: string;
  terrainPath: string;
  targetGrade: number;
  range: GradeRange;
}

interface WorkerJob {
  levelResId: string;
  terrainPath: string;
  targetGrade: number;
  attempts: number;
  simRuns: number;
  colorRatioMin: number;
  colorRatioMax: number;
  closeRateMin: number;
  closeRateMax: number;
  minColorCount: number;
  seedBase: number;
}

type WorkerMessage =
  | { type: 'progress'; levelResId: string; targetGrade: number; attempts: number }
  | { type: 'found'; levelResId: string; targetGrade: number; row: BatchRow; attempts: number }
  | { type: 'done'; levelResId: string; targetGrade: number; attempts: number; found: boolean }
  | { type: 'error'; levelResId: string; targetGrade: number; error: string };

// ── CLI ────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    initial: 'output/100003～100071_100073+_合并去少.csv',
    firstBackfill: 'output/无尽补缺生成.csv',
    latestBackfill: 'output/无尽补缺_G1G2_高闭合生成.csv',
    output: 'output/缺失档位样本_v2.csv',
    plan: 'output/缺失档位样本_v2_计划.csv',
    status: 'output/缺失档位样本_v2_状态.json',
    attemptsPerTarget: 300,
    simRuns: 100,
    concurrency: Math.max(1, Math.min(availableParallelism() - 1, 5)),
    excludeLevels: new Set(['100001', '100002']),
    resume: false,
    run: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? '';
    const num = (fallback: number) => {
      const value = Number(next());
      return Number.isFinite(value) ? value : fallback;
    };
    if (a === '--initial') opts.initial = next();
    else if (a === '--first-backfill') opts.firstBackfill = next();
    else if (a === '--latest-backfill') opts.latestBackfill = next();
    else if (a === '--output') opts.output = next();
    else if (a === '--plan') opts.plan = next();
    else if (a === '--status') opts.status = next();
    else if (a === '--attempts') opts.attemptsPerTarget = num(opts.attemptsPerTarget);
    else if (a === '--sim-runs') opts.simRuns = num(opts.simRuns);
    else if (a === '--concurrency') opts.concurrency = num(opts.concurrency);
    else if (a === '--exclude-levels') opts.excludeLevels = new Set(next().split(',').map(s => s.trim()).filter(Boolean));
    else if (a === '--resume') opts.resume = true;
    else if (a === '--run') opts.run = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  opts.concurrency = Math.max(1, Math.min(opts.concurrency, availableParallelism()));
  return opts;
}

function printHelp(): void {
  console.log(`Usage:
  npx tsx tools/search-missing-grade-samples-v2.ts --run --concurrency 5

Options:
  --initial <csv>             Initial generated CSV
  --first-backfill <csv>      First backfill CSV; grade 0 rows are ignored
  --latest-backfill <csv>     Latest backfill CSV
  --output <csv>              Found sample output CSV
  --plan <csv>                Search plan CSV
  --status <json>             Runtime status JSON
  --attempts <n>              Attempts per target (terrain×grade). Default: 300
  --sim-runs <n>              Strategy2 simulation runs. Default: 100
  --concurrency <n>           Parallel workers. Default: min(cpu-1, 5)
  --exclude-levels <list>     Excluded level IDs. Default: 100001,100002
  --resume                    Count existing output rows as found samples
  --run                       Execute search. Omit for plan-only

Per-grade colorRatio ranges:
  G0  [0.25, 0.40]   closeRates [0.40, 0.90]
  G1  [0.30, 0.50]   closeRates [0.30, 0.80]
  G2+ [0.40, 0.60]   closeRates [0.00, 1.00]
`);
}

// ── CSV utils ──────────────────────────────────────────────────────

function parseCsv(text: string): CsvRow[] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const finish = () => {
    row.push(cell);
    if (row.some(c => c !== '')) records.push(row);
    row = [];
    cell = '';
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') { cell += '"'; i++; }
        else { inQuotes = false; }
      } else { cell += ch; }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      finish();
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) finish();
  const headers = records[0] ?? [];
  return records.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

function readRows(path: string): CsvRow[] {
  if (!existsSync(path)) return [];
  return parseCsv(readFileSync(path, 'utf8'));
}

// ── Coverage ───────────────────────────────────────────────────────

function addCoverage(
  coverage: Map<string, { terrainPath: string; grades: Set<number> }>,
  path: string,
  excludeLevels: Set<string>,
  skipGrade0: boolean,
): void {
  for (const row of readRows(path)) {
    const levelResId = row.levelResId?.trim();
    if (!levelResId || excludeLevels.has(levelResId)) continue;
    const terrainPath = row.terrainPath?.trim();
    const grade = Number(row.grade);
    if (!Number.isInteger(grade) || grade < 0 || grade > 5) continue;
    if (skipGrade0 && grade === 0) continue;
    if (row.CompletionStatus && !row.CompletionStatus.startsWith('Success')) continue;
    const cur = coverage.get(levelResId) ?? { terrainPath: terrainPath || '', grades: new Set<number>() };
    if (!cur.terrainPath && terrainPath) cur.terrainPath = terrainPath;
    cur.grades.add(grade);
    coverage.set(levelResId, cur);
  }
}

function foundKeys(path: string, excludeLevels: Set<string>): Set<string> {
  const keys = new Set<string>();
  for (const row of readRows(path)) {
    const id = row.levelResId?.trim();
    const g = Number(row.grade);
    if (!id || excludeLevels.has(id)) continue;
    if (Number.isInteger(g) && g >= 0 && g <= 5) keys.add(`${id}_G${g}`);
  }
  return keys;
}

// ── Plan ───────────────────────────────────────────────────────────

function buildJobs(opts: Options): TargetJob[] {
  const coverage = new Map<string, { terrainPath: string; grades: Set<number> }>();
  addCoverage(coverage, opts.initial, opts.excludeLevels, false);
  addCoverage(coverage, opts.firstBackfill, opts.excludeLevels, true);
  addCoverage(coverage, opts.latestBackfill, opts.excludeLevels, false);
  const found = opts.resume ? foundKeys(opts.output, opts.excludeLevels) : new Set<string>();

  const jobs: TargetJob[] = [];
  for (const [levelResId, item] of coverage) {
    if (!item.terrainPath) continue;
    const existing = [...item.grades].sort((a, b) => a - b);
    if (existing.length === 0) continue;
    const maxGrade = Math.max(...existing);
    for (let g = 0; g <= maxGrade; g++) {
      if (!item.grades.has(g) && !found.has(`${levelResId}_G${g}`)) {
        jobs.push({ levelResId, terrainPath: item.terrainPath, targetGrade: g, range: gradeRange(g) });
      }
    }
  }
  return jobs.sort((a, b) => Number(a.levelResId) - Number(b.levelResId) || a.targetGrade - b.targetGrade);
}

// ── Output ─────────────────────────────────────────────────────────

function csvEscape(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writePlan(path: string, jobs: TargetJob[]): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const headers = ['levelResId', 'terrainPath', 'targetGrade', 'colorRatioMin', 'colorRatioMax', 'closeRateMin', 'closeRateMax'];
  const lines = [headers.join(',')];
  for (const j of jobs) {
    lines.push([j.levelResId, j.terrainPath, j.targetGrade, j.range.colorRatioMin, j.range.colorRatioMax, j.range.closeRateMin, j.range.closeRateMax].map(csvEscape).join(','));
  }
  writeFileSync(path, `﻿${lines.join('\n')}\n`, 'utf8');
}

function ensureOutput(path: string, resume: boolean): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  if (!resume || !existsSync(path)) {
    writeFileSync(path, `﻿${BATCH_CSV_HEADERS.join(',')}\n`, 'utf8');
  }
}

function appendRow(path: string, row: BatchRow): void {
  appendFileSync(path, `${serializeBatchRow(row)}\n`, 'utf8');
}

function writeStatus(path: string, status: object): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
}

// ── Parameter generation ───────────────────────────────────────────

function computeDepthCount(terrain: TerrainData): number {
  const allTiles = getAllTiles(terrain);
  const free = allTiles.filter(t => !t.isConst);
  const depthMap = computeDependencyDepth(free, new Map(allTiles.map(t => [t.id, t])));
  return depthMap.size > 0 ? Math.max(...depthMap.values()) : 1;
}

function genParams(terrain: TerrainData, job: WorkerJob, rng: () => number): GenerationParams {
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(t => !t.isConst).length;
  const depthLayers = Math.max(0, computeDepthCount(terrain) - 1);
  const ratio = job.colorRatioMin + rng() * (job.colorRatioMax - job.colorRatioMin);
  return {
    closeRates: Array.from({ length: depthLayers }, () =>
      job.closeRateMin + rng() * (job.closeRateMax - job.closeRateMin),
    ),
    colorCount: Math.max(job.minColorCount, colorCountFromRatio(ratio, freeTiles)),
    spreadParam: rng(),
    debtPersistenceWeight: 0,
  };
}

// ── Worker ─────────────────────────────────────────────────────────

function send(msg: WorkerMessage): void {
  if (process.send) process.send(msg);
}

async function runWorker(job: WorkerJob): Promise<void> {
  const terrain = loadTerrainFromFile(job.terrainPath);
  for (let attempt = 0; attempt < job.attempts; attempt++) {
    const seed = job.seedBase + attempt * 101;
    const rng = mulberry32(seed + 17);
    const params = genParams(terrain, job, rng);
    const row = generateAndEvaluateOne(terrain, params, 0, job.terrainPath, attempt + 1, false, job.simRuns, seed);

    if (row.success && row.grade === job.targetGrade) {
      send({ type: 'found', levelResId: job.levelResId, targetGrade: job.targetGrade, row, attempts: attempt + 1 });
      send({ type: 'done', levelResId: job.levelResId, targetGrade: job.targetGrade, attempts: attempt + 1, found: true });
      return;
    }
    if ((attempt + 1) % 50 === 0) {
      send({ type: 'progress', levelResId: job.levelResId, targetGrade: job.targetGrade, attempts: attempt + 1 });
    }
  }
  send({ type: 'done', levelResId: job.levelResId, targetGrade: job.targetGrade, attempts: job.attempts, found: false });
}

// ── Master ─────────────────────────────────────────────────────────

function jobKey(j: TargetJob): string {
  return `${j.levelResId}_G${j.targetGrade}`;
}

async function runJobs(jobs: TargetJob[], opts: Options): Promise<void> {
  let next = 0;
  let done = 0;
  let foundTotal = 0;
  let printedLines = 0;
  const total = jobs.length;
  const lastDone: { key: string; attempts: number; found: boolean }[] = [];
  const state: Record<string, { attempts: number; maxAttempts: number; found: boolean; status: string }> = {};
  for (const j of jobs) state[jobKey(j)] = { attempts: 0, maxAttempts: opts.attemptsPerTarget, found: false, status: 'pending' };

  const barStr = (cur: number, max: number, w: number) => {
    const p = max > 0 ? Math.min(1, cur / max) : 0;
    const fill = Math.round(p * w);
    return '█'.repeat(fill) + '░'.repeat(w - fill);
  };

  const update = () => {
    writeStatus(opts.status, {
      updatedAt: new Date().toISOString(),
      doneJobs: done,
      totalJobs: total,
      foundSamples: foundTotal,
      concurrency: opts.concurrency,
      state,
    });
    const time = new Date().toLocaleTimeString();
    const actives = Object.entries(state)
      .filter(([, s]) => s.status === 'running')
      .map(([key, s]) => ({ key, ...s }));

    if (printedLines > 0) {
      process.stdout.write(`\x1b[${printedLines}A\x1b[J`);
    }
    const lines: string[] = [];
    lines.push(`[${time}] ${done}/${total} jobs | found ${foundTotal} | active ${actives.length}`);
    for (const a of actives) {
      const [lid, g] = a.key.split('_G');
      const b = barStr(a.attempts, a.maxAttempts, 15);
      lines.push(`  ${lid} G${g} [${b}] ${a.attempts}/${a.maxAttempts}`);
    }
    for (const d of lastDone.slice(-5)) {
      const [lid, g] = d.key.split('_G');
      const mark = d.found ? '✓' : '✗';
      lines.push(`  ${lid} G${g} ${mark} ${d.attempts} tries`);
    }
    const output = lines.join('\n');
    process.stdout.write(output);
    printedLines = lines.length;
  };

  const script = fileURLToPath(import.meta.url);
  const runOne = (job: TargetJob): Promise<void> => new Promise((resolvePromise, reject) => {
    const key = jobKey(job);
    const wJob: WorkerJob = {
      levelResId: job.levelResId,
      terrainPath: job.terrainPath,
      targetGrade: job.targetGrade,
      attempts: opts.attemptsPerTarget,
      simRuns: opts.simRuns,
      colorRatioMin: job.range.colorRatioMin,
      colorRatioMax: job.range.colorRatioMax,
      closeRateMin: job.range.closeRateMin,
      closeRateMax: job.range.closeRateMax,
      minColorCount: job.range.minColorCount,
      seedBase: (Date.now() + Number(job.levelResId) * 7919 + job.targetGrade * 131) & 0x7fffffff,
    };
    state[key].status = 'running';
    const child = fork(script, ['--worker'], {
      execArgv: process.execArgv.filter(a => !['--eval', '-e', '--print', '-p'].includes(a)),
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    child.on('message', (msg: WorkerMessage) => {
      const s = state[key];
      if (msg.type === 'found') {
        appendRow(opts.output, msg.row);
        s.attempts = msg.attempts;
        s.found = true;
        foundTotal++;
        update();
      } else if (msg.type === 'progress') {
        s.attempts = msg.attempts;
        update();
      } else if (msg.type === 'done') {
        s.attempts = msg.attempts;
        s.found = msg.found;
        s.status = msg.found ? 'done' : 'not_found';
        lastDone.push({ key, attempts: msg.attempts, found: msg.found });
        if (lastDone.length > 10) lastDone.shift();
        done++;
        update();
      } else if (msg.type === 'error') {
        s.status = 'error';
        reject(new Error(msg.error));
      }
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolvePromise();
      else reject(new Error(`worker ${key} exit ${code}`));
    });
    child.send(wJob);
  });

  const workers = Array.from({ length: Math.min(opts.concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      await runOne(jobs[next++]);
    }
  });
  update();
  await Promise.all(workers);
  update();
  console.log('');
}

// ── Entry ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const jobs = buildJobs(opts);
  writePlan(opts.plan, jobs);
  console.log(`计划: ${opts.plan}`);
  console.log(`搜索目标: ${jobs.length} 个 (地形×档位)`);
  if (!opts.run) {
    console.log('plan-only。执行时加 --run');
    return;
  }
  ensureOutput(opts.output, opts.resume);
  await runJobs(jobs, opts);
  console.log(`完成。输出: ${opts.output}，状态: ${opts.status}`);
}

if (process.argv.includes('--worker')) {
  process.on('message', msg => {
    runWorker(msg as WorkerJob)
      .then(() => process.exit(0))
      .catch(err => {
        const j = msg as Partial<WorkerJob>;
        send({ type: 'error', levelResId: j.levelResId ?? '?', targetGrade: j.targetGrade ?? -1, error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
      });
  });
} else {
  main().catch(err => { console.error(err); process.exit(1); });
}
