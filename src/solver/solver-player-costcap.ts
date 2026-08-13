/**
 * Cost-Cap Player Simulation Solver — 成本上限玩家，限制候选三连组。
 *
 * 与标准玩家求解器差异：
 *   在安全判断之前，先用 maxCost 过滤掉 totalCost > maxCost 的候选组。
 *   即：只考虑"成本可承受"的三连组，超过成本上限的直接忽略。
 *
 * maxCost 作为入参，无默认值（调用方必须显式指定）。
 *
 * 共享 MatchGroup 分析、可见性判断、路径计算等核心逻辑（复用 solver-player.ts）。
 */

import { OfflineGame } from './offline-game.js';
import { OfflineTile } from './types.js';
import { mulberry32 } from '../random-utils.js';
import {
  computeVisibleMatchGroups,
  hasCompletableVisibleColor,
  pickClickableFromPath,
  pickMostRevealingTile,
  type PlayerSimResult,
  type PlayerSimBatchResult,
} from './solver-player.js';

// ═══════════════════════════════════════════════════════════
//  成本上限策略
// ═══════════════════════════════════════════════════════════

/**
 * 玩家策略选牌（成本上限版）。
 *
 * 1. 找所有可见三连组
 * 2. ★ 过滤 totalCost ≤ maxCost（忽略成本过高的候选）
 * 3. 在剩余组中过滤 cost ≤ dockRemain 的安全组
 * 4. 有安全组 → 随机选 → 路径中取可点击牌
 * 5. 无安全组 → 选解锁收益最高的可点击牌
 */
function selectTile(
  game: OfflineGame,
  rng: () => number,
  maxCost: number,
): { tile: OfflineTile | null; hadSafeGroup: boolean } {
  const visibleGroups = computeVisibleMatchGroups(game);
  const dockRemain = game.remainSlotCount;

  // ★ 第一步：成本上限过滤
  const cappedGroups = visibleGroups.filter(g => g.totalCost <= maxCost);

  // 第二步：安全判断
  const safeGroups = cappedGroups.filter(g => g.totalCost <= dockRemain);

  if (safeGroups.length > 0) {
    const chosen = safeGroups[Math.floor(rng() * safeGroups.length)];
    const tile = pickClickableFromPath(chosen, game);
    if (tile) return { tile, hadSafeGroup: true };
    for (const g of safeGroups) {
      const t = pickClickableFromPath(g, game);
      if (t) return { tile: t, hadSafeGroup: true };
    }
  }

  return {
    tile: pickMostRevealingTile(game, rng),
    hadSafeGroup: safeGroups.length > 0,
  };
}

// ═══════════════════════════════════════════════════════════
//  公开 API
// ═══════════════════════════════════════════════════════════

export interface CostCapConfig {
  /** 三连组 cost 上限（超过此值的候选被忽略） */
  maxCost: number;
  /** 最大步数限制（默认 2000） */
  maxSteps?: number;
}

/**
 * 单次成本上限玩家模拟。
 */
export function solvePlayerCostCap(
  game: OfflineGame,
  seed: number,
  config: CostCapConfig,
): PlayerSimResult {
  const maxSteps = config.maxSteps ?? 2000;
  const g = game.clone();
  const picks: number[] = [];
  const rng = mulberry32(seed);
  let forcedRandomPickCount = 0;
  let colorStarvationCount = 0;

  for (let step = 0; step < maxSteps; step++) {
    if (g.isWin) break;
    if (g.isDead) {
      return {
        win: false,
        failReason: `Dock full at step ${step}`,
        picks,
        stepCount: picks.length,
        seed,
        remainingTilesOnFail: g.deskTiles.length,
        forcedRandomPickCount,
        colorStarvationCount,
      };
    }

    if (!hasCompletableVisibleColor(g)) colorStarvationCount++;

    const { tile, hadSafeGroup } = selectTile(g, rng, config.maxCost);
    if (!tile) {
      return {
        win: false,
        failReason: `No clickable tiles at step ${step}`,
        picks,
        stepCount: picks.length,
        seed,
        remainingTilesOnFail: g.deskTiles.length,
        forcedRandomPickCount,
        colorStarvationCount,
      };
    }

    if (!hadSafeGroup) forcedRandomPickCount++;

    g.collect(tile);
    picks.push(tile.id);
  }

  return {
    win: g.isWin,
    failReason: g.isWin
      ? null
      : g.isDead
        ? 'Dock full'
        : `Max steps (${maxSteps}) reached`,
    picks,
    stepCount: picks.length,
    seed,
    remainingTilesOnFail: g.isWin ? 0 : g.deskTiles.length,
    forcedRandomPickCount,
    colorStarvationCount,
  };
}

/**
 * 批量成本上限玩家模拟。
 */
export function solvePlayerCostCapBatch(
  game: OfflineGame,
  runs: number,
  baseSeed: number,
  config: CostCapConfig,
): PlayerSimBatchResult {
  const startTime = performance.now();
  let wins = 0;
  let losses = 0;
  const results: PlayerSimResult[] = [];
  let totalWinSteps = 0;
  let totalLossSteps = 0;
  let totalForcedOnWin = 0;
  let totalStarveOnWin = 0;
  let totalForcedOnLoss = 0;
  let totalStarveOnLoss = 0;

  for (let i = 0; i < runs; i++) {
    const result = solvePlayerCostCap(game, baseSeed + i, config);
    results.push(result);
    if (result.win) {
      wins++;
      totalWinSteps += result.stepCount;
      totalForcedOnWin += result.forcedRandomPickCount;
      totalStarveOnWin += result.colorStarvationCount;
    } else {
      losses++;
      totalLossSteps += result.stepCount;
      totalForcedOnLoss += result.forcedRandomPickCount;
      totalStarveOnLoss += result.colorStarvationCount;
    }
  }

  return {
    wins,
    losses,
    winRate: runs > 0 ? wins / runs : 0,
    results,
    avgStepsOnWin: wins > 0 ? totalWinSteps / wins : 0,
    avgStepsOnLoss: losses > 0 ? totalLossSteps / losses : 0,
    stepsOnLoss: losses > 0 ? totalLossSteps / losses : 0,
    forcedPickOnWin: wins > 0 ? totalForcedOnWin / wins : 0,
    starvationOnWin: wins > 0 ? totalStarveOnWin / wins : 0,
    forcedPickOnLoss: losses > 0 ? totalForcedOnLoss / losses : 0,
    starvationOnLoss: losses > 0 ? totalStarveOnLoss / losses : 0,
    elapsedMs: performance.now() - startTime,
  };
}
