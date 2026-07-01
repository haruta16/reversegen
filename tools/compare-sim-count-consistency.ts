#!/usr/bin/env npx tsx
/** Compare Strategy2 + Optimal decisions at two simulation counts on confirmed replays. */

import { fork } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import {
  decodeFromString,
  getAllTiles,
  getCanonicalTileOrder,
  loadTerrainFromFile,
  LogLevel,
  setLogLevel,
} from '../src/index.js';
import { gradeStrategy2, type SimSnapshot } from '../src/grader.js';
import { createGame } from '../src/solver/offline-game.js';
import { solvePlayerMistakeBatch } from '../src/solver/index.js';
import { solvePlayerShortestBatch, type ShortestSimBatchResult } from '../src/solver/solver-player-shortest.js';
import { mulberry32 } from '../src/random-utils.js';
import type { TerrainTile } from '../src/types.js';

setLogLevel(LogLevel.Silent);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TERRAIN_DIRS = [
  '/Users/wenhaowang/WorkSpace/TileMatchShell/Tools/Config/Json/Levels',
  '/Users/wenhaowang/WorkSpace/levels_json/正式关卡',
  '/Users/wenhaowang/WorkSpace/levels_json/关卡备份',
  '/Users/wenhaowang/WorkSpace/levels_json/关卡调整',
];

interface SourceRow {
  index: number;
  levelResId: string;
  replayKey: string;
  replayCode: string;
  originalGrade: number;
}

interface Job {
  type: 'job';
  row: SourceRow;
  terrainPath: string;
  lowRuns: number;
  referenceRuns: number;
}

interface Decision {
  grade: number;
  passrate: number;
  optimalWinRate: number;
  winStarvationPerTile: number;
  lossRemainingRatio: number;
  accepted: boolean;
}

interface Result {
  row: SourceRow;
  low: Decision;
  reference: Decision;
  lowMs: number;
  referenceMs: number;
}

type WorkerMessage =
  | { type: 'result'; result: Result }
  | { type: 'error'; index: number; error: string };

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function absolute(path: string): string {
  return path.startsWith('/') ? path : resolve(ROOT, path);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(items => items.some(Boolean));
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function loadRows(path: string): { headers: string[]; rows: string[][] } {
  const parsed = parseCsv(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  return { headers: parsed[0] ?? [], rows: parsed.slice(1) };
}

function terrainMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const dir of TERRAIN_DIRS) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (file.endsWith('.json') && !map.has(file.slice(0, -5))) map.set(file.slice(0, -5), join(dir, file));
    }
  }
  return map;
}

function decodeGame(replayCode: string, terrainTiles: TerrainTile[]) {
  const replay = decodeFromString(replayCode);
  if (!replay) throw new Error('Replay decode failed');
  const ordered = getCanonicalTileOrder(terrainTiles);
  const elementValues = new Map<number, number>();
  const initialDock: { tileId: number; element: number }[] = [];
  const eliminatedTileIds = new Set<number>();
  for (let i = 0; i < ordered.length && i < replay.instanceArray.length; i++) {
    const byte = replay.instanceArray[i];
    const state = (byte >> 6) & 0x3;
    const element = (byte & 0x3f) + 1;
    elementValues.set(ordered[i].id, element);
    if (state === 1) eliminatedTileIds.add(ordered[i].id);
    else if (state === 2) initialDock.push({ tileId: ordered[i].id, element });
  }
  for (const entry of replay.dockEntries) {
    if (entry.tileId < 0 || entry.tileId >= ordered.length) continue;
    const tileId = ordered[entry.tileId].id;
    if (!initialDock.some(item => item.tileId === tileId)) initialDock.push({ tileId, element: entry.element });
  }
  return createGame({ terrainTiles, elementValues, initialDock, eliminatedTileIds });
}

function optimalAccepted(grade: number, batch: ShortestSimBatchResult, totalTiles: number): Decision {
  const winStarvationPerTile = totalTiles > 0 ? batch.starvationOnWin / totalTiles : 0;
  const lossRemainingRatio = totalTiles > 0 ? Math.max(0, totalTiles - batch.stepsOnLoss) / totalTiles : 0;
  let accepted = false;
  if (grade === 1) accepted = batch.winRate >= 0.95 && winStarvationPerTile >= 0 && winStarvationPerTile < 0.16;
  else if (grade === 2) accepted = batch.winRate >= 0.90 && winStarvationPerTile >= 0.08 && winStarvationPerTile < 0.25;
  else if (grade === 3) accepted = batch.winRate >= 0.80 && winStarvationPerTile >= 0.16 && winStarvationPerTile < 0.34;
  else if (grade === 4 || grade === 5) accepted = batch.winRate > 0 && batch.winRate < 0.80 && lossRemainingRatio <= 0.40;
  return {
    grade,
    passrate: 0,
    optimalWinRate: batch.winRate,
    winStarvationPerTile,
    lossRemainingRatio,
    accepted,
  };
}

function evaluate(game: ReturnType<typeof decodeGame>, runs: number, seed: number, totalTiles: number): Decision {
  const simulate = (mistakeRate: number, offset: number) => {
    const result = solvePlayerMistakeBatch(game, runs, seed + offset, { mistakeRate });
    return { winRate: result.winRate, wins: result.wins, losses: result.losses, runs, elapsedMs: result.elapsedMs };
  };
  const snapshot: SimSnapshot = {
    sim1: simulate(0.01, 1),
    sim5: simulate(0.05, 2),
    sim15: simulate(0.15, 3),
  };
  const verdict = gradeStrategy2(snapshot);
  const optimal = solvePlayerShortestBatch(game, runs, seed + 700000);
  return { ...optimalAccepted(verdict.grade, optimal, totalTiles), passrate: verdict.passrate };
}

function processJob(job: Job): Result {
  const terrainTiles = getAllTiles(loadTerrainFromFile(job.terrainPath));
  const game = decodeGame(job.row.replayCode, terrainTiles);
  const seed = 1200000 + job.row.index * 1009;
  const referenceStart = performance.now();
  const reference = evaluate(game, job.referenceRuns, seed, terrainTiles.length);
  const referenceMs = performance.now() - referenceStart;
  const lowStart = performance.now();
  const low = evaluate(game, job.lowRuns, seed, terrainTiles.length);
  const lowMs = performance.now() - lowStart;
  return { row: job.row, low, reference, lowMs, referenceMs };
}

function shuffle<T>(items: T[], rng: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

async function main(): Promise<void> {
  const fullPath = absolute(arg('--input-full', 'output/replay导出_G5替换/selection_optimal.csv'));
  const confirmedPath = absolute(arg('--input-confirmed', 'output/replay导出_G5替换/selection_Optimal体验筛选_v1.csv'));
  const outputPath = absolute(arg('--output', 'output/Optimal_20_vs_100_一致性样本.csv'));
  const reportPath = absolute(arg('--report', 'output/Optimal_20_vs_100_一致性报告.json'));
  const samplePerGrade = Math.max(1, Number(arg('--sample-per-grade', '10')));
  const lowRuns = Math.max(1, Number(arg('--low-runs', '20')));
  const referenceRuns = Math.max(lowRuns, Number(arg('--reference-runs', '100')));
  const concurrency = Math.max(1, Math.min(Number(arg('--concurrency', '5')), availableParallelism()));
  const full = loadRows(fullPath);
  const confirmed = loadRows(confirmedPath);
  const confirmedReplayIndex = confirmed.headers.indexOf('ReplayCode');
  const confirmedCodes = new Set(confirmed.rows.map(row => row[confirmedReplayIndex]));
  const index = (name: string) => full.headers.indexOf(name);
  const source: SourceRow[] = full.rows.map((row, rowIndex) => ({
    index: rowIndex,
    levelResId: row[index('levelResId')],
    replayKey: row[index('ReplayKey')],
    replayCode: row[index('ReplayCode')],
    originalGrade: Number(row[index('grade')]),
  })).filter(row => confirmedCodes.has(row.replayCode) && row.originalGrade >= 1 && row.originalGrade <= 5);
  const rng = mulberry32(Number(arg('--sample-seed', '20260630')));
  const sample: SourceRow[] = [];
  for (let grade = 1; grade <= 5; grade++) {
    const rows = source.filter(row => row.originalGrade === grade);
    shuffle(rows, rng);
    sample.push(...rows.slice(0, samplePerGrade));
  }
  const terrains = terrainMap();
  const jobs: Job[] = sample.map(row => {
    const terrainPath = terrains.get(row.levelResId);
    if (!terrainPath) throw new Error(`Missing terrain ${row.levelResId}`);
    return { type: 'job', row, terrainPath, lowRuns, referenceRuns };
  });
  const results: Result[] = [];
  let next = 0;
  let done = 0;
  const script = fileURLToPath(import.meta.url);
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const result = await new Promise<Result>((resolvePromise, reject) => {
        const child = fork(script, ['--worker'], {
          execArgv: process.execArgv.filter(item => !['--eval', '-e', '--print', '-p'].includes(item)),
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        });
        child.on('message', (message: WorkerMessage) => {
          if (message.type === 'result') resolvePromise(message.result);
          else reject(new Error(message.error));
        });
        child.on('error', reject);
        child.on('exit', code => { if (code !== 0) reject(new Error(`worker exit ${code}`)); });
        child.send(job);
      });
      results.push(result);
      done++;
      process.stdout.write(`\rprogress ${done}/${jobs.length}`);
    }
  }));
  process.stdout.write('\n');
  results.sort((a, b) => a.row.index - b.row.index);
  const headers = [
    'levelResId', 'ReplayKey', 'originalGrade',
    `grade_${referenceRuns}`, `grade_${lowRuns}`, 'grade一致',
    `passrate_${referenceRuns}`, `passrate_${lowRuns}`,
    `optimalWin_${referenceRuns}`, `optimalWin_${lowRuns}`,
    `winStarvationPerTile_${referenceRuns}`, `winStarvationPerTile_${lowRuns}`,
    `lossRemainingRatio_${referenceRuns}`, `lossRemainingRatio_${lowRuns}`,
    `accepted_${referenceRuns}`, `accepted_${lowRuns}`, '验收一致', '最终决策一致',
    `elapsedMs_${referenceRuns}`, `elapsedMs_${lowRuns}`,
  ];
  const lines = [headers.join(',')];
  for (const result of results) {
    const gradeSame = result.reference.grade === result.low.grade;
    const acceptedSame = result.reference.accepted === result.low.accepted;
    const decisionSame = gradeSame && acceptedSame;
    lines.push([
      result.row.levelResId, result.row.replayKey, result.row.originalGrade,
      result.reference.grade, result.low.grade, gradeSame ? 1 : 0,
      result.reference.passrate, result.low.passrate,
      result.reference.optimalWinRate, result.low.optimalWinRate,
      result.reference.winStarvationPerTile, result.low.winStarvationPerTile,
      result.reference.lossRemainingRatio, result.low.lossRemainingRatio,
      result.reference.accepted ? 1 : 0, result.low.accepted ? 1 : 0,
      acceptedSame ? 1 : 0, decisionSame ? 1 : 0,
      result.referenceMs, result.lowMs,
    ].map(csvCell).join(','));
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `\uFEFF${lines.join('\n')}\n`, 'utf8');
  const byGrade: Record<string, object> = {};
  for (let grade = 1; grade <= 5; grade++) {
    const subset = results.filter(result => result.row.originalGrade === grade);
    byGrade[`G${grade}`] = {
      samples: subset.length,
      gradeAgreement: subset.filter(result => result.reference.grade === result.low.grade).length / subset.length,
      acceptanceAgreement: subset.filter(result => result.reference.accepted === result.low.accepted).length / subset.length,
      decisionAgreement: subset.filter(result => (
        result.reference.grade === result.low.grade && result.reference.accepted === result.low.accepted
      )).length / subset.length,
    };
  }
  const shiftMatrix: Record<string, number> = {};
  for (const result of results) {
    const key = `G${result.reference.grade}->G${result.low.grade}`;
    shiftMatrix[key] = (shiftMatrix[key] ?? 0) + 1;
  }
  const sumMs = (key: 'lowMs' | 'referenceMs') => results.reduce((sum, result) => sum + result[key], 0);
  const report = {
    sampleSize: results.length,
    samplePerGrade,
    lowRuns,
    referenceRuns,
    gradeAgreement: results.filter(result => result.reference.grade === result.low.grade).length / results.length,
    acceptanceAgreement: results.filter(result => result.reference.accepted === result.low.accepted).length / results.length,
    decisionAgreement: results.filter(result => (
      result.reference.grade === result.low.grade && result.reference.accepted === result.low.accepted
    )).length / results.length,
    acceptedAtReference: results.filter(result => result.reference.accepted).length,
    acceptedAtLow: results.filter(result => result.low.accepted).length,
    falseAcceptAtLow: results.filter(result => !result.reference.accepted && result.low.accepted).length,
    falseRejectAtLow: results.filter(result => result.reference.accepted && !result.low.accepted).length,
    runtime: {
      referenceMs: sumMs('referenceMs'),
      lowMs: sumMs('lowMs'),
      speedup: sumMs('referenceMs') / sumMs('lowMs'),
    },
    byGrade,
    shiftMatrix,
    output: outputPath,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv.includes('--worker')) {
  process.on('message', message => {
    const job = message as Job;
    try {
      process.send?.({ type: 'result', result: processJob(job) } satisfies WorkerMessage);
      process.exit(0);
    } catch (error) {
      process.send?.({
        type: 'error',
        index: job.row.index,
        error: error instanceof Error ? error.message : String(error),
      } satisfies WorkerMessage);
      process.exit(1);
    }
  });
} else {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
