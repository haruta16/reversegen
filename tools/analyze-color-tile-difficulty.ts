#!/usr/bin/env npx tsx

/** 分析花色数、Tile 数与在线难度的关系，并验证对三率估计的增量价值。 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeFromString } from '../src/replay-serializer.js';

const INPUT_CSV = resolve('output/全量难度估计结果.csv');
const DETAIL_CSV = resolve('output/花色Tile难度参数.csv');
const REPORT_MD = resolve('output/花色Tile难度相关报告.md');

interface Row {
  cells: string[];
  replayCode: string;
  replayKey: string;
  terrainId: string;
  online: number;
  baseEstimate: number;
  colorCount: number;
  tileCount: number;
  tilesPerColor: number;
  actualGrade: number;
}

interface EvalResult {
  name: string;
  rateMae: number;
  exact: number;
  withinOne: number;
  crossTwo: number;
  crossThree: number;
  gradeMae: number;
  predictions: number[];
}

interface RidgeModel {
  features: string[];
  means: number[];
  stds: number[];
  beta: number[];
}

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
function mean(values: number[]): number { return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0; }

function sixGrade(rate: number): number {
  if (rate >= 0.90) return 0;
  if (rate >= 0.60) return 1;
  if (rate >= 0.40) return 2;
  if (rate >= 0.20) return 3;
  if (rate >= 0.10) return 4;
  return 5;
}

function percentile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position), high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function pearson(xs: number[], ys: number[]): number {
  if (xs.length < 2 || xs.length !== ys.length) return 0;
  const mx = mean(xs), my = mean(ys);
  let numerator = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i] - mx, y = ys[i] - my;
    numerator += x * y;
    dx += x * x;
    dy += y * y;
  }
  return dx > 0 && dy > 0 ? numerator / Math.sqrt(dx * dy) : 0;
}

function ranks(values: number[]): number[] {
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = new Array<number>(values.length);
  let start = 0;
  while (start < sorted.length) {
    let end = start + 1;
    while (end < sorted.length && sorted[end].value === sorted[start].value) end++;
    const rank = (start + end - 1) / 2 + 1;
    for (let i = start; i < end; i++) result[sorted[i].index] = rank;
    start = end;
  }
  return result;
}

function spearman(xs: number[], ys: number[]): number { return pearson(ranks(xs), ranks(ys)); }

function loadRows(): { rows: Row[]; headers: string[] } {
  const lines = readFileSync(INPUT_CSV, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const headers = lines[0].split(',');
  const index = (name: string): number => {
    const result = headers.indexOf(name);
    if (result < 0) throw new Error(`输入缺少字段: ${name}`);
    return result;
  };
  const replayIndex = index('ReplayCode');
  const keyIndex = index('关卡牌局代码');
  const terrainIndex = index('地形编号');
  const onlineIndex = index('在线胜率(%)');
  const estimateIndex = index('三率估计胜率(%)');
  const cache = new Map<string, { colorCount: number; tileCount: number }>();

  const rows = lines.slice(1).filter(Boolean).map(canonicalLine => {
    const cells = canonicalLine.split(',');
    const replayCode = cells[replayIndex];
    let decoded = cache.get(replayCode);
    if (!decoded) {
      const replay = decodeFromString(replayCode);
      if (!replay) throw new Error(`ReplayCode 解码失败: ${cells[keyIndex]}`);
      decoded = { colorCount: replay.elementCount, tileCount: replay.instanceArray.length };
      cache.set(replayCode, decoded);
    }
    const online = Number(cells[onlineIndex]) / 100;
    return {
      cells,
      replayCode,
      replayKey: cells[keyIndex],
      terrainId: cells[terrainIndex],
      online,
      baseEstimate: Number(cells[estimateIndex]) / 100,
      colorCount: decoded.colorCount,
      tileCount: decoded.tileCount,
      tilesPerColor: decoded.tileCount / decoded.colorCount,
      actualGrade: sixGrade(online),
    };
  });
  return { rows, headers };
}

function groupedWithinCorrelation(rows: Row[], feature: keyof Row, target: (row: Row) => number): { correlation: number; slope: number } {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const group = groups.get(row.terrainId) ?? [];
    group.push(row);
    groups.set(row.terrainId, group);
  }
  const xs: number[] = [], ys: number[] = [];
  let numerator = 0, denominator = 0;
  for (const group of groups.values()) {
    const mx = mean(group.map(row => Number(row[feature])));
    const my = mean(group.map(target));
    for (const row of group) {
      const x = Number(row[feature]) - mx;
      const y = target(row) - my;
      xs.push(x); ys.push(y);
      numerator += x * y;
      denominator += x * x;
    }
  }
  return { correlation: pearson(xs, ys), slope: denominator > 0 ? numerator / denominator : 0 };
}

function terrainDirection(rows: Row[], feature: keyof Row): { tested: number; negative: number; positive: number; median: number } {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const group = groups.get(row.terrainId) ?? [];
    group.push(row);
    groups.set(row.terrainId, group);
  }
  const correlations = [...groups.values()]
    .filter(group => group.length >= 10 && new Set(group.map(row => row[feature])).size >= 3)
    .map(group => pearson(group.map(row => Number(row[feature])), group.map(row => row.online)));
  return {
    tested: correlations.length,
    negative: correlations.filter(value => value < 0).length,
    positive: correlations.filter(value => value > 0).length,
    median: percentile(correlations, 0.5),
  };
}

function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length;
  const matrix = a.map((row, index) => [...row, b[index]]);
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
    }
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const divisor = matrix[column][column];
    if (Math.abs(divisor) < 1e-12) continue;
    for (let c = column; c <= n; c++) matrix[column][c] /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === column) continue;
      const factor = matrix[row][column];
      for (let c = column; c <= n; c++) matrix[row][c] -= factor * matrix[column][c];
    }
  }
  return matrix.map(row => row[n]);
}

function fitResidualRidge(train: Row[], features: Array<keyof Row>, lambda = 2): RidgeModel {
  const means = features.map(feature => mean(train.map(row => Number(row[feature]))));
  const stds = features.map((feature, index) => {
    const variance = mean(train.map(row => (Number(row[feature]) - means[index]) ** 2));
    return Math.sqrt(variance) || 1;
  });
  const size = features.length + 1;
  const xtx = Array.from({ length: size }, () => Array(size).fill(0));
  const xty = Array(size).fill(0);
  for (const row of train) {
    const x = [1, ...features.map((feature, index) => (Number(row[feature]) - means[index]) / stds[index])];
    const target = row.online - row.baseEstimate;
    for (let i = 0; i < size; i++) {
      xty[i] += x[i] * target;
      for (let j = 0; j < size; j++) xtx[i][j] += x[i] * x[j];
    }
  }
  for (let i = 1; i < size; i++) xtx[i][i] += lambda;
  return { features: features.map(String), means, stds, beta: solveLinear(xtx, xty) };
}

function predictCorrection(row: Row, model: RidgeModel): number {
  let correction = model.beta[0];
  for (let i = 0; i < model.features.length; i++) {
    correction += model.beta[i + 1] * (Number(row[model.features[i] as keyof Row]) - model.means[i]) / model.stds[i];
  }
  return correction;
}

function evaluate(name: string, rows: Row[], predictions: number[]): EvalResult {
  let rateError = 0, exact = 0, withinOne = 0, crossTwo = 0, crossThree = 0, gradeError = 0;
  for (let i = 0; i < rows.length; i++) {
    rateError += Math.abs(predictions[i] - rows[i].online);
    const distance = Math.abs(sixGrade(predictions[i]) - rows[i].actualGrade);
    if (distance === 0) exact++;
    if (distance <= 1) withinOne++;
    if (distance >= 2) crossTwo++;
    if (distance >= 3) crossThree++;
    gradeError += distance;
  }
  return {
    name,
    rateMae: rateError / rows.length,
    exact: exact / rows.length,
    withinOne: withinOne / rows.length,
    crossTwo: crossTwo / rows.length,
    crossThree: crossThree / rows.length,
    gradeMae: gradeError / rows.length,
    predictions,
  };
}

function crossValidatedCorrection(rows: Row[], features: Array<keyof Row>): EvalResult {
  const terrains = [...new Set(rows.map(row => row.terrainId))].sort();
  const foldByTerrain = new Map(terrains.map((terrain, index) => [terrain, index % 5]));
  const predictions = new Array<number>(rows.length);
  for (let fold = 0; fold < 5; fold++) {
    const train = rows.filter(row => foldByTerrain.get(row.terrainId) !== fold);
    const model = fitResidualRidge(train, features);
    rows.forEach((row, index) => {
      if (foldByTerrain.get(row.terrainId) === fold) {
        predictions[index] = clamp(row.baseEstimate + predictCorrection(row, model));
      }
    });
  }
  return evaluate(features.length ? `三率+${features.join('+')}` : '三率基线', rows, predictions);
}

function quantileTrend(rows: Row[], feature: keyof Row): Array<{
  quantile: string; count: number; min: number; max: number; onlineMean: number; estimateMean: number; residualMean: number;
}> {
  const sortedValues = rows.map(row => Number(row[feature])).sort((a, b) => a - b);
  const cuts = [1, 2, 3, 4].map(q => sortedValues[Math.ceil(sortedValues.length * q / 5) - 1]);
  const groups = Array.from({ length: 5 }, () => [] as Row[]);
  for (const row of rows) {
    const value = Number(row[feature]);
    const groupIndex = cuts.findIndex(cut => value <= cut);
    groups[groupIndex < 0 ? 4 : groupIndex].push(row);
  }
  const result = [];
  for (let q = 0; q < groups.length; q++) {
    const group = groups[q];
    if (!group.length) continue;
    const values = group.map(row => Number(row[feature]));
    result.push({
      quantile: `Q${q + 1}`,
      count: group.length,
      min: Math.min(...values),
      max: Math.max(...values),
      onlineMean: mean(group.map(row => row.online)),
      estimateMean: mean(group.map(row => row.baseEstimate)),
      residualMean: mean(group.map(row => row.online - row.baseEstimate)),
    });
  }
  return result;
}

function pct(value: number, digits = 1): string { return `${(value * 100).toFixed(digits)}%`; }
function fmt(value: number, digits = 3): string { return value.toFixed(digits); }

function main(): void {
  const { rows, headers } = loadRows();
  const featureDefs: Array<{ key: keyof Row; label: string }> = [
    { key: 'colorCount', label: '花色数' },
    { key: 'tileCount', label: 'Tile数' },
    { key: 'tilesPerColor', label: '每花色Tile数' },
  ];
  const correlations = featureDefs.map(def => {
    const values = rows.map(row => Number(row[def.key]));
    const residuals = rows.map(row => row.online - row.baseEstimate);
    const within = groupedWithinCorrelation(rows, def.key, row => row.online);
    const withinResidual = groupedWithinCorrelation(rows, def.key, row => row.online - row.baseEstimate);
    return {
      ...def,
      min: Math.min(...values), max: Math.max(...values),
      pearson: pearson(values, rows.map(row => row.online)),
      spearman: spearman(values, rows.map(row => row.online)),
      residualPearson: pearson(values, residuals),
      withinCorrelation: within.correlation,
      withinSlope: within.slope,
      withinResidualCorrelation: withinResidual.correlation,
      direction: terrainDirection(rows, def.key),
    };
  });

  const baseline = evaluate('三率基线', rows, rows.map(row => row.baseEstimate));
  const candidates = [
    baseline,
    crossValidatedCorrection(rows, ['colorCount']),
    crossValidatedCorrection(rows, ['tileCount']),
    crossValidatedCorrection(rows, ['tilesPerColor']),
    crossValidatedCorrection(rows, ['colorCount', 'tileCount']),
    crossValidatedCorrection(rows, ['colorCount', 'tileCount', 'tilesPerColor']),
  ];
  candidates.sort((a, b) =>
    (a.crossTwo + 0.7 * a.crossThree + 0.06 * a.gradeMae)
    - (b.crossTwo + 0.7 * b.crossThree + 0.06 * b.gradeMae));
  const best = candidates[0];
  const crossTwoDelta = best.crossTwo - baseline.crossTwo;
  const crossThreeDelta = best.crossThree - baseline.crossThree;
  const rateMaeDelta = best.rateMae - baseline.rateMae;
  const hasStableGain = best.name !== '三率基线'
    && rateMaeDelta <= -0.001
    && crossTwoDelta <= -0.003
    && crossThreeDelta <= 0;

  const fullModel = fitResidualRidge(rows, best.name === '三率基线'
    ? []
    : best.name.replace('三率+', '').split('+') as Array<keyof Row>);
  const rawCoefficients = fullModel.features.map((_, index) => fullModel.beta[index + 1] / fullModel.stds[index]);
  const rawIntercept = fullModel.beta[0]
    - rawCoefficients.reduce((sum, coefficient, index) => sum + coefficient * fullModel.means[index], 0);

  const detailHeaders = [...headers, '花色数', 'Tile数', '每花色Tile数', '参数修正估计胜率(%)', '参数修正grade'];
  const detailLines = rows.map((row, index) => [
    ...row.cells,
    row.colorCount,
    row.tileCount,
    row.tilesPerColor.toFixed(3),
    (best.predictions[index] * 100).toFixed(2),
    sixGrade(best.predictions[index]),
  ].join(','));
  writeFileSync(DETAIL_CSV, [detailHeaders.join(','), ...detailLines].join('\n') + '\n', 'utf8');

  let report = '# 花色数与 Tile 数的难度相关性\n\n';
  report += `- 数据：${rows.length} 条牌局，ReplayCode 解码成功率100%。\n`;
  report += `- 花色数范围：${Math.min(...rows.map(row => row.colorCount))}～${Math.max(...rows.map(row => row.colorCount))}。\n`;
  report += `- Tile数范围：${Math.min(...rows.map(row => row.tileCount))}～${Math.max(...rows.map(row => row.tileCount))}。\n`;
  report += '- 难度方向：在线胜率越低表示越难，因此负相关表示参数越大、关卡越难。\n\n';

  report += '## 相关性\n\n';
  report += '| 参数 | 总体Pearson | 总体Spearman | 同地形相关 | 同地形每+1在线变化 | 与三率误差相关 | 同地形误差相关 | 负相关地形 |\n';
  report += '|---|---:|---:|---:|---:|---:|---:|---:|\n';
  for (const item of correlations) {
    report += `| ${item.label} | ${fmt(item.pearson)} | ${fmt(item.spearman)} | ${fmt(item.withinCorrelation)} | ${(item.withinSlope * 100).toFixed(2)}pp | ${fmt(item.residualPearson)} | ${fmt(item.withinResidualCorrelation)} | ${item.direction.negative}/${item.direction.tested} |\n`;
  }

  report += '\n## 参数分位趋势\n\n';
  for (const def of featureDefs) {
    report += `### ${def.label}\n\n`;
    report += '| 分位 | 范围 | 关卡数 | 在线均值 | 三率估计均值 | 在线-估计 |\n';
    report += '|---|---:|---:|---:|---:|---:|\n';
    for (const trend of quantileTrend(rows, def.key)) {
      report += `| ${trend.quantile} | ${trend.min.toFixed(2)}～${trend.max.toFixed(2)} | ${trend.count} | ${pct(trend.onlineMean)} | ${pct(trend.estimateMean)} | ${(trend.residualMean * 100).toFixed(1)}pp |\n`;
    }
    report += '\n';
  }

  report += '## 加入三率估计后的增量验证\n\n';
  report += '采用按地形分组的五折验证，修正目标为“在线胜率－三率估计胜率”。\n\n';
  report += '| 方法 | 胜率MAE | 精确档 | 目标或相邻档 | 跨≥2档 | 跨≥3档 | 档位MAE |\n';
  report += '|---|---:|---:|---:|---:|---:|---:|\n';
  for (const candidate of candidates) {
    report += `| ${candidate.name} | ${pct(candidate.rateMae)} | ${pct(candidate.exact)} | ${pct(candidate.withinOne)} | ${pct(candidate.crossTwo)} | ${pct(candidate.crossThree)} | ${candidate.gradeMae.toFixed(3)} |\n`;
  }

  report += '\n## 探索性参数修正公式\n\n';
  if (best.name === '三率基线') {
    report += '五折验证中所有参数组合均未稳定优于三率基线，因此不建议加入花色数或Tile数修正。\n';
  } else {
    report += '> 该公式仅用于复现实验。若下方指标没有形成一致改善，不建议直接写入生产分档。\n\n';
    report += '```text\n修正后胜率 = 三率估计胜率';
    if (rawIntercept >= 0) report += ` + ${rawIntercept.toFixed(5)}`;
    else report += ` - ${Math.abs(rawIntercept).toFixed(5)}`;
    for (let i = 0; i < fullModel.features.length; i++) {
      const coefficient = rawCoefficients[i];
      report += coefficient >= 0
        ? ` + ${coefficient.toFixed(5)} × ${fullModel.features[i]}`
        : ` - ${Math.abs(coefficient).toFixed(5)} × ${fullModel.features[i]}`;
    }
    report += '\n```\n';
  }

  const color = correlations[0], tile = correlations[1], ratio = correlations[2];
  report += '\n## 结论\n\n';
  report += `- 花色数与在线胜率的总体Spearman=${fmt(color.spearman)}，同地形相关=${fmt(color.withinCorrelation)}；${Math.abs(color.withinCorrelation) >= 0.1 ? '同一地形内具有可用趋势' : '同一地形内趋势较弱'}。\n`;
  report += `- Tile数与在线胜率的总体Spearman=${fmt(tile.spearman)}。Tile数主要是地形级属性，不能从同地形内验证因果关系。\n`;
  report += `- 每花色Tile数与在线胜率的总体Spearman=${fmt(ratio.spearman)}，同地形相关=${fmt(ratio.withinCorrelation)}。\n`;
  report += `- 综合分最低的五折结果为“${best.name}”：相对三率基线，胜率MAE${rateMaeDelta >= 0 ? '+' : ''}${(rateMaeDelta * 100).toFixed(2)}pp，跨≥2档${crossTwoDelta >= 0 ? '+' : ''}${(crossTwoDelta * 100).toFixed(2)}pp，跨≥3档${crossThreeDelta >= 0 ? '+' : ''}${(crossThreeDelta * 100).toFixed(2)}pp。\n`;
  report += `- ${hasStableGain ? '三个核心指标形成一致改善，可以继续扩大样本验证，但仍不应只凭本次结果上线。' : '增益很小且核心指标没有形成一致改善；花色数和Tile数适合做生成前的难度先验，不建议再叠加到三率grade公式中。'}\n`;
  writeFileSync(REPORT_MD, report, 'utf8');

  console.log(`完成：${rows.length} 条，花色 ${Math.min(...rows.map(r => r.colorCount))}-${Math.max(...rows.map(r => r.colorCount))}，Tile ${Math.min(...rows.map(r => r.tileCount))}-${Math.max(...rows.map(r => r.tileCount))}`);
  for (const item of correlations) console.log(`${item.label}: Spearman=${fmt(item.spearman)}, within=${fmt(item.withinCorrelation)}, residual=${fmt(item.residualPearson)}`);
  console.log(`最佳增量模型: ${best.name}, cross2=${pct(best.crossTwo)}, baseline=${pct(baseline.crossTwo)}`);
  console.log(`输出: ${DETAIL_CSV}`);
  console.log(`报告: ${REPORT_MD}`);
}

main();
