#!/usr/bin/env npx tsx
/** Sample shortest-player paths and collapse each click sequence into dependency-equivalent layers. */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

setLogLevel(LogLevel.Silent);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_INPUT = 'output/generation_feature/samples/0706_SpExp_replay_samples.csv';
const DEFAULT_OUTPUT_DIR = 'output/optimal_equivalent_paths';
const TERRAIN_DIRS = [
  '/Users/wenhaowang/WorkSpace/TileMatchShell/Tools/Config/Json/Levels',
  '/Users/wenhaowang/WorkSpace/levels_json/正式关卡',
  '/Users/wenhaowang/WorkSpace/levels_json/关卡备份',
  '/Users/wenhaowang/WorkSpace/levels_json/关卡调整',
];

interface InputRow {
  index: number;
  strategy: string;
  levelResId: string;
  replayKey: string;
  replayCode: string;
  grade: string;
  raw: Record<string, string>;
}

interface ReplayContext {
  replayData: ReplayData;
  elementValues: Map<number, number>;
  initialDock: { tileId: number; element: number }[];
  eliminatedTileIds: Set<number>;
}

interface EquivalentPath {
  picks: number[];
  layers: number[][];
  expression: string;
  ranks: Record<string, number>;
  edges: string[];
  layerWidths: number[];
  totalClicks: number;
  layerCount: number;
  avgBranchWidth: number;
  maxBranchWidth: number;
  forcedChainRate: number;
  interchangeableRate: number;
}

interface SummaryRow {
  input: InputRow;
  runs: number;
  wins: number;
  losses: number;
  uniqueRawPaths: number;
  bestRawPathCount: number;
  rawPathConsistency: number | null;
  avgRawSameIndexRate: number | null;
  avgRawLcsRate: number | null;
  uniqueEquivalentPaths: number;
  bestEquivalentPathCount: number;
  equivalent: EquivalentPath | null;
  avgPathRankSameRate: number | null;
  avgPathEdgeJaccard: number | null;
  avgPathLayerWidthSimilarity: number | null;
  error: string;
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

function parseNumberArg(name: string, fallback: number): number {
  const value = Number(arg(name, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
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

function findHeader(headers: string[], names: string[]): number {
  for (const name of names) {
    const index = headers.indexOf(name);
    if (index >= 0) return index;
  }
  return -1;
}

function loadInput(path: string): InputRow[] {
  const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error(`CSV has no data: ${path}`);
  const headers = parseCSVLine(lines[0]);
  const levelIndex = findHeader(headers, ['levelResId', '地形', '地形编号', 'LevelResID']);
  const replayIndex = findHeader(headers, ['ReplayCode', 'replayCode']);
  if (levelIndex < 0 || replayIndex < 0) {
    throw new Error(`CSV requires levelResId/地形 and ReplayCode. Headers: ${headers.join(',')}`);
  }
  const strategyIndex = findHeader(headers, ['策略', 'strategy', 'Strategy']);
  const replayKeyIndex = findHeader(headers, ['ReplayKey', 'replayKey']);
  const gradeIndex = findHeader(headers, ['grade', 'Grade', '难度']);

  return lines.slice(1).map((line, index) => {
    const cells = parseCSVLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, i) => { row[header] = cells[i] ?? ''; });
    return {
      index: index + 1,
      strategy: strategyIndex >= 0 ? (cells[strategyIndex] ?? '') : '',
      levelResId: String(cells[levelIndex] ?? '').trim(),
      replayKey: replayKeyIndex >= 0 ? (cells[replayKeyIndex] ?? '') : '',
      replayCode: String(cells[replayIndex] ?? '').trim(),
      grade: gradeIndex >= 0 ? (cells[gradeIndex] ?? '') : '',
      raw: row,
    };
  }).filter(row => row.levelResId && row.replayCode);
}

function terrainMap(extraDir: string): Map<string, string> {
  const map = new Map<string, string>();
  const dirs = [extraDir, ...TERRAIN_DIRS].filter(Boolean);
  for (const dir of dirs) {
    const abs = absolute(dir);
    if (!existsSync(abs)) continue;
    for (const file of readdirSync(abs)) {
      if (file.endsWith('.json') && !map.has(file.slice(0, -5))) {
        map.set(file.slice(0, -5), join(abs, file));
      }
    }
  }
  return map;
}

function decodeReplay(replayCode: string, terrainTiles: TerrainTile[]): ReplayContext {
  const replayData = decodeFromString(replayCode);
  if (!replayData) throw new Error('ReplayCode decode failed');

  const ordered = getCanonicalTileOrder(terrainTiles);
  const elementValues = new Map<number, number>();
  const initialDock: { tileId: number; element: number }[] = [];
  const eliminatedTileIds = new Set<number>();

  for (let i = 0; i < ordered.length && i < replayData.instanceArray.length; i++) {
    const tile = ordered[i];
    const byte = replayData.instanceArray[i];
    const state = (byte >> 6) & 0x3;
    const element = (byte & 0x3F) + 1;
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

function equivalentPath(picks: number[], terrainTiles: TerrainTile[]): EquivalentPath {
  const tileById = new Map(terrainTiles.map(tile => [tile.id, tile]));
  const picked = new Set(picks);
  const position = new Map<number, number>();
  picks.forEach((tileId, index) => position.set(tileId, index));

  const memo = new Map<number, number>();
  const visiting = new Set<number>();
  const rankOf = (tileId: number): number => {
    const cached = memo.get(tileId);
    if (cached != null) return cached;
    if (visiting.has(tileId)) return 0;
    visiting.add(tileId);
    const tile = tileById.get(tileId);
    const tilePos = position.get(tileId) ?? Number.POSITIVE_INFINITY;
    const parentRanks = (tile?.dependencies ?? [])
      .filter(depId => picked.has(depId) && (position.get(depId) ?? Number.POSITIVE_INFINITY) < tilePos)
      .map(depId => rankOf(depId));
    const rank = parentRanks.length > 0 ? Math.max(...parentRanks) + 1 : 0;
    visiting.delete(tileId);
    memo.set(tileId, rank);
    return rank;
  };

  for (const tileId of picks) rankOf(tileId);

  const rankEntries = [...memo.entries()].sort((a, b) => (position.get(a[0]) ?? 0) - (position.get(b[0]) ?? 0));
  const maxRank = rankEntries.reduce((max, [, rank]) => Math.max(max, rank), -1);
  const layers: number[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (const [tileId, rank] of rankEntries) layers[rank].push(tileId);
  for (const layer of layers) layer.sort((a, b) => a - b);

  const edges = new Set<string>();
  for (const tileId of picks) {
    const tile = tileById.get(tileId);
    const tilePos = position.get(tileId) ?? Number.POSITIVE_INFINITY;
    for (const depId of tile?.dependencies ?? []) {
      if (picked.has(depId) && (position.get(depId) ?? Number.POSITIVE_INFINITY) < tilePos) {
        edges.add(`${depId}->${tileId}`);
      }
    }
  }

  const layerWidths = layers.map(layer => layer.length);
  const totalClicks = picks.length;
  const forcedTiles = layers.reduce((sum, layer) => sum + (layer.length === 1 ? 1 : 0), 0);
  const interchangeableTiles = layers.reduce((sum, layer) => sum + (layer.length > 1 ? layer.length : 0), 0);
  const expression = layers
    .map(layer => layer.length === 1 ? String(layer[0]) : `(${layer.join(',')})`)
    .join(',');
  const ranks: Record<string, number> = {};
  for (const [tileId, rank] of rankEntries) ranks[String(tileId)] = rank;

  return {
    picks,
    layers,
    expression,
    ranks,
    edges: [...edges].sort(),
    layerWidths,
    totalClicks,
    layerCount: layers.length,
    avgBranchWidth: layers.length > 0 ? totalClicks / layers.length : 0,
    maxBranchWidth: layerWidths.length > 0 ? Math.max(...layerWidths) : 0,
    forcedChainRate: totalClicks > 0 ? forcedTiles / totalClicks : 0,
    interchangeableRate: totalClicks > 0 ? interchangeableTiles / totalClicks : 0,
  };
}

function jaccard<T>(a: Iterable<T>, b: Iterable<T>): number {
  const left = new Set(a);
  const right = new Set(b);
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection++;
  return intersection / union.size;
}

function rankSameRate(a: EquivalentPath, b: EquivalentPath): number {
  const ids = Object.keys(a.ranks).filter(id => b.ranks[id] != null);
  if (ids.length === 0) return 0;
  return ids.filter(id => a.ranks[id] === b.ranks[id]).length / ids.length;
}

function widthScore(a: number, b: number): number {
  const max = Math.max(a, b);
  return max === 0 ? 1 : 1 - Math.abs(a - b) / max;
}

function layerWidthSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.max(
        dp[i - 1][j],
        dp[i][j - 1],
        dp[i - 1][j - 1] + widthScore(a[i - 1], b[j - 1]),
      );
    }
  }
  return dp[a.length][b.length] / Math.max(a.length, b.length);
}

function rawPathKey(picks: number[]): string {
  return picks.join(',');
}

function sameIndexRate(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return a.length === b.length ? 1 : 0;
  let same = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) same++;
  }
  return same / Math.max(a.length, b.length);
}

function lcsRate(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 1 : 0;
  const dp = Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev + 1
        : Math.max(dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[b.length] / Math.max(a.length, b.length);
}

function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function pairwisePathMetrics(paths: EquivalentPath[]): {
  rank: number | null;
  edge: number | null;
  width: number | null;
} {
  const ranks: number[] = [];
  const edges: number[] = [];
  const widths: number[] = [];
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      ranks.push(rankSameRate(paths[i], paths[j]));
      edges.push(jaccard(paths[i].edges, paths[j].edges));
      widths.push(layerWidthSimilarity(paths[i].layerWidths, paths[j].layerWidths));
    }
  }
  return { rank: average(ranks), edge: average(edges), width: average(widths) };
}

function pairwiseRawMetrics(paths: number[][]): {
  sameIndex: number | null;
  lcs: number | null;
} {
  const sameIndex: number[] = [];
  const lcs: number[] = [];
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      sameIndex.push(sameIndexRate(paths[i], paths[j]));
      lcs.push(lcsRate(paths[i], paths[j]));
    }
  }
  return { sameIndex: average(sameIndex), lcs: average(lcs) };
}

function mostCommonRaw(paths: number[][]): { key: string; count: number; unique: number } {
  const buckets = new Map<string, number>();
  for (const path of paths) {
    const key = rawPathKey(path);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const sorted = [...buckets.entries()].sort((a, b) => b[1] - a[1]);
  return { key: sorted[0]?.[0] ?? '', count: sorted[0]?.[1] ?? 0, unique: buckets.size };
}

function mostCommon(paths: EquivalentPath[]): { path: EquivalentPath | null; count: number; unique: number } {
  const buckets = new Map<string, { path: EquivalentPath; count: number }>();
  for (const path of paths) {
    const current = buckets.get(path.expression);
    if (current) current.count++;
    else buckets.set(path.expression, { path, count: 1 });
  }
  const sorted = [...buckets.values()].sort((a, b) => b.count - a.count);
  return { path: sorted[0]?.path ?? null, count: sorted[0]?.count ?? 0, unique: buckets.size };
}

function runOne(input: InputRow, terrainPath: string, runs: number, seedBase: number): {
  summary: SummaryRow;
  pathRecords: unknown[];
} {
  const terrain = loadTerrainFromFile(terrainPath);
  const terrainTiles = getAllTiles(terrain);
  const replay = decodeReplay(input.replayCode, terrainTiles);
  const game = createGame({
    terrainTiles,
    elementValues: replay.elementValues,
    initialDock: replay.initialDock,
    eliminatedTileIds: replay.eliminatedTileIds,
  });

  const batch = solvePlayerShortestBatch(game, runs, seedBase + input.index * 1009);
  const winning = (batch.results ?? []).filter(result => result.win);
  const rawPaths = winning.map(result => result.picks);
  const commonRaw = mostCommonRaw(rawPaths);
  const rawMetrics = pairwiseRawMetrics(rawPaths);
  const equivalentPaths = winning.map(result => equivalentPath(result.picks, terrainTiles));
  const common = mostCommon(equivalentPaths);
  const pairMetrics = pairwisePathMetrics(equivalentPaths);
  const pathRecords = winning.map((result, pathIndex) => ({
    sourceIndex: input.index,
    strategy: input.strategy,
    levelResId: input.levelResId,
    replayKey: input.replayKey,
    grade: input.grade,
    seed: result.seed,
    pathIndex,
    rawPathKey: rawPathKey(result.picks),
    picks: result.picks,
    equivalentExpression: equivalentPaths[pathIndex].expression,
    layers: equivalentPaths[pathIndex].layers,
    layerWidths: equivalentPaths[pathIndex].layerWidths,
    edges: equivalentPaths[pathIndex].edges,
  }));

  return {
    summary: {
      input,
      runs,
      wins: batch.wins,
      losses: batch.losses,
      uniqueRawPaths: commonRaw.unique,
      bestRawPathCount: commonRaw.count,
      rawPathConsistency: winning.length > 0 ? commonRaw.count / winning.length : null,
      avgRawSameIndexRate: rawMetrics.sameIndex,
      avgRawLcsRate: rawMetrics.lcs,
      uniqueEquivalentPaths: common.unique,
      bestEquivalentPathCount: common.count,
      equivalent: common.path,
      avgPathRankSameRate: pairMetrics.rank,
      avgPathEdgeJaccard: pairMetrics.edge,
      avgPathLayerWidthSimilarity: pairMetrics.width,
      error: '',
    },
    pathRecords,
  };
}

function formatNumber(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '' : value.toFixed(6);
}

function writeSummary(path: string, rows: SummaryRow[]): void {
  const headers = [
    'sourceIndex', 'strategy', 'levelResId', 'ReplayKey', 'grade',
    'runs', 'wins', 'losses',
    'uniqueRawPaths', 'bestRawPathCount', 'rawPathConsistency',
    'avgRawSameIndexRate', 'avgRawLcsRate',
    'uniqueEquivalentPaths', 'bestEquivalentPathCount',
    'totalClicks', 'layerCount', 'avgBranchWidth', 'maxBranchWidth',
    'forcedChainRate', 'interchangeableRate',
    'avgPathRankSameRate', 'avgPathEdgeJaccard', 'avgPathLayerWidthSimilarity',
    'equivalentExpression', 'error',
  ];
  const lines = [headers.join(',')];
  for (const row of rows) {
    const eq = row.equivalent;
    lines.push([
      row.input.index,
      row.input.strategy,
      row.input.levelResId,
      row.input.replayKey,
      row.input.grade,
      row.runs,
      row.wins,
      row.losses,
      row.uniqueRawPaths,
      row.bestRawPathCount,
      formatNumber(row.rawPathConsistency),
      formatNumber(row.avgRawSameIndexRate),
      formatNumber(row.avgRawLcsRate),
      row.uniqueEquivalentPaths,
      row.bestEquivalentPathCount,
      eq?.totalClicks ?? '',
      eq?.layerCount ?? '',
      formatNumber(eq?.avgBranchWidth),
      eq?.maxBranchWidth ?? '',
      formatNumber(eq?.forcedChainRate),
      formatNumber(eq?.interchangeableRate),
      formatNumber(row.avgPathRankSameRate),
      formatNumber(row.avgPathEdgeJaccard),
      formatNumber(row.avgPathLayerWidthSimilarity),
      eq?.expression ?? '',
      row.error,
    ].map(csvCell).join(','));
  }
  writeFileSync(path, `\uFEFF${lines.join('\n')}\n`, 'utf8');
}

function writePathJsonl(path: string, records: unknown[]): void {
  writeFileSync(path, `${records.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8');
}

function writeRawPathPairs(path: string, records: unknown[]): void {
  const bySource = new Map<number, Array<{ sourceIndex: number; pathIndex: number; picks: number[]; rawPathKey: string }>>();
  for (const record of records as Array<{ sourceIndex?: number; pathIndex?: number; picks?: number[]; rawPathKey?: string }>) {
    if (record.sourceIndex == null || record.pathIndex == null || !Array.isArray(record.picks)) continue;
    const list = bySource.get(record.sourceIndex) ?? [];
    list.push({
      sourceIndex: record.sourceIndex,
      pathIndex: record.pathIndex,
      picks: record.picks,
      rawPathKey: record.rawPathKey ?? rawPathKey(record.picks),
    });
    bySource.set(record.sourceIndex, list);
  }

  const headers = ['sourceIndex', 'leftPathIndex', 'rightPathIndex', 'exactSame', 'sameIndexRate', 'lcsRate'];
  const lines = [headers.join(',')];
  for (const paths of bySource.values()) {
    for (let i = 0; i < paths.length; i++) {
      for (let j = i + 1; j < paths.length; j++) {
        lines.push([
          paths[i].sourceIndex,
          paths[i].pathIndex,
          paths[j].pathIndex,
          paths[i].rawPathKey === paths[j].rawPathKey ? 1 : 0,
          formatNumber(sameIndexRate(paths[i].picks, paths[j].picks)),
          formatNumber(lcsRate(paths[i].picks, paths[j].picks)),
        ].map(csvCell).join(','));
      }
    }
  }
  writeFileSync(path, `\uFEFF${lines.join('\n')}\n`, 'utf8');
}

function writePairs(path: string, rows: SummaryRow[]): void {
  const headers = [
    'leftIndex', 'rightIndex', 'leftStrategy', 'rightStrategy',
    'leftGrade', 'rightGrade', 'leftLevelResId', 'rightLevelResId',
    'sameTerrain', 'rankSameRate', 'edgeJaccard', 'layerWidthSimilarity',
    'leftExpression', 'rightExpression',
  ];
  const lines = [headers.join(',')];
  const usable = rows.filter(row => row.equivalent);
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const left = usable[i];
      const right = usable[j];
      const a = left.equivalent!;
      const b = right.equivalent!;
      const sameTerrain = left.input.levelResId === right.input.levelResId;
      lines.push([
        left.input.index,
        right.input.index,
        left.input.strategy,
        right.input.strategy,
        left.input.grade,
        right.input.grade,
        left.input.levelResId,
        right.input.levelResId,
        sameTerrain ? 1 : 0,
        sameTerrain ? formatNumber(rankSameRate(a, b)) : '',
        sameTerrain ? formatNumber(jaccard(a.edges, b.edges)) : '',
        formatNumber(layerWidthSimilarity(a.layerWidths, b.layerWidths)),
        a.expression,
        b.expression,
      ].map(csvCell).join(','));
    }
  }
  writeFileSync(path, `\uFEFF${lines.join('\n')}\n`, 'utf8');
}

function sampleRows(rows: InputRow[], limit: number, seed: number): InputRow[] {
  if (!(limit > 0) || rows.length <= limit) return rows;
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const copy = [...rows];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, limit).sort((a, b) => a.index - b.index);
}

function printHelp(): void {
  console.log(`Usage:
  npx tsx tools/optimal-equivalent-paths.ts [options]

Options:
  --input <csv>          CSV with levelResId/地形 and ReplayCode columns.
                         Default: ${DEFAULT_INPUT}
  --output-dir <dir>     Output directory. Default: ${DEFAULT_OUTPUT_DIR}
  --levels-dir <dir>     Extra terrain JSON directory searched before defaults.
  --runs <n>             Shortest-player samples per replay. Default: 30
  --limit <n>            Randomly sample at most n input rows. Default: all
  --seed <n>             Seed for row sampling and solver base. Default: 20260707
  --help                 Show help.

Outputs:
  summary.csv            One row per replay with raw-path consistency plus equivalent-layer diagnostics.
  paths.jsonl            One row per winning path with raw picks/layers/edges.
  raw_path_pairs.csv     Pairwise raw click-sequence consistency within each replay.
  pairs.csv              Pairwise layer-width similarity across sampled replays.
`);
}

async function main(): Promise<void> {
  if (flag('--help') || flag('-h')) {
    printHelp();
    return;
  }

  const inputPath = absolute(arg('--input', DEFAULT_INPUT));
  const outputDir = absolute(arg('--output-dir', DEFAULT_OUTPUT_DIR));
  const runs = Math.max(1, Math.floor(parseNumberArg('--runs', 30)));
  const limit = Math.floor(parseNumberArg('--limit', 0));
  const seed = Math.floor(parseNumberArg('--seed', 20260707));
  const levelsDir = arg('--levels-dir', '');

  const rows = sampleRows(loadInput(inputPath), limit, seed);
  const terrains = terrainMap(levelsDir);
  mkdirSync(outputDir, { recursive: true });

  const summaries: SummaryRow[] = [];
  const pathRecords: unknown[] = [];
  for (const row of rows) {
    const terrainPath = terrains.get(row.levelResId);
    if (!terrainPath) {
      summaries.push({
        input: row,
        runs,
        wins: 0,
        losses: 0,
        uniqueRawPaths: 0,
        bestRawPathCount: 0,
        rawPathConsistency: null,
        avgRawSameIndexRate: null,
        avgRawLcsRate: null,
        uniqueEquivalentPaths: 0,
        bestEquivalentPathCount: 0,
        equivalent: null,
        avgPathRankSameRate: null,
        avgPathEdgeJaccard: null,
        avgPathLayerWidthSimilarity: null,
        error: `terrain not found: ${row.levelResId}`,
      });
      continue;
    }
    try {
      const result = runOne(row, terrainPath, runs, seed);
      summaries.push(result.summary);
      pathRecords.push(...result.pathRecords);
    } catch (error) {
      summaries.push({
        input: row,
        runs,
        wins: 0,
        losses: 0,
        uniqueRawPaths: 0,
        bestRawPathCount: 0,
        rawPathConsistency: null,
        avgRawSameIndexRate: null,
        avgRawLcsRate: null,
        uniqueEquivalentPaths: 0,
        bestEquivalentPathCount: 0,
        equivalent: null,
        avgPathRankSameRate: null,
        avgPathEdgeJaccard: null,
        avgPathLayerWidthSimilarity: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const summaryPath = join(outputDir, 'summary.csv');
  const pathsPath = join(outputDir, 'paths.jsonl');
  const rawPathPairsPath = join(outputDir, 'raw_path_pairs.csv');
  const pairsPath = join(outputDir, 'pairs.csv');
  writeSummary(summaryPath, summaries);
  writePathJsonl(pathsPath, pathRecords);
  writeRawPathPairs(rawPathPairsPath, pathRecords);
  writePairs(pairsPath, summaries);

  const solved = summaries.filter(row => row.equivalent);
  console.log(JSON.stringify({
    input: inputPath,
    rows: rows.length,
    solved: solved.length,
    outputDir,
    summary: summaryPath,
    paths: pathsPath,
    rawPathPairs: rawPathPairsPath,
    pairs: pairsPath,
  }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
