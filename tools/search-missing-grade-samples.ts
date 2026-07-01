#!/usr/bin/env npx tsx
/**
 * Search one reference sample for still-missing lower grades.
 *
 * Coverage baseline:
 *   1. Initial search CSV
 *   2. First backfill CSV, excluding rule-generated G0 rows
 *   3. Latest G1/G2 backfill CSV
 *
 * For every terrain, expected grades are all grades from 0..maxExistingGrade.
 * Existing rule-generated G0 rows are not counted. Each terrain gets at most
 * --attempts-per-missing-grade * missingGrades.length attempts. A found sample
 * is recorded once per missing target grade.
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

interface Options {
  initial: string;
  firstBackfill: string;
  latestBackfill: string;
  output: string;
  plan: string;
  status: string;
  attemptsPerMissingGrade: number;
  simRuns: number;
  concurrency: number;
  colorRatioMin: number;
  colorRatioMax: number;
  excludeLevels: Set<string>;
  resume: boolean;
  run: boolean;
}

interface CsvRow {
  [key: string]: string;
}

interface LevelPlan {
  levelResId: string;
  terrainPath: string;
  existingGrades: number[];
  maxGrade: number;
  missingGrades: number[];
}

interface WorkerJob extends LevelPlan {
  attemptsPerMissingGrade: number;
  simRuns: number;
  colorRatioMin: number;
  colorRatioMax: number;
  seedBase: number;
}

type WorkerMessage =
  | { type: 'progress'; levelResId: string; attempts: number; foundGrades: number[] }
  | { type: 'row'; levelResId: string; row: BatchRow; attempts: number; foundGrades: number[] }
  | { type: 'done'; levelResId: string; attempts: number; foundGrades: number[]; remainingGrades: number[] }
  | { type: 'error'; levelResId: string; error: string };

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    initial: 'output/100003～100071_100073+_合并去少.csv',
    firstBackfill: 'output/无尽补缺生成.csv',
    latestBackfill: 'output/无尽补缺_G1G2_高闭合生成.csv',
    output: 'output/缺失档位随机样本搜索.csv',
    plan: 'output/缺失档位随机样本计划.csv',
    status: 'output/缺失档位随机样本状态.json',
    attemptsPerMissingGrade: 300,
    simRuns: 100,
    concurrency: Math.max(1, Math.min(availableParallelism() - 1, 5)),
    colorRatioMin: 0.4,
    colorRatioMax: 0.6,
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
    else if (a === '--attempts-per-missing-grade') opts.attemptsPerMissingGrade = num(opts.attemptsPerMissingGrade);
    else if (a === '--sim-runs') opts.simRuns = num(opts.simRuns);
    else if (a === '--concurrency') opts.concurrency = num(opts.concurrency);
    else if (a === '--color-ratio-min') opts.colorRatioMin = num(opts.colorRatioMin);
    else if (a === '--color-ratio-max') opts.colorRatioMax = num(opts.colorRatioMax);
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
  npx tsx tools/search-missing-grade-samples.ts --run --concurrency 5

Options:
  --initial <csv>              Initial generated CSV
  --first-backfill <csv>       First backfill CSV; grade 0 rows are ignored
  --latest-backfill <csv>      Latest backfill CSV
  --output <csv>               Found sample output CSV
  --plan <csv>                 Search plan CSV
  --status <json>              Runtime status JSON
  --attempts-per-missing-grade <n>  Random attempts per missing grade. Default: 300
  --sim-runs <n>               Strategy2 simulation runs. Default: 100
  --concurrency <n>            Parallel workers. Default: min(cpu-1, 5)
  --color-ratio-min <n>        Min color ratio. Default: 0.4
  --color-ratio-max <n>        Max color ratio. Default: 0.6
  --exclude-levels <list>      Excluded level IDs. Default: 100001,100002
  --resume                    Count existing output rows as found samples
  --run                       Execute search. Omit for plan-only
`);
}

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
        if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
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
  return records.slice(1).map(record => Object.fromEntries(headers.map((header, i) => [header, record[i] ?? ''])));
}

function readRows(path: string): CsvRow[] {
  if (!existsSync(path)) return [];
  return parseCsv(readFileSync(path, 'utf8'));
}

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
    const current = coverage.get(levelResId) ?? { terrainPath: terrainPath || '', grades: new Set<number>() };
    if (!current.terrainPath && terrainPath) current.terrainPath = terrainPath;
    current.grades.add(grade);
    coverage.set(levelResId, current);
  }
}

function foundSamplesByLevelGrade(path: string, excludeLevels: Set<string>): Set<string> {
  const found = new Set<string>();
  for (const row of readRows(path)) {
    const levelResId = row.levelResId?.trim();
    const grade = Number(row.grade);
    if (!levelResId || excludeLevels.has(levelResId)) continue;
    if (Number.isInteger(grade) && grade >= 0 && grade <= 5) {
      found.add(`${levelResId}_G${grade}`);
    }
  }
  return found;
}

function buildPlan(opts: Options): LevelPlan[] {
  const coverage = new Map<string, { terrainPath: string; grades: Set<number> }>();
  addCoverage(coverage, opts.initial, opts.excludeLevels, false);
  addCoverage(coverage, opts.firstBackfill, opts.excludeLevels, true);
  addCoverage(coverage, opts.latestBackfill, opts.excludeLevels, false);
  const found = opts.resume ? foundSamplesByLevelGrade(opts.output, opts.excludeLevels) : new Set<string>();

  const plan: LevelPlan[] = [];
  for (const [levelResId, item] of coverage) {
    if (!item.terrainPath) continue;
    const existingGrades = [...item.grades].sort((a, b) => a - b);
    if (existingGrades.length === 0) continue;
    const maxGrade = Math.max(...existingGrades);
    const missingGrades = Array.from({ length: maxGrade + 1 }, (_, g) => g)
      .filter(g => !item.grades.has(g))
      .filter(g => !found.has(`${levelResId}_G${g}`));
    if (missingGrades.length > 0) {
      plan.push({ levelResId, terrainPath: item.terrainPath, existingGrades, maxGrade, missingGrades });
    }
  }
  return plan.sort((a, b) => Number(a.levelResId) - Number(b.levelResId));
}

function csvEscape(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writePlan(path: string, plan: LevelPlan[]): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const headers = ['levelResId', 'terrainPath', 'existingGrades', 'maxGrade', 'missingGrades', 'missingCount'];
  const lines = [headers.join(',')];
  for (const item of plan) {
    lines.push([
      item.levelResId,
      item.terrainPath,
      item.existingGrades.join('|'),
      item.maxGrade,
      item.missingGrades.join('|'),
      item.missingGrades.length,
    ].map(csvEscape).join(','));
  }
  writeFileSync(path, `\ufeff${lines.join('\n')}\n`, 'utf8');
}

function ensureOutput(path: string, resume: boolean): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  if (!resume || !existsSync(path)) {
    writeFileSync(path, `\ufeff${BATCH_CSV_HEADERS.join(',')}\n`, 'utf8');
  }
}

function appendRow(path: string, row: BatchRow): void {
  appendFileSync(path, `${serializeBatchRow(row)}\n`, 'utf8');
}

function writeStatus(path: string, status: object): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
}

function computeDepthCount(terrain: TerrainData): number {
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(t => !t.isConst);
  const depthMap = computeDependencyDepth(freeTiles, new Map(allTiles.map(t => [t.id, t])));
  return depthMap.size > 0 ? Math.max(...depthMap.values()) : 1;
}

function randomParams(terrain: TerrainData, job: WorkerJob, rng: () => number): GenerationParams {
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(t => !t.isConst).length;
  const depthCount = computeDepthCount(terrain);
  const ratio = job.colorRatioMin + rng() * (job.colorRatioMax - job.colorRatioMin);
  return {
    closeRates: Array.from({ length: Math.max(0, depthCount - 1) }, () => rng()),
    colorCount: Math.max(1, colorCountFromRatio(ratio, freeTiles)),
    spreadParam: rng(),
    debtPersistenceWeight: rng(),
  };
}

function send(message: WorkerMessage): void {
  if (process.send) process.send(message);
}

async function runWorker(job: WorkerJob): Promise<void> {
  const terrain = loadTerrainFromFile(job.terrainPath);
  const remaining = new Set(job.missingGrades);
  const found = new Set<number>();
  let attempts = 0;
  while (attempts < job.attemptsPerMissingGrade * job.missingGrades.length && remaining.size > 0) {
    const seed = job.seedBase + attempts * 101;
    const rng = mulberry32(seed + 17);
    const params = randomParams(terrain, job, rng);
    const row = generateAndEvaluateOne(
      terrain,
      params,
      0,
      job.terrainPath,
      attempts + 1,
      false,
      job.simRuns,
      seed,
    );
    attempts++;
    if (row.success && remaining.has(row.grade)) {
      remaining.delete(row.grade);
      found.add(row.grade);
      send({ type: 'row', levelResId: job.levelResId, row, attempts, foundGrades: [...found].sort((a, b) => a - b) });
    }
    if (attempts % 10 === 0) {
      send({ type: 'progress', levelResId: job.levelResId, attempts, foundGrades: [...found].sort((a, b) => a - b) });
    }
  }
  send({
    type: 'done',
    levelResId: job.levelResId,
    attempts,
    foundGrades: [...found].sort((a, b) => a - b),
    remainingGrades: [...remaining].sort((a, b) => a - b),
  });
}

async function runJobs(plan: LevelPlan[], opts: Options): Promise<void> {
  let next = 0;
  let doneLevels = 0;
  let foundTargets = 0;
  const totalTargets = plan.reduce((sum, item) => sum + item.missingGrades.length, 0);
  const state: Record<string, { missingGrades: number[]; foundGrades: number[]; remainingGrades: number[]; attempts: number; status: string }> = {};
  for (const item of plan) {
    state[item.levelResId] = {
      missingGrades: item.missingGrades,
      foundGrades: [],
      remainingGrades: item.missingGrades,
      attempts: 0,
      status: 'pending',
    };
  }

  const update = () => {
    const doneText = `${doneLevels}/${plan.length}`;
    const targetText = `${foundTargets}/${totalTargets}`;
    writeStatus(opts.status, {
      updatedAt: new Date().toISOString(),
      doneLevels,
      totalLevels: plan.length,
      foundTargets,
      totalTargets,
      progressText: `levels ${doneText}, targets ${targetText}`,
      concurrency: opts.concurrency,
      state,
    });
    console.log(`level-progress ${doneText} target-progress ${targetText}`);
  };

  const script = fileURLToPath(import.meta.url);
  const runOne = (item: LevelPlan) => new Promise<void>((resolvePromise, reject) => {
    const job: WorkerJob = {
      ...item,
      attemptsPerMissingGrade: opts.attemptsPerMissingGrade,
      simRuns: opts.simRuns,
      colorRatioMin: opts.colorRatioMin,
      colorRatioMax: opts.colorRatioMax,
      seedBase: (Date.now() + Number(item.levelResId) * 7919) & 0x7fffffff,
    };
    state[item.levelResId].status = 'running';
    const child = fork(script, ['--worker'], {
      execArgv: process.execArgv.filter(arg => !['--eval', '-e', '--print', '-p'].includes(arg)),
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    child.on('message', (message: WorkerMessage) => {
      const s = state[item.levelResId];
      if (message.type === 'row') {
        appendRow(opts.output, message.row);
        s.foundGrades = message.foundGrades;
        s.remainingGrades = s.missingGrades.filter(g => !s.foundGrades.includes(g));
        s.attempts = message.attempts;
        foundTargets++;
        update();
      } else if (message.type === 'progress') {
        s.foundGrades = message.foundGrades;
        s.remainingGrades = s.missingGrades.filter(g => !s.foundGrades.includes(g));
        s.attempts = message.attempts;
      } else if (message.type === 'done') {
        s.foundGrades = message.foundGrades;
        s.remainingGrades = message.remainingGrades;
        s.attempts = message.attempts;
        s.status = message.remainingGrades.length === 0 ? 'done' : 'partial';
        doneLevels++;
        update();
      } else if (message.type === 'error') {
        s.status = 'error';
        reject(new Error(message.error));
      }
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolvePromise();
      else reject(new Error(`worker ${item.levelResId} exited with code ${code}`));
    });
    child.send(job);
  });

  const workers = Array.from({ length: Math.min(opts.concurrency, plan.length) }, async () => {
    while (next < plan.length) {
      const item = plan[next++];
      await runOne(item);
    }
  });
  update();
  await Promise.all(workers);
  update();
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const plan = buildPlan(opts);
  writePlan(opts.plan, plan);
  const totalTargets = plan.reduce((sum, item) => sum + item.missingGrades.length, 0);
  console.log(`已写计划: ${opts.plan}`);
  console.log(`待搜地形: ${plan.length}, 待搜目标: ${totalTargets}`);
  if (!opts.run) {
    console.log('当前是 plan-only。需要执行时加 --run');
    return;
  }
  ensureOutput(opts.output, opts.resume);
  await runJobs(plan, opts);
  console.log(`完成。输出: ${opts.output}，状态: ${opts.status}`);
}

if (process.argv.includes('--worker')) {
  process.on('message', message => {
    runWorker(message as WorkerJob)
      .then(() => process.exit(0))
      .catch(error => {
        send({
          type: 'error',
          levelResId: (message as Partial<WorkerJob>)?.levelResId ?? 'unknown',
          error: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      });
  });
} else {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
