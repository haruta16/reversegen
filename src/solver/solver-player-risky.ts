/**
 * Risky Player Simulation Solver — 水位线式激进玩家。
 *
 * 与标准玩家求解器差异：
 *   当 dockRemain ≥ riskThreshold 时（Dock 有余裕），安全判断放宽为 totalCost ≤ dockRemain + 1；
 *   当 dockRemain < riskThreshold 时（Dock 紧张），使用原始保守条件 totalCost ≤ dockRemain。
 *
 *   这样避免了在 Dock 几乎满的时候冒险导致必死的雪崩效应。
 *
 * riskThreshold 作为入参，默认 3（Dock 占用不到一半时允许冒险）。
 *
 * 共享 MatchGroup 分析、可见性判断、路径计算等核心逻辑（复用 solver-player.ts）。
 */

import { OfflineGame } from './offline-game.js';
import { OfflineTile } from './types.js';
import { mulberry32 } from '../random-utils.js';
import {
  computeVisibleMatchGroups,
  pickClickableFromPath,
  pickMostRevealingTile,
  type PlayerSimResult,
  type PlayerSimBatchResult,
} from './solver-player.js';

// ═══════════════════════════════════════════════════════════
//  水位线式激进策略
// ═══════════════════════════════════════════════════════════

/**
 * 玩家策略选牌（水位线激进版）。
 *
 * 当 dockRemain ≥ riskThreshold → 宽松安全判断（+1 容错）
 * 当 dockRemain < riskThreshold → 原始保守安全判断
 */
function selectTile(
  game: OfflineGame,
  rng: () => number,
  riskThreshold: number,
): OfflineTile | null {
  const visibleGroups = computeVisibleMatchGroups(game);
  const dockRemain = game.remainSlotCount;

  // ★ 水位线逻辑：有余裕时 +1，紧张时保守
  const safetyMargin = dockRemain >= riskThreshold
    ? dockRemain + 1
    : dockRemain;

  const safeGroups = visibleGroups.filter(g => g.totalCost <= safetyMargin);

  if (safeGroups.length > 0) {
    const chosen = safeGroups[Math.floor(rng() * safeGroups.length)];
    const tile = pickClickableFromPath(chosen, game);
    if (tile) return tile;
    for (const g of safeGroups) {
      const t = pickClickableFromPath(g, game);
      if (t) return t;
    }
  }

  return pickMostRevealingTile(game, rng);
}

// ═══════════════════════════════════════════════════════════
//  公开 API
// ═══════════════════════════════════════════════════════════

export interface RiskyConfig {
  /** 冒险水位线：dockRemain ≥ 此值时才启用 +1 放宽（默认 3） */
  riskThreshold?: number;
  /** 最大步数限制（默认 2000） */
  maxSteps?: number;
}

/**
 * 单次水位线激进玩家模拟。
 */
export function solvePlayerRisky(
  game: OfflineGame,
  seed: number,
  config: RiskyConfig,
): PlayerSimResult {
  const riskThreshold = config.riskThreshold ?? 3;
  const maxSteps = config.maxSteps ?? 2000;
  const g = game.clone();
  const picks: number[] = [];
  const rng = mulberry32(seed);

  for (let step = 0; step < maxSteps; step++) {
    if (g.isWin) break;
    if (g.isDead) {
      return {
        win: false,
        failReason: `Dock full at step ${step}`,
        picks,
        stepCount: picks.length,
        seed,
      };
    }

    const tile = selectTile(g, rng, riskThreshold);
    if (!tile) {
      return {
        win: false,
        failReason: `No clickable tiles at step ${step}`,
        picks,
        stepCount: picks.length,
        seed,
      };
    }

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
  };
}

/**
 * 批量水位线激进玩家模拟。
 */
export function solvePlayerRiskyBatch(
  game: OfflineGame,
  runs: number,
  baseSeed: number,
  config: RiskyConfig,
): PlayerSimBatchResult {
  const startTime = performance.now();
  let wins = 0;
  let losses = 0;
  const results: PlayerSimResult[] = [];
  let totalWinSteps = 0;

  for (let i = 0; i < runs; i++) {
    const result = solvePlayerRisky(game, baseSeed + i, config);
    results.push(result);
    if (result.win) {
      wins++;
      totalWinSteps += result.stepCount;
    } else {
      losses++;
    }
  }

  return {
    wins,
    losses,
    winRate: runs > 0 ? wins / runs : 0,
    results,
    avgStepsOnWin: wins > 0 ? totalWinSteps / wins : 0,
    elapsedMs: performance.now() - startTime,
  };
}
