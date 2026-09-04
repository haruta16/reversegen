/**
 * Solver framework — public API.
 *
 * Provides tile-click granularity game simulation and solvers
 * for analyzing board properties (solvability, death points, decision branches).
 */

// Types
export type {
  TileConfig,
  SolverResult,
  GreedyResult,
  RandomResult,
  DAGFeatures,
  ReviveStep,
} from './types.js';

export { OfflineTile, TileFlag, PileType } from './types.js';

// Game engine
export { OfflineGame, createGame, defaultVictoryCondition } from './offline-game.js';
export type { VictoryCondition } from './offline-game.js';
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
export { solvePlayerMistakeBatchRust } from './solver-player-mistake-rust.js';
export { solvePlayerMistakeMechanic, solvePlayerMistakeMechanicBatch } from './solver-player-mistake-mechanic.js';
export type { MistakeMechanicConfig } from './solver-player-mistake-mechanic.js';
export { solvePlayerShortest, solvePlayerShortestBatch } from './solver-player-shortest.js';
export { analyzeWinningPaths } from './winning-path-analysis.js';
export type {
  SimulationPathResult,
  WinningPathAnalysis,
  WinningPathInterval,
} from './winning-path-analysis.js';
