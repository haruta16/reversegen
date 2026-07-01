/**
 * Shortest-current-state player solver.
 *
 * Each step chooses the visible safe match group with the smallest current
 * totalCost. If no safe group exists, it falls back to the clickable tile with
 * the highest unlock gain. Ties are randomly selected by seed.
 */

import { OfflineGame } from './offline-game.js';
import { OfflineTile } from './types.js';
import { mulberry32 } from '../random-utils.js';
import {
  computeVisibleMatchGroups,
  pickClickableFromPath,
  type MatchGroup,
} from './solver-player.js';

interface ShortestSimResult {
  win: boolean;
  failReason: string | null;
  picks: number[];
  stepCount: number;
  seed: number;
  forcedRandomPickCount: number;
  colorStarvationCount: number;
}

export interface ShortestSimBatchResult {
  wins: number;
  losses: number;
  winRate: number;
  results: ShortestSimResult[];
  avgStepsOnWin: number;
  avgStepsOnLoss: number;
  forcedPickOnWin: number;
  starvationOnWin: number;
  stepsOnLoss: number;
  forcedPickOnLoss: number;
  starvationOnLoss: number;
  elapsedMs: number;
}

function hasCompletableVisibleColor(game: OfflineGame): boolean {
  const counts = new Map<number, number>();
  for (const [color, n] of game.getDockCounts()) counts.set(color, n);
  for (const tile of game.deskTiles) {
    if (tile.isClickable && tile.elementValue > 0) {
      counts.set(tile.elementValue, (counts.get(tile.elementValue) ?? 0) + 1);
    }
  }
  return [...counts.values()].some(n => n >= 3);
}

function pickOne<T>(items: T[], rng: () => number): T | null {
  if (items.length === 0) return null;
  return items[Math.floor(rng() * items.length)];
}

function pickHighestUnlockGain(game: OfflineGame, rng: () => number): OfflineTile | null {
  const clickable = game.deskTiles.filter(t => t.isClickable);
  if (clickable.length === 0) return null;

  const scored = clickable.map(tile => ({ tile, gain: game.countUnlockGain(tile.id) }));
  const maxGain = Math.max(...scored.map(item => item.gain));
  return pickOne(scored.filter(item => item.gain === maxGain).map(item => item.tile), rng);
}

function selectTile(game: OfflineGame, rng: () => number): { tile: OfflineTile | null; usedFallback: boolean } {
  const safeGroups = computeVisibleMatchGroups(game)
    .filter(group => group.totalCost <= game.remainSlotCount);

  if (safeGroups.length > 0) {
    const minCost = Math.min(...safeGroups.map(group => group.totalCost));
    const shortestGroups = safeGroups.filter(group => group.totalCost === minCost);
    const start = Math.floor(rng() * shortestGroups.length);
    for (let offset = 0; offset < shortestGroups.length; offset++) {
      const group = shortestGroups[(start + offset) % shortestGroups.length];
      const tile = pickClickableFromPath(group, game);
      if (tile) return { tile, usedFallback: false };
    }
  }

  for (const group of safeGroups) {
    const tile = pickClickableFromPath(group, game);
    if (tile) return { tile, usedFallback: false };
  }

  return { tile: pickHighestUnlockGain(game, rng), usedFallback: true };
}

export function solvePlayerShortest(
  game: OfflineGame,
  seed: number = 0,
  maxSteps: number = 2000,
): ShortestSimResult {
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
        forcedRandomPickCount,
        colorStarvationCount,
      };
    }

    if (!hasCompletableVisibleColor(g)) colorStarvationCount++;

    const { tile, usedFallback } = selectTile(g, rng);
    if (!tile) {
      return {
        win: false,
        failReason: `No clickable tiles at step ${step}`,
        picks,
        stepCount: picks.length,
        seed,
        forcedRandomPickCount,
        colorStarvationCount,
      };
    }

    if (usedFallback) forcedRandomPickCount++;
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
    forcedRandomPickCount,
    colorStarvationCount,
  };
}

export function solvePlayerShortestBatch(
  game: OfflineGame,
  runs: number = 100,
  baseSeed: number = 0,
  maxSteps: number = 2000,
): ShortestSimBatchResult {
  const startTime = performance.now();
  let wins = 0;
  let losses = 0;
  const results: ShortestSimResult[] = [];
  let totalWinSteps = 0;
  let totalLossSteps = 0;
  let totalForcedOnWin = 0;
  let totalStarveOnWin = 0;
  let totalForcedOnLoss = 0;
  let totalStarveOnLoss = 0;

  for (let i = 0; i < runs; i++) {
    const result = solvePlayerShortest(game, baseSeed + i, maxSteps);
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
    forcedPickOnWin: wins > 0 ? totalForcedOnWin / wins : 0,
    starvationOnWin: wins > 0 ? totalStarveOnWin / wins : 0,
    stepsOnLoss: losses > 0 ? totalLossSteps / losses : 0,
    forcedPickOnLoss: losses > 0 ? totalForcedOnLoss / losses : 0,
    starvationOnLoss: losses > 0 ? totalStarveOnLoss / losses : 0,
    elapsedMs: performance.now() - startTime,
  };
}
