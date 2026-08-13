/**
 * Cost Ladder 反向生成算法。
 *
 * Unity C# 版 ReverseGenAlgorithm.AssignTileTypes 的移植。
 *
 * === 核心机制（不可移除，移除则算法不成立）===
 *
 * 1. Cost 计算: cost = |depSet \ collectedIds| — 消除这个 triple 需要释放多少尚未释放的依赖。
 *    每步重新计算所有候选 triple 的实时 cost。这是算法唯一的决策依据。
 *
 * 2. 贪心选择: 每步选 cost ≥ target 的第一个候选。
 *
 * 3. 黑名单: cost ≤ 选中 triple 的候选全部封杀。
 *    没有黑名单，贪心会退化为每步选最便宜的，全局 cost 链毫无起伏。
 *
 * 4. r-chain 约束: r_i = r_{i-1} + c_i - 3, r_0 = r_N = 0。
 *    这是 Cost 数组生成器的合法性依据，算法本身不直接使用但依赖其正确性。
 *
 * === 辅助机制（可调整/替换，不影响算法正确性）===
 *
 * 5. 池化（历史机制，已移除）: 连续同 cost 步骤在同一快照下互选。
 *    早期版本含池化多选分支，但池构造始终为 count=1 使其不可达；
 *    为避免文档与实现不一致，该分支已删除（见 executeStep 前说明）。
 *
 * 6. 抢救: 候选耗光时从黑名单尾部找回。搜索方向可改（头部/随机）。
 *
 * 7. 花色选择: 选违规最少的花色，平局时负载均衡。可替换为其他策略。
 *
 * 8. 排序稳定性: 同等 cost 候选的相对顺序。C# 不稳定 / JS 稳定，已知差异。
 */

import type { TerrainTile, Triple, TripleKey, ScheduleEntry, StepRecord, ReverseGenInput, ReverseGenOutput, CostStats } from './types.js';
import { tripleKey, parseTripleKey } from './types.js';
import { computeAllDependencies } from './dependency-graph.js';
import { buildTriples, overlaps, computeCost } from './triple-builder.js';
import { runPureGreedySimulation } from './greedy-sim.js';
import { logger } from './logger.js';

// ── 内部类型 ──

interface CandidateInfo {
  triple: Triple;
  cost: number;
  key: TripleKey;
}

// ── 主入口 ──

export function runReverseGen(input: ReverseGenInput): ReverseGenOutput {
  const { tiles, costArray, colorCount } = input;

  // ── 准备工作 ──
  const tileMap = new Map<number, TerrainTile>();
  for (const tile of tiles) tileMap.set(tile.id, tile);

  const allDeps = computeAllDependencies(tiles);

  const constTiles = tiles.filter(t => t.isConst);
  const freeTiles = tiles.filter(t => !t.isConst);

  const constAssignments = new Map<number, number>();
  for (const t of constTiles) {
    if (t.constElementValue > 0) constAssignments.set(t.id, t.constElementValue);
  }

  const triples = buildTriples(freeTiles, allDeps);
  const steps = Math.floor(freeTiles.length / 3);

  // 验证 cost 数组
  if (costArray.length !== steps) throw new Error(`costArray length ${costArray.length} != steps ${steps}`);
  for (const v of costArray) { if (v < 1) throw new Error(`cost value ${v} < 1`); }

  const costTargets = costArray;

  logger.info(
    `[ReverseGen] 开始 | 总牌:${freeTiles.length} 花色:${colorCount} 步数:${steps} triple数:${triples.length}` +
    ` cost目标=[${costTargets.join(',')}]`
  );

  // ── 状态 ──
  const usedIds = new Set<number>();
  const collectedIds = new Set<number>();
  const banSet = new Set<TripleKey>();
  const banList: Triple[] = [];
  const banStepMap = new Map<TripleKey, number>();
  const schedule: ScheduleEntry[] = [];
  const stepLog: StepRecord[] = [];
  const tileToBanTriples = new Map<number, TripleKey[]>();
  const tileColorMap = new Map<number, number>();

  // ── 单步执行 ──
  // 说明：历史版本包含"连续同 cost 步骤在同一快照下互选"的池化多选分支，
  // 但池构造始终为 count=1（从未实际分组），该分支不可达。为避免注释与
  // 实现不一致，池化多选分支已移除——当前算法是每步独立快照的标准贪心。
  let currentStep = 0;
  let aborted = false;

  function executeStep(target: number): void {
    const stepNum = currentStep + 1;

    // 1) 收集当前快照下全部候选
    const allCandidates: CandidateInfo[] = [];
    for (const t of triples) {
      if (overlaps(t, usedIds)) continue;
      const key = tripleKey(t.tileIds);
      if (banSet.has(key)) continue;
      allCandidates.push({ triple: t, cost: computeCost(t, collectedIds), key });
    }

    // 2) 候选耗光 → 抢救
    if (allCandidates.length === 0) {
      logger.warn(`[ReverseGen] 第${stepNum}步无可用candidate，从黑名单抢救剩余${freeTiles.length - usedIds.size}张牌`);
      const rescueResult = rescueFromBlacklist(usedIds, collectedIds, banSet, banList, banStepMap);
      if (!rescueResult) { logger.warn('[ReverseGen] 抢救失败，中止'); aborted = true; return; }

      const { triple, cost, key, bannedAtStep } = rescueResult;
      banSet.delete(key);
      const chosenColor = selectSafeColor(triple.tileIds, tileToBanTriples, tileColorMap, colorCount);

      logger.info(`[ReverseGen] 第${stepNum}/${steps}步 ID=[${triple.tileIds.join(',')}] cost=${cost} 候选=0 封杀=0 色=${chosenColor} ⚠抢救(第${bannedAtStep}步拉黑)`);

      stepLog.push({ step: stepNum, tileIds: triple.tileIds, cost, target, candidateCount: 0, bannedCount: 0, colorIndex: chosenColor, rescued: true, bannedAtStep, simCost: 0 });
      schedule.push({ tileIds: triple.tileIds, colorIndex: chosenColor });
      for (const id of triple.tileIds) { usedIds.add(id); tileColorMap.set(id, chosenColor); }
      for (const id of triple.depSet) collectedIds.add(id);

      currentStep++;
      return;
    }

    // 3) 标准贪心: 按 cost 排序，选第一个 cost ≥ target 的候选
    allCandidates.sort((a, b) => a.cost - b.cost);
    const idx = allCandidates.findIndex(c => c.cost >= target);
    const selected: CandidateInfo = idx >= 0
      ? allCandidates[idx]
      : allCandidates[allCandidates.length - 1];

    // 4) 封杀: 阈值 = 选中 triple 的实际 cost
    const banThreshold = selected.cost;
    let banCnt = 0;
    for (const { triple: t, cost, key } of allCandidates) {
      if (cost <= banThreshold && key !== selected.key) {
        banSet.add(key);
        banList.push(t);
        banStepMap.set(key, stepNum);
        addToBanIndex(tileToBanTriples, t.tileIds);
        banCnt++;
      }
    }

    // 5) 落色 + 记录
    const { triple, cost } = selected;
    const chosenColor = selectSafeColor(triple.tileIds, tileToBanTriples, tileColorMap, colorCount);

    logger.info(`[ReverseGen] 第${stepNum}/${steps}步 ID=[${triple.tileIds.join(',')}] cost=${cost} 目标=${target} 候选=${allCandidates.length} 封杀=${banCnt} 色=${chosenColor}`);

    stepLog.push({ step: stepNum, tileIds: triple.tileIds, cost, target, candidateCount: allCandidates.length, bannedCount: banCnt, colorIndex: chosenColor, rescued: false, bannedAtStep: -1, simCost: 0 });
    schedule.push({ tileIds: triple.tileIds, colorIndex: chosenColor });
    for (const id of triple.tileIds) { usedIds.add(id); tileColorMap.set(id, chosenColor); }
    for (const id of triple.depSet) collectedIds.add(id);

    currentStep++;
  }

  // ── 主循环: 逐目标执行 ──
  for (const target of costTargets) {
    executeStep(target);
    if (aborted) break;
  }

  // ── 落色 ──
  const assignments = new Map<number, number>();
  for (const { tileIds, colorIndex } of schedule) {
    const ev = colorIndex + 1;
    for (const id of tileIds) assignments.set(id, ev);
  }

  // ── 纯贪心模拟 ──
  const { costLog, branchLog } = runPureGreedySimulation(freeTiles, assignments, allDeps, steps);
  for (let i = 0; i < stepLog.length && i < costLog.length; i++) {
    stepLog[i].simCost = costLog[i];
  }

  // ── 统计 ──
  const stats = computeStats(costLog);
  let devCount = 0;
  const devInfos: string[] = [];
  for (let i = 0; i < costLog.length; i++) {
    if (costLog[i] !== costTargets[i]) {
      devCount++;
      if (devInfos.length < 8) devInfos.push(`#${i + 1}:${costTargets[i]}→${costLog[i]}`);
    }
  }
  const matchRate = (steps - devCount) * 100 / steps;

  // ── 日志 ──
  const lines: string[] = [];
  lines.push(`[ReverseGen] 完成 | 步数:${costLog.length}/${steps} | 花色:${colorCount}`);
  lines.push(`  目标cost: [${costTargets.join(',')}]`);
  lines.push(`  实际cost: [${costLog.join(',')}]`);
  lines.push(`  偏差: ${devCount}/${steps}`);
  if (devCount > 0) lines.push(`  匹配率: ${matchRate.toFixed(0)}% | 偏差位置: [${devInfos.join(', ')}]${devCount > 8 ? ` ...等${devCount}处` : ''}`);
  lines.push(`  策略分支数: [${branchLog.join(',')}]`);
  if (costLog.length > 0) lines.push(`  cost统计: min=${stats.min} max=${stats.max} avg=${stats.avg.toFixed(1)}`);
  lines.push(`  黑名单: ${banSet.size}`);
  logger.info(lines.join('\n'));

  return { assignments, constAssignments, costLog, branchLog, stepLog, completed: !aborted, deviationCount: devCount, matchRate, totalSteps: steps, banSetSize: banSet.size, stats };
}

// ═══════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════

function rescueFromBlacklist(
  usedIds: Set<number>, collectedIds: Set<number>,
  banSet: Set<TripleKey>, banList: Triple[], banStepMap: Map<TripleKey, number>
): { triple: Triple; cost: number; key: TripleKey; bannedAtStep: number } | null {
  for (let i = banList.length - 1; i >= 0; i--) {
    const t = banList[i];
    if (overlaps(t, usedIds)) continue;
    const key = tripleKey(t.tileIds);
    if (!banSet.has(key)) continue;
    return { triple: t, cost: computeCost(t, collectedIds), key, bannedAtStep: banStepMap.get(key) ?? -1 };
  }
  return null;
}

function addToBanIndex(index: Map<number, TripleKey[]>, tileIds: [number, number, number]): void {
  const key = tripleKey(tileIds);
  for (const tileId of tileIds) {
    let list = index.get(tileId);
    if (!list) { list = []; index.set(tileId, list); }
    list.push(key);
  }
}

function selectSafeColor(tileIds: [number, number, number], tileToBanTriples: Map<number, TripleKey[]>, tileColorMap: Map<number, number>, colorCount: number): number {
  let bestColor = 0;
  let fewestViolations = Infinity;
  for (let c = 0; c < colorCount; c++) {
    const violations = countViolations(tileIds, c, tileToBanTriples, tileColorMap);
    if (violations === 0) return c;
    if (violations < fewestViolations) { fewestViolations = violations; bestColor = c; }
    else if (violations === fewestViolations) {
      let cur = 0, best = 0;
      for (const [, col] of tileColorMap) { if (col === c) cur++; if (col === bestColor) best++; }
      if (cur < best) bestColor = c;
    }
  }
  return bestColor;
}

function countViolations(tileIds: [number, number, number], color: number, tileToBanTriples: Map<number, TripleKey[]>, tileColorMap: Map<number, number>): number {
  const assigningSet = new Set(tileIds);
  const violatedBans = new Set<TripleKey>();
  for (const tid of tileIds) {
    const bans = tileToBanTriples.get(tid);
    if (!bans) continue;
    for (const banKey of bans) {
      if (violatedBans.has(banKey)) continue;
      const [bt1, bt2, bt3] = parseTripleKey(banKey);
      let sameColorCount = 0;
      for (const bt of [bt1, bt2, bt3]) {
        if (assigningSet.has(bt)) sameColorCount++;
        else { const ac = tileColorMap.get(bt); if (ac !== undefined && ac === color) sameColorCount++; }
      }
      if (sameColorCount === 3) violatedBans.add(banKey);
    }
  }
  return violatedBans.size;
}

function computeStats(costLog: number[]): CostStats {
  if (costLog.length === 0) return { min: 0, max: 0, avg: 0 };
  let min = Infinity, max = -Infinity, sum = 0;
  for (const c of costLog) { if (c < min) min = c; if (c > max) max = c; sum += c; }
  return { min, max, avg: sum / costLog.length };
}
