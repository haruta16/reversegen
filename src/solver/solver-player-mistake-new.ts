/**
 * Mistake-Prone Player Simulation Solver — 有失误概率的玩家。
 *
 * 与标准玩家求解器差异：
 *   每步操作前，以 probability = mistakeRate 触发"失误"：
 *     失误 → 从所有可点击牌中随机选一张（无视策略）
 *     正常 → 执行标准玩家策略（安全三连组 / 揭露模式）
 *
 * mistakeRate 作为入参，范围 0.0 ~ 1.0。
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
} from './solver-player-new.js';

// ═══════════════════════════════════════════════════════════
//  失误策略
// ═══════════════════════════════════════════════════════════

/**
 * 在可点击牌中随机选一张（失误时的行为）。
 */
function pickRandomClickable(game: OfflineGame, rng: () => number): OfflineTile | null {
  const clickable = game.deskTiles.filter(t => t.isClickable);
  if (clickable.length === 0) return null;
  return clickable[Math.floor(rng() * clickable.length)];
}

/**
 * 标准玩家策略（与 solver-player.ts 的 selectTile 逻辑一致）。
 */
function selectTileStrategic(game: OfflineGame, rng: () => number): OfflineTile | null {
  const visibleGroups = computeVisibleMatchGroups(game);
  const dockRemain = game.remainSlotCount;
  const safeGroups = visibleGroups.filter(g => g.totalCost <= dockRemain);

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

/**
 * 带失误概率的选牌。
 *
 * 每步以 mistakeRate 概率随机选牌，否则执行标准策略。
 */
function selectTile(
  game: OfflineGame,
  rng: () => number,
  mistakeRate: number,
): OfflineTile | null {
  // ★ 失误判定：rng() < mistakeRate → 随机选
  if (rng() < mistakeRate) {
    return pickRandomClickable(game, rng);
  }

  return selectTileStrategic(game, rng);
}

// ═══════════════════════════════════════════════════════════
//  公开 API
// ═══════════════════════════════════════════════════════════

export interface MistakeConfig {
  /** 每步失误概率（0.0 ~ 1.0） */
  mistakeRate: number;
  /** 最大步数限制（默认 2000） */
  maxSteps?: number;
}

/**
 * 单次带失误玩家模拟。
 */
export function solvePlayerMistake(
  game: OfflineGame,
  seed: number,
  config: MistakeConfig,
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

    // color starvation: dock+clickable 中是否有颜色 ≥2 张
    const cb = new Map<number, number>();
    for (const [c, n] of g.getDockCounts()) cb.set(c, n);
    for (const t of g.deskTiles) {
      if (t.isClickable && t.elementValue > 0) {
        cb.set(t.elementValue, (cb.get(t.elementValue) ?? 0) + 1);
      }
    }
    let hasColorPair = false;
    for (const n of cb.values()) { if (n >= 3) { hasColorPair = true; break; } }
    if (!hasColorPair) colorStarvationCount++;

    // detect forced-random-pick: safeGroups=0 走 fallback
    const visibleGroups = computeVisibleMatchGroups(g);
    const dockRemain = g.remainSlotCount;
    const safeGroups = visibleGroups.filter(mg => mg.totalCost <= dockRemain);

    const tile = selectTile(g, rng, config.mistakeRate);
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

    if (safeGroups.length === 0) forcedRandomPickCount++;

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
 * 批量带失误玩家模拟。
 */
export function solvePlayerMistakeBatch(
  game: OfflineGame,
  runs: number,
  baseSeed: number,
  config: MistakeConfig,
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
    const result = solvePlayerMistake(game, baseSeed + i, config);
    results.push(result);
    if (result.win) {
      wins++;
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
    forcedPickOnWin: wins > 0 ? totalForcedOnWin / wins : 0,
    starvationOnWin: wins > 0 ? totalStarveOnWin / wins : 0,
    stepsOnLoss: losses > 0 ? totalLossSteps / losses : 0,
    forcedPickOnLoss: losses > 0 ? totalForcedOnLoss / losses : 0,
    starvationOnLoss: losses > 0 ? totalStarveOnLoss / losses : 0,
    elapsedMs: performance.now() - startTime,
  };
}
