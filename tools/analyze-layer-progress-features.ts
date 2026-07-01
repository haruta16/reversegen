#!/usr/bin/env npx tsx

/**
 * 批量追加逐层闭合率、花色使用率、债务 tile 数与债务保留率，
 * 并用地形分组五折验证它们对 sim1/sim5/sim15 分档的增量价值。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadTerrainFromFile, getAllTiles } from '../src/terrain-loader.js';
import { decodeFromString, getCanonicalTileOrder } from '../src/replay-serializer.js';
import { computeDependencyDepth, computeCloseRatesFromAssignments, computeLayerProgressMetrics } from '../src/layer-closure-gen.js';
import { setLogLevel, LogLevel } from '../src/logger.js';
import type { TerrainTile } from '../src/types.js';

setLogLevel(LogLevel.Silent);

const RAW_CSV = resolve('output/失误率扫描/原始数据.csv');
const RESULT_JSON = resolve('output/逐层花色债务指标_预测分析.json');
const RESULT_CSV = resolve('output/逐层花色债务指标_预测对比.csv');
const FEATURE_COLUMNS = [
  '闭合率_逐层',
  '花色使用率_逐层', '花色使用率_首层', '花色使用率_均值',
  '花色平均启用层',
  '债务Tile数_逐层',
  '债务保留率_逐层', '债务保留率_首跳', '债务保留率_均值', '债务保留率_最大值',
  '债务保留率_加权均值',
];
const TERRAIN_DIRS = [
  resolve('../TileMatchShell/Tools/Config/Json/Levels'),
  '/Users/wenhaowang/WorkSpace/levels_json/正式关卡',
  '/Users/wenhaowang/WorkSpace/levels_json/关卡备份',
  '/Users/wenhaowang/WorkSpace/levels_json/关卡调整',
];

interface Context {
  ordered: TerrainTile[];
  freeTiles: TerrainTile[];
  depthLayers: TerrainTile[][];
}

interface Row {
  replayKey: string; terrainId: string; online: number;
  sim1: number; sim5: number; sim15: number;
  usageFirst: number; usageMean: number;
  activationLayerMean: number;
  retentionFirst: number; retentionMean: number; retentionMax: number;
  retentionWeighted: number;
  closeRates: number[]; usageRates: number[]; debtTiles: number[]; retentionRates: number[];
}

interface EvalMetrics {
  method: string; winRateMae: number; winRateRmse: number;
  exactGrade: number; withinOneGrade: number; crossTwoGrade: number; gradeMae: number;
}

function terrainPath(id: string): string {
  for (const dir of TERRAIN_DIRS) {
    const path = `${dir}/${id}.json`;
    if (existsSync(path)) return path;
  }
  throw new Error(`找不到地形 ${id}`);
}

function loadContext(id: string): Context {
  const allTiles = getAllTiles(loadTerrainFromFile(terrainPath(id)));
  const freeTiles = allTiles.filter(tile => !tile.isConst);
  const tileMap = new Map(allTiles.map(tile => [tile.id, tile]));
  const depthMap = computeDependencyDepth(freeTiles, tileMap);
  const maxDepth = freeTiles.length ? Math.max(...depthMap.values()) : 0;
  const depthLayers = Array.from({ length: maxDepth }, (_, i) =>
    freeTiles.filter(tile => depthMap.get(tile.id) === i + 1));
  return { ordered: getCanonicalTileOrder(allTiles), freeTiles, depthLayers };
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function calculate(replayCode: string, context: Context): Omit<Row, 'replayKey'|'terrainId'|'online'|'sim1'|'sim5'|'sim15'> {
  const replay = decodeFromString(replayCode);
  if (!replay) throw new Error('ReplayCode 解码失败');
  const assignments = new Map<number, number>();
  for (let i = 0; i < context.ordered.length && i < replay.instanceArray.length; i++) {
    const tile = context.ordered[i];
    if (!tile.isConst) assignments.set(tile.id, (replay.instanceArray[i] & 0x3f) + 1);
  }
  const closeRates = computeCloseRatesFromAssignments(assignments, context.depthLayers);
  const progress = computeLayerProgressMetrics(assignments, context.depthLayers);
  return {
    usageFirst: progress.colorUsageRates[0] ?? 0,
    usageMean: mean(progress.colorUsageRates),
    activationLayerMean: progress.averageColorActivationLayer,
    retentionFirst: progress.debtRetentionRates[0] ?? 0,
    retentionMean: mean(progress.debtRetentionRates),
    retentionMax: Math.max(...progress.debtRetentionRates, 0),
    retentionWeighted: progress.weightedDebtRetentionRate,
    closeRates,
    usageRates: progress.colorUsageRates,
    debtTiles: progress.debtTileCountsByLayer,
    retentionRates: progress.debtRetentionRates,
  };
}

function formatArray(values: number[], digits = 4): string {
  return values.map(value => value.toFixed(digits)).join('|');
}

function sixGrade(rate: number): number {
  if (rate >= 0.90) return 0;
  if (rate >= 0.60) return 1;
  if (rate >= 0.40) return 2;
  if (rate >= 0.20) return 3;
  if (rate >= 0.10) return 4;
  return 5;
}

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
function transpose(a: number[][]): number[][] { return a[0].map((_, j) => a.map(row => row[j])); }
function multiply(a: number[][], b: number[][]): number[][] {
  return a.map(row => b[0].map((_, j) => row.reduce((s, v, k) => s + v * b[k][j], 0)));
}
function invert(a: number[][]): number[][] {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => i === j ? 1 : 0)]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    const d = m[c][c];
    if (Math.abs(d) < 1e-12) throw new Error('回归矩阵不可逆');
    for (let j = 0; j < n * 2; j++) m[c][j] /= d;
    for (let r = 0; r < n; r++) if (r !== c) {
      const f = m[r][c];
      for (let j = 0; j < n * 2; j++) m[r][j] -= f * m[c][j];
    }
  }
  return m.map(row => row.slice(n));
}
function fitRidge(x: number[][], y: number[], lambda = 1): (features: number[]) => number {
  const cols = x[0].length;
  const means = Array.from({ length: cols }, (_, j) => mean(x.map(row => row[j])));
  const stds = means.map((v, j) => Math.sqrt(mean(x.map(row => (row[j] - v) ** 2))) || 1);
  const design = x.map(row => [1, ...row.map((v, j) => (v - means[j]) / stds[j])]);
  const xt = transpose(design), xtx = multiply(xt, design);
  for (let i = 1; i < xtx.length; i++) xtx[i][i] += lambda;
  const beta = multiply(multiply(invert(xtx), xt), y.map(v => [v])).map(row => row[0]);
  return features => beta[0] + features.reduce((s, v, j) => s + beta[j + 1] * ((v - means[j]) / stds[j]), 0);
}
function folds(rows: Row[], n = 5): number[][] {
  const groups = new Map<string, number[]>();
  rows.forEach((row, i) => { const g = groups.get(row.terrainId) ?? []; g.push(i); groups.set(row.terrainId, g); });
  const result = Array.from({ length: n }, () => [] as number[]), sizes = Array(n).fill(0);
  for (const group of [...groups.values()].sort((a, b) => b.length - a.length)) {
    const f = sizes.indexOf(Math.min(...sizes)); result[f].push(...group); sizes[f] += group.length;
  }
  return result;
}
function cv(rows: Row[], feature: (row: Row) => number[]): number[] {
  const predictions = Array(rows.length).fill(0);
  for (const test of folds(rows)) {
    const testSet = new Set(test), train = rows.map((_, i) => i).filter(i => !testSet.has(i));
    const model = fitRidge(train.map(i => feature(rows[i])), train.map(i => rows[i].online));
    test.forEach(i => { predictions[i] = clamp(model(feature(rows[i]))); });
  }
  return predictions;
}
function evaluate(method: string, rows: Row[], predictions: number[]): EvalMetrics {
  let abs = 0, sq = 0, exact = 0, within = 0, cross = 0, gradeError = 0;
  rows.forEach((row, i) => {
    const error = predictions[i] - row.online; abs += Math.abs(error); sq += error * error;
    const d = Math.abs(sixGrade(predictions[i]) - sixGrade(row.online));
    if (d === 0) exact++; if (d <= 1) within++; if (d >= 2) cross++; gradeError += d;
  });
  return { method, winRateMae: abs / rows.length, winRateRmse: Math.sqrt(sq / rows.length),
    exactGrade: exact / rows.length, withinOneGrade: within / rows.length,
    crossTwoGrade: cross / rows.length, gradeMae: gradeError / rows.length };
}
function pearson(xs: number[], ys: number[]): number {
  const mx = mean(xs), my = mean(ys); let xy = 0, xx = 0, yy = 0;
  for (let i = 0; i < xs.length; i++) { const x = xs[i] - mx, y = ys[i] - my; xy += x*y; xx += x*x; yy += y*y; }
  return xy / Math.sqrt(xx * yy);
}
function ranks(values: number[]): number[] {
  const sorted = values.map((v, i) => ({v, i})).sort((a, b) => a.v - b.v), result = Array(values.length);
  for (let i = 0; i < sorted.length;) { let j = i + 1; while (j < sorted.length && sorted[j].v === sorted[i].v) j++;
    const rank = (i + j + 1) / 2; for (let k = i; k < j; k++) result[sorted[k].i] = rank; i = j; }
  return result;
}
function correlation(rows: Row[], key: 'usageFirst'|'usageMean'|'activationLayerMean'|'retentionFirst'|'retentionMean'|'retentionMax'|'retentionWeighted') {
  const xs = rows.map(row => row[key]), online = rows.map(row => row.online);
  const production = rows.map(row => clamp(0.30*row.sim1 + 0.10*row.sim5 + 0.60*row.sim15 + 0.08));
  const residual = rows.map((row, i) => row.online - production[i]);
  return { metric: key, pearsonOnline: pearson(xs, online), spearmanOnline: pearson(ranks(xs), ranks(online)), pearsonResidual: pearson(xs, residual) };
}

function main(): void {
  const lines = readFileSync(RAW_CSV, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const oldHeaders = lines[0].split(','), headers = oldHeaders.filter(h => !FEATURE_COLUMNS.includes(h));
  const idx = (name: string) => oldHeaders.indexOf(name);
  const replayIdx = idx('ReplayCode'), keyIdx = idx('关卡牌局代码'), terrainIdx = idx('地形编号');
  const onlineIdx = idx('在线胜率(%)'), sim1Idx = idx('mistake_0.01'), sim5Idx = idx('mistake_0.05'), sim15Idx = idx('mistake_0.15');
  const contexts = new Map<string, Context>(), rows: Row[] = [], output = [[...headers, ...FEATURE_COLUMNS].join(',')];
  for (const line of lines.slice(1).filter(Boolean)) {
    const cells = line.split(','), terrainId = cells[terrainIdx];
    let context = contexts.get(terrainId); if (!context) { context = loadContext(terrainId); contexts.set(terrainId, context); }
    const f = calculate(cells[replayIdx], context);
    const base = headers.map(h => cells[oldHeaders.indexOf(h)]);
    output.push([...base,
      formatArray(f.closeRates), formatArray(f.usageRates), f.usageFirst.toFixed(4), f.usageMean.toFixed(4),
      f.activationLayerMean.toFixed(4),
      f.debtTiles.join('|'), formatArray(f.retentionRates), f.retentionFirst.toFixed(4),
      f.retentionMean.toFixed(4), f.retentionMax.toFixed(4), f.retentionWeighted.toFixed(4),
    ].join(','));
    rows.push({ replayKey: cells[keyIdx], terrainId, online: Number(cells[onlineIdx])/100,
      sim1: Number(cells[sim1Idx])/100, sim5: Number(cells[sim5Idx])/100, sim15: Number(cells[sim15Idx])/100, ...f });
  }
  const temp = `${RAW_CSV}.tmp`; writeFileSync(temp, output.join('\n') + '\n', 'utf8'); renameSync(temp, RAW_CSV);

  const sim = (row: Row) => [row.sim1, row.sim5, row.sim15];
  const basePred = cv(rows, sim);
  const usagePred = cv(rows, row => [...sim(row), row.usageFirst, row.activationLayerMean]);
  const retentionPred = cv(rows, row => [...sim(row), row.retentionFirst, row.retentionWeighted, row.retentionMax]);
  const allPred = cv(rows, row => [...sim(row), row.usageFirst, row.activationLayerMean, row.retentionFirst, row.retentionWeighted, row.retentionMax]);
  const comparisons = [evaluate('三率基线', rows, basePred), evaluate('三率+花色使用率', rows, usagePred),
    evaluate('三率+债务保留率', rows, retentionPred), evaluate('三率+两类逐层指标', rows, allPred)];
  const correlations = (['usageFirst','usageMean','activationLayerMean','retentionFirst','retentionMean','retentionMax','retentionWeighted'] as const).map(k => correlation(rows, k));
  const targetIndex = rows.findIndex(row => row.replayKey === '9-6-2-15-1342747756'), target = rows[targetIndex];
  const result = { rows: rows.length, terrains: contexts.size,
    definitions: {
      colorUsageRate: '1~L累计出现花色数 ÷ 全局实际花色数',
      debtRetentionRate: '1~L结束时的债务tile中，到1~L+1结束仍未被闭合消除的比例；无旧债务时记0',
    }, correlations, comparisons,
    target: target ? { replayKey: target.replayKey, closeRates: target.closeRates, usageRates: target.usageRates,
      debtTiles: target.debtTiles, retentionRates: target.retentionRates,
      predictions: { baseline: basePred[targetIndex], usage: usagePred[targetIndex], retention: retentionPred[targetIndex], all: allPred[targetIndex] } } : null,
  };
  writeFileSync(RESULT_JSON, JSON.stringify(result, null, 2) + '\n', 'utf8');
  const outHeader = ['方法','胜率MAE','胜率RMSE','精确分档','相邻档内','跨两档及以上','档位MAE'];
  writeFileSync(RESULT_CSV, [outHeader.join(','), ...comparisons.map(x => [x.method,x.winRateMae,x.winRateRmse,x.exactGrade,x.withinOneGrade,x.crossTwoGrade,x.gradeMae].join(','))].join('\n') + '\n', 'utf8');
  console.log(JSON.stringify(result, null, 2));
}

main();
