#!/usr/bin/env npx tsx
/**
 * Selected full sweep for online-rate calibration.
 *
 * Runs mistake rates 0%, 1%, 2%, 3%, 4%, 5%, 7%, 10%, 15%. Optional metric bots
 * add prefixed diagnostic columns such as sim5_forcedPickOnLoss.
 *
 * Usage:
 *   npx tsx tools/batch-sim-selected-sweep.ts --output 失误率扫描_精选
 *   npx tsx tools/batch-sim-selected-sweep.ts --resume --output 失误率扫描_精选
 *   npx tsx tools/batch-sim-selected-sweep.ts --quick --output 失误率扫描_精选_test
 *   npx tsx tools/batch-sim-selected-sweep.ts --sim-count 200 --output 失误率扫描_精选
 *   npx tsx tools/batch-sim-selected-sweep.ts --metric-bots optimal,sim0,sim5 --sample-per-online-bucket 2
 *   npx tsx tools/batch-sim-selected-sweep.ts --sim-count 100 --concurrency 5 --metric-bots optimal,sim0,sim5
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { fork } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeFromString,
  getAllTiles,
  getCanonicalTileOrder,
  loadTerrainFromFile,
  LogLevel,
  setLogLevel,
} from '../src/index.js';
import { createGame } from '../src/solver/offline-game.js';
import { solvePlayerMistakeBatch } from '../src/solver/solver-player-mistake.js';
import { solvePlayerShortestBatch } from '../src/solver/solver-player-shortest.js';
import type { ReplayData, TerrainTile } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
setLogLevel(LogLevel.Silent);

const TERRAIN_DIRS = [
  '/Users/wenhaowang/WorkSpace/TileMatchShell/Tools/Config/Json/Levels',
  '/Users/wenhaowang/WorkSpace/levels_json/正式关卡',
  '/Users/wenhaowang/WorkSpace/levels_json/关卡备份',
  '/Users/wenhaowang/WorkSpace/levels_json/关卡调整',
];
const BASE_OUTPUT = resolve(__dirname, '../output');
const DEFAULT_OUTPUT_NAME = '失误率扫描_精选';
const MISTAKE_RATES = [0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.07, 0.10, 0.15];
const ONLINE_BUCKETS: [number, number][] = [[0, 20], [20, 40], [40, 60], [60, 80], [80, 101]];
const METRIC_COLUMNS = [
  'winRate',
  'forcedPickOnWin',
  'colorStarvationOnWin',
  'stepsOnLoss',
  'forcedPickOnLoss',
  'colorStarvationOnLoss',
] as const;

type MetricBotName = 'optimal' | 'sim0' | 'sim5';
type MetricColumn = typeof METRIC_COLUMNS[number];

interface MetricResult {
  winRate: number;
  forcedPickOnWin: number;
  colorStarvationOnWin: number;
  stepsOnLoss: number;
  forcedPickOnLoss: number;
  colorStarvationOnLoss: number;
}

interface Options {
  inputFile: string;
  outputName: string;
  simCount: number;
  limit: number;
  quick: boolean;
  resume: boolean;
  concurrency: number;
  metricBots: MetricBotName[];
  samplePerOnlineBucket: number;
  sampleSeed: number;
}

interface CsvRow {
  replayKey: string;
  terrainId: string;
  starts: number;
  clears: number;
  onlineWinRate: number;
  replayCode: string;
}

interface DecodedReplay {
  replayData: ReplayData;
  elementValues: Map<number, number>;
  initialDock: { tileId: number; element: number }[];
  eliminatedTileIds: Set<number>;
}

interface SweepJob {
  index: number;
  total: number;
  row: CsvRow;
  terrainPath: string;
  simCount: number;
  metricBots: MetricBotName[];
}

interface WorkerResult {
  type: 'result';
  index: number;
  replayKey: string;
  line: string;
  m0: number;
  m5: number;
  m7: number;
  m10: number;
  m15: number;
  metrics: Record<string, number>;
}

interface WorkerError {
  type: 'error';
  index: number;
  replayKey: string;
  error: string;
}

type WorkerMessage = WorkerResult | WorkerError;

function readArg(args: string[], name: string): string | null {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  const value = args[idx + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parseOptions(): Options {
  const args = process.argv.slice(2);
  const quick = args.includes('--quick');
  const inputArg = readArg(args, '--input');
  const simCountArg = readArg(args, '--sim-count');
  const limitArg = readArg(args, '--limit');
  const concurrencyArg = readArg(args, '--concurrency');
  const metricBotsArg = readArg(args, '--metric-bots');
  const samplePerBucketArg = readArg(args, '--sample-per-online-bucket');
  const sampleSeedArg = readArg(args, '--sample-seed');
  const defaultInput = existsSync(join(BASE_OUTPUT, 'sim_results.csv'))
    ? join(BASE_OUTPUT, 'sim_results.csv')
    : join(BASE_OUTPUT, '原始数据.csv');

  return {
    inputFile: inputArg
      ? isAbsolute(inputArg)
        ? inputArg
        : existsSync(resolve(inputArg))
          ? resolve(inputArg)
          : join(BASE_OUTPUT, inputArg)
      : defaultInput,
    outputName: readArg(args, '--output') ?? DEFAULT_OUTPUT_NAME,
    simCount: quick ? 3 : Math.max(1, Math.floor(Number(simCountArg ?? 100))),
    limit: quick ? 5 : Math.max(1, Math.floor(Number(limitArg ?? Infinity))),
    quick,
    resume: args.includes('--resume'),
    concurrency: Math.max(
      1,
      Math.min(
        Math.floor(Number(concurrencyArg ?? Math.min(Math.max(availableParallelism() - 1, 1), 5))),
        availableParallelism(),
      ),
    ),
    metricBots: parseMetricBots(metricBotsArg),
    samplePerOnlineBucket: Math.max(0, Math.floor(Number(samplePerBucketArg ?? 0))),
    sampleSeed: Math.floor(Number(sampleSeedArg ?? 20260626)),
  };
}

function parseMetricBots(raw: string | null): MetricBotName[] {
  if (!raw || raw.trim() === '' || raw.trim() === 'none') return [];
  const expanded = raw.split(',').flatMap(part => {
    const name = part.trim().toLowerCase();
    if (name === 'all') return ['optimal', 'sim0', 'sim5'];
    if (name === 'shortest') return ['optimal'];
    return [name];
  });
  const valid = new Set<MetricBotName>(['optimal', 'sim0', 'sim5']);
  const result: MetricBotName[] = [];
  for (const name of expanded) {
    if (!valid.has(name as MetricBotName)) {
      throw new Error(`Unknown metric bot: ${name}. Use optimal,sim0,sim5,all,none.`);
    }
    const bot = name as MetricBotName;
    if (!result.includes(bot)) result.push(bot);
  }
  return result;
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

function csvEscape(value: unknown): string {
  const s = String(value ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], seed: number): T[] {
  const result = [...items];
  const random = rng(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function parseInputRows(inputFile: string): CsvRow[] {
  if (!inputFile.endsWith('.csv')) {
    throw new Error(`--input 需要 CSV 文件，不是 JSON/目录: ${inputFile}`);
  }
  const raw = readFileSync(inputFile, 'utf-8').replace(/^\uFEFF/, '');
  const lines = raw.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = parseCSVLine(lines[0]).map(cell => cell.trim());
  const indexOf = (...names: string[]) => {
    for (const name of names) {
      const idx = header.indexOf(name);
      if (idx >= 0) return idx;
    }
    return -1;
  };
  const replayKeyIdx = indexOf('关卡牌局代码', 'ReplayKey');
  const terrainIdx = indexOf('地形编号', 'levelResId', 'LevelResID');
  const startsIdx = indexOf('开始次数');
  const clearsIdx = indexOf('净过关次数');
  const onlineIdx = indexOf('净胜率(%)', '在线胜率(%)', 'passrate');
  const replayCodeIdx = indexOf('ReplayCode');
  if (terrainIdx < 0 || replayCodeIdx < 0) {
    throw new Error(`输入 CSV 缺少必要列：地形编号/levelResId 和 ReplayCode。当前表头: ${header.join(',')}`);
  }
  const rows: CsvRow[] = [];

  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = parseCSVLine(line);
    const rawOnline = onlineIdx >= 0 ? Number(cells[onlineIdx]) || 0 : 0;
    const onlineWinRate = header[onlineIdx] === 'passrate' && rawOnline <= 1
      ? rawOnline * 100
      : rawOnline;
    const replayCode = (cells[replayCodeIdx] ?? '').trim();
    if (!replayCode) continue;
    rows.push({
      replayKey: replayKeyIdx >= 0 ? (cells[replayKeyIdx] ?? '').trim() : replayCode.slice(0, 16),
      terrainId: (cells[terrainIdx] ?? '').trim(),
      starts: startsIdx >= 0 ? Number(cells[startsIdx]) || 0 : 0,
      clears: clearsIdx >= 0 ? Number(cells[clearsIdx]) || 0 : 0,
      onlineWinRate,
      replayCode,
    });
  }
  return rows;
}

function buildTerrainMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const dir of TERRAIN_DIRS) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -'.json'.length);
      if (!map.has(id)) map.set(id, join(dir, file));
    }
  }
  return map;
}

const terrainCache = new Map<string, TerrainTile[]>();

function getTerrainTiles(terrainId: string, terrainMap: Map<string, string>): TerrainTile[] | null {
  const cached = terrainCache.get(terrainId);
  if (cached) return cached;

  const path = terrainMap.get(terrainId);
  if (!path) return null;

  const terrain = loadTerrainFromFile(path);
  const tiles = getAllTiles(terrain);
  terrainCache.set(terrainId, tiles);
  return tiles;
}

function decodeReplay(replayCode: string, terrainTiles: TerrainTile[]): DecodedReplay | null {
  const replayData = decodeFromString(replayCode);
  if (!replayData) return null;

  const ordered = getCanonicalTileOrder(terrainTiles);
  const elementValues = new Map<number, number>();
  const initialDock: { tileId: number; element: number }[] = [];
  const eliminatedTileIds = new Set<number>();

  for (let i = 0; i < ordered.length && i < replayData.instanceArray.length; i++) {
    const tile = ordered[i];
    const byte = replayData.instanceArray[i];
    const state = (byte >> 6) & 0x3;
    const element = (byte & 0x3f) + 1;

    elementValues.set(tile.id, element);
    if (state === 1) eliminatedTileIds.add(tile.id);
    else if (state === 2) initialDock.push({ tileId: tile.id, element });
  }

  for (const entry of replayData.dockEntries) {
    if (entry.tileId >= 0 && entry.tileId < ordered.length) {
      const tile = ordered[entry.tileId];
      if (!initialDock.some(d => d.tileId === tile.id)) {
        initialDock.push({ tileId: tile.id, element: entry.element });
      }
    }
  }

  return { replayData, elementValues, initialDock, eliminatedTileIds };
}

function metricHeaders(metricBots: MetricBotName[]): string[] {
  return metricBots.flatMap(bot => METRIC_COLUMNS.map(col => `${bot}_${col}`));
}

function outputHeader(metricBots: MetricBotName[]): string {
  const mistakeCols = MISTAKE_RATES.map(rate => `mistake_${rate.toFixed(2)}`);
  return [
    '关卡牌局代码',
    '地形编号',
    '开始次数',
    '净过关次数',
    '净胜率(%)',
    'ReplayCode',
    ...mistakeCols,
    ...metricHeaders(metricBots),
    '地形总牌数',
  ].join(',');
}

function metricResultFromBatch(batch: {
  winRate: number;
  forcedPickOnWin?: number;
  starvationOnWin?: number;
  stepsOnLoss?: number;
  forcedPickOnLoss?: number;
  starvationOnLoss?: number;
}): MetricResult {
  return {
    winRate: batch.winRate,
    forcedPickOnWin: batch.forcedPickOnWin ?? 0,
    colorStarvationOnWin: batch.starvationOnWin ?? 0,
    stepsOnLoss: batch.stepsOnLoss ?? 0,
    forcedPickOnLoss: batch.forcedPickOnLoss ?? 0,
    colorStarvationOnLoss: batch.starvationOnLoss ?? 0,
  };
}

function metricValues(metricBots: MetricBotName[], metrics: Map<MetricBotName, MetricResult>): string[] {
  return metricBots.flatMap(bot => {
    const metric = metrics.get(bot);
    if (!metric) return METRIC_COLUMNS.map(() => '');
    return METRIC_COLUMNS.map(col => (
      col === 'winRate' ? (metric[col] * 100).toFixed(2) : metric[col].toFixed(2)
    ));
  });
}

function outputRowLine(
  row: CsvRow,
  mistakeWinRates: number[],
  metricBots: MetricBotName[],
  metrics: Map<MetricBotName, MetricResult>,
  totalTiles: number,
): string {
  return [
    csvEscape(row.replayKey),
    csvEscape(row.terrainId),
    row.starts,
    row.clears,
    row.onlineWinRate.toFixed(2),
    csvEscape(row.replayCode),
    ...mistakeWinRates.map(rate => (rate * 100).toFixed(2)),
    ...metricValues(metricBots, metrics),
    totalTiles,
  ].join(',');
}

function appendOutputRow(
  outputFile: string,
  row: CsvRow,
  mistakeWinRates: number[],
  metricBots: MetricBotName[],
  metrics: Map<MetricBotName, MetricResult>,
  totalTiles: number,
): void {
  appendFileSync(outputFile, `${outputRowLine(row, mistakeWinRates, metricBots, metrics, totalTiles)}\n`, 'utf-8');
}

function readCheckpoint(path: string): number {
  if (!existsSync(path)) return 0;
  const checkpoint = JSON.parse(readFileSync(path, 'utf-8'));
  if (checkpoint.done) return Number(checkpoint.nextIdx ?? checkpoint.completedCount ?? 0);
  return Number(checkpoint.nextIdx ?? 0);
}

function selectRows(rows: CsvRow[], opts: Options): CsvRow[] {
  const limited = rows.slice(0, opts.limit);
  if (opts.samplePerOnlineBucket <= 0) return limited;

  const selected: CsvRow[] = [];
  for (let i = 0; i < ONLINE_BUCKETS.length; i++) {
    const [lo, hi] = ONLINE_BUCKETS[i];
    const bucket = limited.filter(row => row.onlineWinRate >= lo && row.onlineWinRate < hi);
    selected.push(...shuffle(bucket, opts.sampleSeed + i).slice(0, opts.samplePerOnlineBucket));
  }
  return selected;
}

function findMistakeIndex(rate: number): number {
  return MISTAKE_RATES.findIndex(value => Math.abs(value - rate) < 0.000001);
}

function readCompletedKeys(outputFile: string): Set<string> {
  const keys = new Set<string>();
  if (!existsSync(outputFile)) return keys;
  const raw = readFileSync(outputFile, 'utf-8').replace(/^\uFEFF/, '').trim();
  if (!raw) return keys;
  const lines = raw.split(/\r?\n/);
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = parseCSVLine(line);
    if (cells[0]) keys.add(cells[0]);
  }
  return keys;
}

function processJob(job: SweepJob): WorkerResult {
  const terrain = loadTerrainFromFile(job.terrainPath);
  const terrainTiles = getAllTiles(terrain);
  const decoded = decodeReplay(job.row.replayCode, terrainTiles);
  if (!decoded) {
    throw new Error(`Replay decode failed: ${job.row.replayKey}`);
  }

  const game = createGame({
    terrainTiles,
    elementValues: decoded.elementValues,
    initialDock: decoded.initialDock,
    eliminatedTileIds: decoded.eliminatedTileIds,
  });

  const mistakeResults = MISTAKE_RATES.map((mistakeRate, idx) => (
    solvePlayerMistakeBatch(game, job.simCount, idx * 100000, { mistakeRate })
  ));
  const mistakeWinRates = mistakeResults.map(result => result.winRate);
  const metrics = new Map<MetricBotName, MetricResult>();
  for (const bot of job.metricBots) {
    if (bot === 'optimal') {
      metrics.set(bot, metricResultFromBatch(solvePlayerShortestBatch(game, job.simCount, 900000)));
    } else if (bot === 'sim0') {
      const idx = findMistakeIndex(0);
      const result = idx >= 0
        ? mistakeResults[idx]
        : solvePlayerMistakeBatch(game, job.simCount, 0, { mistakeRate: 0 });
      metrics.set(bot, metricResultFromBatch(result));
    } else if (bot === 'sim5') {
      const idx = findMistakeIndex(0.05);
      const result = idx >= 0
        ? mistakeResults[idx]
        : solvePlayerMistakeBatch(game, job.simCount, 500000, { mistakeRate: 0.05 });
      metrics.set(bot, metricResultFromBatch(result));
    }
  }

  return {
    type: 'result',
    index: job.index,
    replayKey: job.row.replayKey,
    line: outputRowLine(job.row, mistakeWinRates, job.metricBots, metrics, terrainTiles.length),
    m0: mistakeWinRates[0] ?? 0,
    m5: mistakeWinRates[5] ?? 0,
    m7: mistakeWinRates[6] ?? 0,
    m10: mistakeWinRates[7] ?? 0,
    m15: mistakeWinRates[8] ?? 0,
    metrics: Object.fromEntries(job.metricBots.map(bot => [bot, metrics.get(bot)?.winRate ?? 0])),
  };
}

function sendWorkerMessage(message: WorkerMessage): void {
  if (process.send) process.send(message);
}

async function runSweepJobs(
  jobs: SweepJob[],
  opts: Options,
  outputFile: string,
  checkpointFile: string,
): Promise<void> {
  let next = 0;
  let done = 0;
  const startedAt = performance.now();
  const script = fileURLToPath(import.meta.url);

  const writeCheckpoint = () => {
    writeFileSync(checkpointFile, JSON.stringify({
      done: done >= jobs.length,
      completedCount: done,
      total: jobs.length,
      outputFile,
      concurrency: opts.concurrency,
      updatedAt: new Date().toISOString(),
    }, null, 2), 'utf-8');
  };

  const runOne = (job: SweepJob) => new Promise<void>((resolvePromise, reject) => {
    let gotResult = false;
    const child = fork(script, ['--worker'], {
      execArgv: process.execArgv.filter(arg => !['--eval', '-e', '--print', '-p'].includes(arg)),
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });

    child.on('message', (message: WorkerMessage) => {
      if (message.type === 'error') {
        reject(new Error(`${message.replayKey}: ${message.error}`));
        return;
      }

      gotResult = true;
      appendFileSync(outputFile, `${message.line}\n`, 'utf-8');
      done++;
      writeCheckpoint();

      console.log(`progress ${done}/${jobs.length}`);
    });

    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0 && gotResult) resolvePromise();
      else if (code === 0) reject(new Error(`worker ${job.row.replayKey} exited without result`));
      else reject(new Error(`worker ${job.row.replayKey} exited with code ${code}`));
    });
    child.send(job);
  });

  const workers = Array.from({ length: Math.min(opts.concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      await runOne(job);
    }
  });

  writeCheckpoint();
  await Promise.all(workers);
  writeCheckpoint();
}

async function main(): Promise<void> {
  const opts = parseOptions();
  const outputDir = join(BASE_OUTPUT, opts.outputName);
  const outputFile = join(outputDir, '原始数据.csv');
  const checkpointFile = join(outputDir, 'checkpoint.json');

  setLogLevel(LogLevel.Silent);
  mkdirSync(outputDir, { recursive: true });

  if (!existsSync(outputFile) || !opts.resume) {
    writeFileSync(outputFile, outputHeader(opts.metricBots) + '\n', 'utf-8');
  }

  const inputRows = parseInputRows(opts.inputFile);
  const terrainMap = buildTerrainMap();
  const validRows = inputRows.filter(row => terrainMap.has(row.terrainId));
  const completedKeys = opts.resume ? readCompletedKeys(outputFile) : new Set<string>();
  const rows = selectRows(validRows, opts).filter(row => !completedKeys.has(row.replayKey));
  const jobs: SweepJob[] = rows.map((row, index) => ({
    index,
    total: rows.length,
    row,
    terrainPath: terrainMap.get(row.terrainId)!,
    simCount: opts.simCount,
    metricBots: opts.metricBots,
  }));

  console.log('selected sweep');
  console.log(`input: ${opts.inputFile}`);
  console.log(`output: ${outputFile}`);
  console.log(`rows: ${rows.length}, skippedByResume: ${completedKeys.size}, simCount: ${opts.simCount}, concurrency: ${opts.concurrency}`);
  console.log(`rates: ${MISTAKE_RATES.map(rate => `${Math.round(rate * 100)}%`).join(', ')}`);
  console.log(`metric bots: ${opts.metricBots.length ? opts.metricBots.join(', ') : 'none'}`);
  if (opts.samplePerOnlineBucket > 0) {
    console.log(`sample: ${opts.samplePerOnlineBucket}/bucket, seed=${opts.sampleSeed}`);
  }

  await runSweepJobs(jobs, opts, outputFile, checkpointFile);

  console.log(`done: ${outputFile}`);
}

if (process.argv.includes('--worker')) {
  process.on('message', message => {
    try {
      sendWorkerMessage(processJob(message as SweepJob));
      process.exit(0);
    } catch (error) {
      const job = message as Partial<SweepJob>;
      sendWorkerMessage({
        type: 'error',
        index: job.index ?? -1,
        replayKey: job.row?.replayKey ?? 'unknown',
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  });
} else {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
