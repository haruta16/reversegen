/**
 * Cost Ladder 反向生成算法。
 *
 * Unity C# 版 ReverseGenAlgorithm.AssignTileTypes 的精确移植。
 *
 * 核心原理：每步贪心选取动态 cost 最小的 triple。为消除贪心的内部矛盾，
 * 将 cost 低于选中 triple 的候选拉入黑名单（banSet），确保被选中的始终是
 * 当前局面的全局最优解。
 *
 * 池化优化：cost ≤ 3 的连续同值步骤合并为"池"，在同一 collectedIds 快照下
 * 一次性选出互不占牌、优先共享 DepSet 的多个 triple。消除逐步执行中
 * peer triple 因 collectedIds 膨胀而 cost 互降的"同伴互杀"问题，
 * 同时因共享 DepSet 减少了依赖清空量，为后期保留更多高 cost 候选。
 *
 * 抢救策略：从 banList 尾部（最近被 ban 的 triple）向前搜索第一个可用的，
 * 遵循 temporal locality 原则，最小化对前期 cost ladder 的冲击。
 */

import type { TerrainTile, Triple, TripleKey, ScheduleEntry, ReverseGenInput, ReverseGenOutput, CostStats } from './types.js';
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

/**
 * 执行 ReverseGen CostLadder 算法。
 *
 * @param input - 地形牌列表、cost 数组、花色数
 * @returns 完整算法输出：花色分配、cost 日志、统计信息
 */
export function runReverseGen(input: ReverseGenInput): ReverseGenOutput {
  const { tiles, costArray, colorCount } = input;

  // ── 准备工作 ──
  const tileMap = new Map<number, TerrainTile>();
  for (const tile of tiles) {
    tileMap.set(tile.id, tile);
  }

  // 为所有牌预计算传递闭包
  const allDeps = computeAllDependencies(tiles);

  // 分离固定牌和自由牌
  const constTiles = tiles.filter(t => t.isConst);
  const freeTiles = tiles.filter(t => !t.isConst);

  // 构建固定牌的花色映射
  const constAssignments = new Map<number, number>();
  for (const t of constTiles) {
    if (t.constElementValue > 0) {
      constAssignments.set(t.id, t.constElementValue);
    }
  }

  // C(n,3) 枚举所有合法 triple
  const triples = buildTriples(freeTiles, allDeps);

  const steps = Math.floor(freeTiles.length / 3);

  // 解析 cost 目标（null = 自然 minCost 模式）
  const costTargets = hasCostArray(costArray, steps) ? costArray! : null;

  logger.info(
    `[ReverseGen] 开始 | 总牌:${freeTiles.length} 花色:${colorCount} 步数:${steps} triple数:${triples.length}` +
    (costTargets ? ` cost目标=[${costTargets.join(',')}]` : ' 自然minCost')
  );

  // ── 状态变量 ──
  const usedIds = new Set<number>();        // 已被选中分配的牌
  const collectedIds = new Set<number>();    // 依赖已被释放的牌
  const banSet = new Set<TripleKey>();       // 黑名单（被ban的triple键）
  const banList: Triple[] = [];              // 黑名单列表（按插入顺序，抢救时从后往前）
  const schedule: ScheduleEntry[] = [];      // 生成调度记录
  const tileToBanTriples = new Map<number, TripleKey[]>(); // tile→被ban的triple键 索引
  const tileColorMap = new Map<number, number>();          // tile→已分配花色

  // ── 池化构造 ──
  // 将连续相同 cost 值合并: [3,3,2,2,2] → [{cost:3, count:2}, {cost:2, count:3}]
  interface Pool {
    cost: number;
    count: number;
  }

  const pools: Pool[] = [];
  if (costTargets) {
    for (let i = 0; i < costTargets.length; i++) {
      if (pools.length === 0 || pools[pools.length - 1].cost !== costTargets[i]) {
        pools.push({ cost: costTargets[i], count: 1 });
      } else {
        pools[pools.length - 1].count++;
      }
    }
  } else {
    pools.push({ cost: -1, count: steps });
  }

  let currentStep = 0;
  let aborted = false;

  // ── 单步选择：挑一个 triple ──
  function step(target: number, stepNum: number): void {
    const candidates: CandidateInfo[] = [];

    for (const t of triples) {
      if (overlaps(t, usedIds)) continue;
      const key = tripleKey(t.tileIds);
      if (banSet.has(key)) continue;
      const cost = computeCost(t, collectedIds);
      candidates.push({ triple: t, cost, key });
    }

    let best: Triple | null = null;
    let bestCost = 0;
    let bestKey: TripleKey = '';

    if (candidates.length === 0) {
      // 候选耗光 → 从黑名单抢救
      logger.warn(
        `[ReverseGen] 第${stepNum}步无可用candidate，从黑名单抢救剩余${freeTiles.length - usedIds.size}张牌`
      );
      const rescued = rescueFromBlacklist(usedIds, collectedIds, banSet, banList);
      if (!rescued) {
        logger.warn('[ReverseGen] 抢救失败，中止');
        aborted = true;
        return;
      }
      best = rescued.triple;
      bestCost = rescued.cost;
      bestKey = rescued.key;
      banSet.delete(bestKey);
    } else {
      // 按 cost 升序排列
      candidates.sort((a, b) => a.cost - b.cost);

      if (target > 0) {
        // 找第一个 cost ≥ target 的候选
        const idx = candidates.findIndex(c => c.cost >= target);
        if (idx >= 0) {
          best = candidates[idx].triple;
          bestCost = candidates[idx].cost;
          bestKey = candidates[idx].key;
        } else {
          // 没有候选满足 target → 选 cost 最高的
          const last = candidates[candidates.length - 1];
          best = last.triple;
          bestCost = last.cost;
          bestKey = last.key;
        }
      } else {
        // 自然 minCost 模式：选 cost 最低的
        best = candidates[0].triple;
        bestCost = candidates[0].cost;
        bestKey = candidates[0].key;
      }
    }

    // ── 封杀：所有 cost ≤ bestCost 且不是选中的候选全部拉黑 ──
    let banCnt = 0;
    if (candidates.length > 0) {
      for (const { triple: t, cost, key } of candidates) {
        if (cost <= bestCost && key !== bestKey) {
          banSet.add(key);
          banList.push(t);
          addToBanIndex(tileToBanTriples, t.tileIds);
          banCnt++;
        }
      }
    }

    // ── 安全选色 ──
    const chosenColor = selectSafeColor(best.tileIds, tileToBanTriples, tileColorMap, colorCount);

    if (target > 0) {
      logger.info(
        `[ReverseGen] 第${stepNum}/${steps}步 ID=[${best.tileIds.join(',')}] cost=${bestCost} 目标=${target} 候选=${candidates.length} 封杀=${banCnt} 色=${chosenColor}`
      );
    } else {
      logger.info(
        `[ReverseGen] 第${stepNum}/${steps}步 ID=[${best.tileIds.join(',')}] cost=${bestCost} 候选=${candidates.length} 封杀=${banCnt} 色=${chosenColor}`
      );
    }

    schedule.push({ tileIds: best.tileIds, colorIndex: chosenColor });
    for (const id of best.tileIds) {
      usedIds.add(id);
      tileColorMap.set(id, chosenColor);
    }
    for (const id of best.depSet) {
      collectedIds.add(id);
    }
  }

  // ── 池化多选：同一快照下一次性选出 count 个互不占牌的 triple ──
  function selectPool(target: number, count: number): void {
    const startStep = currentStep + 1;

    // 收集当前快照下的全部候选
    const allCandidates: CandidateInfo[] = [];
    for (const t of triples) {
      if (overlaps(t, usedIds)) continue;
      const key = tripleKey(t.tileIds);
      if (banSet.has(key)) continue;
      const cost = computeCost(t, collectedIds);
      allCandidates.push({ triple: t, cost, key });
    }

    if (allCandidates.length === 0) {
      logger.warn(`[ReverseGen] 池cost=${target}x${count} 无候选，回退单步`);
      for (let i = 0; i < count; i++) {
        if (aborted) return;
        step(target, ++currentStep);
      }
      return;
    }

    // 筛选 cost == target 的池内候选
    const poolCandidates = allCandidates.filter(c => c.cost === target);

    const selected: CandidateInfo[] = [];
    const selectedTiles = new Set<number>();

    // 贪心选取:
    //   第一个: 选 DepSet 最大的（锚定代表 triple）
    //   后续: 选与已选 DepSet 重叠最多的（共享依赖，减少清空量）
    for (let pick = 0; pick < count; pick++) {
      const available = poolCandidates.filter(
        c => !c.triple.tileIds.some(id => selectedTiles.has(id))
      );
      if (available.length === 0) break;

      let chosen: CandidateInfo;
      if (pick === 0) {
        // 首个: 选 DepSet 最大的（> 表示 tie 时保最早的，匹配 C# stable sort 行为）
        chosen = available.reduce((best, c) =>
          c.triple.depSet.size > best.triple.depSet.size ? c : best
        );
      } else {
        // 后续: 选与已选中 triple 的 DepSet 重叠最多的
        chosen = available.reduce((best, c) => {
          const candidateOverlap = selected.reduce(
            (sum, s) => sum + intersectCount(s.triple.depSet, c.triple.depSet), 0
          );
          const currentBestOverlap = selected.reduce(
            (sum, s) => sum + intersectCount(s.triple.depSet, best.triple.depSet), 0
          );
          // >= 表示 tie 时保最早的，匹配 C# OrderByDescending.First() stable sort 行为
          return currentBestOverlap >= candidateOverlap ? best : c;
        });
      }

      selected.push(chosen);
      for (const id of chosen.triple.tileIds) {
        selectedTiles.add(id);
      }
    }

    const shortfall = count - selected.length;
    if (shortfall > 0) {
      logger.warn(
        `[ReverseGen] 池cost=${target} 仅选出${selected.length}/${count}，回退单步补齐${shortfall}步`
      );
    }

    // Ban: allCandidates 中 cost ≤ target 且未被选中的全部封杀
    let banCnt = 0;
    for (const { triple: t, cost, key } of allCandidates) {
      if (cost <= target && !selected.some(s => s.key === key)) {
        banSet.add(key);
        banList.push(t);
        addToBanIndex(tileToBanTriples, t.tileIds);
        banCnt++;
      }
    }

    // 落色 + 更新状态
    for (const { triple, cost, key } of selected) {
      const chosenColor = selectSafeColor(triple.tileIds, tileToBanTriples, tileColorMap, colorCount);
      logger.info(
        `[ReverseGen] 池cost=${target} 第${startStep}-${startStep + count - 1}步 ID=[${triple.tileIds.join(',')}] cost=${cost} 总候选=${allCandidates.length} 池内=${poolCandidates.length} 封杀=${banCnt} 色=${chosenColor}`
      );
      schedule.push({ tileIds: triple.tileIds, colorIndex: chosenColor });
      for (const id of triple.tileIds) {
        usedIds.add(id);
        tileColorMap.set(id, chosenColor);
      }
      for (const id of triple.depSet) {
        collectedIds.add(id);
      }
    }

    // 补齐：池内选不够的余量用单步
    currentStep += selected.length;
    for (let i = 0; i < shortfall; i++) {
      if (aborted) return;
      step(target, ++currentStep);
    }
  }

  // ── 池迭代主循环 ──
  for (const { cost: target, count } of pools) {
    if (target >= 1 && target <= 3 && count >= 2) {
      // 满足池化条件: cost ≤ 3 且连续 ≥ 2 步
      selectPool(target, count);
    } else {
      for (let i = 0; i < count; i++) {
        step(target, ++currentStep);
        if (aborted) break;
      }
    }
    if (aborted) break;
  }

  // ── 落色: 将花色索引映射为实际花色值（归一化 1..K） ──
  const assignments = new Map<number, number>();
  for (const { tileIds, colorIndex } of schedule) {
    const elementValue = colorIndex + 1;
    for (const id of tileIds) {
      assignments.set(id, elementValue);
    }
  }

  // ── 纯贪心模拟: 落色后按花色分组，每步严格选 minCost ──
  const { costLog, branchLog } = runPureGreedySimulation(freeTiles, assignments, allDeps, steps);

  // ── 构建统计信息 ──
  const stats = computeStats(costLog);

  // 计算偏离统计（日志和返回值共用）
  let devCount = 0;
  const devInfos: string[] = [];
  if (costTargets) {
    for (let i = 0; i < costLog.length; i++) {
      if (costLog[i] !== costTargets[i]) {
        devCount++;
        if (devInfos.length < 8) {
          devInfos.push(`#${i + 1}:${costTargets[i]}→${costLog[i]}`);
        }
      }
    }
  }
  const matchRate = costTargets ? (steps - devCount) * 100 / steps : undefined;

  // ── 输出总结日志 ──
  const lines: string[] = [];
  lines.push(`[ReverseGen] 完成 | 步数:${costLog.length}/${steps} | 花色:${colorCount}`);

  if (costTargets) {
    lines.push(`  目标cost: [${costTargets.join(',')}]`);
    lines.push(`  实际cost: [${costLog.join(',')}]`);
    lines.push(`  偏差: ${devCount}/${steps}`);
    if (devCount > 0) {
      lines.push(`  匹配率: ${matchRate!.toFixed(0)}% | 偏差位置: [${devInfos.join(', ')}]${devCount > 8 ? ` ...等${devCount}处` : ''}`);
    }
  } else {
    lines.push(`  实际cost: [${costLog.join(',')}]`);
  }

  lines.push(`  策略分支数: [${branchLog.join(',')}]`);

  if (costLog.length > 0) {
    lines.push(`  cost统计: min=${stats.min} max=${stats.max} avg=${stats.avg.toFixed(1)}`);
  }

  lines.push(`  黑名单: ${banSet.size}`);
  logger.info(lines.join('\n'));

  // ── 返回结果 ──
  return {
    assignments,
    constAssignments,
    costLog,
    branchLog,
    completed: !aborted,
    deviationCount: costTargets ? devCount : undefined,
    matchRate,
    totalSteps: steps,
    banSetSize: banSet.size,
    stats,
  };
}

// ═══════════════════════════════════════
// 内部辅助函数
// ═══════════════════════════════════════

/**
 * 验证 cost 数组是否有效。
 * 返回 false 的情况: 数组为 null/空、长度不匹配、含非法值（< 1）。
 * 直接对应 C# 版 HasCostArray。
 */
function hasCostArray(arr: number[] | null | undefined, expectedSteps: number): arr is number[] {
  if (!arr || arr.length === 0) return false;
  if (arr.length !== expectedSteps) {
    logger.warn(
      `[ReverseGen] cost数组长度(${arr.length})≠步数(${expectedSteps})，改为自然minCost`
    );
    return false;
  }
  for (const v of arr) {
    if (v < 1) {
      logger.warn(
        `[ReverseGen] cost数组含非法值${v}(最小=1)，改为自然minCost。输入: [${arr.join(',')}]`
      );
      return false;
    }
  }
  return true;
}

/**
 * 从黑名单尾部向前搜索第一个可用的 triple（最近被ban的优先）。
 * 遵循 temporal locality 原则，最小化对前期 cost ladder 的冲击。
 * 直接对应 C# 版 RescueFromBlacklist。
 */
function rescueFromBlacklist(
  usedIds: Set<number>,
  collectedIds: Set<number>,
  banSet: Set<TripleKey>,
  banList: Triple[]
): { triple: Triple; cost: number; key: TripleKey } | null {
  for (let i = banList.length - 1; i >= 0; i--) {
    const t = banList[i];
    if (overlaps(t, usedIds)) continue;
    const key = tripleKey(t.tileIds);
    if (!banSet.has(key)) continue; // 已被之前的抢救移除

    return {
      triple: t,
      cost: computeCost(t, collectedIds),
      key,
    };
  }
  return null;
}

/** 计算两个集合的交集大小 */
function intersectCount(a: Set<number>, b: Set<number>): number {
  let count = 0;
  // 遍历较小的集合以提高效率
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const id of small) {
    if (large.has(id)) count++;
  }
  return count;
}

/**
 * 将 triple 的三张牌 ID 注册到 tile→ban triple 索引。
 * 直接对应 C# 版 AddToBanIndex。
 */
function addToBanIndex(
  index: Map<number, TripleKey[]>,
  tileIds: [number, number, number]
): void {
  const key = tripleKey(tileIds);
  for (const tileId of tileIds) {
    let list = index.get(tileId);
    if (!list) {
      list = [];
      index.set(tileId, list);
    }
    list.push(key);
  }
}

/**
 * 为 triple 选择最安全的花色——创建最少"违规"的花色索引。
 * 违规 = 被 ban 的 triple 变成三张同色（将被 ban 的 triple 复活了）。
 * 平局打破: 优先选当前已分配牌数最少的花色（保持花色均衡）。
 * 直接对应 C# 版 SelectSafeColor。
 */
function selectSafeColor(
  tileIds: [number, number, number],
  tileToBanTriples: Map<number, TripleKey[]>,
  tileColorMap: Map<number, number>,
  colorCount: number
): number {
  let bestColor = 0;
  let fewestViolations = Infinity;

  for (let c = 0; c < colorCount; c++) {
    const violations = countViolations(tileIds, c, tileToBanTriples, tileColorMap);
    if (violations === 0) return c; // 无违规，直接返回
    if (violations < fewestViolations) {
      fewestViolations = violations;
      bestColor = c;
    } else if (violations === fewestViolations) {
      // 平局: 选当前已分配牌数更少的花色（负载均衡）
      let currentCount = 0;
      let bestCount = 0;
      for (const [, color] of tileColorMap) {
        if (color === c) currentCount++;
        if (color === bestColor) bestCount++;
      }
      if (currentCount < bestCount) {
        bestColor = c;
      }
    }
  }

  return bestColor;
}

/**
 * 计算如果给 triple 分配 color 花色，会产生多少个违规（被 ban 的 triple 复活）。
 * 直接对应 C# 版 CountViolations。
 */
function countViolations(
  tileIds: [number, number, number],
  color: number,
  tileToBanTriples: Map<number, TripleKey[]>,
  tileColorMap: Map<number, number>
): number {
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
        if (assigningSet.has(bt)) {
          sameColorCount++;
        } else {
          const ac = tileColorMap.get(bt);
          if (ac !== undefined && ac === color) {
            sameColorCount++;
          }
        }
      }

      // 三张同色 = 违规成立
      if (sameColorCount === 3) {
        violatedBans.add(banKey);
      }
    }
  }

  return violatedBans.size;
}

/** 计算 cost 统计 (min / max / 均值) */
function computeStats(costLog: number[]): CostStats {
  if (costLog.length === 0) return { min: 0, max: 0, avg: 0 };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const c of costLog) {
    if (c < min) min = c;
    if (c > max) max = c;
    sum += c;
  }
  return { min, max, avg: sum / costLog.length };
}
