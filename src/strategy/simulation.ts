import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OfflineGame } from '../solver/offline-game.js';
import { solvePlayerMistakeBatch } from '../solver/solver-player-mistake.js';
import { solvePlayerShortestBatch } from '../solver/solver-player-shortest.js';
import { PileType } from '../solver/types.js';
import type { ExecutionEngine, SimulationPolicySpec, SimulationSummary } from './types.js';

export const SIMULATION_PROTOCOL_VERSION = 2;

export interface SimulationTraceResult {
  win: boolean;
  fail_reason: string | null;
  picks: number[];
  step_count: number;
  seed: number;
}

export interface PolicySimulationResult {
  policy: { id: string; version: number };
  summary: SimulationSummary;
  elapsed_ms: number;
  results?: SimulationTraceResult[];
}

export interface RunPolicyOptions {
  engine: ExecutionEngine;
  policy: SimulationPolicySpec;
  runs: number;
  baseSeed: number;
  maxSteps?: number;
  collectTrace?: boolean;
  requestId: string;
}

export interface PolicyVariantOptions {
  id: string;
  config: Record<string, unknown>;
  baseSeed: number;
  collectTrace?: boolean;
}

export interface RunPolicyVariantsOptions {
  engine: ExecutionEngine;
  policy: SimulationPolicySpec;
  variants: PolicyVariantOptions[];
  runs: number;
  maxSteps?: number;
  requestId: string;
}

interface RustVariantResponse {
  id: string;
  summary: SimulationSummary;
  elapsed_ms: number;
  results?: SimulationTraceResult[];
}

interface RustSimulationResponse {
  protocol_version: number;
  request_id: string;
  policy: { id: string; version: number };
  variants: RustVariantResponse[];
  elapsed_ms: number;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RUST_BINARY = resolve(ROOT, 'rust/strategy-sim/target/release/reversegen-strategy-sim');

function pileName(pileType: PileType): 'desk' | 'dock' | 'discard' {
  if (pileType === PileType.Dock) return 'dock';
  if (pileType === PileType.Discard) return 'discard';
  return 'desk';
}

function serializeBoard(game: OfflineGame): object {
  const tiles = [...game.allTiles.values()].sort((a, b) => a.id - b.id);
  for (const tile of tiles) {
    if (![tile.id, tile.elementValue, tile.config.posX, tile.config.posY].every(Number.isSafeInteger)) {
      throw new Error(`Rust simulation requires integer board fields, tile=${tile.id}`);
    }
  }
  return {
    tiles: tiles.map(tile => ({
      id: tile.id,
      dependencies: tile.config.dependencies,
      element: tile.elementValue,
      pos_x: tile.config.posX,
      pos_y: tile.config.posY,
      pile: pileName(tile.pileType),
    })),
  };
}

function runRustPolicyVariants(
  game: OfflineGame,
  options: RunPolicyVariantsOptions,
): Record<string, PolicySimulationResult> {
  const request = {
    protocol_version: SIMULATION_PROTOCOL_VERSION,
    request_id: options.requestId,
    policy: { id: options.policy.id, version: options.policy.version },
    variants: options.variants.map(variant => ({
      id: variant.id,
      config: { ...options.policy.config, ...variant.config },
      base_seed: variant.baseSeed >>> 0,
      collect_trace: variant.collectTrace ?? false,
    })),
    board: serializeBoard(game),
    execution: {
      runs: options.runs,
      max_steps: options.maxSteps ?? 2000,
    },
  };
  const started = performance.now();
  const processResult = spawnSync(RUST_BINARY, ['-'], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const wallTime = performance.now() - started;
  if (processResult.error) {
    throw new Error(`Rust simulation failed to start (build with cargo build --release --manifest-path rust/strategy-sim/Cargo.toml): ${processResult.error.message}`);
  }
  if (processResult.status !== 0) {
    throw new Error(`Rust simulation failed: ${processResult.stderr || processResult.stdout}`.trim());
  }
  const response = JSON.parse(processResult.stdout) as RustSimulationResponse;
  if (response.protocol_version !== SIMULATION_PROTOCOL_VERSION) {
    throw new Error(`Rust protocol mismatch: ${response.protocol_version} != ${SIMULATION_PROTOCOL_VERSION}`);
  }
  if (response.request_id !== options.requestId) {
    throw new Error(`Rust request_id mismatch: ${response.request_id} != ${options.requestId}`);
  }
  if (response.policy.id !== options.policy.id || response.policy.version !== options.policy.version) {
    throw new Error(`Rust policy mismatch: ${response.policy.id}@${response.policy.version}`);
  }
  const expected = new Set(options.variants.map(variant => variant.id));
  const results: Record<string, PolicySimulationResult> = {};
  for (const variant of response.variants) {
    if (!expected.delete(variant.id) || results[variant.id]) {
      throw new Error(`Rust returned unexpected or duplicate variant ${variant.id}`);
    }
    results[variant.id] = {
      policy: response.policy,
      summary: variant.summary,
      elapsed_ms: options.variants.length === 1 ? wallTime : variant.elapsed_ms,
      results: variant.results,
    };
  }
  if (expected.size > 0) throw new Error(`Rust omitted variants: ${[...expected].join(', ')}`);
  return results;
}

function runTypescriptPolicy(game: OfflineGame, options: RunPolicyOptions): PolicySimulationResult {
  const collectTrace = options.collectTrace ?? false;
  const maxSteps = options.maxSteps ?? 2000;
  if (options.policy.id === 'mistake_player') {
    const mistakeRate = Number(options.policy.config.mistake_rate);
    if (!Number.isFinite(mistakeRate) || mistakeRate < 0 || mistakeRate > 1) {
      throw new Error('mistake_player.config.mistake_rate must be within [0,1]');
    }
    const batch = solvePlayerMistakeBatch(game, options.runs, options.baseSeed, {
      mistakeRate,
      maxSteps,
      collectTrace,
    });
    return {
      policy: { id: options.policy.id, version: options.policy.version },
      summary: {
        runs: options.runs,
        wins: batch.wins,
        losses: batch.losses,
        win_rate: batch.winRate,
        total_win_steps: Math.round(batch.avgStepsOnWin * batch.wins),
        total_loss_steps: Math.round(batch.avgStepsOnLoss * batch.losses),
        avg_steps_on_win: batch.avgStepsOnWin,
        avg_steps_on_loss: batch.avgStepsOnLoss,
      },
      elapsed_ms: batch.elapsedMs,
      results: batch.results?.map(result => ({
        win: result.win,
        fail_reason: result.failReason,
        picks: result.picks,
        step_count: result.stepCount,
        seed: result.seed,
      })),
    };
  }

  if (options.policy.id === 'shortest_current_state') {
    const batch = solvePlayerShortestBatch(game, options.runs, options.baseSeed, maxSteps, { collectTrace });
    return {
      policy: { id: options.policy.id, version: options.policy.version },
      summary: {
        runs: options.runs,
        wins: batch.wins,
        losses: batch.losses,
        win_rate: batch.winRate,
        total_win_steps: Math.round(batch.avgStepsOnWin * batch.wins),
        total_loss_steps: Math.round(batch.avgStepsOnLoss * batch.losses),
        avg_steps_on_win: batch.avgStepsOnWin,
        avg_steps_on_loss: batch.avgStepsOnLoss,
        forced_pick_on_win: batch.forcedPickOnWin,
        starvation_on_win: batch.starvationOnWin,
        steps_on_loss: batch.stepsOnLoss,
        forced_pick_on_loss: batch.forcedPickOnLoss,
        starvation_on_loss: batch.starvationOnLoss,
      },
      elapsed_ms: batch.elapsedMs,
      results: batch.results?.map(result => ({
        win: result.win,
        fail_reason: result.failReason,
        picks: result.picks,
        step_count: result.stepCount,
        seed: result.seed,
      })),
    };
  }

  throw new Error(`TypeScript engine does not implement policy ${options.policy.id}@${options.policy.version}`);
}

export function runSimulationPolicy(game: OfflineGame, options: RunPolicyOptions): PolicySimulationResult {
  return runSimulationPolicyVariants(game, {
    engine: options.engine,
    policy: options.policy,
    variants: [{
      id: 'default',
      config: {},
      baseSeed: options.baseSeed,
      collectTrace: options.collectTrace,
    }],
    runs: options.runs,
    maxSteps: options.maxSteps,
    requestId: options.requestId,
  }).default;
}

export function runSimulationPolicyVariants(
  game: OfflineGame,
  options: RunPolicyVariantsOptions,
): Record<string, PolicySimulationResult> {
  if (options.policy.version !== 1) {
    throw new Error(`Unsupported policy version ${options.policy.id}@${options.policy.version}`);
  }
  if (options.variants.length === 0) throw new Error('At least one simulation policy variant is required');
  if (new Set(options.variants.map(variant => variant.id)).size !== options.variants.length) {
    throw new Error('Simulation policy variant IDs must be unique');
  }
  // Rust protocol v2 does not carry terrainStructures yet. Structured boards
  // must stay on the shared TypeScript state machine so falling visibility is exact.
  if (options.engine === 'rust' && game.terrainStructures.length === 0) {
    return runRustPolicyVariants(game, options);
  }
  return Object.fromEntries(options.variants.map(variant => [variant.id, runTypescriptPolicy(game, {
    engine: options.engine,
    policy: { ...options.policy, config: { ...options.policy.config, ...variant.config } },
    runs: options.runs,
    baseSeed: variant.baseSeed,
    maxSteps: options.maxSteps,
    collectTrace: variant.collectTrace,
    requestId: `${options.requestId}:${variant.id}`,
  })]));
}
