#!/usr/bin/env npx tsx
/**
 * Headless batch board generation with plan/execute/resume support.
 *
 * Plan-only:
 *   npx tsx tools/run-batch-generation.ts --levels 100075,100074 --output output/batch.csv
 *
 * Execute:
 *   npx tsx tools/run-batch-generation.ts --levels 100075,100074 --output output/batch.csv --run
 *
 * Resume:
 *   npx tsx tools/run-batch-generation.ts --levels 100075,100074 --output output/batch.csv --run --resume
 */

import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fork } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LogLevel, setLogLevel, getAllTiles, loadTerrainFromFile } from '../src/index.js';
import {
  BATCH_CSV_HEADERS,
  generateAndEvaluateOne,
  serializeBatchRow,
  determineMaxGrade,
  collectGradesForTerrain,
  type BatchAcceptanceConfig,
  type NumericRange,
  type UnifiedParams,
  type ParamMode,
  type ParamModeStr,
  type BatchRow,
  type OptimalAcceptanceConfig,
} from '../src/batch-generator.js';
import type { TerrainData } from '../src/types.js';
import { mulberry32 } from '../src/random-utils.js';

setLogLevel(LogLevel.Silent);

// ── Types ──

interface Options {
  levelsDir: string;
  levels: string[];
  output: string;
  plan: string;
  status: string;
  closeRates: ParamModeStr;
  colorCount: ParamMode;
  colorCountRatio: number;
  spreadParam: ParamMode;
  debtPersistenceWeight: ParamMode;
  simRuns: number;
  targetPerTier: number;
  maxAttempts: number;
  concurrency: number;
  targetGrades: number[];
  closeRateRange?: NumericRange;
  colorRatioRange?: NumericRange;
  colorJitter: number;
  spreadRange?: NumericRange;
  debtRange?: NumericRange;
  colorAllocationMode: 'balanced' | 'single-heavy';
  acceptance: BatchAcceptanceConfig;
  resume: boolean;
  run: boolean;
}

interface TerrainPlan {
  levelResId: string;
  terrainPath: string;
  existing: Record<number, number>;
  needed: Record<number, number>;
  totalNeeded: number;
}

interface TerrainJob {
  jobId: string;
  levelResId: string;
  terrainPath: string;
  targetNeeds: Record<number, number>;
  maxAttempts: number;
  unified: UnifiedParams;
  simRuns: number;
  acceptance: BatchAcceptanceConfig;
  seedBase: number;
}

interface JobStatus {
  levelResId: string;
  targetNeeds: Record<number, number>;
  foundByGrade: Record<number, number>;
  needed: number;
  found: number;
  attempts: number;
  status: 'pending' | 'running' | 'done' | 'partial' | 'error';
}

// ── Parse args ──

function parseNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseMode(value: string | undefined, fallback: ParamMode): ParamMode {
  if (value == null || value === '') return fallback;
  if (value === 'random') return 'random';
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseModeStr(value: string | undefined, fallback: ParamModeStr): ParamModeStr {
  if (value == null || value === '') return fallback;
  return value === 'random' ? 'random' : value;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    levelsDir: join(process.cwd(), '..', 'TileMatchShell', 'Tools', 'Config', 'Json', 'Levels'),
    levels: [],
    output: 'output/batch生成.csv',
    plan: '',
    status: '',
    closeRates: 'random',
    colorCount: 'random',
    colorCountRatio: 0.6,
    spreadParam: 'random',
    debtPersistenceWeight: 'random',
    simRuns: 200,
    targetPerTier: 10,
    maxAttempts: 500,
    concurrency: 2,
    targetGrades: [],
    colorJitter: 0,
    colorAllocationMode: 'balanced',
    acceptance: {},
    resume: false,
    run: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--levels-dir') opts.levelsDir = next() ?? opts.levelsDir;
    else if (arg === '--levels') opts.levels = (next() ?? '').split(',').map(s => s.trim()).filter(Boolean);
    else if (arg === '--output') opts.output = next() ?? opts.output;
    else if (arg === '--plan') opts.plan = next() ?? '';
    else if (arg === '--status') opts.status = next() ?? '';
    else if (arg === '--close-rates') opts.closeRates = parseModeStr(next(), opts.closeRates);
    else if (arg === '--color-count') opts.colorCount = parseMode(next(), opts.colorCount);
    else if (arg === '--color-ratio') opts.colorCountRatio = parseNumber(next(), opts.colorCountRatio);
    else if (arg === '--spread') opts.spreadParam = parseMode(next(), opts.spreadParam);
    else if (arg === '--debt') opts.debtPersistenceWeight = parseMode(next(), opts.debtPersistenceWeight);
    else if (arg === '--sim-runs') opts.simRuns = Math.floor(parseNumber(next(), opts.simRuns));
    else if (arg === '--target-per-tier') opts.targetPerTier = Math.floor(parseNumber(next(), opts.targetPerTier));
    else if (arg === '--max-attempts') opts.maxAttempts = Math.floor(parseNumber(next(), opts.maxAttempts));
    else if (arg === '--concurrency') opts.concurrency = Math.floor(parseNumber(next(), opts.concurrency));
    else if (arg === '--target-grades') opts.targetGrades = (next() ?? '').split(',').map(Number).filter(Number.isInteger);
    else if (arg === '--close-min') opts.closeRateRange = { min: parseNumber(next(), 0), max: opts.closeRateRange?.max ?? 1 };
    else if (arg === '--close-max') opts.closeRateRange = { min: opts.closeRateRange?.min ?? 0, max: parseNumber(next(), 1) };
    else if (arg === '--color-ratio-min') opts.colorRatioRange = { min: parseNumber(next(), 0), max: opts.colorRatioRange?.max ?? 1 };
    else if (arg === '--color-ratio-max') opts.colorRatioRange = { min: opts.colorRatioRange?.min ?? 0, max: parseNumber(next(), 1) };
    else if (arg === '--color-jitter') opts.colorJitter = Math.max(0, Math.floor(parseNumber(next(), 0)));
    else if (arg === '--spread-min') opts.spreadRange = { min: parseNumber(next(), 0), max: opts.spreadRange?.max ?? 1 };
    else if (arg === '--spread-max') opts.spreadRange = { min: opts.spreadRange?.min ?? 0, max: parseNumber(next(), 1) };
    else if (arg === '--debt-min') opts.debtRange = { min: parseNumber(next(), 0), max: opts.debtRange?.max ?? 1 };
    else if (arg === '--debt-max') opts.debtRange = { min: opts.debtRange?.min ?? 0, max: parseNumber(next(), 1) };
    else if (arg === '--color-allocation') {
      const v = next();
      if (v === 'single-heavy') opts.colorAllocationMode = 'single-heavy';
      else if (v === 'balanced') opts.colorAllocationMode = 'balanced';
      else throw new Error(`未知花色配额模式: ${v}`);
    }
    else if (arg === '--accept-min-sim1-wins') opts.acceptance.minSim1Wins = parseNumber(next(), 0);
    else if (arg === '--accept-min-sim5-wins') opts.acceptance.minSim5Wins = parseNumber(next(), 0);
    else if (arg === '--accept-min-sim15-wins') opts.acceptance.minSim15Wins = parseNumber(next(), 0);
    else if (arg === '--accept-min-passrate') opts.acceptance.minPassrate = parseNumber(next(), 0);
    else if (arg === '--optimal-acceptance-json') opts.acceptance.optimal = JSON.parse(next() ?? '{}') as OptimalAcceptanceConfig;
    else if (arg === '--resume') opts.resume = true;
    else if (arg === '--run') opts.run = true;
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
  }

  if (opts.levels.length === 0) throw new Error('请通过 --levels 指定地形ID列表，例如 --levels 100075,100074');
  opts.concurrency = Math.max(1, opts.concurrency);
  if (!opts.plan) opts.plan = opts.output.replace(/\.csv$/i, '.plan.csv');
  if (!opts.status) opts.status = opts.output.replace(/\.csv$/i, '.status.json');

  for (const [grade, constraint] of Object.entries(opts.acceptance.optimal?.grade_constraints ?? {})) {
    for (const [name, value] of Object.entries(constraint)) {
      if (name.includes('win_rate') || name.includes('starvation_per_tile') || name === 'max_loss_remaining_ratio') {
        if (value == null || value < 0 || value > 1) {
          throw new Error(`Optimal G${grade} ${name} 必须在 0 到 1 之间，当前为 ${value}`);
        }
      }
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(`Usage:
  npx tsx tools/run-batch-generation.ts --levels 100075,100074 --output output/batch.csv [options]

Plan mode (default):
  Reads existing output (if --resume) and prints a plan. No generation.

Execute mode (--run):
  Runs generation for terrains that still need rows.

Options:
  --levels-dir <dir>       Terrain JSON directory.
  --levels <ids>           Comma-separated terrain IDs. Required.
  --output <csv>           Output CSV.
  --plan <csv>             Plan CSV output. Default: \${output}.plan.csv
  --status <json>          Status tracking JSON. Default: \${output}.status.json
  --run                    Execute generation after planning.
  --resume                 Count existing output rows and resume.
  --close-rates <value>    random or comma list, e.g. 0.3,0.6,0.8
  --color-count <value>    random or fixed integer
  --color-ratio <n>        Used when color-count=random. Default: 0.6
  --spread <value>         random or fixed 0..1
  --debt <value>           random or fixed 0..1
  --sim-runs <n>           Simulation runs. Default: 200
  --target-per-tier <n>    Target rows per grade. Default: 10
  --max-attempts <n>       Max attempts per terrain. Default: 500
  --concurrency <n>        Parallel terrains. Default: 2
  --target-grades <list>   Only collect these grades, e.g. 1,2,3,4,5
  --close-min/max <n>      Random closure-rate bounds
  --color-ratio-min/max <n> Random color-ratio bounds
  --color-jitter <n>       Integer color-count jitter +/-n
  --spread-min/max <n>     Random spread bounds
  --debt-min/max <n>       Random debt bounds
  --color-allocation <mode> balanced | single-heavy (default: balanced)
  --optimal-acceptance-json <json> Per-grade Optimal acceptance
`);
}

// ── Helpers ──

function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function writeJson(path: string, data: unknown): void {
  ensureDir(path);
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function jsonClone<T>(v: T): T { return JSON.parse(JSON.stringify(v)); }

// ── Phase 1: Plan ──

function readExistingFile(path: string): Map<string, Map<number, number>> {
  const counts = new Map<string, Map<number, number>>();
  if (!existsSync(path)) return counts;

  const raw = readFileSync(path, 'utf8').replace(/^[﻿]/, '');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return counts;

  const header = lines[0].split(',');
  const li = header.indexOf('levelResId');
  const gi = header.indexOf('grade');
  if (li < 0 || gi < 0) return counts;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const lid = (cols[li] ?? '').trim();
    const g = Number(cols[gi]);
    if (!lid || !Number.isInteger(g)) continue;
    let m = counts.get(lid);
    if (!m) { m = new Map(); counts.set(lid, m); }
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return counts;
}

function buildPlans(levels: string[], levelsDir: string, targetGrades: number[], targetPerTier: number, existing: Map<string, Map<number, number>>): TerrainPlan[] {
  return levels.map((levelId) => {
    const path = join(levelsDir, `${levelId}.json`);
    if (!existsSync(path)) throw new Error(`地形不存在: ${path}`);
    const em = existing.get(levelId) ?? new Map();
    const needed: Record<number, number> = {};
    const ex: Record<number, number> = {};
    let total = 0;
    for (const g of targetGrades) {
      const have = em.get(g) ?? 0;
      ex[g] = have;
      needed[g] = Math.max(0, targetPerTier - have);
      total += needed[g];
    }
    return { levelResId: levelId, terrainPath: path, existing: ex, needed, totalNeeded: total };
  });
}

function writePlanCsv(path: string, plans: TerrainPlan[], targetGrades: number[]): void {
  ensureDir(path);
  const grades = targetGrades.sort((a, b) => a - b);
  const header = ['levelResId', ...grades.flatMap(g => [`G${g}_existing`, `G${g}_needed`]), 'totalNeeded'];
  const lines = [header.join(',')];
  for (const p of plans) {
    const row = [p.levelResId];
    for (const g of grades) {
      row.push(String(p.existing[g] ?? 0), String(p.needed[g] ?? 0));
    }
    row.push(String(p.totalNeeded));
    lines.push(row.join(','));
  }
  writeFileSync(path, '﻿' + lines.join('\n') + '\n', 'utf8');
}

function summarizePlans(plans: TerrainPlan[], targetGrades: number[]): Record<string, unknown> {
  const active = plans.filter(p => p.totalNeeded > 0);
  const complete = plans.length - active.length;
  const neededByGrade: Record<string, number> = {};
  for (const g of targetGrades) neededByGrade[`G${g}`] = active.reduce((s, p) => s + (p.needed[g] ?? 0), 0);
  return {
    terrains: plans.length,
    active: active.length,
    complete,
    totalNeeded: active.reduce((s, p) => s + p.totalNeeded, 0),
    neededByGrade,
  };
}

// ── Phase 2: Execute ──

function ensureOutputCsv(path: string, resume: boolean): void {
  ensureDir(path);
  if (!resume || !existsSync(path)) {
    writeFileSync(path, '﻿' + BATCH_CSV_HEADERS.join(',') + '\n', 'utf8');
  } else {
    const backup = path.replace(/\.csv$/i, `.bak-${Date.now().toString(36)}.csv`);
    writeFileSync(backup, readFileSync(path));
    const existing = readFileSync(path, 'utf8').replace(/^[﻿]/, '').split(/\r?\n/).filter(Boolean);
    console.log(`resume: 备份至 ${backup}`);
    console.log(`resume: 已有 ${existing.length - 1} 行数据，继续追加`);
  }
}

function appendRow(path: string, row: BatchRow): void {
  appendFileSync(path, serializeBatchRow(row) + '\n', 'utf8');
}

function buildJobs(plans: TerrainPlan[], opts: Options): TerrainJob[] {
  const jobs: TerrainJob[] = [];
  for (const p of plans) {
    if (p.totalNeeded <= 0) continue;
    const targetNeeds: Record<number, number> = {};
    for (const [g, n] of Object.entries(p.needed)) {
      if (n > 0) targetNeeds[Number(g)] = n;
    }
    if (Object.keys(targetNeeds).length === 0) continue;

    jobs.push({
      jobId: p.levelResId,
      levelResId: p.levelResId,
      terrainPath: p.terrainPath,
      targetNeeds,
      maxAttempts: opts.maxAttempts,
      unified: {
        closeRates: opts.closeRates,
        colorCount: opts.colorCount,
        colorCountRatio: opts.colorCountRatio,
        spreadParam: opts.spreadParam,
        debtPersistenceWeight: opts.debtPersistenceWeight,
        closeRateRange: opts.closeRateRange,
        colorRatioRange: opts.colorRatioRange,
        colorJitter: opts.colorJitter,
        spreadRange: opts.spreadRange,
        debtRange: opts.debtRange,
        colorAllocationMode: opts.colorAllocationMode,
      },
      simRuns: opts.simRuns,
      acceptance: jsonClone(opts.acceptance),
      seedBase: hashSeed(p.levelResId),
    });
  }
  return jobs;
}

function hashSeed(levelId: string): number {
  let h = 0;
  for (let i = 0; i < levelId.length; i++) {
    h = ((h << 5) - h) + levelId.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

// ── Progress display ──

function progressLine(
  doneJobs: number, totalJobs: number,
  totalFound: number, totalNeeded: number,
  totalAttempts: number, totalAttemptLimit: number,
): string {
  const pct = totalAttemptLimit > 0 ? Math.min(100, totalAttempts / totalAttemptLimit * 100) : 100;
  return `progress 命中 ${totalFound}/${totalNeeded} | 搜索 ${totalAttempts}/${totalAttemptLimit} (${pct.toFixed(1)}%) | 任务 ${doneJobs}/${totalJobs}`;
}

// ── Worker IPC ──

interface WorkerRowMsg { type: 'row'; jobId: string; row: BatchRow; attempts: number; foundByGrade: Record<number, number>; }
interface WorkerProgressMsg { type: 'progress'; jobId: string; attempts: number; foundByGrade: Record<number, number>; }
interface WorkerDoneMsg { type: 'done'; jobId: string; attempts: number; foundByGrade: Record<number, number>; }
interface WorkerErrorMsg { type: 'error'; jobId: string; error: string; }
type WorkerMsg = WorkerRowMsg | WorkerProgressMsg | WorkerDoneMsg | WorkerErrorMsg;

async function runWorkerJob(job: TerrainJob): Promise<void> {
  const terrain = loadTerrainFromFile(job.terrainPath);

  const probe = determineMaxGrade(terrain, job.unified, 0, job.terrainPath, job.simRuns, job.seedBase);
  const maxGrade = probe.maxGrade;
  if (process.send) {
    process.send({
      type: 'row',
      jobId: job.jobId,
      row: probe.row,
      attempts: 1,
      foundByGrade: { [probe.row.grade]: 1 },
    } satisfies WorkerRowMsg);
  }

  const targetGrades = Object.keys(job.targetNeeds).map(Number);
  let lastProgressAttempts = 0;

  const result = await collectGradesForTerrain(
    terrain, job.unified, 0, job.terrainPath,
    maxGrade, 0, job.maxAttempts,
    job.simRuns, job.seedBase + 1,
    {
      targetGrades,
      acceptance: job.acceptance,
      acceptedOnly: true,
      gradeTargets: job.targetNeeds,
    },
    undefined,
    (collected, attempts) => {
      if (attempts - lastProgressAttempts >= 10 || attempts >= job.maxAttempts) {
        lastProgressAttempts = attempts;
        if (process.send) {
          process.send({
            type: 'progress',
            jobId: job.jobId,
            attempts,
            foundByGrade: collected,
          } satisfies WorkerProgressMsg);
        }
      }
    },
  );

  for (const row of result.rows) {
    if (process.send) {
      process.send({
        type: 'row',
        jobId: job.jobId,
        row,
        attempts: result.attempts,
        foundByGrade: result.collected,
      } satisfies WorkerRowMsg);
    }
  }

  if (process.send) {
    process.send({
      type: 'done',
      jobId: job.jobId,
      attempts: result.attempts,
      foundByGrade: result.collected,
    } satisfies WorkerDoneMsg);
  }
}

// ── Job execution ──

function runJobs(jobs: TerrainJob[], opts: Options): Promise<{ totalFound: number }> {
  return new Promise((resolve, reject) => {
    let next = 0;
    let doneJobs = 0;
    let totalFound = 0;
    const totalNeeded = jobs.reduce((s, j) => s + Object.values(j.targetNeeds).reduce((a, b) => a + b, 0), 0);
    const totalAttemptLimit = jobs.reduce((s, j) => s + j.maxAttempts, 0);
    let lastLoggedPercent = -1;

    const jobState: Record<string, JobStatus> = {};
    for (const j of jobs) {
      const needed = Object.values(j.targetNeeds).reduce((a, b) => a + b, 0);
      jobState[j.jobId] = {
        levelResId: j.levelResId,
        targetNeeds: { ...j.targetNeeds },
        foundByGrade: {},
        needed,
        found: 0,
        attempts: 0,
        status: 'pending',
      };
    }

    const saveStatus = () => {
      const totalAttempts = Object.values(jobState).reduce((s, js) => s + js.attempts, 0);
      writeJson(opts.status, {
        updatedAt: new Date().toISOString(),
        totalJobs: jobs.length,
        doneJobs,
        totalNeeded,
        totalFound,
        totalAttempts,
        totalAttemptLimit,
        concurrency: opts.concurrency,
        jobs: jobState,
      });
    };

    const updateDisplay = () => {
      const totalAttempts = Object.values(jobState).reduce((s, js) => s + js.attempts, 0);
      const line = progressLine(doneJobs, jobs.length, totalFound, totalNeeded, totalAttempts, totalAttemptLimit);
      if (process.stdout.isTTY) {
        process.stdout.write(`\r\x1b[2K${line}`);
      } else {
        const pct = Math.floor(totalAttemptLimit > 0 ? totalAttempts / totalAttemptLimit * 100 : 100);
        if (pct > lastLoggedPercent || doneJobs === jobs.length) {
          lastLoggedPercent = pct;
          process.stdout.write(`${line}\n`);
        }
      }
    };

    saveStatus();

    const script = fileURLToPath(import.meta.url);
    const runOne = (job: TerrainJob): Promise<void> => {
      return new Promise((res, rej) => {
        jobState[job.jobId].status = 'running';
        saveStatus();

        const child = fork(script, ['--worker'], {
          execArgv: process.execArgv.filter(a => !['--eval', '-e', '--print', '-p'].includes(a)),
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        });

        child.on('message', (msg: WorkerMsg) => {
          if (msg.type === 'row') {
            appendRow(opts.output, msg.row);
            const g = msg.row.grade;
            jobState[job.jobId].foundByGrade[g] = (jobState[job.jobId].foundByGrade[g] ?? 0) + 1;
            jobState[job.jobId].found++;
            jobState[job.jobId].attempts = msg.attempts;
            totalFound++;
          } else if (msg.type === 'progress') {
            jobState[job.jobId].attempts = msg.attempts;
            for (const [g, c] of Object.entries(msg.foundByGrade)) {
              jobState[job.jobId].foundByGrade[Number(g)] = c;
            }
            jobState[job.jobId].found = Object.values(msg.foundByGrade).reduce((a, b) => a + b, 0);
            saveStatus();
            updateDisplay();
          } else if (msg.type === 'done') {
            jobState[job.jobId].attempts = msg.attempts;
            for (const [g, c] of Object.entries(msg.foundByGrade)) {
              jobState[job.jobId].foundByGrade[Number(g)] = c;
            }
            const needed = Object.values(job.targetNeeds).reduce((a, b) => a + b, 0);
            const found = Object.values(msg.foundByGrade).reduce((a, b) => a + b, 0);
            jobState[job.jobId].found = found;
            jobState[job.jobId].status = found >= needed ? 'done' : 'partial';
            doneJobs++;
            saveStatus();
            updateDisplay();
            res();
          } else if (msg.type === 'error') {
            jobState[job.jobId].status = 'error';
            saveStatus();
            rej(new Error(msg.error));
          }
        });

        child.on('error', rej);
        child.on('exit', (code) => {
          if (code !== 0 && jobState[job.jobId].status !== 'error') {
            rej(new Error(`Worker ${job.jobId} exited with code ${code}`));
          }
        });

        child.send(job);
      });
    };

    const workers = Array.from({ length: Math.min(opts.concurrency, jobs.length) }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        await runOne(job);
      }
    });

    Promise.all(workers).then(() => {
      if (process.stdout.isTTY) process.stdout.write('\n');
      resolve({ totalFound });
    }).catch(reject);
  });
}

// ── Main ──

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const targetGrades = opts.targetGrades.length > 0 ? opts.targetGrades : [0, 1, 2, 3, 4, 5];

  // Phase 1: Plan
  const existing = opts.resume ? readExistingFile(opts.output) : new Map<string, Map<number, number>>();
  const plans = buildPlans(opts.levels, opts.levelsDir, targetGrades, opts.targetPerTier, existing);
  const activePlans = plans.filter(p => p.totalNeeded > 0);
  writePlanCsv(opts.plan, plans, targetGrades);

  const summary = summarizePlans(plans, targetGrades);
  console.log(`Plan written to ${opts.plan}`);
  console.log(JSON.stringify(summary, null, 2));

  if (activePlans.length === 0) {
    console.log('所有地形已完成，无需生成。');
    return;
  }

  if (!opts.run) {
    console.log(`\nPlan-only mode. ${activePlans.length} terrains need generation.`);
    console.log('Add --run to execute, or re-run with:');
    console.log(`  npx tsx tools/run-batch-generation.ts --levels ${opts.levels.join(',')} --output ${opts.output} --run`);
    if (!opts.resume) console.log('  (add --resume to count existing data)');
    return;
  }

  // Phase 2: Execute
  ensureOutputCsv(opts.output, opts.resume);
  const jobs = buildJobs(activePlans, opts);
  console.log(`\nExecuting ${jobs.length} jobs (concurrency: ${opts.concurrency})...`);

  const result = await runJobs(jobs, opts);
  const totalNeeded = activePlans.reduce((s, p) => s + p.totalNeeded, 0);
  console.log(`\n完成 | 命中 ${result.totalFound}/${totalNeeded} | 输出 ${opts.output}`);
}

// ── Entry ──

if (process.argv.includes('--worker')) {
  setLogLevel(LogLevel.Silent);
  process.on('message', (job: TerrainJob) => {
    runWorkerJob(job)
      .then(() => process.exit(0))
      .catch((err) => {
        if (process.send) {
          process.send({
            type: 'error',
            jobId: job?.jobId ?? '?',
            error: err instanceof Error ? err.message : String(err),
          } satisfies WorkerErrorMsg);
        }
        process.exit(1);
      });
  });
  // Keep alive
  setInterval(() => {}, 60000);
} else {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
