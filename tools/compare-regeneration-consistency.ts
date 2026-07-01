#!/usr/bin/env npx tsx
/** Regenerate replay codes with identical generation parameters and compare grading decisions. */

import { fork } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  decodeFromString,
  generateBoardLayerClosure,
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
import type { TerrainData, TerrainTile } from '../src/types.js';

setLogLevel(LogLevel.Silent);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEVELS_DIR = '/Users/wenhaowang/WorkSpace/TileMatchShell/Tools/Config/Json/Levels';

interface SourceRow {
  index: number;
  levelResId: string;
  replayKey: string;
  replayCode: string;
  targetGrade: number;
  colorCount: number;
  closeRates: number[];
  spreadParam: number;
  debtPersistenceWeight: number;
}

interface Decision {
  grade: number;
  passrate: number;
  optimalWinRate: number;
  winStarvationPerTile: number;
  lossRemainingRatio: number;
  accepted: boolean;
}

interface Job {
  type: 'job';
  row: SourceRow;
  runs: number;
}

interface Result {
  row: SourceRow;
  regeneratedReplayCode: string;
  sameReplayCode: boolean;
  original: Decision;
  regenerated: Decision;
  elapsedMs: number;
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

function evaluateOptimal(grade: number, batch: ShortestSimBatchResult, totalTiles: number): Omit<Decision, 'passrate'> {
  const winStarvationPerTile = totalTiles > 0 ? batch.starvationOnWin / totalTiles : 0;
  const lossRemainingRatio = totalTiles > 0 ? Math.max(0, totalTiles - batch.stepsOnLoss) / totalTiles : 0;
  let accepted = false;
  if (grade === 1) accepted = batch.winRate >= 0.95 && winStarvationPerTile >= 0 && winStarvationPerTile < 0.16;
  else if (grade === 2) accepted = batch.winRate >= 0.90 && winStarvationPerTile >= 0.08 && winStarvationPerTile < 0.25;
  else if (grade === 3) accepted = batch.winRate >= 0.80 && winStarvationPerTile >= 0.16 && winStarvationPerTile < 0.34;
  else if (grade === 4 || grade === 5) accepted = batch.winRate > 0 && batch.winRate < 0.80 && lossRemainingRatio <= 0.40;
  return { grade, optimalWinRate: batch.winRate, winStarvationPerTile, lossRemainingRatio, accepted };
}

function evaluate(replayCode: string, terrainTiles: TerrainTile[], runs: number, seed: number): Decision {
  const game = decodeGame(replayCode, terrainTiles);
  const sim = (mistakeRate: number, offset: number) => {
    const result = solvePlayerMistakeBatch(game, runs, seed + offset, { mistakeRate });
    return { winRate: result.winRate, wins: result.wins, losses: result.losses, runs, elapsedMs: result.elapsedMs };
  };
  const snapshot: SimSnapshot = { sim1: sim(0.01, 1), sim5: sim(0.05, 2), sim15: sim(0.15, 3) };
  const verdict = gradeStrategy2(snapshot);
  const optimal = solvePlayerShortestBatch(game, runs, seed + 700000);
  return { ...evaluateOptimal(verdict.grade, optimal, terrainTiles.length), passrate: verdict.passrate };
}

function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function processJob(job: Job): Result {
  const terrainPath = resolve(LEVELS_DIR, `${job.row.levelResId}.json`);
  const terrain: TerrainData = loadTerrainFromFile(terrainPath);
  const terrainTiles = getAllTiles(terrain);
  const started = performance.now();
  const generated = generateBoardLayerClosure({
    terrain,
    closeRates: job.row.closeRates,
    colorCount: job.row.colorCount,
    dock: 7,
    spreadParam: job.row.spreadParam,
    debtPersistenceWeight: job.row.debtPersistenceWeight,
  });
  const seed = hashSeed(`${job.row.levelResId}:${job.row.replayKey}:regeneration-v1`);
  const original = evaluate(job.row.replayCode, terrainTiles, job.runs, seed);
  const regenerated = evaluate(generated.replayCode, terrainTiles, job.runs, seed);
  return {
    row: job.row,
    regeneratedReplayCode: generated.replayCode,
    sameReplayCode: generated.replayCode === job.row.replayCode,
    original,
    regenerated,
    elapsedMs: performance.now() - started,
  };
}

function shuffle<T>(items: T[], rng: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

async function main(): Promise<void> {
  const inputPath = absolute(arg('--input', 'output/generation_feature/runs/optimal_experience_backfill_20260629/01_generation/backfill.csv'));
  const outputPath = absolute(arg('--output', 'output/同参数重生成_分档一致性样本.csv'));
  const reportPath = absolute(arg('--report', 'output/同参数重生成_分档一致性报告.json'));
  const samplePerGrade = Math.max(1, Number(arg('--sample-per-grade', '10')));
  const runs = Math.max(1, Number(arg('--runs', '100')));
  const concurrency = Math.max(1, Math.min(Number(arg('--concurrency', '3')), availableParallelism()));
  const parsed = parseCsv(readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, ''));
  const headers = parsed[0];
  const index = (name: string) => headers.indexOf(name);
  const rows: SourceRow[] = parsed.slice(1).map((row, rowIndex) => ({
    index: rowIndex,
    levelResId: row[index('levelResId')],
    replayKey: row[index('ReplayKey')],
    replayCode: row[index('ReplayCode')],
    targetGrade: Number(row[index('grade')]),
    colorCount: Number(row[index('colorCount')]),
    closeRates: row[index('closeRates')].split(',').map(Number),
    spreadParam: Number(row[index('spreadParam')]),
    debtPersistenceWeight: Number(row[index('debtPersistenceWeight')]),
  })).filter(row => row.targetGrade >= 1 && row.targetGrade <= 5 && row.replayCode && row.closeRates.length > 0);
  const rng = mulberry32(Number(arg('--sample-seed', '20260630')));
  const sample: SourceRow[] = [];
  for (let grade = 1; grade <= 5; grade++) {
    const candidates = rows.filter(row => row.targetGrade === grade);
    shuffle(candidates, rng);
    sample.push(...candidates.slice(0, samplePerGrade));
  }
  const jobs: Job[] = sample.map(row => ({ type: 'job', row, runs }));
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
  const outputHeaders = [
    'levelResId', 'ReplayKey', 'targetGrade', 'colorCount', 'closeRates', 'spreadParam', 'debtPersistenceWeight',
    'originalReplayCode', 'regeneratedReplayCode', 'ReplayCode相同',
    'originalFixedGrade', 'regeneratedGrade', '档位一致', '重生成命中目标档',
    'originalFixedPassrate', 'regeneratedPassrate',
    'originalOptimalWinRate', 'regeneratedOptimalWinRate',
    'originalAccepted', 'regeneratedAccepted', '验收一致', '重生成命中目标且验收通过', 'elapsedMs',
  ];
  const lines = [outputHeaders.join(',')];
  for (const result of results) {
    const gradeSame = result.original.grade === result.regenerated.grade;
    const targetGradeHit = result.regenerated.grade === result.row.targetGrade;
    const acceptanceSame = result.original.accepted === result.regenerated.accepted;
    lines.push([
      result.row.levelResId, result.row.replayKey, result.row.targetGrade,
      result.row.colorCount, result.row.closeRates.join('|'), result.row.spreadParam, result.row.debtPersistenceWeight,
      result.row.replayCode, result.regeneratedReplayCode, result.sameReplayCode ? 1 : 0,
      result.original.grade, result.regenerated.grade, gradeSame ? 1 : 0, targetGradeHit ? 1 : 0,
      result.original.passrate, result.regenerated.passrate,
      result.original.optimalWinRate, result.regenerated.optimalWinRate,
      result.original.accepted ? 1 : 0, result.regenerated.accepted ? 1 : 0,
      acceptanceSame ? 1 : 0, targetGradeHit && result.regenerated.accepted ? 1 : 0, result.elapsedMs,
    ].map(csvCell).join(','));
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `\uFEFF${lines.join('\n')}\n`, 'utf8');
  const byGrade: Record<string, object> = {};
  for (let grade = 1; grade <= 5; grade++) {
    const subset = results.filter(result => result.row.targetGrade === grade);
    const count = subset.length;
    byGrade[`G${grade}`] = {
      samples: count,
      replayChanged: subset.filter(result => !result.sameReplayCode).length,
      gradeAgreement: subset.filter(result => result.original.grade === result.regenerated.grade).length / count,
      targetGradeReproduction: subset.filter(result => result.regenerated.grade === grade).length / count,
      acceptanceAgreement: subset.filter(result => result.original.accepted === result.regenerated.accepted).length / count,
      targetAndAcceptedReproduction: subset.filter(result => (
        result.regenerated.grade === grade && result.regenerated.accepted
      )).length / count,
    };
  }
  const shiftMatrix: Record<string, number> = {};
  for (const result of results) {
    const key = `G${result.original.grade}->G${result.regenerated.grade}`;
    shiftMatrix[key] = (shiftMatrix[key] ?? 0) + 1;
  }
  const report = {
    input: inputPath,
    sampleSize: results.length,
    samplePerGrade,
    runs,
    replayChanged: results.filter(result => !result.sameReplayCode).length,
    gradeAgreement: results.filter(result => result.original.grade === result.regenerated.grade).length / results.length,
    targetGradeReproduction: results.filter(result => result.regenerated.grade === result.row.targetGrade).length / results.length,
    acceptanceAgreement: results.filter(result => result.original.accepted === result.regenerated.accepted).length / results.length,
    targetAndAcceptedReproduction: results.filter(result => (
      result.regenerated.grade === result.row.targetGrade && result.regenerated.accepted
    )).length / results.length,
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
