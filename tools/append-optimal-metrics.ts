#!/usr/bin/env npx tsx
/** Run only the optimal bot and append its metrics after every source CSV row. */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fork, type ChildProcess } from 'node:child_process';
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
import { solvePlayerShortestBatch } from '../src/solver/solver-player-shortest.js';
import type { ReplayData, TerrainTile } from '../src/types.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TERRAIN_DIRS = [
  '/Users/wenhaowang/WorkSpace/TileMatchShell/Tools/Config/Json/Levels',
  '/Users/wenhaowang/WorkSpace/levels_json/正式关卡',
  '/Users/wenhaowang/WorkSpace/levels_json/关卡备份',
  '/Users/wenhaowang/WorkSpace/levels_json/关卡调整',
];
const METRIC_HEADERS = [
  '最优机器人模拟次数',
  '最优机器人胜局数',
  '最优机器人负局数',
  '最优机器人胜率(%)',
  '最优机器人胜局平均被迫选牌次数',
  '最优机器人胜局平均断色次数',
  '最优机器人负局平均已走步数',
  '地形总牌数',
  '最优机器人负局平均剩余牌数',
  '最优机器人负局平均剩余牌比例(%)',
  '最优机器人负局平均被迫选牌次数',
  '最优机器人负局平均断色次数',
];

interface InputRow {
  index: number;
  rawLine: string;
  terrainId: string;
  replayCode: string;
}

interface Job {
  type: 'job';
  index: number;
  terrainPath: string;
  replayCode: string;
  simCount: number;
}

interface Result {
  index: number;
  values: number[];
}

type WorkerMessage =
  | { type: 'result'; result: Result }
  | { type: 'error'; index: number; error: string };

function arg(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
}

function absolute(path: string): string {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

function parseCSVLine(line: string): string[] {
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

function loadInput(path: string): { header: string; rows: InputRow[] } {
  const lines = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error(`CSV has no data: ${path}`);
  const headers = parseCSVLine(lines[0]);
  const terrainIndex = headers.findIndex(name => ['levelResId', '地形编号', 'LevelResID'].includes(name));
  const replayIndex = headers.indexOf('ReplayCode');
  if (terrainIndex < 0 || replayIndex < 0) throw new Error('CSV requires levelResId/地形编号 and ReplayCode');
  return {
    header: lines[0],
    rows: lines.slice(1).map((rawLine, index) => {
      const cells = parseCSVLine(rawLine);
      return {
        index,
        rawLine,
        terrainId: String(cells[terrainIndex] ?? '').trim(),
        replayCode: String(cells[replayIndex] ?? '').trim(),
      };
    }),
  };
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

function decodeReplay(replayCode: string, terrainTiles: TerrainTile[]): {
  replayData: ReplayData;
  elementValues: Map<number, number>;
  initialDock: { tileId: number; element: number }[];
  eliminatedTileIds: Set<number>;
} {
  const replayData = decodeFromString(replayCode);
  if (!replayData) throw new Error('Replay decode failed');
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
    if (entry.tileId < 0 || entry.tileId >= ordered.length) continue;
    const tile = ordered[entry.tileId];
    if (!initialDock.some(item => item.tileId === tile.id)) {
      initialDock.push({ tileId: tile.id, element: entry.element });
    }
  }
  return { replayData, elementValues, initialDock, eliminatedTileIds };
}

const cache = new Map<string, TerrainTile[]>();

function runJob(job: Job): Result {
  let tiles = cache.get(job.terrainPath);
  if (!tiles) {
    tiles = getAllTiles(loadTerrainFromFile(job.terrainPath));
    cache.set(job.terrainPath, tiles);
  }
  const replay = decodeReplay(job.replayCode, tiles);
  const game = createGame({
    terrainTiles: tiles,
    elementValues: replay.elementValues,
    initialDock: replay.initialDock,
    eliminatedTileIds: replay.eliminatedTileIds,
  });
  const batch = solvePlayerShortestBatch(game, job.simCount, 900000 + job.index * 1009);
  const losses = (batch.results ?? []).filter(result => !result.win);
  const remaining = losses.length
    ? losses.reduce((sum, result) => sum + Math.max(0, tiles.length - result.stepCount), 0) / losses.length
    : 0;
  return {
    index: job.index,
    values: [
      job.simCount,
      batch.wins,
      batch.losses,
      batch.winRate * 100,
      batch.forcedPickOnWin,
      batch.starvationOnWin,
      batch.stepsOnLoss,
      batch.forcedPickOnLoss,
      batch.starvationOnLoss,
      tiles.length,
      remaining,
      tiles.length ? remaining / tiles.length * 100 : 0,
    ],
  };
}

function loadProgress(path: string): Map<number, Result> {
  const map = new Map<number, Result>();
  if (!existsSync(path)) return map;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const result = JSON.parse(line) as Result;
    map.set(result.index, result);
  }
  return map;
}

function format(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '';
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function repairDerivedMetrics(result: Result, totalTiles: number): Result {
  const values = [...result.values];
  // Progress files created before totalTiles was recorded contain 11 values.
  if (values.length === 11) values.splice(9, 0, totalTiles);
  else values[9] = totalTiles;
  const stepsOnLoss = Number(Number(values[6] ?? 0).toFixed(2));
  values[6] = stepsOnLoss;
  values[10] = Math.max(0, totalTiles - stepsOnLoss);
  values[11] = totalTiles > 0 ? (1 - stepsOnLoss / totalTiles) * 100 : 0;
  return { ...result, values };
}

function outputMetricValues(result: Result): number[] {
  const values = result.values;
  // Internal/progress order remains stable; output keeps the loss formula inputs adjacent.
  return [
    ...values.slice(0, 7),
    values[9],
    values[10],
    values[11],
    values[7],
    values[8],
  ];
}

async function main(): Promise<void> {
  setLogLevel(LogLevel.Silent);
  const input = absolute(arg('--input', 'output/replay导出_G5替换/selection.csv'));
  const output = absolute(arg('--output', 'output/replay导出_G5替换/selection_optimal.csv'));
  const progress = absolute(arg('--progress', `${output}.progress.jsonl`));
  const checkpoint = absolute(arg('--checkpoint', `${output}.checkpoint.json`));
  const simCount = Math.max(1, Math.floor(Number(arg('--sim-count', '100'))));
  const concurrency = Math.max(1, Math.min(Math.floor(Number(arg('--concurrency', '5'))), availableParallelism()));
  const limit = Math.max(1, Math.floor(Number(arg('--limit', 'Infinity'))));
  const resume = process.argv.includes('--resume');
  if (!existsSync(input)) throw new Error(`Input not found: ${input}`);
  mkdirSync(dirname(output), { recursive: true });
  if (!resume) {
    writeFileSync(progress, '', 'utf8');
    writeFileSync(checkpoint, '{}\n', 'utf8');
  }

  const loaded = loadInput(input);
  const source = { header: loaded.header, rows: loaded.rows.slice(0, limit) };
  const terrains = terrainMap();
  const missing = [...new Set(source.rows.filter(row => !terrains.has(row.terrainId)).map(row => row.terrainId))];
  if (missing.length) throw new Error(`Missing terrain JSON: ${missing.join(', ')}`);
  const terrainTileCounts = new Map<string, number>();
  for (const row of source.rows) {
    if (!terrainTileCounts.has(row.terrainId)) {
      terrainTileCounts.set(row.terrainId, getAllTiles(loadTerrainFromFile(terrains.get(row.terrainId)!)).length);
    }
  }
  const results = resume ? loadProgress(progress) : new Map<number, Result>();
  const jobs: Job[] = source.rows.filter(row => !results.has(row.index)).map(row => ({
    type: 'job',
    index: row.index,
    terrainPath: terrains.get(row.terrainId)!,
    replayCode: row.replayCode,
    simCount,
  }));
  let next = 0;
  let completed = results.size;
  const children = new Set<ChildProcess>();
  const saveCheckpoint = (done: boolean) => writeFileSync(checkpoint, JSON.stringify({
    done,
    completedCount: completed,
    total: source.rows.length,
    simCount,
    concurrency,
    input,
    output,
    updatedAt: new Date().toISOString(),
  }, null, 2) + '\n', 'utf8');
  saveCheckpoint(jobs.length === 0);

  if (jobs.length) {
    await new Promise<void>((resolvePromise, reject) => {
      let stopped = false;
      let exited = 0;
      const workerCount = Math.min(concurrency, jobs.length);
      const stop = (error: Error) => {
        if (stopped) return;
        stopped = true;
        for (const child of children) child.kill();
        reject(error);
      };
      const assign = (child: ChildProcess) => {
        if (next < jobs.length) child.send?.(jobs[next++]);
        else child.send?.({ type: 'shutdown' });
      };
      for (let i = 0; i < workerCount; i++) {
        const child = fork(fileURLToPath(import.meta.url), ['--worker'], {
          execArgv: process.execArgv.filter(item => !['--eval', '-e', '--print', '-p'].includes(item)),
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        });
        children.add(child);
        child.on('message', (message: WorkerMessage) => {
          if (message.type === 'error') {
            stop(new Error(`row ${message.index + 2}: ${message.error}`));
            return;
          }
          results.set(message.result.index, message.result);
          appendFileSync(progress, `${JSON.stringify(message.result)}\n`, 'utf8');
          completed++;
          saveCheckpoint(false);
          console.log(`progress ${completed}/${source.rows.length}`);
          assign(child);
        });
        child.on('error', stop);
        child.on('exit', code => {
          children.delete(child);
          if (stopped) return;
          if (code !== 0) {
            stop(new Error(`worker exited with code ${code}`));
            return;
          }
          exited++;
          if (exited === workerCount) resolvePromise();
        });
        assign(child);
      }
    });
  }

  const lines = [`${source.header},${METRIC_HEADERS.join(',')}`];
  for (const row of source.rows) {
    const saved = results.get(row.index);
    const result = saved ? repairDerivedMetrics(saved, terrainTileCounts.get(row.terrainId)!) : null;
    if (!result) throw new Error(`Missing result for row ${row.index + 2}`);
    lines.push(`${row.rawLine},${outputMetricValues(result).map(value => csvCell(format(value))).join(',')}`);
  }
  writeFileSync(output, `\uFEFF${lines.join('\n')}\n`, 'utf8');
  saveCheckpoint(true);
  console.log(`done: ${output}`);
}

if (process.argv.includes('--worker')) {
  setLogLevel(LogLevel.Silent);
  process.on('message', message => {
    if ((message as { type?: string }).type === 'shutdown') {
      process.exit(0);
      return;
    }
    const job = message as Job;
    try {
      process.send?.({ type: 'result', result: runJob(job) } satisfies WorkerMessage);
    } catch (error) {
      process.send?.({
        type: 'error',
        index: job.index,
        error: error instanceof Error ? error.message : String(error),
      } satisfies WorkerMessage);
    }
  });
} else {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
