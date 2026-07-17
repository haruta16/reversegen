import type { DebtMetrics } from '../types.js';

export const STRATEGY_SCHEMA_VERSION = 2 as const;

export type ExecutionEngine = 'typescript' | 'rust';

export interface StrategyDefinition {
  schema_version: typeof STRATEGY_SCHEMA_VERSION;
  id: string;
  version: number;
  description?: string;
  scope: {
    levels_dir: string;
    levels: Array<number | string>;
    exclude_levels?: Array<number | string>;
  };
  target: {
    grades: number[];
    count_per_grade: number;
    max_attempts_per_level: number;
  };
  generator: GeneratorSpec;
  pipeline: PipelineStage[];
  runtime: {
    seed: number;
    concurrency: number | 'auto';
    trace: { enabled: boolean; sample_rate: number };
  };
  output: {
    format: 'jsonl';
  };
}

export interface LayerClosureGeneratorSpec {
  method: 'layer_closure';
  version: 1;
  parameters: {
    close_rates: { kind: 'random' } | { kind: 'range'; min: number; max: number } | { kind: 'fixed'; values: number[] };
    color_count: { kind: 'ratio_range'; min: number; max: number; jitter?: number } | { kind: 'fixed'; value: number };
    spread: { kind: 'range'; min: number; max: number } | { kind: 'fixed'; value: number };
    debt: { kind: 'range'; min: number; max: number } | { kind: 'fixed'; value: number };
    color_allocation: { mode: 'balanced' } | { mode: 'single_heavy'; max_ratio?: number };
  };
}

export type GeneratorSpec = LayerClosureGeneratorSpec;

export interface SimulationPolicySpec {
  id: 'mistake_player' | 'shortest_current_state';
  version: 1;
  config: Record<string, unknown>;
}

export interface SimulationVariant {
  id: string;
  config: Record<string, unknown>;
}

export interface SimulateStage {
  id: string;
  type: 'simulate';
  engine: ExecutionEngine;
  policy: SimulationPolicySpec;
  runs: number;
  max_steps?: number;
  variants?: SimulationVariant[];
}

export interface GradeStage {
  id: string;
  type: 'grade';
  method: 'strategy2';
  source: string;
  inputs: { sim1: string; sim5: string; sim15: string };
}

export interface MetricConstraint {
  min?: number;
  min_exclusive?: number;
  max?: number;
  max_exclusive?: number;
}

export interface FilterStage {
  id: string;
  type: 'filter';
  method: 'grade_metric_constraints';
  source: string;
  grade_source: string;
  constraints: Record<string, Record<string, MetricConstraint>>;
}

export type PipelineStage = SimulateStage | GradeStage | FilterStage;

export interface CandidateBoard {
  terrain_id: string;
  terrain_path: string;
  tile_count: number;
  attempt: number;
  seed: number;
  generator: {
    method: GeneratorSpec['method'];
    version: number;
    parameters: Record<string, unknown>;
    metrics: DebtMetrics;
  };
  assignments: Array<[number, number]>;
  replay_code: string;
}

export interface SimulationSummary {
  runs: number;
  wins: number;
  losses: number;
  win_rate: number;
  total_win_steps: number;
  total_loss_steps: number;
  avg_steps_on_win: number;
  avg_steps_on_loss: number;
  [metric: string]: number;
}

export interface StageResult {
  id: string;
  type: PipelineStage['type'];
  implementation: string;
  engine?: ExecutionEngine;
  seed?: number;
  variant_seeds?: Record<string, number>;
  elapsed_ms: number;
  variants?: Record<string, SimulationSummary>;
  traces?: Record<string, Array<{
    win: boolean;
    fail_reason: string | null;
    picks: number[];
    step_count: number;
    seed: number;
  }>>;
  metrics?: Record<string, number | string | boolean | null>;
  accepted?: boolean;
  reasons?: string[];
}

export interface StrategyRunRecord {
  schema_version: typeof STRATEGY_SCHEMA_VERSION;
  strategy: { id: string; version: number };
  candidate: CandidateBoard;
  stages: StageResult[];
  decision: {
    grade: number;
    passrate: number;
    label: string;
    accepted: boolean;
    reasons: string[];
  };
  elapsed_ms: number;
}
