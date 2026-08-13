#!/usr/bin/env npx tsx

/**
 * 为失误率扫描原始数据补充项目内置的花色离散指标，并分析趋势。
 *
 * 输出：
 *   - 原地更新 output/失误率扫描/原始数据.csv
 *   - output/失误率扫描/离散度分位趋势.csv
 *   - output/失误率扫描/离散度趋势分析.md
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeCloseRatesFromAssignments,
  computeDependencyDepth,
  computeMetrics,
  computeTileDepSets,
  decodeFromString,
  getAllTiles,
  getCanonicalTileOrder,
  loadTerrainFromFile,
  LogLevel,
  setLogLevel,
} from '../src/index.js';
import type { TerrainTile } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(__dirname, '../output/失误率扫描');
const RAW_CSV = join(OUTPUT_DIR, '原始数据.csv');
const TREND_CSV = join(OUTPUT_DIR, '离散度分位趋势.csv');
const REPORT_MD = join(OUTPUT_DIR, '离散度趋势分析.md');
const TERRAIN_DIRS = [
  '/Users/wenhaowang/WorkSpace/levels_json/正式关卡',
  '/Users/wenhaowang/WorkSpace/levels_json/关卡备份',
  '/Users/wenhaowang/WorkSpace/levels_json/关卡调整',
  '/Users/wenhaowang/WorkSpace/TileMatchShell/Tools/Config/Json/Levels',
];

setLogLevel(LogLevel.Silent);

interface TerrainContext {
  allTiles: TerrainTile[];
  freeTiles: TerrainTile[];
  ordered: TerrainTile[];
  allTileMap: Map<number, TerrainTile>;
  depthMap: Map<number, number>;
  depthLayers: TerrainTile[][];
  tileDepSets: Map<number, Set<number>>;
}

interface DataRow {
  cells: string[];
  replayCode: string;
  replayKey: string;
  terrainId: string;
  online: number;
  sim5: number;
  spread: number;
  spreadNorm: number;
}

interface Point {
  terrainId: string;
  replayCode: string;
  online: number;
  sim5: number;
  spread: number;
  spreadNorm: number;
}

interface MetricSummary {
  label: string;
  rowPearson: number;
  rowSpearman: number;
  uniquePearson: number;
  uniqueSpearman: number;
  withinTerrainPearson: number;
  withinTerrainSlope: number;
  withinTerrainSim5Pearson: number;
  withinTerrainResidualPearson: number;
  residualPearson: number;
  terrainTested: number;
  terrainNegative: number;
  terrainPositive: number;
  terrainCorrelationMedian: number;
  slope: number;
  r2: number;
  q1Online: number;
  q5Online: number;
  qDelta: number;
}

function buildTerrainMap(): Map<string, string> {
  const result = new Map<string, string>();
  for (const dir of TERRAIN_DIRS) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (file.endsWith('.json') && !result.has(basename(file, '.json'))) {
        result.set(basename(file, '.json'), join(dir, file));
      }
    }
  }
  return result;
}

function loadTerrainContext(path: string): TerrainContext {
  const terrain = loadTerrainFromFile(path);
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(tile => !tile.isConst);
  const allTileMap = new Map(allTiles.map(tile => [tile.id, tile]));
  const depthMap = computeDependencyDepth(freeTiles, allTileMap);
  const depthCount = freeTiles.length > 0 ? Math.max(...depthMap.values()) : 0;
  const depthLayers: TerrainTile[][] = [];
  for (let depth = 1; depth <= depthCount; depth++) {
    depthLayers.push(freeTiles.filter(tile => depthMap.get(tile.id) === depth));
  }
  return {
    allTiles,
    freeTiles,
    ordered: getCanonicalTileOrder(allTiles),
    allTileMap,
    depthMap,
    depthLayers,
    tileDepSets: computeTileDepSets(freeTiles, allTileMap),
  };
}

function calculateSpread(replayCode: string, context: TerrainContext): { spread: number; spreadNorm: number } {
  const replay = decodeFromString(replayCode);
  if (!replay) throw new Error('ReplayCode 解码失败');
  const assignments = new Map<number, number>();
  for (let i = 0; i < context.ordered.length && i < replay.instanceArray.length; i++) {
    const tile = context.ordered[i];
    if (!tile.isConst) assignments.set(tile.id, (replay.instanceArray[i] & 0x3F) + 1);
  }
  const colors = new Set(assignments.values()).size;
  const closeRates = computeCloseRatesFromAssignments(assignments, context.depthLayers);
  const metrics = computeMetrics({
    assignments,
    tiles: context.freeTiles,
    depthLayers: context.depthLayers,
    depthMap: context.depthMap,
    tileMap: context.allTileMap,
    tileDepSets: context.tileDepSets,
    dock: 7,
    colorCount: colors,
    actualCloseRates: closeRates,
    debtPersistenceWeight: 0,
  });
  return { spread: metrics.suitSpread, spreadNorm: metrics.suitSpreadNorm };
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
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
  const indexed = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = new Array<number>(values.length);
  let start = 0;
  while (start < indexed.length) {
    let end = start + 1;
    while (end < indexed.length && indexed[end].value === indexed[start].value) end++;
    const rank = (start + end - 1) / 2 + 1;
    for (let i = start; i < end; i++) result[indexed[i].index] = rank;
    start = end;
  }
  return result;
}

function spearman(xs: number[], ys: number[]): number {
  return pearson(ranks(xs), ranks(ys));
}

function regression(xs: number[], ys: number[]): { slope: number; r2: number } {
  const mx = mean(xs), my = mean(ys);
  let numerator = 0, denominator = 0;
  for (let i = 0; i < xs.length; i++) {
    numerator += (xs[i] - mx) * (ys[i] - my);
    denominator += (xs[i] - mx) ** 2;
  }
  const slope = denominator > 0 ? numerator / denominator : 0;
  const r = pearson(xs, ys);
  return { slope, r2: r * r };
}

function aggregateUnique(rows: DataRow[]): Point[] {
  const groups = new Map<string, DataRow[]>();
  for (const row of rows) {
    const key = `${row.terrainId}\u0000${row.replayCode}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({
    terrainId: group[0].terrainId,
    replayCode: group[0].replayCode,
    online: mean(group.map(row => row.online)),
    sim5: mean(group.map(row => row.sim5)),
    spread: group[0].spread,
    spreadNorm: group[0].spreadNorm,
  }));
}

function withinTerrainCorrelation(
  points: Point[],
  metric: 'spread' | 'spreadNorm',
  target: 'online' | 'sim5' | 'residual' = 'online',
): number {
  const groups = new Map<string, Point[]>();
  for (const point of points) {
    const group = groups.get(point.terrainId) ?? [];
    group.push(point);
    groups.set(point.terrainId, group);
  }
  const xs: number[] = [], ys: number[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const mx = mean(group.map(point => point[metric]));
    const targetValue = (point: Point): number => target === 'residual'
      ? point.sim5 - point.online
      : point[target];
    const my = mean(group.map(targetValue));
    for (const point of group) {
      xs.push(point[metric] - mx);
      ys.push(targetValue(point) - my);
    }
  }
  return pearson(xs, ys);
}

function withinTerrainSlope(points: Point[], metric: 'spread' | 'spreadNorm'): number {
  const groups = new Map<string, Point[]>();
  for (const point of points) {
    const group = groups.get(point.terrainId) ?? [];
    group.push(point);
    groups.set(point.terrainId, group);
  }
  let numerator = 0, denominator = 0;
  for (const group of groups.values()) {
    const mx = mean(group.map(point => point[metric]));
    const my = mean(group.map(point => point.online));
    for (const point of group) {
      numerator += (point[metric] - mx) * (point.online - my);
      denominator += (point[metric] - mx) ** 2;
    }
  }
  return denominator > 0 ? numerator / denominator : 0;
}

function perTerrainStats(points: Point[], metric: 'spread' | 'spreadNorm'): {
  tested: number; negative: number; positive: number; medianCorrelation: number;
} {
  const groups = new Map<string, Point[]>();
  for (const point of points) {
    const group = groups.get(point.terrainId) ?? [];
    group.push(point);
    groups.set(point.terrainId, group);
  }
  const correlations = [...groups.values()]
    .filter(group => group.length >= 10)
    .map(group => pearson(group.map(point => point[metric]), group.map(point => point.online)));
  return {
    tested: correlations.length,
    negative: correlations.filter(value => value < 0).length,
    positive: correlations.filter(value => value > 0).length,
    medianCorrelation: median(correlations),
  };
}

function quantileRows(points: Point[], metric: 'spread' | 'spreadNorm'): Array<{
  metric: string; quantile: string; count: number; min: number; max: number;
  onlineMean: number; onlineMedian: number; sim5Mean: number; residualMean: number;
}> {
  const sorted = [...points].sort((a, b) => a[metric] - b[metric]);
  const result = [];
  for (let q = 0; q < 5; q++) {
    const start = Math.floor(sorted.length * q / 5);
    const end = Math.floor(sorted.length * (q + 1) / 5);
    const group = sorted.slice(start, end);
    result.push({
      metric,
      quantile: `Q${q + 1}`,
      count: group.length,
      min: group.length ? group[0][metric] : 0,
      max: group.length ? group[group.length - 1][metric] : 0,
      onlineMean: mean(group.map(point => point.online)),
      onlineMedian: median(group.map(point => point.online)),
      sim5Mean: mean(group.map(point => point.sim5)),
      residualMean: mean(group.map(point => point.sim5 - point.online)),
    });
  }
  return result;
}

function summarizeMetric(rows: DataRow[], unique: Point[], metric: 'spread' | 'spreadNorm', quantiles: ReturnType<typeof quantileRows>): MetricSummary {
  const rowXs = rows.map(row => row[metric]);
  const rowYs = rows.map(row => row.online);
  const uniqueXs = unique.map(point => point[metric]);
  const uniqueYs = unique.map(point => point.online);
  const fit = regression(uniqueXs, uniqueYs);
  const relevant = quantiles.filter(row => row.metric === metric);
  const terrainStats = perTerrainStats(unique, metric);
  return {
    label: metric === 'spread' ? '离散率' : '归一离散率',
    rowPearson: pearson(rowXs, rowYs),
    rowSpearman: spearman(rowXs, rowYs),
    uniquePearson: pearson(uniqueXs, uniqueYs),
    uniqueSpearman: spearman(uniqueXs, uniqueYs),
    withinTerrainPearson: withinTerrainCorrelation(unique, metric),
    withinTerrainSlope: withinTerrainSlope(unique, metric),
    withinTerrainSim5Pearson: withinTerrainCorrelation(unique, metric, 'sim5'),
    withinTerrainResidualPearson: withinTerrainCorrelation(unique, metric, 'residual'),
    residualPearson: pearson(uniqueXs, unique.map(point => point.sim5 - point.online)),
    terrainTested: terrainStats.tested,
    terrainNegative: terrainStats.negative,
    terrainPositive: terrainStats.positive,
    terrainCorrelationMedian: terrainStats.medianCorrelation,
    slope: fit.slope,
    r2: fit.r2,
    q1Online: relevant[0]?.onlineMean ?? 0,
    q5Online: relevant[4]?.onlineMean ?? 0,
    qDelta: (relevant[4]?.onlineMean ?? 0) - (relevant[0]?.onlineMean ?? 0),
  };
}

function strength(value: number): string {
  const absolute = Math.abs(value);
  if (absolute < 0.10) return '无明显';
  if (absolute < 0.20) return '弱';
  if (absolute < 0.35) return '中等';
  return '较强';
}

function direction(value: number): string {
  return value < 0 ? '离散越高，在线胜率越低' : '离散越高，在线胜率越高';
}

function format(value: number, digits = 3): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '0';
}

function main(): void {
  const terrainMap = buildTerrainMap();
  const source = readFileSync(RAW_CSV, 'utf8').replace(/^\uFEFF/, '');
  const lines = source.trimEnd().split(/\r?\n/);
  const headers = lines[0].split(',');
  const replayIndex = headers.indexOf('ReplayCode');
  const keyIndex = headers.indexOf('关卡牌局代码');
  const terrainIndex = headers.indexOf('地形编号');
  const onlineIndex = headers.indexOf('在线胜率(%)');
  const sim5Index = headers.indexOf('mistake_0.05');
  if ([replayIndex, keyIndex, terrainIndex, onlineIndex, sim5Index].some(index => index < 0)) {
    throw new Error('原始数据缺少 ReplayCode/关卡牌局代码/地形编号/在线胜率/mistake_0.05 字段');
  }

  let spreadIndex = headers.indexOf('离散率');
  let spreadNormIndex = headers.indexOf('归一离散率');
  if (spreadIndex < 0) { spreadIndex = headers.length; headers.push('离散率'); }
  if (spreadNormIndex < 0) { spreadNormIndex = headers.length; headers.push('归一离散率'); }

  const contexts = new Map<string, TerrainContext>();
  const metricCache = new Map<string, { spread: number; spreadNorm: number }>();
  const rows: DataRow[] = [];
  const failures: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    while (cells.length < headers.length) cells.push('');
    const terrainId = cells[terrainIndex];
    const replayCode = cells[replayIndex];
    try {
      const terrainPath = terrainMap.get(terrainId);
      if (!terrainPath) throw new Error('找不到地形');
      let context = contexts.get(terrainId);
      if (!context) {
        context = loadTerrainContext(terrainPath);
        contexts.set(terrainId, context);
      }
      const cacheKey = `${terrainId}\u0000${replayCode}`;
      let metrics = metricCache.get(cacheKey);
      if (!metrics) {
        metrics = calculateSpread(replayCode, context);
        metricCache.set(cacheKey, metrics);
      }
      cells[spreadIndex] = metrics.spread.toFixed(4);
      cells[spreadNormIndex] = metrics.spreadNorm.toFixed(4);
      rows.push({
        cells,
        replayCode,
        replayKey: cells[keyIndex],
        terrainId,
        online: Number(cells[onlineIndex]),
        sim5: Number(cells[sim5Index]),
        spread: metrics.spread,
        spreadNorm: metrics.spreadNorm,
      });
    } catch (error) {
      cells[spreadIndex] = '';
      cells[spreadNormIndex] = '';
      failures.push(`第${i + 1}行 ${terrainId}/${cells[keyIndex]}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`有 ${failures.length} 行计算失败，未改写原始数据：\n${failures.slice(0, 10).join('\n')}`);
  }

  const tempPath = `${RAW_CSV}.tmp`;
  writeFileSync(tempPath, [headers.join(','), ...rows.map(row => row.cells.join(','))].join('\n') + '\n', 'utf8');
  renameSync(tempPath, RAW_CSV);

  const unique = aggregateUnique(rows);
  const quantiles = [
    ...quantileRows(unique, 'spread'),
    ...quantileRows(unique, 'spreadNorm'),
  ];
  const summaries = [
    summarizeMetric(rows, unique, 'spread', quantiles),
    summarizeMetric(rows, unique, 'spreadNorm', quantiles),
  ];

  const trendHeader = '指标,分位,样本数,最小值,最大值,在线均值(%),在线中位数(%),sim5均值(%),sim5减在线均值(%)';
  const trendLines = quantiles.map(row => [
    row.metric === 'spread' ? '离散率' : '归一离散率', row.quantile, row.count,
    format(row.min, 4), format(row.max, 4), format(row.onlineMean, 2),
    format(row.onlineMedian, 2), format(row.sim5Mean, 2), format(row.residualMean, 2),
  ].join(','));
  writeFileSync(TREND_CSV, [trendHeader, ...trendLines].join('\n') + '\n', 'utf8');

  const duplicateRows = rows.length - unique.length;
  let report = '# 离散度与在线胜率趋势分析\n\n';
  report += `- 原始记录：${rows.length} 条；按 地形+ReplayCode 去重后：${unique.length} 个牌局。\n`;
  report += `- 重复映射记录：${duplicateRows} 条。趋势判断以去重牌局为主，避免同一 ReplayCode 被重复加权。\n`;
  report += `- 地形：${contexts.size} 个；计算失败：0 条。\n`;
  report += '- sim5 指 mistake=5% 机器人胜率。\n\n';
  report += '## 核心统计\n\n';
  report += '| 指标 | 行级 Spearman | 去重 Pearson | 去重 Spearman | 同地形在线相关 | 同地形每+0.1变化 | 同地形sim5相关 | 同地形误差相关 | 跨地形R² | Q5-Q1 在线胜率 |\n';
  report += '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n';
  for (const item of summaries) {
    report += `| ${item.label} | ${format(item.rowSpearman)} | ${format(item.uniquePearson)} | ${format(item.uniqueSpearman)} | ${format(item.withinTerrainPearson)} | ${format(item.withinTerrainSlope * 0.1, 2)}pp | ${format(item.withinTerrainSim5Pearson)} | ${format(item.withinTerrainResidualPearson)} | ${format(item.r2)} | ${format(item.qDelta, 2)}pp |\n`;
  }

  report += '\n## 地形内方向一致性\n\n';
  report += '仅统计至少有 10 个去重牌局的地形。\n\n';
  report += '| 指标 | 地形数 | 负相关地形 | 正相关地形 | 负相关占比 | 地形相关中位数 |\n';
  report += '|---|---:|---:|---:|---:|---:|\n';
  for (const item of summaries) {
    report += `| ${item.label} | ${item.terrainTested} | ${item.terrainNegative} | ${item.terrainPositive} | ${format(item.terrainNegative / item.terrainTested * 100, 1)}% | ${format(item.terrainCorrelationMedian)} |\n`;
  }

  report += '\n## 分位趋势\n\n';
  report += '| 指标 | 分位 | 范围 | 牌局数 | 在线均值 | 在线中位数 | sim5均值 | sim5-在线 |\n';
  report += '|---|---|---:|---:|---:|---:|---:|---:|\n';
  for (const row of quantiles) {
    report += `| ${row.metric === 'spread' ? '离散率' : '归一离散率'} | ${row.quantile} | ${format(row.min, 4)}-${format(row.max, 4)} | ${row.count} | ${format(row.onlineMean, 1)}% | ${format(row.onlineMedian, 1)}% | ${format(row.sim5Mean, 1)}% | ${format(row.residualMean, 1)}pp |\n`;
  }

  report += '\n## 结论\n\n';
  for (const item of summaries) {
    report += `- **${item.label}**：去重 Spearman=${format(item.uniqueSpearman)}，属于${strength(item.uniqueSpearman)}趋势，方向为“${direction(item.uniqueSpearman)}”；最高与最低分位在线均值相差 ${format(item.qDelta, 1)} 个百分点。`;
    report += `同地形相关=${format(item.withinTerrainPearson)}，离散度每增加 0.1，在线胜率平均变化 ${format(item.withinTerrainSlope * 0.1, 1)} 个百分点，说明控制地形后${Math.abs(item.withinTerrainPearson) >= 0.1 ? '仍保留一定关系' : '关系明显减弱'}。\n`;
    report += `  - 在至少 10 个牌局的地形中，${item.terrainNegative}/${item.terrainTested}（${format(item.terrainNegative / item.terrainTested * 100, 1)}%）呈“越分散越难”，地形相关中位数=${format(item.terrainCorrelationMedian)}。\n`;
  }
  const normalized = summaries[1];
  report += `- 归一离散率单变量只能解释约 ${(normalized.r2 * 100).toFixed(1)}% 的在线胜率方差，${normalized.r2 >= 0.10 ? '可以作为辅助难度特征，但不宜单独分档' : '暂不足以单独作为分档条件'}。\n`;
  report += `- 控制地形后，归一离散率与 sim5-在线误差的相关系数为 ${format(normalized.withinTerrainResidualPearson)}；${Math.abs(normalized.withinTerrainResidualPearson) >= 0.15 ? '它可能帮助修正机器人胜率偏差，值得加入后续组合模型验证' : '对机器人偏差的额外解释力有限，暂不建议直接改现有分档阈值'}。\n`;
  writeFileSync(REPORT_MD, report, 'utf8');

  console.log(`完成：${rows.length} 行，${unique.length} 个去重牌局，${contexts.size} 个地形`);
  for (const item of summaries) {
    console.log(`${item.label}: Spearman=${format(item.uniqueSpearman)}, within=${format(item.withinTerrainPearson)}, negativeTerrains=${item.terrainNegative}/${item.terrainTested}, Q5-Q1=${format(item.qDelta, 2)}pp, R²=${format(item.r2)}`);
  }
  console.log(`已更新: ${RAW_CSV}`);
  console.log(`趋势表: ${TREND_CSV}`);
  console.log(`报告: ${REPORT_MD}`);
}

main();
