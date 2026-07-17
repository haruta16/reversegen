/** Legacy solver-shaped adapter over the strategy simulation registry. */

import { OfflineGame } from './offline-game.js';
import type { PlayerSimBatchResult } from './solver-player.js';
import { runSimulationPolicy } from '../strategy/simulation.js';

export function solvePlayerMistakeBatchRust(
  game: OfflineGame,
  runs: number,
  baseSeed: number,
  mistakeRate: number,
  collectTrace: boolean = false,
  maxSteps: number = 2000,
): PlayerSimBatchResult {
  const result = runSimulationPolicy(game, {
    engine: 'rust',
    policy: { id: 'mistake_player', version: 1, config: { mistake_rate: mistakeRate } },
    runs,
    baseSeed,
    maxSteps,
    collectTrace,
    requestId: `legacy-mistake-${baseSeed}-${mistakeRate}`,
  });
  return {
    wins: result.summary.wins,
    losses: result.summary.losses,
    winRate: result.summary.win_rate,
    avgStepsOnWin: result.summary.avg_steps_on_win,
    avgStepsOnLoss: result.summary.avg_steps_on_loss,
    results: result.results?.map(run => ({
      win: run.win,
      failReason: run.fail_reason,
      picks: run.picks,
      stepCount: run.step_count,
      seed: run.seed,
    })),
    elapsedMs: result.elapsed_ms,
  };
}
