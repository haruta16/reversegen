#!/usr/bin/env npx tsx

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  decodeFromString,
  generateBoardLayerClosure,
  generateReplayCode,
  getAllTiles,
  getCanonicalTileOrder,
  loadTerrainFromFile,
  LogLevel,
  setLogLevel,
} from '../src/index.js';
import { colorCountFromRatio, randomizeCloseRatesFromTiles } from '../src/batch-generator.js';
import { gradeStrategy2, type SimResult, type SimSnapshot } from '../src/grader.js';
import { mulberry32 } from '../src/random-utils.js';
import { createGame } from '../src/solver/offline-game.js';
import { solvePlayerMistakeBatch } from '../src/solver/index.js';
import { solvePlayerShortestBatch } from '../src/solver/solver-player-shortest.js';
import type { TerrainData } from '../src/types.js';

type Mode = 'structured' | 'random-placement';

interface CandidateResult {
  levelResId: string;
  mode: Mode;
  attempt: number;
  colorCount: number;
  optimalWinRate: number;
  optimalStarvationPerTile: number;
  optimalLossRemainingRatio: number;
  optimalPassed: boolean;
  strategyGrade: number | null;
  strategyPassrate: number | null;
  accepted: boolean;
  replayCode: string;
}

const repoRoot = resolve(import.meta.dirname, '..');
setLogLevel(LogLevel.Silent);

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function absolute(path: string): string {
  return path.startsWith('/') ? path : resolve(repoRoot, path);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function shuffle<T>(items: T[], rng: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

function colorCountFor(terrain: TerrainData, rng: () => number): number {
  const freeTiles = getAllTiles(terrain).filter(tile => !tile.isConst).length;
  const ratio = 0.5 + rng() * 0.1;
  const jitter = Math.floor(rng() * 3) - 1;
  return Math.max(1, colorCountFromRatio(ratio, freeTiles) + jitter);
}

function randomElementValues(terrain: TerrainData, colorCount: number, rng: () => number): Map<number, number> {
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(tile => !tile.isConst);
  if (freeTiles.length % 3 !== 0) throw new Error(`${terrain.levelResId}: 自由牌数不是3的倍数`);
  const triplets = freeTiles.length / 3;
  const base = Math.floor(triplets / colorCount);
  const extra = triplets % colorCount;
  const colorBag: number[] = [];
  for (let color = 1; color <= colorCount; color++) {
    const tileCount = (base + (color <= extra ? 1 : 0)) * 3;
    for (let i = 0; i < tileCount; i++) colorBag.push(color);
  }
  shuffle(colorBag, rng);
  const values = new Map<number, number>();
  for (const tile of allTiles) {
    if (tile.isConst && tile.constElementValue > 0) values.set(tile.id, tile.constElementValue);
  }
  freeTiles.forEach((tile, index) => values.set(tile.id, colorBag[index]));
  return values;
}

function elementValuesFromReplay(terrain: TerrainData, replayCode: string): Map<number, number> {
  const decoded = decodeFromString(replayCode);
  if (!decoded) throw new Error('ReplayCode解码失败');
  const ordered = getCanonicalTileOrder(getAllTiles(terrain));
  const values = new Map<number, number>();
  for (let i = 0; i < ordered.length && i < decoded.instanceArray.length; i++) {
    values.set(ordered[i].id, (decoded.instanceArray[i] & 0x3f) + 1);
  }
  return values;
}

function makeReplay(
  terrain: TerrainData,
  mode: Mode,
  colorCount: number,
  rng: () => number,
): { replayCode: string; values: Map<number, number> } {
  const allTiles = getAllTiles(terrain);
  if (mode === 'random-placement') {
    const values = randomElementValues(terrain, colorCount, rng);
    return {
      values,
      replayCode: generateReplayCode(getCanonicalTileOrder(allTiles), values, terrain.levelHash ?? ''),
    };
  }
  const generated = generateBoardLayerClosure({
    terrain,
    colorCount,
    dock: 7,
    closeRates: randomizeCloseRatesFromTiles(allTiles, rng),
    spreadParam: 0.7 + rng() * 0.3,
    debtPersistenceWeight: 0.5 + rng() * 0.5,
  });
  const values = new Map<number, number>();
  for (const tile of allTiles) {
    if (tile.isConst && tile.constElementValue > 0) values.set(tile.id, tile.constElementValue);
  }
  for (const [tileId, color] of generated.assignments) values.set(tileId, color);
  return { values, replayCode: generated.replayCode };
}

function simResult(batch: ReturnType<typeof solvePlayerMistakeBatch>, runs: number): SimResult {
  return { winRate: batch.winRate, wins: batch.wins, losses: batch.losses, runs, elapsedMs: batch.elapsedMs };
}

function passesChallengeOptimal(winRate: number, lossRemainingRatio: number): boolean {
  return winRate > 0 && winRate < 0.8 && lossRemainingRatio <= 0.4;
}

function evaluate(
  terrain: TerrainData,
  values: Map<number, number>,
  replayCode: string,
  mode: Mode,
  attempt: number,
  colorCount: number,
  runs: number,
  seed: number,
): CandidateResult {
  const allTiles = getAllTiles(terrain);
  const optimal = solvePlayerShortestBatch(createGame({ terrainTiles: allTiles, elementValues: values }), runs, seed);
  const lossResults = (optimal.results ?? []).filter(result => !result.win);
  const remainingRatio = lossResults.length > 0
    ? lossResults.reduce((sum, result) => sum + Math.max(0, allTiles.length - result.stepCount) / allTiles.length, 0) / lossResults.length
    : 0;
  const optimalPassed = passesChallengeOptimal(optimal.winRate, remainingRatio);
  let grade: number | null = null;
  let passrate: number | null = null;
  if (optimalPassed) {
    const run = (mistakeRate: number, offset: number) => simResult(
      solvePlayerMistakeBatch(
        createGame({ terrainTiles: allTiles, elementValues: values }),
        runs,
        seed + offset,
        { mistakeRate },
      ),
      runs,
    );
    const snapshot: SimSnapshot = {
      sim1: run(0.01, 1000),
      sim5: run(0.05, 2000),
      sim15: run(0.15, 3000),
    };
    const verdict = gradeStrategy2(snapshot);
    grade = verdict.grade;
    passrate = verdict.passrate;
  }
  return {
    levelResId: String(terrain.levelResId ?? ''),
    mode,
    attempt,
    colorCount,
    optimalWinRate: optimal.winRate,
    optimalStarvationPerTile: allTiles.length > 0 ? optimal.starvationOnWin / allTiles.length : 0,
    optimalLossRemainingRatio: remainingRatio,
    optimalPassed,
    strategyGrade: grade,
    strategyPassrate: passrate,
    accepted: optimalPassed && (grade === 4 || grade === 5),
    replayCode,
  };
}

function selectLevels(planPath: string, count: number, rng: () => number): string[] {
  const rows = parseCsv(readFileSync(planPath, 'utf8').replace(/^\uFEFF/, ''));
  const headers = rows[0];
  const levelIndex = headers.indexOf('levelResId');
  const missingG4 = headers.indexOf('missingG4');
  const missingG5 = headers.indexOf('missingG5');
  const candidates = rows.slice(1)
    .filter(row => Number(row[missingG4]) > 0 || Number(row[missingG5]) > 0)
    .map(row => row[levelIndex]);
  shuffle(candidates, rng);
  return candidates.slice(0, count);
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function main(): Promise<void> {
  const planPath = absolute(arg('--plan', 'output/generation_feature/runs/optimal_experience_backfill_20260629/02_analysis/backfill_similar_plan.csv'));
  const levelsDir = absolute(arg('--levels-dir', '/Users/wenhaowang/WorkSpace/TileMatchShell/Tools/Config/Json/Levels'));
  const outputPath = absolute(arg('--output', 'output/generation_feature/experiments/random_color_placement_ab.csv'));
  const reportPath = absolute(arg('--report', 'output/generation_feature/experiments/random_color_placement_ab_report.json'));
  const levelCount = Math.max(1, Number(arg('--level-count', '8')));
  const attemptsPerMode = Math.max(1, Number(arg('--attempts', '10')));
  const runs = Math.max(1, Number(arg('--runs', '20')));
  const seed = Number(arg('--seed', '20260630'));
  const confirmInput = arg('--confirm-input', '');
  if (confirmInput) {
    const inputPath = absolute(confirmInput);
    const parsed = parseCsv(readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, ''));
    const headers = parsed[0];
    const index = (name: string) => headers.indexOf(name);
    const acceptedRows = parsed.slice(1).filter(row => row[index('accepted')] === 'true');
    const confirmations = acceptedRows.map((row, rowIndex) => {
      const level = row[index('levelResId')];
      const terrain = loadTerrainFromFile(resolve(levelsDir, `${level}.json`));
      const replayCode = row[index('replayCode')];
      return evaluate(
        terrain,
        elementValuesFromReplay(terrain, replayCode),
        replayCode,
        row[index('mode')] as Mode,
        Number(row[index('attempt')]),
        Number(row[index('colorCount')]),
        runs,
        seed + rowIndex * 10_000,
      );
    });
    const confirmationReport = {
      createdAt: new Date().toISOString(),
      input: inputPath,
      runs,
      candidates: confirmations.length,
      accepted: confirmations.filter(row => row.accepted).length,
      rows: confirmations,
    };
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(confirmationReport, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(confirmationReport, null, 2));
    return;
  }
  const rng = mulberry32(seed);
  const levels = selectLevels(planPath, levelCount, rng);
  const results: CandidateResult[] = [];
  const total = levels.length * attemptsPerMode * 2;
  let done = 0;
  for (const level of levels) {
    const terrain = loadTerrainFromFile(resolve(levelsDir, `${level}.json`));
    for (const mode of ['structured', 'random-placement'] as Mode[]) {
      for (let attempt = 1; attempt <= attemptsPerMode; attempt++) {
        const candidateRng = mulberry32(seed + Number(level) * 97 + attempt * 17 + (mode === 'random-placement' ? 1_000_000 : 0));
        const colorCount = colorCountFor(terrain, candidateRng);
        const generated = makeReplay(terrain, mode, colorCount, candidateRng);
        results.push(evaluate(
          terrain,
          generated.values,
          generated.replayCode,
          mode,
          attempt,
          colorCount,
          runs,
          seed + done * 10_000,
        ));
        done++;
        process.stdout.write(`\r\x1b[2Kprogress ${done}/${total}`);
      }
    }
  }
  process.stdout.write('\n');
  const summarize = (mode: Mode) => {
    const rows = results.filter(row => row.mode === mode);
    const accepted = rows.filter(row => row.accepted);
    return {
      attempts: rows.length,
      optimalPassed: rows.filter(row => row.optimalPassed).length,
      strategyEvaluated: rows.filter(row => row.strategyGrade != null).length,
      accepted: accepted.length,
      acceptanceRate: rows.length > 0 ? accepted.length / rows.length : 0,
      acceptedByGrade: {
        G4: accepted.filter(row => row.strategyGrade === 4).length,
        G5: accepted.filter(row => row.strategyGrade === 5).length,
      },
      averageOptimalWinRate: rows.reduce((sum, row) => sum + row.optimalWinRate, 0) / Math.max(1, rows.length),
      averageLossRemainingRatio: rows.reduce((sum, row) => sum + row.optimalLossRemainingRatio, 0) / Math.max(1, rows.length),
    };
  };
  const report = {
    createdAt: new Date().toISOString(),
    levels,
    attemptsPerMode,
    runs,
    structured: summarize('structured'),
    randomPlacement: summarize('random-placement'),
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  const headers: Array<keyof CandidateResult> = [
    'levelResId', 'mode', 'attempt', 'colorCount', 'optimalWinRate', 'optimalStarvationPerTile',
    'optimalLossRemainingRatio', 'optimalPassed', 'strategyGrade', 'strategyPassrate', 'accepted', 'replayCode',
  ];
  const lines = [headers.join(','), ...results.map(row => headers.map(header => csvCell(row[header])).join(','))];
  writeFileSync(outputPath, `\uFEFF${lines.join('\n')}\n`, 'utf8');
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
