#!/usr/bin/env npx tsx
/** Generate boards by pure random color placement at a fixed color-count ratio and grade them. */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeCloseRatesFromAssignments,
  computeDependencyDepth,
  generateReplayCode,
  getAllTiles,
  getCanonicalTileOrder,
  loadTerrainFromFile,
  LogLevel,
  setLogLevel,
} from '../src/index.js';
import { colorCountFromRatio } from '../src/batch-generator.js';
import { gradeStrategy2, type SimResult, type SimSnapshot } from '../src/grader.js';
import { mulberry32 } from '../src/random-utils.js';
import { createGame } from '../src/solver/offline-game.js';
import { solvePlayerMistakeBatch } from '../src/solver/index.js';
import { solvePlayerShortestBatch } from '../src/solver/solver-player-shortest.js';
import type { TerrainData, TerrainTile } from '../src/types.js';

setLogLevel(LogLevel.Silent);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SOURCE = 'output/strategy_runs/20260630_至少8局当前校准/01_data/每档至少8局_全部保留.csv';
const DEFAULT_OUTPUT = 'output/random_color_ratio_055/generated.csv';
const DEFAULT_LEVELS_DIR = '/Users/wenhaowang/WorkSpace/TileMatchShell/Tools/Config/Json/Levels';

interface OutputRow {
  levelResId: string;
  ReplayKey: string;
  ReplayCode: string;
  grade: number;
  passrate: number;
  ElementCount: number;
  DifficultyScore: number;
  CompletionStatus: string;
  ExpectConsume: number;
  LevelTags: string;
  ReplayTags: string;
  highWinRate: number;
  MiddleWinRate: number;
  LowWinRate: number;
  colorCount: number;
  colorRatio: number;
  baseColorCount: number;
  colorOffset: number;
  closeRates: string;
  closeMean: number;
  closeStd: number;
  closeRange: number;
  spreadParam: number;
  debtPersistenceWeight: number;
  simRuns: number;
  sim1Wins: number;
  sim5Wins: number;
  sim15Wins: number;
  totalTiles: number;
  optimalRuns: number;
  optimalWins: number;
  optimalLosses: number;
  optimalWinRate: number;
  optimalForcedPickOnWin: number;
  optimalStarvationOnWin: number;
  optimalStepsOnLoss: number;
  optimalForcedPickOnLoss: number;
  optimalStarvationOnLoss: number;
  optimalRemainingTilesOnLoss: number;
  optimalRemainingRatioOnLoss: number;
  attemptIndex: number;
  generator: string;
  terrainPath: string;
}

function arg(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
}

function flag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function absolute(path: string): string {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

function numArg(name: string, fallback: number): number {
  const value = Number(arg(name, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

function intListArg(name: string): number[] {
  const raw = arg(name, '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map(part => Number(part.trim()))
    .filter(value => Number.isFinite(value))
    .map(value => Math.trunc(value));
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

function shuffle<T>(items: T[], rng: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

function terrainIdsFromSource(path: string): string[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  const levelIndex = headers.findIndex(header => ['levelResId', '地形编号', 'LevelResID'].includes(header));
  if (levelIndex < 0) return [];
  return [...new Set(lines.slice(1)
    .map(line => parseCSVLine(line)[levelIndex]?.trim())
    .filter(Boolean))]
    .sort();
}

function terrainIdsFromDir(levelsDir: string): string[] {
  if (!existsSync(levelsDir)) return [];
  return readdirSync(levelsDir)
    .filter(file => file.endsWith('.json'))
    .map(file => file.slice(0, -5))
    .sort();
}

function pickLevels(levelsDir: string, sourcePath: string, count: number, seed: number, explicit: string): string[] {
  if (explicit.trim()) return explicit.split(',').map(part => part.trim()).filter(Boolean);
  const rng = mulberry32(seed);
  const sourceIds = terrainIdsFromSource(sourcePath);
  const available = new Set(terrainIdsFromDir(levelsDir));
  const candidates = (sourceIds.length > 0 ? sourceIds : [...available])
    .filter(id => available.has(id));
  shuffle(candidates, rng);
  return candidates.slice(0, Math.min(count, candidates.length));
}

function randomElementValuesByColorCount(terrain: TerrainData, colorCountInput: number, rng: () => number): {
  values: Map<number, number>;
  colorCount: number;
} {
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(tile => !tile.isConst);
  if (freeTiles.length % 3 !== 0) throw new Error(`${terrain.levelResId}: free tile count is not divisible by 3`);
  const triplets = freeTiles.length / 3;
  const colorCount = Math.max(1, Math.min(triplets, Math.trunc(colorCountInput)));
  const base = Math.floor(triplets / colorCount);
  const extra = triplets % colorCount;
  const bag: number[] = [];
  for (let color = 1; color <= colorCount; color++) {
    const count = (base + (color <= extra ? 1 : 0)) * 3;
    for (let i = 0; i < count; i++) bag.push(color);
  }
  shuffle(bag, rng);
  const values = new Map<number, number>();
  for (const tile of allTiles) {
    if (tile.isConst && tile.constElementValue > 0) values.set(tile.id, tile.constElementValue);
  }
  freeTiles.forEach((tile, index) => values.set(tile.id, bag[index]));
  return { values, colorCount };
}

function randomElementValues(terrain: TerrainData, ratio: number, rng: () => number): {
  values: Map<number, number>;
  colorCount: number;
} {
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(tile => !tile.isConst);
  return randomElementValuesByColorCount(terrain, colorCountFromRatio(ratio, freeTiles.length), rng);
}

function simResult(batch: ReturnType<typeof solvePlayerMistakeBatch>, runs: number): SimResult {
  return {
    winRate: batch.winRate,
    wins: batch.wins,
    losses: batch.losses,
    runs,
    elapsedMs: batch.elapsedMs,
  };
}

function closeRateStats(terrainTiles: TerrainTile[], values: Map<number, number>): {
  closeRates: number[];
  mean: number;
  std: number;
  range: number;
} {
  const freeTiles = terrainTiles.filter(tile => !tile.isConst);
  const tileMap = new Map(terrainTiles.map(tile => [tile.id, tile]));
  const depthMap = computeDependencyDepth(freeTiles, tileMap);
  const maxDepth = depthMap.size > 0 ? Math.max(...depthMap.values()) : 1;
  const depthLayers = Array.from({ length: maxDepth }, (_, index) =>
    freeTiles.filter(tile => depthMap.get(tile.id) === index + 1));
  const closeRates = computeCloseRatesFromAssignments(values, depthLayers);
  const mean = closeRates.length > 0 ? closeRates.reduce((sum, value) => sum + value, 0) / closeRates.length : 0;
  const variance = closeRates.length > 0
    ? closeRates.reduce((sum, value) => sum + (value - mean) ** 2, 0) / closeRates.length
    : 0;
  return {
    closeRates,
    mean,
    std: Math.sqrt(variance),
    range: closeRates.length > 0 ? Math.max(...closeRates) - Math.min(...closeRates) : 0,
  };
}

function evaluate(
  terrain: TerrainData,
  terrainPath: string,
  values: Map<number, number>,
  colorCount: number,
  ratio: number,
  baseColorCount: number,
  colorOffset: number,
  attempt: number,
  simRuns: number,
  optimalRuns: number,
  seed: number,
  generator: string,
): OutputRow {
  const allTiles = getAllTiles(terrain);
  const replayCode = generateReplayCode(getCanonicalTileOrder(allTiles), values, terrain.levelHash ?? '');
  const run = (mistakeRate: number, offset: number) => simResult(
    solvePlayerMistakeBatch(
      createGame({ terrainTiles: allTiles, elementValues: values }),
      simRuns,
      seed + offset,
      { mistakeRate },
    ),
    simRuns,
  );
  const snapshot: SimSnapshot = {
    sim1: run(0.01, 1000),
    sim5: run(0.05, 2000),
    sim15: run(0.15, 3000),
  };
  const verdict = gradeStrategy2(snapshot);
  const optimal = solvePlayerShortestBatch(
    createGame({ terrainTiles: allTiles, elementValues: values }),
    optimalRuns,
    seed + 4000,
  );
  const losses = optimal.results.filter(result => !result.win);
  const remainingTiles = losses.length > 0
    ? losses.reduce((sum, result) => sum + Math.max(0, allTiles.length - result.stepCount), 0) / losses.length
    : 0;
  const close = closeRateStats(allTiles, values);
  const totalTiles = allTiles.length;
  return {
    levelResId: String(terrain.levelResId ?? ''),
    ReplayKey: colorOffset === 0
      ? `random-color-${ratio.toFixed(2)}-${attempt}`
      : `random-color-${ratio.toFixed(2)}-${colorOffset > 0 ? 'p' : 'm'}${Math.abs(colorOffset)}-${attempt}`,
    ReplayCode: replayCode,
    grade: verdict.grade,
    passrate: verdict.passrate,
    ElementCount: colorCount,
    DifficultyScore: 0,
    CompletionStatus: 'Success',
    ExpectConsume: 0,
    LevelTags: `random-color-ratio-${ratio.toFixed(2)}`,
    ReplayTags: 'random-color',
    highWinRate: snapshot.sim1.winRate,
    MiddleWinRate: snapshot.sim5.winRate,
    LowWinRate: snapshot.sim15.winRate,
    colorCount,
    colorRatio: ratio,
    baseColorCount,
    colorOffset,
    closeRates: close.closeRates.map(value => value.toFixed(4)).join('|'),
    closeMean: close.mean,
    closeStd: close.std,
    closeRange: close.range,
    spreadParam: 0,
    debtPersistenceWeight: 0,
    simRuns,
    sim1Wins: snapshot.sim1.wins,
    sim5Wins: snapshot.sim5.wins,
    sim15Wins: snapshot.sim15.wins,
    totalTiles,
    optimalRuns,
    optimalWins: optimal.wins,
    optimalLosses: optimal.losses,
    optimalWinRate: optimal.winRate,
    optimalForcedPickOnWin: optimal.forcedPickOnWin,
    optimalStarvationOnWin: optimal.starvationOnWin,
    optimalStepsOnLoss: optimal.stepsOnLoss,
    optimalForcedPickOnLoss: optimal.forcedPickOnLoss,
    optimalStarvationOnLoss: optimal.starvationOnLoss,
    optimalRemainingTilesOnLoss: remainingTiles,
    optimalRemainingRatioOnLoss: totalTiles > 0 ? remainingTiles / totalTiles : 0,
    attemptIndex: attempt,
    generator,
    terrainPath,
  };
}

function writeCsv(path: string, rows: OutputRow[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const headers: Array<keyof OutputRow> = [
    'levelResId', 'ReplayKey', 'ReplayCode', 'grade', 'passrate', 'ElementCount',
    'DifficultyScore', 'CompletionStatus', 'ExpectConsume', 'LevelTags', 'ReplayTags',
    'highWinRate', 'MiddleWinRate', 'LowWinRate', 'colorCount', 'colorRatio',
    'baseColorCount', 'colorOffset',
    'closeRates', 'closeMean', 'closeStd', 'closeRange', 'spreadParam', 'debtPersistenceWeight',
    'simRuns', 'sim1Wins', 'sim5Wins', 'sim15Wins', 'totalTiles',
    'optimalRuns', 'optimalWins', 'optimalLosses', 'optimalWinRate',
    'optimalForcedPickOnWin', 'optimalStarvationOnWin', 'optimalStepsOnLoss',
    'optimalForcedPickOnLoss', 'optimalStarvationOnLoss',
    'optimalRemainingTilesOnLoss', 'optimalRemainingRatioOnLoss',
    'attemptIndex', 'generator', 'terrainPath',
  ];
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map(header => csvCell(row[header])).join(','));
  writeFileSync(path, `\uFEFF${lines.join('\n')}\n`, 'utf8');
}

function printHelp(): void {
  console.log(`Usage:
  npx tsx tools/random-color-ratio-sample.ts [options]

Options:
  --ratio <n>         Fixed random-color ratio. Default: 0.55
  --color-offsets <n> Comma-separated offsets from ratio-derived base color count.
                      Example: -3,-2,-1,0,1,2,3
  --levels <ids>      Comma-separated terrain IDs. Overrides source sampling.
  --level-count <n>   Number of terrains sampled from source. Default: 20
  --attempts <n>      Boards per terrain. Default: 4
  --sim-runs <n>      Strategy2 runs per mistake rate. Default: 30
  --optimal-runs <n>  Optimal metric runs during generation. Default: 30
  --seed <n>          Random seed. Default: 20260707
  --source <csv>      Source CSV used only for terrain sampling.
  --levels-dir <dir>  Terrain JSON directory.
  --output <csv>      Output CSV. Default: ${DEFAULT_OUTPUT}
`);
}

async function main(): Promise<void> {
  if (flag('--help') || flag('-h')) {
    printHelp();
    return;
  }
  const ratio = numArg('--ratio', 0.55);
  const colorOffsets = intListArg('--color-offsets');
  const levelCount = Math.max(1, Math.floor(numArg('--level-count', 20)));
  const attempts = Math.max(1, Math.floor(numArg('--attempts', 4)));
  const simRuns = Math.max(1, Math.floor(numArg('--sim-runs', 30)));
  const optimalRuns = Math.max(1, Math.floor(numArg('--optimal-runs', 30)));
  const seed = Math.floor(numArg('--seed', 20260707));
  const levelsDir = absolute(arg('--levels-dir', DEFAULT_LEVELS_DIR));
  const source = absolute(arg('--source', DEFAULT_SOURCE));
  const output = absolute(arg('--output', DEFAULT_OUTPUT));
  const levels = pickLevels(levelsDir, source, levelCount, seed, arg('--levels', ''));
  const rows: OutputRow[] = [];
  let done = 0;
  const colorVariants = colorOffsets.length > 0 ? colorOffsets : [0];
  const total = levels.length * attempts * colorVariants.length;
  for (const level of levels) {
    const terrainPath = join(levelsDir, `${level}.json`);
    const terrain = loadTerrainFromFile(terrainPath);
    const allTiles = getAllTiles(terrain);
    const freeTiles = allTiles.filter(tile => !tile.isConst);
    const baseColorCount = colorCountFromRatio(ratio, freeTiles.length);
    for (const colorOffset of colorVariants) {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const offsetSeedPart = (colorOffset + 100) * 104729;
        const candidateSeed = seed + Number(level) * 1009 + attempt * 9173 + offsetSeedPart;
        const rng = mulberry32(candidateSeed);
        const generated = colorOffsets.length > 0
          ? randomElementValuesByColorCount(terrain, baseColorCount + colorOffset, rng)
          : randomElementValues(terrain, ratio, rng);
        rows.push(evaluate(
          terrain,
          terrainPath,
          generated.values,
          generated.colorCount,
          ratio,
          baseColorCount,
          colorOffset,
          attempt,
          simRuns,
          optimalRuns,
          candidateSeed,
          colorOffsets.length > 0 ? 'random-color-count-offset' : 'random-color-fixed-ratio',
        ));
        done++;
        process.stdout.write(`\r\x1b[2Kgenerated ${done}/${total}`);
      }
    }
  }
  process.stdout.write('\n');
  writeCsv(output, rows);
  console.log(JSON.stringify({
    output,
    rows: rows.length,
    levels,
    ratio,
    colorOffsets: colorOffsets.length > 0 ? colorOffsets : undefined,
    attempts,
    simRuns,
    optimalRuns,
  }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
