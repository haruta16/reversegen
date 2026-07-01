#!/usr/bin/env npx tsx
/**
 * Generate grade samples with fixed color-count ranges (v3).
 *
 * G0: 8-10 colors,  G1: 10-11 colors,  G2: 12+ colors
 * Sim-verified before recording.
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

// ── Color-count ranges per grade ──────────────────────────────────

function ccRange(grade: number, maxCC: number): [number, number] {
  if (grade === 0) return [Math.min(8, maxCC), Math.min(10, maxCC)];
  if (grade === 1) return [Math.min(10, maxCC), Math.min(11, maxCC)];
  return [Math.min(12, maxCC), Math.min(Math.max(12, Math.floor(maxCC * 0.7)), maxCC)];
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

interface TargetJob {
  levelResId: string;
  terrainPath: string;
  targetGrade: number;
}

interface WorkerJob {
  levelResId: string;
  terrainPath: string;
  targetGrade: number;
  attempts: number;
  simRuns: number;
  ccMin: number;
  ccMax: number;
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
    output: 'output/分档样本_v3.csv',
    plan: 'output/分档样本_v3_计划.csv',
    status: 'output/分档样本_v3_状态.json',
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
      const v = Number(next());
      return Number.isFinite(v) ? v : fallback;
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
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  opts.concurrency = Math.max(1, Math.min(opts.concurrency, availableParallelism()));
  return opts;
}

function printHelp(): void {
  console.log(`Usage:
  npx tsx tools/generate-grade-samples-v3.ts --run --concurrency 5

Color-count ranges per grade:
  G0: 8-10   G1: 10-11   G2+: 12+

Options:
  --initial <csv>       --first-backfill <csv>    --latest-backfill <csv>
  --output <csv>        --plan <csv>              --status <json>
  --attempts <n>        --sim-runs <n>            --concurrency <n>
  --exclude-levels <list>   --resume   --run
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
      if (ch === '"') { if (source[i + 1] === '"') { cell += '"'; i++; } else { inQuotes = false; } }
      else { cell += ch; }
    } else if (ch === '"') { inQuotes = true; }
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && source[i + 1] === '\n') i++; finish(); }
    else { cell += ch; }
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
  coverage: Map<string, { terrainPath: string; grades: Set<number>; freeTiles: number }>,
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
    const cur = coverage.get(levelResId) ?? { terrainPath: terrainPath || '', grades: new Set<number>(), freeTiles: 0 };
    if (!cur.terrainPath && terrainPath) cur.terrainPath = terrainPath;
    cur.grades.add(grade);
    // grab freeTiles from LevelTags if available
    if (!cur.freeTiles && row.LevelTags) {
      const m = row.LevelTags.match(/ft=(\d+)/);
      if (m) cur.freeTiles = parseInt(m[1]);
    }
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
  const coverage = new Map<string, { terrainPath: string; grades: Set<number>; freeTiles: number }>();
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
        jobs.push({ levelResId, terrainPath: item.terrainPath, targetGrade: g });
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
  const headers = ['levelResId', 'terrainPath', 'targetGrade'];
  const lines = [headers.join(',')];
  for (const j of jobs) lines.push([j.levelResId, j.terrainPath, j.targetGrade].map(csvEscape).join(','));
  writeFileSync(path, `﻿${lines.join('\n')}\n`, 'utf8');
}

function ensureOutput(path: string, resume: boolean): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  if (!resume || !existsSync(path)) writeFileSync(path, `﻿${BATCH_CSV_HEADERS.join(',')}\n`, 'utf8');
}

function appendRow(path: string, row: BatchRow): void {
  appendFileSync(path, `${serializeBatchRow(row)}\n`, 'utf8');
}

function writeStatus(path: string, status: object): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
}

// ── Terrain free-tile cache ────────────────────────────────────────

const terrainCache = new Map<string, number>();
function getFreeTiles(terrainPath: string): number {
  if (terrainCache.has(terrainPath)) return terrainCache.get(terrainPath)!;
  const terrain = loadTerrainFromFile(terrainPath);
  const free = getAllTiles(terrain).filter(t => !t.isConst).length;
  terrainCache.set(terrainPath, free);
  return free;
}

// ── Parameter generation ───────────────────────────────────────────

function depthCount(terrain: TerrainData): number {
  const allTiles = getAllTiles(terrain);
  const free = allTiles.filter(t => !t.isConst);
  const dm = computeDependencyDepth(free, new Map(allTiles.map(t => [t.id, t])));
  return dm.size > 0 ? Math.max(...dm.values()) : 1;
}

function genParams(terrain: TerrainData, job: WorkerJob, rng: () => number): GenerationParams {
  const layers = Math.max(0, depthCount(terrain) - 1);
  const cc = job.ccMin + Math.floor(rng() * (job.ccMax - job.ccMin + 1));
  return {
    closeRates: Array.from({ length: layers }, () => rng()),
    colorCount: Math.max(1, cc),
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

function jobKey(j: TargetJob): string { return `${j.levelResId}_G${j.targetGrade}`; }

async function runJobs(jobs: TargetJob[], opts: Options): Promise<void> {
  let next = 0;
  let done = 0;
  let foundTotal = 0;
  const total = jobs.length;
  const lastDone: { key: string; attempts: number; found: boolean }[] = [];
  const state: Record<string, { attempts: number; maxAttempts: number; found: boolean; status: string }> = {};
  for (const j of jobs) state[jobKey(j)] = { attempts: 0, maxAttempts: opts.attemptsPerTarget, found: false, status: 'pending' };

  const update = () => {
    writeStatus(opts.status, {
      updatedAt: new Date().toISOString(),
      doneJobs: done, totalJobs: total, foundSamples: foundTotal,
      concurrency: opts.concurrency, state,
    });
    const time = new Date().toLocaleTimeString();
    const actives = Object.entries(state)
      .filter(([, s]) => s.status === 'running')
      .map(([key, s]) => ({ key, ...s }));
    // single-line status
    const pct = total > 0 ? Math.round(done / total * 100) : 0;
    let line = `[${time}] ${done}/${total} (${pct}%) | found ${foundTotal} | active ${actives.length}`;
    // up to 3 active job labels
    const labels = actives.slice(0, 3).map(a => {
      const [lid, g] = a.key.split('_G');
      const p = a.maxAttempts > 0 ? Math.round(a.attempts / a.maxAttempts * 100) : 0;
      return `${lid}_G${g} ${p}%`;
    });
    if (labels.length > 0) line += ' | ' + labels.join(' ');
    // last completed
    if (lastDone.length > 0) {
      const d = lastDone[lastDone.length - 1];
      const [lid, g] = d.key.split('_G');
      line += ` | last: ${lid}_G${g} ${d.found ? '✓' : '✗'}`;
    }
    process.stdout.write(`\r\x1b[K${line}`);
  };

  const script = fileURLToPath(import.meta.url);
  const runOne = (job: TargetJob): Promise<void> => new Promise((res, rej) => {
    const key = jobKey(job);
    const ft = getFreeTiles(job.terrainPath);
    const maxCC = Math.floor(ft / 3);
    const [cMin, cMax] = ccRange(job.targetGrade, maxCC);
    const wJob: WorkerJob = {
      levelResId: job.levelResId,
      terrainPath: job.terrainPath,
      targetGrade: job.targetGrade,
      attempts: opts.attemptsPerTarget,
      simRuns: opts.simRuns,
      ccMin: cMin,
      ccMax: cMax,
      seedBase: (Date.now() + Number(job.levelResId) * 7919 + job.targetGrade * 131) & 0x7fffffff,
    };
    state[key].maxAttempts = opts.attemptsPerTarget;
    state[key].status = 'running';
    const child = fork(script, ['--worker'], {
      execArgv: process.execArgv.filter(a => !['--eval', '-e', '--print', '-p'].includes(a)),
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    child.on('message', (msg: WorkerMessage) => {
      const s = state[key];
      if (msg.type === 'found') {
        appendRow(opts.output, msg.row);
        s.attempts = msg.attempts; s.found = true; foundTotal++; update();
      } else if (msg.type === 'progress') {
        s.attempts = msg.attempts; update();
      } else if (msg.type === 'done') {
        s.attempts = msg.attempts; s.found = msg.found;
        s.status = msg.found ? 'done' : 'not_found';
        lastDone.push({ key, attempts: msg.attempts, found: msg.found });
        if (lastDone.length > 10) lastDone.shift();
        done++; update();
      } else if (msg.type === 'error') {
        s.status = 'error'; rej(new Error(msg.error));
      }
    });
    child.on('error', rej);
    child.on('exit', code => {
      if (code === 0) res();
      else rej(new Error(`worker ${key} exit ${code}`));
    });
    child.send(wJob);
  });

  const workers = Array.from({ length: Math.min(opts.concurrency, jobs.length) }, async () => {
    while (next < jobs.length) await runOne(jobs[next++]);
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
  console.log(`花色范围: G0=8-10, G1=10-11, G2+=12+`);
  if (!opts.run) { console.log('plan-only。执行时加 --run'); return; }
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
