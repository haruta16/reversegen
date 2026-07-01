#!/usr/bin/env npx tsx

/**
 * 为失误率扫描原始数据追加“底部三张完成牌数”静态特征，并评估它对
 * 在线胜率六档预测的增量价值。
 *
 * 底部三张：每个颜色按依赖深度降序取三张；并列时按传递依赖数降序、ID升序。
 * 完成牌数：三张自身 + 三张传递依赖闭包的并集（去重）。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadTerrainFromFile, getAllTiles } from '../src/terrain-loader.js';
import { decodeFromString, getCanonicalTileOrder } from '../src/replay-serializer.js';
import { computeAllDependencies } from '../src/dependency-graph.js';
import { computeDependencyDepth } from '../src/layer-closure-gen.js';
import { setLogLevel, LogLevel } from '../src/logger.js';

setLogLevel(LogLevel.Silent);

const RAW_CSV = resolve('output/失误率扫描/原始数据.csv');
const ANALYSIS_JSON = resolve('output/底部三张完成牌数_预测分析.json');
const ANALYSIS_CSV = resolve('output/底部三张完成牌数_预测对比.csv');
const FEATURE_COLUMNS = ['底部三张完成牌数_均值', '底部三张完成牌数_最大值', '底部三张完成牌数_颜色明细'];

const TERRAIN_DIRS = [
  resolve('../TileMatchShell/Tools/Config/Json/Levels'),
  '/Users/wenhaowang/WorkSpace/levels_json/正式关卡',
  '/Users/wenhaowang/WorkSpace/levels_json/关卡备份',
  '/Users/wenhaowang/WorkSpace/levels_json/关卡调整',
];

interface FeatureRow {
  replayCode: string;
  replayKey: string;
  terrainId: string;
  online: number;
  sim1: number;
  sim5: number;
  sim15: number;
  completionMean: number;
  completionMax: number;
  completionDetail: string;
}

interface Metrics {
  method: string;
  winRateMae: number;
  winRateRmse: number;
  exactGrade: number;
  withinOneGrade: number;
  crossTwoGrade: number;
  crossThreeGrade: number;
  gradeMae: number;
}

function terrainPath(id: string): string {
  for (const dir of TERRAIN_DIRS) {
    const path = `${dir}/${id}.json`;
    if (existsSync(path)) return path;
  }
  throw new Error(`找不到地形 ${id}`);
}

function sixGrade(rate: number): number {
  if (rate >= 0.90) return 0;
  if (rate >= 0.60) return 1;
  if (rate >= 0.40) return 2;
  if (rate >= 0.20) return 3;
  if (rate >= 0.10) return 4;
  return 5;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function calculateFeature(replayCode: string, terrainId: string): {
  mean: number; max: number; detail: string;
} {
  const tiles = getAllTiles(loadTerrainFromFile(terrainPath(terrainId)));
  const ordered = getCanonicalTileOrder(tiles);
  const replay = decodeFromString(replayCode);
  if (!replay) throw new Error(`ReplayCode 解码失败: ${terrainId}`);

  const suitMap = new Map<number, number>();
  for (let i = 0; i < ordered.length; i++) {
    const tile = ordered[i];
    const color = tile.isConst
      ? tile.constElementValue
      : (replay.instanceArray[i] & 0x3f) + 1;
    suitMap.set(tile.id, color);
  }

  const tileMap = new Map(tiles.map(tile => [tile.id, tile]));
  const depthMap = computeDependencyDepth(tiles, tileMap);
  const dependencyMap = computeAllDependencies(tiles);
  const groups = new Map<number, typeof tiles>();
  for (const tile of tiles) {
    const color = suitMap.get(tile.id)!;
    const group = groups.get(color) ?? [];
    group.push(tile);
    groups.set(color, group);
  }

  const values: Array<{ color: number; completion: number }> = [];
  for (const [color, group] of groups) {
    if (group.length < 3) continue;
    const bottomThree = [...group]
      .sort((a, b) =>
        (depthMap.get(b.id)! - depthMap.get(a.id)!)
        || ((dependencyMap.get(b.id)?.size ?? 0) - (dependencyMap.get(a.id)?.size ?? 0))
        || (a.id - b.id))
      .slice(0, 3);
    const completionTiles = new Set(bottomThree.map(tile => tile.id));
    for (const tile of bottomThree) {
      for (const id of dependencyMap.get(tile.id) ?? []) completionTiles.add(id);
    }
    values.push({ color, completion: completionTiles.size });
  }

  values.sort((a, b) => a.color - b.color);
  const completions = values.map(value => value.completion);
  return {
    mean: completions.reduce((sum, value) => sum + value, 0) / completions.length,
    max: Math.max(...completions),
    detail: values.map(value => `${value.color}:${value.completion}`).join('|'),
  };
}

function transpose(matrix: number[][]): number[][] {
  return matrix[0].map((_, col) => matrix.map(row => row[col]));
}

function multiply(a: number[][], b: number[][]): number[][] {
  return a.map(row => b[0].map((_, col) => row.reduce((sum, value, k) => sum + value * b[k][col], 0)));
}

function invert(matrix: number[][]): number[][] {
  const n = matrix.length;
  const aug = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => i === j ? 1 : 0)]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(aug[row][col]) > Math.abs(aug[pivot][col])) pivot = row;
    [aug[col], aug[pivot]] = [aug[pivot], aug[col]];
    const divisor = aug[col][col];
    if (Math.abs(divisor) < 1e-12) throw new Error('回归矩阵不可逆');
    for (let j = 0; j < 2 * n; j++) aug[col][j] /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row][col];
      for (let j = 0; j < 2 * n; j++) aug[row][j] -= factor * aug[col][j];
    }
  }
  return aug.map(row => row.slice(n));
}

function fitRidge(x: number[][], y: number[], lambda = 1): { predict: (features: number[]) => number; rawCoefficients: number[] } {
  const cols = x[0].length;
  const means = Array.from({ length: cols }, (_, j) => x.reduce((s, row) => s + row[j], 0) / x.length);
  const stds = means.map((mean, j) => Math.sqrt(x.reduce((s, row) => s + (row[j] - mean) ** 2, 0) / x.length) || 1);
  const design = x.map(row => [1, ...row.map((value, j) => (value - means[j]) / stds[j])]);
  const xt = transpose(design);
  const xtx = multiply(xt, design);
  for (let i = 1; i < xtx.length; i++) xtx[i][i] += lambda;
  const beta = multiply(multiply(invert(xtx), xt), y.map(value => [value])).map(row => row[0]);
  const rawCoefficients = beta.slice(1).map((value, j) => value / stds[j]);
  return {
    predict: features => beta[0] + features.reduce((sum, value, j) => sum + beta[j + 1] * ((value - means[j]) / stds[j]), 0),
    rawCoefficients,
  };
}

function groupedFolds(rows: FeatureRow[], count = 5): number[][] {
  const groups = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const group = groups.get(row.terrainId) ?? [];
    group.push(index);
    groups.set(row.terrainId, group);
  });
  const folds = Array.from({ length: count }, () => [] as number[]);
  const sizes = Array(count).fill(0);
  for (const indices of [...groups.values()].sort((a, b) => b.length - a.length)) {
    const fold = sizes.indexOf(Math.min(...sizes));
    folds[fold].push(...indices);
    sizes[fold] += indices.length;
  }
  return folds;
}

function crossValidatedPredictions(rows: FeatureRow[], features: (row: FeatureRow) => number[]): {
  predictions: number[]; completionCoefficient?: number;
} {
  const predictions = Array(rows.length).fill(0);
  const coefficients: number[] = [];
  const folds = groupedFolds(rows);
  for (const testIndices of folds) {
    const testSet = new Set(testIndices);
    const trainIndices = rows.map((_, i) => i).filter(i => !testSet.has(i));
    const model = fitRidge(trainIndices.map(i => features(rows[i])), trainIndices.map(i => rows[i].online));
    testIndices.forEach(i => { predictions[i] = clamp(model.predict(features(rows[i]))); });
    coefficients.push(model.rawCoefficients[3] ?? NaN);
  }
  const valid = coefficients.filter(Number.isFinite);
  return {
    predictions,
    completionCoefficient: valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : undefined,
  };
}

function metrics(method: string, rows: FeatureRow[], predictions: number[]): Metrics {
  let abs = 0, sq = 0, exact = 0, withinOne = 0, crossTwo = 0, crossThree = 0, gradeError = 0;
  rows.forEach((row, i) => {
    const error = predictions[i] - row.online;
    abs += Math.abs(error); sq += error * error;
    const distance = Math.abs(sixGrade(predictions[i]) - sixGrade(row.online));
    if (distance === 0) exact++;
    if (distance <= 1) withinOne++;
    if (distance >= 2) crossTwo++;
    if (distance >= 3) crossThree++;
    gradeError += distance;
  });
  return {
    method,
    winRateMae: abs / rows.length,
    winRateRmse: Math.sqrt(sq / rows.length),
    exactGrade: exact / rows.length,
    withinOneGrade: withinOne / rows.length,
    crossTwoGrade: crossTwo / rows.length,
    crossThreeGrade: crossThree / rows.length,
    gradeMae: gradeError / rows.length,
  };
}

function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position), high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function gradeTransitions(rows: FeatureRow[], before: number[], after: number[]): {
  improved: number; worsened: number; unchanged: number; exactGained: number; exactLost: number;
} {
  let improved = 0, worsened = 0, unchanged = 0, exactGained = 0, exactLost = 0;
  rows.forEach((row, i) => {
    const actual = sixGrade(row.online);
    const oldDistance = Math.abs(sixGrade(before[i]) - actual);
    const newDistance = Math.abs(sixGrade(after[i]) - actual);
    if (newDistance < oldDistance) improved++;
    else if (newDistance > oldDistance) worsened++;
    else unchanged++;
    if (oldDistance > 0 && newDistance === 0) exactGained++;
    if (oldDistance === 0 && newDistance > 0) exactLost++;
  });
  return { improved, worsened, unchanged, exactGained, exactLost };
}

function main(): void {
  const lines = readFileSync(RAW_CSV, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const originalHeaders = lines[0].split(',');
  const baseHeaders = originalHeaders.filter(header => !FEATURE_COLUMNS.includes(header));
  const index = (name: string) => originalHeaders.indexOf(name);
  const replayIndex = index('ReplayCode'), keyIndex = index('关卡牌局代码'), terrainIndex = index('地形编号');
  const onlineIndex = index('在线胜率(%)'), sim1Index = index('mistake_0.01');
  const sim5Index = index('mistake_0.05'), sim15Index = index('mistake_0.15');
  if ([replayIndex, keyIndex, terrainIndex, onlineIndex, sim1Index, sim5Index, sim15Index].some(i => i < 0)) {
    throw new Error('原始数据缺少必需列');
  }

  const outputLines = [[...baseHeaders, ...FEATURE_COLUMNS].join(',')];
  const rows: FeatureRow[] = [];
  for (const line of lines.slice(1).filter(Boolean)) {
    const cells = line.split(',');
    const feature = calculateFeature(cells[replayIndex], cells[terrainIndex]);
    const baseCells = baseHeaders.map(header => cells[originalHeaders.indexOf(header)]);
    outputLines.push([...baseCells, feature.mean.toFixed(4), String(feature.max), feature.detail].join(','));
    rows.push({
      replayCode: cells[replayIndex], replayKey: cells[keyIndex], terrainId: cells[terrainIndex],
      online: Number(cells[onlineIndex]) / 100,
      sim1: Number(cells[sim1Index]) / 100, sim5: Number(cells[sim5Index]) / 100, sim15: Number(cells[sim15Index]) / 100,
      completionMean: feature.mean, completionMax: feature.max, completionDetail: feature.detail,
    });
  }
  writeFileSync(RAW_CSV, outputLines.join('\n') + '\n', 'utf8');

  const production = rows.map(row => clamp(0.30 * row.sim1 + 0.10 * row.sim5 + 0.60 * row.sim15 + 0.08));
  const baselineCv = crossValidatedPredictions(rows, row => [row.sim1, row.sim5, row.sim15]);
  const meanCv = crossValidatedPredictions(rows, row => [row.sim1, row.sim5, row.sim15, row.completionMean]);
  const meanMaxCv = crossValidatedPredictions(rows, row => [row.sim1, row.sim5, row.sim15, row.completionMean, row.completionMax]);
  const comparisons = [
    metrics('现有生产公式', rows, production),
    metrics('三率线性模型（地形分组5折）', rows, baselineCv.predictions),
    metrics('三率+完成牌数均值（地形分组5折）', rows, meanCv.predictions),
    metrics('三率+完成牌数均值/最大值（地形分组5折）', rows, meanMaxCv.predictions),
  ];
  const target = rows.find(row => row.replayKey === '9-6-2-15-1342747756');
  const targetIndex = rows.findIndex(row => row.replayKey === '9-6-2-15-1342747756');
  const completionMeans = rows.map(row => row.completionMean);
  const completionMaxes = rows.map(row => row.completionMax);
  const result = {
    rows: rows.length,
    definition: '每个颜色取依赖深度最深的三张；完成牌数=三张自身与其传递依赖牌的去重总数',
    columnsAdded: FEATURE_COLUMNS,
    comparisons,
    meanCompletionRawCoefficient: meanCv.completionCoefficient,
    featureDistribution: {
      meanP50: percentile(completionMeans, 0.50),
      meanP90: percentile(completionMeans, 0.90),
      maxP50: percentile(completionMaxes, 0.50),
      maxP90: percentile(completionMaxes, 0.90),
    },
    gradeTransitionsVsThreeRateCv: gradeTransitions(rows, baselineCv.predictions, meanMaxCv.predictions),
    target: target ? {
      replayKey: target.replayKey,
      completionMean: target.completionMean,
      completionMax: target.completionMax,
      completionDetail: target.completionDetail,
      meanPercentile: completionMeans.filter(value => value <= target.completionMean).length / completionMeans.length,
      maxPercentile: completionMaxes.filter(value => value <= target.completionMax).length / completionMaxes.length,
      predictions: targetIndex >= 0 ? {
        production: production[targetIndex],
        threeRateCv: baselineCv.predictions[targetIndex],
        withCompletionMeanCv: meanCv.predictions[targetIndex],
        withCompletionMeanMaxCv: meanMaxCv.predictions[targetIndex],
      } : null,
    } : null,
  };
  writeFileSync(ANALYSIS_JSON, JSON.stringify(result, null, 2) + '\n', 'utf8');
  const csvHeader = ['方法', '胜率MAE', '胜率RMSE', '精确分档', '相邻档内', '跨两档及以上', '跨三档及以上', '档位MAE'];
  const csvRows = comparisons.map(item => [
    item.method, item.winRateMae, item.winRateRmse, item.exactGrade, item.withinOneGrade,
    item.crossTwoGrade, item.crossThreeGrade, item.gradeMae,
  ].join(','));
  writeFileSync(ANALYSIS_CSV, [csvHeader.join(','), ...csvRows].join('\n') + '\n', 'utf8');
  console.log(JSON.stringify(result, null, 2));
}

main();
