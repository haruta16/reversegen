#!/usr/bin/env npx ts-node
/**
 * 关卡挑战次数期望计算工具
 *
 * ── 问题描述 ──
 *
 * 给定一个 GradeSequence = [g1, g2, ..., gk]，玩家依次使用对应难度挑战关卡。
 * 每个难度 gi 对应一个过关概率 p(gi)。
 *
 * 规则：
 *   - 第 1..k 次挑战依次使用 g1, g2, ..., gk
 *   - 第 > k 次挑战固定使用 gk（序列的最后一位，无限重复直到过关）
 *
 * 目标：计算玩家通过该关卡的期望挑战次数 E[T]。
 *
 * ── 解析公式 ──
 *
 * 定义:
 *   S = [g1, ..., gk]  等级序列
 *   pi = p(gi)        第 i 级的过关概率
 *
 * 对于 i = 1..k:
 *   P(第 i 次通过) = pi × ∏_{j=1}^{i-1} (1 - pj)
 *
 * 第 k 次之后未通过的概率:
 *   P(前 k 次未通过) = ∏_{j=1}^{k} (1 - pj)
 *
 * 之后每次使用 gk，过关概率为 pk，后续次数服从几何分布：
 *   后续期望次数 = 1 / pk
 *
 * 总期望:
 *   E[T] = Σ_{i=1}^{k} [ i × pi × ∏_{j=1}^{i-1} (1-pj) ]
 *        + ∏_{j=1}^{k} (1-pj) × (k + 1/pk)
 *
 *
 * ── 用法示例 ──
 *
 *   npx ts-node tools/challenge-expectation.ts --sequence 5,4,3
 *   npx ts-node tools/challenge-expectation.ts --sequence 4,3,2,1,0
 *   npx ts-node tools/challenge-expectation.ts --sequence 5,4,3 --customProbs 0.02,0.10,0.35
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// ── 类型定义 ──

interface ChallengeParams {
  /** 等级序列，如 [5, 4, 3] */
  gradeSequence: number[];
  /** grade → 过关概率 映射 */
  gradeProbMap: Map<number, number>;
  /** 蒙特卡洛模拟次数 */
  simCount: number;
}

interface ExpectationResult {
  /** 解析公式计算结果 */
  analytical: number;
  /** 蒙特卡洛模拟结果 */
  simulated: number;
  /** 模拟的置信区间 (95%) */
  ci95: [number, number];
  /** 模拟的标准误 */
  stdErr: number;
  /** 有效等级序列 */
  effectiveSequence: number[];
  /** 每步详情 */
  steps: StepDetail[];
  /** 模拟样本（用于分布分析） */
  samples: number[];
}

interface DistributionStats {
  /** 解析 PMF：{尝试次数: 概率} */
  analyticalPmf: Map<number, number>;
  /** 模拟频数：{尝试次数: 频数} */
  simulatedFreq: Map<number, number>;
  /** 分位数 */
  percentiles: { p50: number; p75: number; p90: number; p95: number; p99: number };
  /** 偏度 (Fisher-Pearson) */
  skewness: number;
  /** 众数 */
  mode: number;
  /** 标准差 */
  stdDev: number;
}

interface StepDetail {
  attempt: number;
  grade: number;
  winProb: number;
  cumulativeFailProb: number;
  contributeToExpectation: number;
}

// ── 内置 Grade → 过关概率映射 ──

/**
 * 基于分档策略1的目标胜率区间，取中位值作为默认映射。
 * grade 0 (极易): 90-100% → 0.95
 * grade 1 (简单): 60-90% → 0.75
 * grade 2 (中等偏易): 40-60% → 0.50
 * grade 3 (中等偏难): 20-40% → 0.30
 * grade 4 (困难): 10-20% → 0.15
 * grade 5 (极难): 0-10% → 0.05
 */
function loadDefaultGradeProbMap(): Map<number, number> {
  const map = new Map<number, number>();
  // 尝试从配置文件读取，失败则使用默认值
  try {
    const configPath = path.join(__dirname, '..', 'config', 'grade-strategy-1.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    for (const tier of config.tiers) {
      const range = tier.targetRate.replace('%', '').split('-').map(Number);
      // 取区间中点
      const mid = (range[0] + range[1]) / 200; // 除以200因为百分比转比例再取中点
      map.set(tier.grade, mid);
    }
  } catch {
    // 使用硬编码默认值
    map.set(0, 0.95);
    map.set(1, 0.75);
    map.set(2, 0.50);
    map.set(3, 0.30);
    map.set(4, 0.15);
    map.set(5, 0.05);
  }
  return map;
}

// ── 解析公式 ──

/**
 * 解析计算期望挑战次数。
 *
 * 推导：
 *   阶段1: 前 k 次使用序列中的难度 g1..gk
 *     - 第 i 次通过概率: pi × ∏(1 - pj) for j < i
 *     - 贡献: i × 该概率
 *
 *   阶段2: 第 k+1 次及以后使用 gk
 *     - 前 k 次全部未通过概率: cf = ∏(1 - pj) for j=1..k
 *     - 剩余次数 ~ Geometric(pk)，期望 = 1/pk
 *     - 贡献: cf × (k + 1/pk)
 *
 *   总期望:
 *     E[T] = Σ i × pi × ∏_{j<i} (1-pj) + cf × (k + 1/pk)
 */
function analyticalExpectation(params: ChallengeParams): { expectation: number; steps: StepDetail[] } {
  const { gradeSequence, gradeProbMap } = params;
  const k = gradeSequence.length;
  const probs = gradeSequence.map(g => gradeProbMap.get(g) ?? 0.05);
  const pk = probs[k - 1];

  if (pk <= 0) {
    throw new Error(`保底难度 ${gradeSequence[k - 1]} 的过关概率为 0，期望次数为无穷大`);
  }

  const steps: StepDetail[] = [];
  let cumulativeFail = 1.0; // cumulative probability of failing all previous attempts
  let totalExpectation = 0.0;

  // 阶段1: 前 k 次
  for (let i = 0; i < k; i++) {
    const winProb = probs[i];
    const clearOnThis = cumulativeFail * winProb; // P(前 i 次失败 且 第 i+1 次通过)
    const contribution = (i + 1) * clearOnThis;
    totalExpectation += contribution;

    steps.push({
      attempt: i + 1,
      grade: gradeSequence[i],
      winProb,
      cumulativeFailProb: cumulativeFail,
      contributeToExpectation: contribution,
    });

    cumulativeFail *= (1 - winProb);
  }

  // 阶段2: 第 k+1 次及以后，使用 gk
  // P(进入阶段2) = cumulativeFail
  const geoExpectation = 1 / pk;
  const phase2Contribution = cumulativeFail * (k + geoExpectation);
  totalExpectation += phase2Contribution;

  // 记录阶段2的摘要信息
  steps.push({
    attempt: k + 1,
    grade: gradeSequence[k - 1],
    winProb: pk,
    cumulativeFailProb: cumulativeFail,
    contributeToExpectation: phase2Contribution,
  });

  return { expectation: totalExpectation, steps };
}

// ── 蒙特卡洛模拟 ──

/**
 * 单次蒙特卡洛试验，模拟一个玩家挑战该关卡的过程。
 * @returns 通过时所用的总挑战次数
 */
function simulateOneRun(params: ChallengeParams): number {
  const { gradeSequence, gradeProbMap } = params;
  const k = gradeSequence.length;

  let attempts = 0;

  while (true) {
    attempts++;
    // 确定当前难度：序列内按索引，超出用最后一位
    const gradeIdx = (attempts <= k) ? (attempts - 1) : (k - 1);
    const grade = gradeSequence[gradeIdx];
    const winProb = gradeProbMap.get(grade) ?? 0.05;

    // 掷骰子
    if (Math.random() < winProb) {
      return attempts;
    }
  }
}

interface SimResult {
  mean: number;
  stdErr: number;
  ci95: [number, number];
  samples: number[];
}

/**
 * 运行蒙特卡洛模拟。
 */
function monteCarloSimulation(params: ChallengeParams): SimResult {
  const { simCount } = params;
  const samples: number[] = [];

  for (let i = 0; i < simCount; i++) {
    samples.push(simulateOneRun(params));
  }

  // 统计
  const n = samples.length;
  const sum = samples.reduce((a, b) => a + b, 0);
  const mean = sum / n;

  // 方差
  const variance = samples.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (n - 1);
  const stdErr = Math.sqrt(variance / n);

  // 95% 置信区间
  const z = 1.96;
  const ciLow = mean - z * stdErr;
  const ciHigh = mean + z * stdErr;

  return { mean, stdErr, ci95: [ciLow, ciHigh], samples };
}

// ── 构建有效等级序列 ──

function buildEffectiveSequence(params: ChallengeParams): number[] {
  const { gradeSequence } = params;
  return [...gradeSequence]; // 序列本身已完整定义
}

// ── 分布分析 ──

/**
 * 解析计算概率质量函数 (PMF)。
 * 对 t = 1..k:  P(T=t) = pt × ∏_{j=1}^{t-1} (1-pj)
 * 对 t > k:   P(T=t) = ∏_{j=1}^{k} (1-pj) × (1-pk)^(t-k-1) × pk
 */
function analyticalPmf(params: ChallengeParams, maxT: number): Map<number, number> {
  const { gradeSequence, gradeProbMap } = params;
  const k = gradeSequence.length;
  const probs = gradeSequence.map(g => gradeProbMap.get(g) ?? 0.05);
  const pk = probs[k - 1];

  const pmf = new Map<number, number>();
  let cumulativeFail = 1.0;

  // 阶段1: t = 1..k
  for (let t = 0; t < k; t++) {
    const probClear = cumulativeFail * probs[t];
    pmf.set(t + 1, probClear);
    cumulativeFail *= (1 - probs[t]);
  }

  // 阶段2: t = k+1..maxT, 几何分布
  const phase2Entry = cumulativeFail;
  for (let t = k + 1; t <= maxT; t++) {
    const probClear = phase2Entry * Math.pow(1 - pk, t - k - 1) * pk;
    pmf.set(t, probClear);
  }

  // 截断余量（t > maxT 的概率）
  const truncation = phase2Entry * Math.pow(1 - pk, maxT - k);
  if (truncation > 0.0001) {
    pmf.set(maxT + 1, truncation);
  }

  return pmf;
}

/**
 * 从模拟样本计算频数分布。
 */
function simulatedFreq(samples: number[]): Map<number, number> {
  const freq = new Map<number, number>();
  for (const t of samples) {
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  // 排序
  const sorted = new Map<number, number>();
  const keys = [...freq.keys()].sort((a, b) => a - b);
  for (const k of keys) {
    sorted.set(k, freq.get(k)!);
  }
  return sorted;
}

/**
 * 计算分布统计量。
 */
function computeDistributionStats(
  params: ChallengeParams,
  samples: number[],
): DistributionStats {
  const n = samples.length;
  const sorted = [...samples].sort((a, b) => a - b);

  const p50 = sorted[Math.floor(n * 0.50)];
  const p75 = sorted[Math.floor(n * 0.75)];
  const p90 = sorted[Math.floor(n * 0.90)];
  const p95 = sorted[Math.floor(n * 0.95)];
  const p99 = sorted[Math.floor(n * 0.99)];

  // 均值
  const mean = samples.reduce((a, b) => a + b, 0) / n;

  // 标准差
  const variance = samples.reduce((acc, x) => acc + (x - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);

  // Fisher-Pearson 偏度系数
  const m3 = samples.reduce((acc, x) => acc + (x - mean) ** 3, 0) / n;
  const skewness = stdDev > 0 ? m3 / (stdDev ** 3) : 0;

  // 众数
  const freq = simulatedFreq(samples);
  let mode = 1;
  let maxFreq = 0;
  for (const [t, f] of freq) {
    if (f > maxFreq) {
      maxFreq = f;
      mode = t;
    }
  }

  // 解析 PMF（覆盖到 P99 + 10）
  const maxT = p99 + 10;
  const pmf = analyticalPmf(params, maxT);

  return {
    analyticalPmf: pmf,
    simulatedFreq: freq,
    percentiles: { p50, p75, p90, p95, p99 },
    skewness,
    mode,
    stdDev,
  };
}

/**
 * 打印 ASCII 分布直方图。
 */
function printHistogram(
  analyticalPmf: Map<number, number>,
  simulatedFreq: Map<number, number>,
  simCount: number,
  maxBins: number = 30,
): void {
  // 确定显示范围：覆盖到 P99 + 2
  const allKeys = new Set([...analyticalPmf.keys(), ...simulatedFreq.keys()]);
  let maxT = Math.max(...allKeys);
  // 限制显示范围
  if (maxT > 30) maxT = Math.min(maxT, maxBins);

  // 找最大柱高度（用于归一化）
  let maxAnalytical = 0;
  for (let t = 1; t <= maxT; t++) {
    const p = analyticalPmf.get(t) ?? 0;
    if (p > maxAnalytical) maxAnalytical = p;
  }
  const maxSim = Math.max(...simulatedFreq.values());

  const barWidth = 40; // 最大柱状条宽度字符数

  console.log('  ' + '─'.repeat(70));
  console.log('  尝试次数 |   解析 PMF   |   模拟频数   | 分布图 (█=解析, ░=模拟)');
  console.log('  ' + '─'.repeat(70));

  for (let t = 1; t <= maxT; t++) {
    const ap = analyticalPmf.get(t) ?? 0;
    const sf = simulatedFreq.get(t) ?? 0;
    const sfRate = sf / simCount;

    // 跳过概率极小的行（但在有模拟数据的行保留）
    if (ap < 0.0001 && sf === 0 && t > 5) continue;

    const aBarLen = Math.round((ap / (maxAnalytical || 1)) * barWidth);
    const sBarLen = Math.round((sfRate / (maxAnalytical || 1)) * barWidth);

    const aBar = '█'.repeat(aBarLen);
    const sBar = '░'.repeat(Math.max(0, sBarLen - aBarLen));

    console.log(
      `  ${String(t).padStart(6)}   | ${(ap * 100).toFixed(2).padStart(6)}%     | ${String(sf).padStart(6)} (${(sfRate * 100).toFixed(1)}%) | ${aBar}${sBar}`,
    );
  }
  console.log('  ' + '─'.repeat(70));
  console.log('  █ = 解析理论值    ░ = 蒙特卡洛模拟  (超出理论部分叠加显示)');
}

// ── 主计算函数 ──

function computeExpectation(params: ChallengeParams): ExpectationResult {
  const { expectation: analytical, steps } = analyticalExpectation(params);
  const simResult = monteCarloSimulation(params);
  const effectiveSequence = buildEffectiveSequence(params);

  return {
    analytical,
    simulated: simResult.mean,
    ci95: simResult.ci95,
    stdErr: simResult.stdErr,
    effectiveSequence,
    steps,
    samples: simResult.samples,
  };
}

// ── 输出格式化 ──

function printResult(result: ExpectationResult, params: ChallengeParams, showDist: boolean): void {
  const { gradeSequence, gradeProbMap, simCount } = params;
  const k = gradeSequence.length;

  console.log('═'.repeat(70));
  console.log('  关卡挑战次数期望计算');
  console.log('═'.repeat(70));
  console.log();

  // 输入参数
  console.log('【输入参数】');
  console.log(`  GradeSequence    : [${gradeSequence.join(', ')}]`);
  console.log('  Grade → 过关概率 :');
  for (const g of gradeSequence) {
    console.log(`    grade ${g} → ${((gradeProbMap.get(g) ?? 0.05) * 100).toFixed(1)}%`);
  }
  console.log(`  模拟次数          : ${simCount.toLocaleString()}`);
  console.log();

  // 有效序列
  console.log('【实际使用的难度序列】');
  const labels = gradeSequence.map((g, i) => `第${i + 1}次=grade ${g}`);
  labels.push(`第${k + 1}次起=grade ${gradeSequence[k - 1]}(序列耗尽)`);
  console.log(`  ${labels.join(' → ')}`);
  console.log();

  // 解析公式逐步骤
  console.log('【解析公式 - 逐步骤分解】');
  console.log('  步骤 | 使用难度 | 过关概率 | 累积失败率 | 对期望的贡献');
  console.log('  ' + '─'.repeat(55));
  for (const step of result.steps) {
    if (step.attempt <= k) {
      console.log(
        `  第${step.attempt}次 | grade ${step.grade}  | ${(step.winProb * 100).toFixed(1)}%    | ${(step.cumulativeFailProb * 100).toFixed(2)}%      | ${step.contributeToExpectation.toFixed(4)}`,
      );
    } else {
      console.log(
        `  第${step.attempt}+次 | grade ${step.grade}(序列耗尽) | ${(step.winProb * 100).toFixed(1)}% | ${(step.cumulativeFailProb * 100).toFixed(2)}%     | ${step.contributeToExpectation.toFixed(4)} (含几何期望)`,
      );
    }
  }
  console.log();
  console.log('  解析公式: E[T] = Σ(步骤贡献)');
  console.log();

  // 最终结果
  console.log('【计算结果】');
  console.log(`  解析公式期望    : ${result.analytical.toFixed(4)} 次`);
  console.log(`  蒙特卡洛模拟期望 : ${result.simulated.toFixed(4)} 次`);
  console.log(`  95% 置信区间    : [${result.ci95[0].toFixed(4)}, ${result.ci95[1].toFixed(4)}]`);
  console.log(`  模拟标准误      : ${result.stdErr.toFixed(6)}`);
  const diff = Math.abs(result.analytical - result.simulated);
  console.log(`  解析 vs 模拟偏差 : ${diff.toFixed(6)} (${((diff / result.analytical) * 100).toFixed(4)}%)`);
  console.log();

  // 序列耗尽分析
  console.log('【序列耗尽分析】');
  const { gradeProbMap: map } = params;
  const pk = map.get(gradeSequence[k - 1]) ?? 0.05;
  let probBeforeRepeat = 1.0;
  for (let i = 0; i < k; i++) {
    probBeforeRepeat *= (1 - (map.get(gradeSequence[i]) ?? 0.05));
  }
  console.log(`  序列耗尽概率        : ${(probBeforeRepeat * 100).toFixed(2)}%`);
  console.log(`  耗尽后单次过关概率    : ${(pk * 100).toFixed(1)}%`);
  console.log(`  耗尽后期望挑战次数    : ${(1 / pk).toFixed(2)} 次 (几何分布, p=${(pk * 100).toFixed(1)}%)`);
  console.log();

  // 分布特征
  if (showDist) {
    const distStats = computeDistributionStats(params, result.samples);
    console.log('【分布特征】');
    console.log(`  分布类型        : 相型分布 (Phase-Type)，前 m 次多概率混合 + 尾部几何分布`);
    console.log(`  标准差          : ${distStats.stdDev.toFixed(4)}`);
    console.log(`  偏度 (Skewness) : ${distStats.skewness.toFixed(4)} ${distStats.skewness > 0.5 ? '(显著右偏/长尾)' : distStats.skewness > 0 ? '(轻微右偏)' : '(左偏)'}`);
    console.log(`  众数 (Mode)     : ${distStats.mode} 次`);
    console.log(`  分位数:`);
    console.log(`    P50 (中位数)  : ${distStats.percentiles.p50} 次`);
    console.log(`    P75           : ${distStats.percentiles.p75} 次`);
    console.log(`    P90           : ${distStats.percentiles.p90} 次`);
    console.log(`    P95           : ${distStats.percentiles.p95} 次`);
    console.log(`    P99           : ${distStats.percentiles.p99} 次`);
    console.log();

    // 直方图
    console.log('【分布直方图 - 解析理论值 vs 蒙特卡洛模拟】');
    printHistogram(distStats.analyticalPmf, distStats.simulatedFreq, simCount);
    console.log();
  }
}

// ── 命令行参数解析 ──

function parseArgs(): { params: ChallengeParams; showDist: boolean } {
  const args = process.argv.slice(2);

  let gradeSequence: number[] = [5, 4, 3];
  let simCount = 100000;
  let gradeProbMap = loadDefaultGradeProbMap();
  let customProbs: number[] | null = null;
  let showDist = true;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--sequence':
      case '-s':
        gradeSequence = args[++i].split(',').map(Number);
        break;
      case '--simCount':
      case '-n':
        simCount = Number(args[++i]);
        break;
      case '--customProbs':
      case '-p':
        customProbs = args[++i].split(',').map(Number);
        break;
      case '--no-dist':
        showDist = false;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        console.error(`未知参数: ${args[i]}`);
        printHelp();
        process.exit(1);
    }
  }

  // 如果提供了自定义概率，覆盖映射
  if (customProbs) {
    if (customProbs.length !== gradeSequence.length) {
      throw new Error(
        `自定义概率数量 (${customProbs.length}) 与 GradeSequence 长度 (${gradeSequence.length}) 不匹配`,
      );
    }
    gradeProbMap = new Map<number, number>();
    for (let i = 0; i < customProbs.length; i++) {
      gradeProbMap.set(gradeSequence[i], customProbs[i]);
    }
  }

  // 验证输入
  if (gradeSequence.length === 0) {
    throw new Error('GradeSequence 不能为空');
  }
  if (simCount < 100) {
    throw new Error('模拟次数至少 100');
  }

  // 确保所有 grade 都有概率映射
  for (const g of gradeSequence) {
    if (!gradeProbMap.has(g)) {
      console.warn(`警告: grade ${g} 没有对应的过关概率，使用默认值 5%`);
      gradeProbMap.set(g, 0.05);
    }
  }

  return { params: { gradeSequence, gradeProbMap, simCount }, showDist };
}

function printHelp(): void {
  console.log(`
关卡挑战次数期望计算工具

规则:
  给定 GradeSequence = [g1, ..., gk]，第 1..k 次依次使用对应难度，
  第 k+1 次起固定使用 gk（最后一位）。计算通过关卡的期望挑战次数。

用法:
  npx ts-node tools/challenge-expectation.ts [选项]

选项:
  -s, --sequence <grades>    GradeSequence，逗号分隔 (默认: 5,4,3)
  -n, --simCount <n>         蒙特卡洛模拟次数 (默认: 100000)
  -p, --customProbs <probs>  自定义每个 grade 的过关概率，逗号分隔
                              (长度必须与 sequence 一致)
      --no-dist              不显示分布直方图和统计量
  -h, --help                 显示此帮助

概率映射 (内置):
  grade 0 (极易,   90-100%) → 95.0%
  grade 1 (简单,   60-90%)  → 75.0%
  grade 2 (中等偏易,40-60%) → 50.0%
  grade 3 (中等偏难,20-40%) → 30.0%
  grade 4 (困难,   10-20%) → 15.0%
  grade 5 (极难,    0-10%) →  5.0%

示例:
  npx ts-node tools/challenge-expectation.ts
  npx ts-node tools/challenge-expectation.ts -s 4,3,2,1,0
  npx ts-node tools/challenge-expectation.ts -s 5,4,3 -p 0.02,0.10,0.35
  npx ts-node tools/challenge-expectation.ts -s 5 -n 1000000
`);
}

// ── 入口 ──

function main(): void {
  try {
    const { params, showDist } = parseArgs();
    const result = computeExpectation(params);
    printResult(result, params, showDist);
  } catch (err: any) {
    console.error(`错误: ${err.message}`);
    process.exit(1);
  }
}

main();
