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
 * 共享 MatchGroup 分析、可见性判断、路径计算、随机选牌与指标统计
 * 核心逻辑（复用 solver-player.ts 唯一基础引擎）。
 */

import { OfflineGame } from './offline-game.js';
import { mulberry32 } from '../random-utils.js';
import {
  chooseStrategicTile,
  computeVisibleMatchGroups,
  hasCompletableVisibleColor,
  pickRandomClickable,
  type PlayerSimResult,
  type PlayerSimBatchResult,
} from './solver-player.js';

// ═══════════════════════════════════════════════════════════
//  失误策略
// ═══════════════════════════════════════════════════════════

/**
 * 带失误概率的选牌。
 *
 * 每步以 mistakeRate 概率随机选牌，否则执行标准策略。
 */
function selectTile(
  game: OfflineGame,
  rng: () => number,
  mistakeRate: number,
): number | null {
  // ★ 失误判定：rng() < mistakeRate → 随机选
  if (rng() < mistakeRate) {
    const tile = pickRandomClickable(game, rng);
    return tile?.id ?? null;
  }

  const { tile } = chooseStrategicTile(game, rng);
  return tile?.id ?? null;
}

// ═══════════════════════════════════════════════════════════
//  公开 API
// ═══════════════════════════════════════════════════════════

export interface MistakeConfig {
  /** 每步失误概率（0.0 ~ 1.0） */
  mistakeRate: number;
  /** 最大步数限制（默认 2000） */
  maxSteps?: number;
  /** Keep per-run pick paths. Batch search should normally leave this false. */
  collectTrace?: boolean;
}

interface MistakeRunSummary {
  win: boolean;
  failReason: string | null;
  stepCount: number;
  picks?: number[];
  remainingTilesOnFail: number;
  forcedRandomPickCount: number;
  colorStarvationCount: number;
}

function runMistakeSimulation(
  game: OfflineGame,
  seed: number,
  config: MistakeConfig,
  collectTrace: boolean,
): MistakeRunSummary {
  const maxSteps = config.maxSteps ?? 2000;
  const g = game.clone();
  const picks = collectTrace ? [] as number[] : undefined;
  const rng = mulberry32(seed);
  let forcedRandomPickCount = 0;
  let colorStarvationCount = 0;

  for (let step = 0; step < maxSteps; step++) {
    if (g.isWin) break;
    if (g.isDead) {
      return {
        win: false,
        failReason: `Dock full at step ${step}`,
        stepCount: step,
        picks,
        remainingTilesOnFail: g.deskTiles.length,
        forcedRandomPickCount,
        colorStarvationCount,
      };
    }

    // color starvation: dock+clickable 中是否有颜色 ≥3 张
    if (!hasCompletableVisibleColor(g)) colorStarvationCount++;

    // detect forced-random-pick: safeGroups=0 走 fallback
    const visibleGroups = computeVisibleMatchGroups(g);
    const dockRemain = g.remainSlotCount;
    const safeGroups = visibleGroups.filter(mg => mg.totalCost <= dockRemain);

    const tileId = selectTile(g, rng, config.mistakeRate);
    if (tileId === null) {
      return {
        win: false,
        failReason: `No clickable tiles at step ${step}`,
        stepCount: step,
        picks,
        remainingTilesOnFail: g.deskTiles.length,
        forcedRandomPickCount,
        colorStarvationCount,
      };
    }

    // forced pick: safeGroups=0（与失误是否触发无关）
    if (safeGroups.length === 0) forcedRandomPickCount++;

    g.collect(g.allTiles.get(tileId)!);
    picks?.push(tileId);
  }

  // Without a trace, count completed actions from the remaining board rather
  // than allocating a picks array. Every action removes one desk tile.
  const actions = collectTrace ? (picks?.length ?? 0) : Math.max(0, game.deskTiles.length - g.deskTiles.length);
  return {
    win: g.isWin,
    failReason: g.isWin ? null : (g.isDead ? 'Dock full' : `Max steps (${maxSteps}) reached`),
    stepCount: actions,
    picks,
    remainingTilesOnFail: g.isWin ? 0 : g.deskTiles.length,
    forcedRandomPickCount,
    colorStarvationCount,
  };
}

/**
 * 单次带失误玩家模拟。
 */
export function solvePlayerMistake(
  game: OfflineGame,
  seed: number,
  config: MistakeConfig,
): PlayerSimResult {
  const result = runMistakeSimulation(game, seed, config, config.collectTrace !== false);
  return {
    ...result,
    picks: result.picks ?? [],
    seed,
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
  const collectTrace = config.collectTrace ?? true;
  const results = collectTrace ? [] as PlayerSimResult[] : undefined;
  let totalWinSteps = 0;
  let totalLossSteps = 0;
  let totalForcedOnWin = 0;
  let totalStarveOnWin = 0;
  let totalForcedOnLoss = 0;
  let totalStarveOnLoss = 0;

  for (let i = 0; i < runs; i++) {
    const result = collectTrace
      ? solvePlayerMistake(game, baseSeed + i, { ...config, collectTrace: true })
      : runMistakeSimulation(game, baseSeed + i, config, false);
    if (collectTrace) {
      results!.push({ ...result, picks: result.picks ?? [], seed: baseSeed + i });
    }
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
