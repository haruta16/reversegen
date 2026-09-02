import type { OfflineGame } from '../../src/solver/offline-game.js';
import { runSimulationPolicy } from '../../src/strategy/simulation.js';
import type { SimulationSummary } from '../../src/strategy/types.js';
import {
  gradeLatestReplayPolicy,
  type LatestReplayGradeVerdict,
} from '../../src/strategy/latest-grade-policy.js';

export interface LatestGradeEvaluation {
  runs: number;
  sim1: SimulationSummary;
  optimal: SimulationSummary;
  optimalLossRemainingRatio: number;
  verdict: LatestReplayGradeVerdict;
}

function randomSeed(): number {
  return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}

export async function evaluateLatestGrade(
  game: OfflineGame,
  totalTiles: number,
  runs: number = 100,
  requestPrefix: string = 'latest-grade',
): Promise<LatestGradeEvaluation> {
  if (!Number.isInteger(runs) || runs <= 0 || runs > 5000) {
    throw new Error('runs 必须是 1-5000 的整数');
  }
  const nonce = `${Date.now()}-${randomSeed()}`;
  const sim1Result = runSimulationPolicy(game, {
    engine: 'typescript',
    policy: { id: 'mistake_player', version: 1, config: { mistake_rate: 0.01 } },
    runs,
    baseSeed: randomSeed(),
    maxSteps: 2000,
    collectTrace: false,
    requestId: `${requestPrefix}:${nonce}:sim1`,
  });
  const optimalResult = runSimulationPolicy(game, {
    engine: 'typescript',
    policy: { id: 'shortest_current_state', version: 1, config: {} },
    runs,
    baseSeed: randomSeed(),
    maxSteps: 2000,
    collectTrace: false,
    requestId: `${requestPrefix}:${nonce}:optimal`,
  });
  const optimalStepsOnLoss = Number(
    optimalResult.summary.steps_on_loss ?? optimalResult.summary.avg_steps_on_loss ?? 0,
  );
  const optimalLossRemainingRatio = optimalResult.summary.losses > 0 && totalTiles > 0
    ? Math.max(0, totalTiles - optimalStepsOnLoss) / totalTiles
    : 0;
  return {
    runs,
    sim1: sim1Result.summary,
    optimal: optimalResult.summary,
    optimalLossRemainingRatio,
    verdict: gradeLatestReplayPolicy(
      sim1Result.summary.win_rate,
      optimalResult.summary.win_rate,
      optimalLossRemainingRatio,
    ),
  };
}
