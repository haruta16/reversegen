/**
 * Solver framework — public API.
 *
 * Provides tile-click granularity game simulation and solvers
 * for analyzing board properties (solvability, death points, decision branches).
 */

// Types
export type {
  TileConfig,
  GameStateKey,
  SolverResult,
  GreedyResult,
  RandomResult,
  BoardAnalysis,
  DAGFeatures,
  ReviveStep,
} from './types.js';

export { OfflineTile, TileFlag, PileType } from './types.js';

// Game engine
export { OfflineGame, createGame } from './offline-game.js';
export type { GameFactoryInput } from './offline-game.js';

// Solvers
export { solveDFS, hasColorParityIssue } from './solver-dfs.js';
export { solveDeathCheckpoint } from './solver-death-checkpoint.js';
export { solveGreedy } from './solver-greedy.js';
export { solveRandom, solveRandomBatch } from './solver-random.js';
export { solvePlayer, solvePlayerBatch } from './solver-player.js';
export type { PlayerSimResult, PlayerSimBatchResult, MatchGroup } from './solver-player.js';
export { solvePlayerRisky, solvePlayerRiskyBatch } from './solver-player-risky.js';
export type { RiskyConfig } from './solver-player-risky.js';
export { solvePlayerCostCap, solvePlayerCostCapBatch } from './solver-player-costcap.js';
export type { CostCapConfig } from './solver-player-costcap.js';
export { solvePlayerMistake, solvePlayerMistakeBatch } from './solver-player-mistake.js';
export type { MistakeConfig } from './solver-player-mistake.js';
