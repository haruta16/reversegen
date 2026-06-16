/**
 * Random Monte Carlo solver.
 *
 * At each step, picks a random clickable tile.
 * Useful for estimating solvability probability and identifying
 * "wide" vs "narrow" decision spaces.
 *
 * Uses a seeded PRNG (mulberry32) for reproducibility.
 */

import { OfflineGame } from './offline-game.js';
import type { RandomResult } from './types.js';
import { mulberry32 } from '../random-utils.js';

export function solveRandom(
  game: OfflineGame,
  seed: number = 0,
  maxSteps: number = 2000,
): RandomResult {
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
      };
    }

    const clickable = g.clickableTiles;
    if (clickable.length === 0) {
      return {
        win: false,
        failReason: `No clickable tiles at step ${step}`,
        picks,
        stepCount: picks.length,
      };
    }

    const idx = Math.floor(rng() * clickable.length);
    const tile = clickable[idx];
    g.collect(tile);
    picks.push(tile.id);
  }

  return {
    win: g.isWin,
    failReason: g.isWin ? null : (g.isDead ? 'Dock full' : `Max steps (${maxSteps}) reached`),
    picks,
    stepCount: picks.length,
  };
}

/**
 * Run multiple random simulations and return aggregate stats.
 */
export function solveRandomBatch(
  game: OfflineGame,
  runs: number = 100,
  baseSeed: number = 0,
  maxSteps: number = 2000,
): { wins: number; winRate: number; results: RandomResult[]; avgStepsOnWin: number } {
  let wins = 0;
  const results: RandomResult[] = [];
  let totalWinSteps = 0;

  for (let i = 0; i < runs; i++) {
    const result = solveRandom(game, baseSeed + i, maxSteps);
    results.push(result);
    if (result.win) {
      wins++;
      totalWinSteps += result.stepCount;
    }
  }

  return {
    wins,
    winRate: wins / runs,
    results,
    avgStepsOnWin: wins > 0 ? totalWinSteps / wins : 0,
  };
}
