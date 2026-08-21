/**
 * Mistake-Mechanic Player Simulation Solver — 机制感知的失误玩家。
 *
 * 与 mistake 的差异只在"正常选牌"分支：
 *   1. 候选组按"机制可见性"过滤：
 *      - 基础几何 Invisible（PerfectCovered / 投影并集覆盖）
 *      - 未揭示问号(2/202/203, isDone!==true) → 视为被完全遮住（点击状态按真实）
 *      - 未揭示翻转(7/207, isDone!==true) → 同上
 *      - 被大型地形(51-53)覆盖 → 同上
 *   2. 魔药优先：存在"含魔药(31)且 cost ≤ 剩余槽位"的候选组 → 必选
 *      （多组时按 cost 升序、组内最小 ID 升序确定性取一，不随机）
 *   3. 其余与 mistake 一致：安全组随机选、无安全组走解锁收益 fallback、
 *      失误概率 mistakeRate 先于一切判定。
 *
 * 指标（forcedPick / starvation）与批量聚合沿用 mistake 口径。
 */

import { OfflineGame } from './offline-game.js';
import { mulberry32 } from '../random-utils.js';
import { TileFlag, type OfflineTile } from './types.js';
import {
  computeAnalyzerMatchGroups,
  hasCompletableVisibleColor,
  pickClickableFromPath,
  pickMostRevealingTile,
  pickRandomClickable,
  type MatchGroup,
  type PlayerSimResult,
  type PlayerSimBatchResult,
} from './solver-player.js';

const UNKNOWN_EXTRAS = new Set([2, 202, 203]);
const FLIP_EXTRAS = new Set([7, 207]);

export interface MistakeMechanicConfig {
  /** 每步失误概率（0.0 ~ 1.0） */
  mistakeRate: number;
  /** 未揭示问号/翻转视为不可见（默认 true） */
  hideUnrevealed?: boolean;
  /** 魔药组 cost ≤ 剩余槽位时必选（默认 true） */
  magicBottlePriority?: boolean;
  /** 最大步数限制（默认 2000） */
  maxSteps?: number;
  /** Keep per-run pick paths. Batch search should normally leave this false. */
  collectTrace?: boolean;
}

/** 机制可见性：几何 Invisible + 未揭示问号/翻转 + 大 tile 覆盖。 */
function isMechanicVisible(tile: OfflineTile, game: OfflineGame, hideUnrevealed: boolean): boolean {
  if (tile.hasFlag(TileFlag.Destroyed) || tile.hasFlag(TileFlag.Invisible)) return false;
  if (game.hasActiveBoardSpecialCovering(tile.id)) return false;
  if (!hideUnrevealed) return true;
  return !tile.extras.some(e =>
    (UNKNOWN_EXTRAS.has(e.extraEnum) || FLIP_EXTRAS.has(e.extraEnum)) && e.isDone !== true);
}

/** 机制可见的候选组（基于 analyzer 全量组过滤）。 */
function mechanicVisibleGroups(game: OfflineGame, hideUnrevealed: boolean): MatchGroup[] {
  return computeAnalyzerMatchGroups(game).filter(g =>
    g.tiles.every(t => isMechanicVisible(t, game, hideUnrevealed)));
}

function groupMinId(group: MatchGroup): number {
  let min = Number.POSITIVE_INFINITY;
  for (const t of group.tiles) if (t.id < min) min = t.id;
  return min;
}

/** 魔药优先：cost ≤ 剩余槽位且含魔药挂件的组，按 (cost, 最小ID) 确定性取一。 */
function magicBottleGroup(groups: MatchGroup[], dockRemain: number): MatchGroup | null {
  const candidates = groups.filter(g =>
    g.totalCost <= dockRemain
    && g.tiles.some(t => t.extras.some(e => e.extraEnum === 31)));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) =>
    a.totalCost !== b.totalCost ? a.totalCost - b.totalCost : groupMinId(a) - groupMinId(b));
  return candidates[0];
}

/** 带失误概率 + 机制感知的选牌。 */
function selectTile(
  game: OfflineGame,
  rng: () => number,
  groups: MatchGroup[],
  safeGroups: MatchGroup[],
  config: MistakeMechanicConfig,
): number | null {
  // 失误判定优先（同 mistake）
  if (rng() < config.mistakeRate) {
    const tile = pickRandomClickable(game, rng);
    return tile?.id ?? null;
  }

  const dockRemain = game.remainSlotCount;
  let chosen: MatchGroup | null = null;
  if (config.magicBottlePriority !== false) {
    chosen = magicBottleGroup(groups, dockRemain);
  }
  if (!chosen && safeGroups.length > 0) {
    chosen = safeGroups[Math.floor(rng() * safeGroups.length)];
  }
  if (chosen) {
    const tile = pickClickableFromPath(chosen, game);
    if (tile) return tile.id;
  }
  // fallback 只用解锁收益（不复用 chooseStrategicTile：它会重新选到被机制隐藏的组）
  const tile = pickMostRevealingTile(game, rng);
  return tile?.id ?? null;
}

// ═══════════════════════════════════════════════════════════
//  公开 API
// ═══════════════════════════════════════════════════════════

interface MistakeMechanicRunSummary {
  win: boolean;
  failReason: string | null;
  stepCount: number;
  picks?: number[];
  remainingTilesOnFail: number;
  forcedRandomPickCount: number;
  colorStarvationCount: number;
}

function runMistakeMechanicSimulation(
  game: OfflineGame,
  seed: number,
  config: MistakeMechanicConfig,
  collectTrace: boolean,
): MistakeMechanicRunSummary {
  const maxSteps = config.maxSteps ?? 2000;
  const hideUnrevealed = config.hideUnrevealed ?? true;
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

    if (!hasCompletableVisibleColor(g)) colorStarvationCount++;

    const groups = mechanicVisibleGroups(g, hideUnrevealed);
    const dockRemain = g.remainSlotCount;
    const safeGroups = groups.filter(mg => mg.totalCost <= dockRemain);

    const tileId = selectTile(g, rng, groups, safeGroups, config);
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

    // forced pick：机制可见的安全组为空（与失误是否触发无关）
    if (safeGroups.length === 0) forcedRandomPickCount++;

    g.collect(g.allTiles.get(tileId)!);
    picks?.push(tileId);
  }

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

/** 单次机制感知失误玩家模拟。 */
export function solvePlayerMistakeMechanic(
  game: OfflineGame,
  seed: number,
  config: MistakeMechanicConfig,
): PlayerSimResult {
  const result = runMistakeMechanicSimulation(game, seed, config, config.collectTrace !== false);
  return {
    ...result,
    picks: result.picks ?? [],
    seed,
  };
}

/** 批量机制感知失误玩家模拟。 */
export function solvePlayerMistakeMechanicBatch(
  game: OfflineGame,
  runs: number,
  baseSeed: number,
  config: MistakeMechanicConfig,
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
      ? solvePlayerMistakeMechanic(game, baseSeed + i, { ...config, collectTrace: true })
      : runMistakeMechanicSimulation(game, baseSeed + i, config, false);
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
