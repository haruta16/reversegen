/**
 * Legacy solver-shaped adapter over the strategy simulation registry.
 *
 * Rust 的 mistake_player 策略只产出基础汇总指标（胜率 / 步数），
 * 不产出 forced-pick 与花色饥饿等体验指标，因此这里返回窄化的
 * legacy 类型，不伪造 PlayerSimBatchResult 的扩展字段。
 */

import { OfflineGame } from './offline-game.js';
import { runSimulationPolicy } from '../strategy/simulation.js';

/** Rust 引擎可提供的单次运行结果。 */
export interface RustMistakeRunResult {
  win: boolean;
  failReason: string | null;
  picks: number[];
  stepCount: number;
  seed: number;
}

/** Rust 引擎可提供的批量结果（无体验指标扩展字段）。 */
export interface RustMistakeBatchResult {
  wins: number;
  losses: number;
  winRate: number;
  results?: RustMistakeRunResult[];
  avgStepsOnWin: number;
  avgStepsOnLoss: number;
  elapsedMs: number;
}

export function solvePlayerMistakeBatchRust(
  game: OfflineGame,
  runs: number,
  baseSeed: number,
  mistakeRate: number,
  collectTrace: boolean = false,
  maxSteps: number = 2000,
): RustMistakeBatchResult {
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
