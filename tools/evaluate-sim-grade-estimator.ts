#!/usr/bin/env npx tsx

/**
 * 只使用 sim1/sim5/sim15 的全覆盖六档估计，并与原始 JSON grade 的
 * 在线胜率分布集中度进行比较。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const RAW_CSV = resolve('output/失误率扫描/原始数据.csv');
const REPLAYS_DIR = '/Users/wenhaowang/WorkSpace/TileMatchShell/Tools/Config/Json/Replays_B';
const DETAIL_CSV = resolve('output/全量难度估计结果.csv');
const DISTRIBUTION_CSV = resolve('output/全量难度估计分布.csv');
const REPORT_MD = resolve('output/全量难度估计对比报告.md');

const GRADE_NAMES = ['极易候选', '简单', '中等偏易', '中等偏难', '困难', '极难'];
const TARGET_RANGES = ['90-100%', '60-90%', '40-60%', '20-40%', '10-20%', '0-10%'];

interface Row {
  replayCode: string;
  replayKey: string;
  terrainId: string;
  online: number;
  sim1: number;
  sim5: number;
  sim15: number;
  oldGrade: number | null;
  estimatedRate: number;
  newGrade: number;
  sim5Grade: number;
  actualGrade: number;
}

interface GroupStat {
  method: string;
  grade: string;
  count: number;
  mean: number;
  p10: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
  iqr: number;
}

interface MethodSummary {
  rows: number;
  groupCount: number;
  weightedWithinStd: number;
  weightedIqr: number;
  etaSquared: number;
  adjacentMedianMonotonic: number;
  adjacentPairs: number;
  averageAdjacentOverlap: number;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * 地形分组五折搜索得到的稳定简化权重。
 * sim15 权重最高，用能力下限抑制 sim5 对困难关的高估；+8pp 修正整体偏低。
 */
export function estimateOnlineRate(sim1: number, sim5: number, sim15: number): number {
  return clamp(0.30 * sim1 + 0.10 * sim5 + 0.60 * sim15 + 0.08);
}

export function sixGrade(rate: number): number {
  if (rate >= 0.90) return 0;
  if (rate >= 0.60) return 1;
  if (rate >= 0.40) return 2;
  if (rate >= 0.20) return 3;
  if (rate >= 0.10) return 4;
  return 5;
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position), high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function std(values: number[]): number {
  const average = mean(values);
  return Math.sqrt(mean(values.map(value => (value - average) ** 2)));
}

function buildOldGradeMap(): Map<string, number> {
  if (!existsSync(REPLAYS_DIR)) throw new Error(`原始 Replay 目录不存在: ${REPLAYS_DIR}`);
  const result = new Map<string, number>();
  for (const file of readdirSync(REPLAYS_DIR)) {
    if (!file.endsWith('.json')) continue;
    const data = JSON.parse(readFileSync(join(REPLAYS_DIR, file), 'utf8')) as {
      levelResId: number | string;
      replayInfoList?: Array<{ ReplayKey?: string; grade?: number }>;
    };
    for (const entry of data.replayInfoList ?? []) {
      if (!entry.ReplayKey || entry.grade == null) continue;
      result.set(`${data.levelResId}\u0000${entry.ReplayKey}`, Number(entry.grade));
    }
  }
  return result;
}

function loadRows(): Row[] {
  const lines = readFileSync(RAW_CSV, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const headers = lines[0].split(',');
  const index = (name: string): number => {
    const value = headers.indexOf(name);
    if (value < 0) throw new Error(`原始数据缺少字段: ${name}`);
    return value;
  };
  const replayIndex = index('ReplayCode');
  const keyIndex = index('关卡牌局代码');
  const terrainIndex = index('地形编号');
  const onlineIndex = index('在线胜率(%)');
  const sim1Index = index('mistake_0.01');
  const sim5Index = index('mistake_0.05');
  const sim15Index = index('mistake_0.15');
  const oldGrades = buildOldGradeMap();

  return lines.slice(1).filter(Boolean).map(line => {
    const cells = line.split(',');
    const sim1 = Number(cells[sim1Index]) / 100;
    const sim5 = Number(cells[sim5Index]) / 100;
    const sim15 = Number(cells[sim15Index]) / 100;
    const online = Number(cells[onlineIndex]) / 100;
    const oldGrade = oldGrades.get(`${cells[terrainIndex]}\u0000${cells[keyIndex]}`) ?? null;
    const estimatedRate = estimateOnlineRate(sim1, sim5, sim15);
    return {
      replayCode: cells[replayIndex],
      replayKey: cells[keyIndex],
      terrainId: cells[terrainIndex],
      online,
      sim1,
      sim5,
      sim15,
      oldGrade,
      estimatedRate,
      newGrade: sixGrade(estimatedRate),
      sim5Grade: sixGrade(sim5),
      actualGrade: sixGrade(online),
    };
  });
}

function groupStats(method: string, rows: Row[], gradeOf: (row: Row) => string | null, order: string[]): GroupStat[] {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const grade = gradeOf(row);
    if (grade == null) continue;
    const values = groups.get(grade) ?? [];
    values.push(row.online);
    groups.set(grade, values);
  }
  return order.filter(grade => groups.has(grade)).map(grade => {
    const values = groups.get(grade)!;
    const p25 = percentile(values, 0.25), p75 = percentile(values, 0.75);
    return {
      method,
      grade,
      count: values.length,
      mean: mean(values),
      p10: percentile(values, 0.10),
      p25,
      median: percentile(values, 0.50),
      p75,
      p90: percentile(values, 0.90),
      iqr: p75 - p25,
    };
  });
}

function summarize(stats: GroupStat[]): MethodSummary {
  const rows = stats.reduce((sum, item) => sum + item.count, 0);
  const allMean = stats.reduce((sum, item) => sum + item.mean * item.count, 0) / rows;
  let withinVariance = 0, totalVariance = 0, betweenVariance = 0;
  // 根据分组摘要重建组内方差需要原始值，因此调用方随后覆盖 weightedWithinStd/etaSquared。
  const overlaps: number[] = [];
  let monotonic = 0;
  for (let i = 0; i < stats.length - 1; i++) {
    const left = stats[i], right = stats[i + 1];
    if (left.median >= right.median) monotonic++;
    const intersection = Math.max(0, Math.min(left.p75, right.p75) - Math.max(left.p25, right.p25));
    const smallerWidth = Math.min(left.iqr, right.iqr);
    overlaps.push(smallerWidth > 0 ? intersection / smallerWidth : 0);
  }
  void allMean; void withinVariance; void totalVariance; void betweenVariance;
  return {
    rows,
    groupCount: stats.length,
    weightedWithinStd: 0,
    weightedIqr: stats.reduce((sum, item) => sum + item.iqr * item.count, 0) / rows,
    etaSquared: 0,
    adjacentMedianMonotonic: monotonic,
    adjacentPairs: Math.max(0, stats.length - 1),
    averageAdjacentOverlap: mean(overlaps),
  };
}

function completeSummary(rows: Row[], stats: GroupStat[], gradeOf: (row: Row) => string | null): MethodSummary {
  const summary = summarize(stats);
  const valid = rows.filter(row => gradeOf(row) != null);
  const overallMean = mean(valid.map(row => row.online));
  const byGrade = new Map<string, number[]>();
  for (const row of valid) {
    const grade = gradeOf(row)!;
    const values = byGrade.get(grade) ?? [];
    values.push(row.online);
    byGrade.set(grade, values);
  }
  let within = 0, total = 0, between = 0;
  for (const row of valid) total += (row.online - overallMean) ** 2;
  for (const values of byGrade.values()) {
    const groupMean = mean(values);
    within += values.reduce((sum, value) => sum + (value - groupMean) ** 2, 0);
    between += values.length * (groupMean - overallMean) ** 2;
  }
  summary.weightedWithinStd = Math.sqrt(within / valid.length);
  summary.etaSquared = total > 0 ? between / total : 0;
  return summary;
}

function classificationMetrics(rows: Row[], gradeOf: (row: Row) => number): {
  exact: number; withinOne: number; crossTwo: number; crossThree: number; gradeMae: number;
} {
  let exact = 0, withinOne = 0, crossTwo = 0, crossThree = 0, gradeError = 0;
  for (const row of rows) {
    const distance = Math.abs(gradeOf(row) - row.actualGrade);
    if (distance === 0) exact++;
    if (distance <= 1) withinOne++;
    if (distance >= 2) crossTwo++;
    if (distance >= 3) crossThree++;
    gradeError += distance;
  }
  return {
    exact: exact / rows.length,
    withinOne: withinOne / rows.length,
    crossTwo: crossTwo / rows.length,
    crossThree: crossThree / rows.length,
    gradeMae: gradeError / rows.length,
  };
}

function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function number(value: number, digits = 1): string {
  return (value * 100).toFixed(digits);
}

function main(): void {
  const rows = loadRows();
  const oldOrder = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '999'];
  const newOrder = ['0', '1', '2', '3', '4', '5'];
  const oldGradeOf = (row: Row): string | null => row.oldGrade == null ? null : String(row.oldGrade);
  const newGradeOf = (row: Row): string => String(row.newGrade);
  const sim5GradeOf = (row: Row): string => String(row.sim5Grade);

  const oldStats = groupStats('原始grade', rows, oldGradeOf, oldOrder);
  const sim5Stats = groupStats('sim5直接六档', rows, sim5GradeOf, newOrder);
  const newStats = groupStats('三率估计六档', rows, newGradeOf, newOrder);
  const allStats = [...oldStats, ...sim5Stats, ...newStats];

  const oldSummary = completeSummary(rows, oldStats, oldGradeOf);
  const sim5Summary = completeSummary(rows, sim5Stats, sim5GradeOf);
  const newSummary = completeSummary(rows, newStats, newGradeOf);
  const sim5Metrics = classificationMetrics(rows, row => row.sim5Grade);
  const newMetrics = classificationMetrics(rows, row => row.newGrade);

  const detailHeader = [
    'ReplayCode', '关卡牌局代码', '地形编号', '原始grade', '在线胜率(%)',
    'sim1%', 'sim5%', 'sim15%', '三率估计胜率(%)', '新grade', '新grade名称',
    '目标区间', '线上真实六档', '档位差',
  ];
  const detailLines = rows.map(row => [
    row.replayCode,
    row.replayKey,
    row.terrainId,
    row.oldGrade ?? '',
    number(row.online, 2),
    number(row.sim1, 0),
    number(row.sim5, 0),
    number(row.sim15, 0),
    number(row.estimatedRate, 2),
    row.newGrade,
    GRADE_NAMES[row.newGrade],
    TARGET_RANGES[row.newGrade],
    row.actualGrade,
    Math.abs(row.newGrade - row.actualGrade),
  ].join(','));
  writeFileSync(DETAIL_CSV, [detailHeader.join(','), ...detailLines].join('\n') + '\n', 'utf8');

  const distributionHeader = ['方法', 'grade', '关卡数', '在线均值(%)', 'P10', 'P25', 'P50', 'P75', 'P90', 'IQR宽度'];
  const distributionLines = allStats.map(item => [
    item.method, item.grade, item.count, number(item.mean), number(item.p10), number(item.p25),
    number(item.median), number(item.p75), number(item.p90), number(item.iqr),
  ].join(','));
  writeFileSync(DISTRIBUTION_CSV, [distributionHeader.join(','), ...distributionLines].join('\n') + '\n', 'utf8');

  const missingOldGrade = rows.filter(row => row.oldGrade == null).length;
  let report = '# 全量难度估计与原始 grade 分布对比\n\n';
  report += `- 数据：${rows.length} 条牌局，全部获得新六档估计。\n`;
  report += `- 原始 grade 可关联 ${rows.length - missingOldGrade} 条，缺失 ${missingOldGrade} 条。\n`;
  report += '- 新估计只使用 sim1/sim5/sim15，不使用在线胜率、原始 grade、离散度或地形结构作为输入。\n\n';
  report += '## 新估计方法\n\n';
  report += '```text\n估计在线胜率 = clamp(0.30 × sim1 + 0.10 × sim5 + 0.60 × sim15 + 0.08, 0, 1)\n```\n\n';
  report += '再按 90–100、60–90、40–60、20–40、10–20、0–10 映射为新 grade 0～5。权重来自按地形分组的五折网格搜索，并四舍五入为生产可读参数。\n\n';

  report += '## 总体集中度\n\n';
  report += '| 方法 | 覆盖 | 档位数 | 加权档内标准差 | 加权IQR | 分组解释方差η² | 中位数单调相邻档 | 平均相邻IQR重叠 |\n';
  report += '|---|---:|---:|---:|---:|---:|---:|---:|\n';
  const summaryRows: Array<[string, MethodSummary]> = [
    ['原始grade', oldSummary], ['sim5直接六档', sim5Summary], ['三率估计六档', newSummary],
  ];
  for (const [label, summary] of summaryRows) {
    report += `| ${label} | ${summary.rows}/${rows.length} | ${summary.groupCount} | ${number(summary.weightedWithinStd)}pp | ${number(summary.weightedIqr)}pp | ${pct(summary.etaSquared)} | ${summary.adjacentMedianMonotonic}/${summary.adjacentPairs} | ${pct(summary.averageAdjacentOverlap)} |\n`;
  }

  report += '\n## 六档分类效果\n\n';
  report += '| 方法 | 全覆盖 | 精确档 | 目标或相邻档 | 跨≥2档 | 跨≥3档 | 档位MAE |\n';
  report += '|---|---:|---:|---:|---:|---:|---:|\n';
  report += `| sim5直接六档 | 100% | ${pct(sim5Metrics.exact)} | ${pct(sim5Metrics.withinOne)} | ${pct(sim5Metrics.crossTwo)} | ${pct(sim5Metrics.crossThree)} | ${sim5Metrics.gradeMae.toFixed(3)} |\n`;
  report += `| 三率估计六档 | 100% | ${pct(newMetrics.exact)} | ${pct(newMetrics.withinOne)} | ${pct(newMetrics.crossTwo)} | ${pct(newMetrics.crossThree)} | ${newMetrics.gradeMae.toFixed(3)} |\n`;

  report += '\n## 原始 grade 在线胜率分布\n\n';
  report += '| 原始grade | 关卡数 | 在线均值 | P25 | P50 | P75 | IQR |\n';
  report += '|---:|---:|---:|---:|---:|---:|---:|\n';
  for (const item of oldStats) {
    report += `| ${item.grade} | ${item.count} | ${pct(item.mean)} | ${pct(item.p25)} | ${pct(item.median)} | ${pct(item.p75)} | ${number(item.iqr)}pp |\n`;
  }

  report += '\n## 新 grade 在线胜率分布\n\n';
  report += '| 新grade | 名称 | 关卡数 | 在线均值 | P25 | P50 | P75 | IQR |\n';
  report += '|---:|---|---:|---:|---:|---:|---:|---:|\n';
  for (const item of newStats) {
    const grade = Number(item.grade);
    report += `| ${grade} | ${GRADE_NAMES[grade]} | ${item.count} | ${pct(item.mean)} | ${pct(item.p25)} | ${pct(item.median)} | ${pct(item.p75)} | ${number(item.iqr)}pp |\n`;
  }

  const severeDelta = sim5Metrics.crossTwo - newMetrics.crossTwo;
  report += '\n## 结论\n\n';
  report += `- 新方法覆盖全部 ${rows.length} 条；相较 sim5 直接六档，跨≥2档从 ${pct(sim5Metrics.crossTwo)} 降到 ${pct(newMetrics.crossTwo)}，改善 ${pct(severeDelta)}。\n`;
  report += `- 原始 grade 的分组解释方差为 ${pct(oldSummary.etaSquared)}，新 grade 为 ${pct(newSummary.etaSquared)}；该指标越高，说明不同档位对在线胜率的区分越明显。\n`;
  report += `- 原始 grade 相邻档中位数满足“grade越高胜率越低”的只有 ${oldSummary.adjacentMedianMonotonic}/${oldSummary.adjacentPairs}，新 grade 为 ${newSummary.adjacentMedianMonotonic}/${newSummary.adjacentPairs}。\n`;
  report += '- 新估计适合用于生产阶段全量导航；严格分档策略1仍可保留为最终认证标签。\n';
  writeFileSync(REPORT_MD, report, 'utf8');

  console.log(`完成：${rows.length} 条全部估计，原始grade关联 ${rows.length - missingOldGrade} 条`);
  console.log(`sim5: exact=${pct(sim5Metrics.exact)} within1=${pct(sim5Metrics.withinOne)} cross2=${pct(sim5Metrics.crossTwo)}`);
  console.log(`三率: exact=${pct(newMetrics.exact)} within1=${pct(newMetrics.withinOne)} cross2=${pct(newMetrics.crossTwo)}`);
  console.log(`输出: ${DETAIL_CSV}`);
  console.log(`报告: ${REPORT_MD}`);
}

main();
