import { basename, dirname, extname } from 'node:path';
import type { BatchRow } from '../batch-generator.js';
import type {
  FilterStage,
  LayerClosureGeneratorSpec,
  MetricConstraint,
  SimulateStage,
  StrategyDefinition,
  StrategyRunRecord,
} from './types.js';
import { validateStrategyDefinition } from './definition.js';

export interface StrategyEditorMeta {
  name?: string;
  status?: string;
  notes?: string;
}

type EditorStrategy = Record<string, any>;

function finiteNumber(value: unknown, fallback?: number): number {
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  if (fallback != null) return fallback;
  throw new Error(`Expected a finite number, received ${String(value)}`);
}

function positiveInteger(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

function policyRange(policy: Record<string, unknown> | undefined, name: string): { kind: 'range'; min: number; max: number } | { kind: 'fixed'; value: number } {
  const mode = String(policy?.mode ?? 'random');
  if (mode === 'random') return { kind: 'range', min: 0, max: 1 };
  if (mode === 'random_range') return {
    kind: 'range',
    min: finiteNumber(policy?.min),
    max: finiteNumber(policy?.max),
  };
  if (mode === 'fixed') return { kind: 'fixed', value: finiteNumber(policy?.value) };
  throw new Error(`${name}.mode ${mode} is not supported by strategy v2`);
}

function closeRatePolicy(policy: Record<string, unknown> | undefined): LayerClosureGeneratorSpec['parameters']['close_rates'] {
  const mode = String(policy?.mode ?? 'random');
  if (mode === 'random') return { kind: 'random' };
  if (mode === 'random_range') return {
    kind: 'range',
    min: finiteNumber(policy?.min),
    max: finiteNumber(policy?.max),
  };
  if (mode === 'fixed_points' || mode === 'per_layer_list') {
    const values = (Array.isArray(policy?.points) ? policy?.points : policy?.values) as unknown[] | undefined;
    if (!values?.length) throw new Error('generation.closure needs at least one value');
    return { kind: 'fixed', values: values.map(value => finiteNumber(value)) };
  }
  throw new Error(`generation.closure.mode ${mode} is not supported by strategy v2`);
}

function colorPolicy(policy: Record<string, unknown> | undefined): LayerClosureGeneratorSpec['parameters']['color_count'] {
  const mode = String(policy?.mode ?? 'ratio');
  if (mode === 'fixed_count') return { kind: 'fixed', value: positiveInteger(policy?.value ?? policy?.count, 'generation.color.value') };
  if (mode === 'ratio' || mode === 'ratio_jitter') {
    const ratio = finiteNumber(policy?.ratio, 0.6);
    return { kind: 'ratio_range', min: ratio, max: ratio, jitter: Math.max(0, Math.floor(finiteNumber(policy?.jitter, 0))) };
  }
  if (mode === 'range') return {
    kind: 'ratio_range',
    min: finiteNumber(policy?.min),
    max: finiteNumber(policy?.max),
    jitter: Math.max(0, Math.floor(finiteNumber(policy?.jitter, 0))),
  };
  throw new Error(`generation.color.mode ${mode} is not supported by strategy v2`);
}

function optimalConstraints(
  grades: number[],
  legacy: Record<string, Record<string, unknown>>,
): FilterStage['constraints'] {
  return Object.fromEntries(grades.map(grade => {
    const source = legacy[String(grade)];
    if (!source) throw new Error(`Optimal constraints are missing G${grade}`);
    const metrics: Record<string, MetricConstraint> = {};
    const winRate: MetricConstraint = {};
    if (source.min_win_rate != null) winRate.min = finiteNumber(source.min_win_rate);
    if (source.min_win_rate_exclusive != null) winRate.min_exclusive = finiteNumber(source.min_win_rate_exclusive);
    if (source.max_win_rate_exclusive != null) winRate.max_exclusive = finiteNumber(source.max_win_rate_exclusive);
    if (Object.keys(winRate).length > 0) metrics.win_rate = winRate;
    const starvation: MetricConstraint = {};
    if (source.min_win_starvation_per_tile != null) starvation.min = finiteNumber(source.min_win_starvation_per_tile);
    if (source.max_win_starvation_per_tile != null) starvation.max_exclusive = finiteNumber(source.max_win_starvation_per_tile);
    if (Object.keys(starvation).length > 0) metrics.starvation_on_win_per_tile = starvation;
    if (source.max_loss_remaining_ratio != null) {
      metrics.loss_remaining_ratio = { max: finiteNumber(source.max_loss_remaining_ratio) };
    }
    if (Object.keys(metrics).length === 0) throw new Error(`Optimal constraints for G${grade} are empty`);
    return [String(grade), metrics];
  }));
}

function playerStage(runs: number, engine: 'typescript' | 'rust'): SimulateStage {
  return {
    id: 'player_metrics',
    type: 'simulate',
    engine,
    policy: { id: 'mistake_player', version: 1, config: {} },
    runs,
    max_steps: 2000,
    variants: [
      { id: 'mistake_01', config: { mistake_rate: 0.01 } },
      { id: 'mistake_05', config: { mistake_rate: 0.05 } },
      { id: 'mistake_15', config: { mistake_rate: 0.15 } },
    ],
  };
}

export function compileEditorStrategyV2(editor: EditorStrategy): StrategyDefinition {
  if (editor?.schema_version === 2) return validateStrategyDefinition(editor);
  const meta = editor.meta ?? {};
  const scope = editor.scope ?? {};
  const target = editor.target ?? {};
  const generation = editor.generation ?? {};
  const evaluation = editor.evaluation ?? {};
  const search = editor.search ?? {};
  const adapter = editor.adapter ?? {};
  if (adapter.executor && adapter.executor !== 'run-batch-generation' && adapter.executor !== 'strategy-v2') {
    throw new Error(`adapter.executor ${adapter.executor} belongs to the retired strategy framework`);
  }
  if (generation.placement_mode !== 'layer-closure') {
    throw new Error(`generator ${String(generation.placement_mode)} is not implemented in strategy v2`);
  }
  if (evaluation.grade_strategy && evaluation.grade_strategy !== 'strategy2') {
    throw new Error(`grade strategy ${String(evaluation.grade_strategy)} is not implemented in strategy v2`);
  }
  const unsupportedAcceptance = ['min_sim1_wins', 'min_sim5_wins', 'min_sim15_wins', 'min_passrate']
    .filter(key => evaluation.acceptance?.[key] != null);
  if (unsupportedAcceptance.length > 0) {
    throw new Error(`strategy v2 needs explicit filter stages for: ${unsupportedAcceptance.join(', ')}`);
  }
  const grades = (Array.isArray(target.grades) ? target.grades : []).map(Number);
  const runs = positiveInteger(evaluation.sim_runs ?? 100, 'evaluation.sim_runs');
  const engine = evaluation.simulation_engine === 'typescript' ? 'typescript' : 'rust';
  const pipeline: StrategyDefinition['pipeline'] = [playerStage(runs, engine), {
    id: 'current_grade',
    type: 'grade',
    method: 'strategy2',
    source: 'player_metrics',
    inputs: { sim1: 'mistake_01', sim5: 'mistake_05', sim15: 'mistake_15' },
  }];
  const optimal = evaluation.acceptance?.optimal;
  if (optimal) {
    const optimalStage: SimulateStage = {
      id: 'optimal_metrics',
      type: 'simulate',
      engine: 'typescript',
      policy: { id: 'shortest_current_state', version: 1, config: {} },
      runs: positiveInteger(optimal.runs ?? 100, 'evaluation.acceptance.optimal.runs'),
      max_steps: 2000,
    };
    pipeline.unshift(optimalStage);
    pipeline.push({
      id: 'optimal_experience',
      type: 'filter',
      method: 'grade_metric_constraints',
      source: 'optimal_metrics',
      grade_source: 'current_grade',
      constraints: optimalConstraints(grades, optimal.grade_constraints ?? {}),
    });
  }
  return validateStrategyDefinition({
    schema_version: 2,
    id: String(meta.strategy_id ?? ''),
    version: positiveInteger(meta.version ?? 1, 'meta.version'),
    description: String(meta.purpose ?? ''),
    scope: {
      levels_dir: String(scope.levels_dir ?? ''),
      levels: Array.isArray(scope.include_levels) ? scope.include_levels : [],
      exclude_levels: Array.isArray(scope.exclude_levels) ? scope.exclude_levels : [],
    },
    target: {
      grades,
      count_per_grade: positiveInteger(target.target_count_per_grade, 'target.target_count_per_grade'),
      max_attempts_per_level: positiveInteger(search.attempts_per_level, 'search.attempts_per_level'),
    },
    generator: {
      method: 'layer_closure',
      version: 1,
      parameters: {
        close_rates: closeRatePolicy(generation.closure),
        color_count: colorPolicy(generation.color),
        spread: policyRange(generation.spread, 'generation.spread'),
        debt: policyRange(generation.debt, 'generation.debt'),
        color_allocation: generation.color_allocation?.mode === 'single_heavy'
          ? { mode: 'single_heavy', max_ratio: finiteNumber(generation.color_allocation.ratio, 1) }
          : { mode: 'balanced' },
      },
    },
    pipeline,
    runtime: {
      seed: Math.trunc(finiteNumber(search.seed, 20260630)),
      concurrency: search.concurrency === 'auto' ? 'auto' : positiveInteger(search.concurrency ?? 1, 'search.concurrency'),
      trace: {
        enabled: evaluation.collect_trace === true,
        sample_rate: evaluation.collect_trace === true ? finiteNumber(evaluation.trace_sample_rate, 1) : 0,
      },
    },
    output: {
      format: 'jsonl',
    },
  });
}

function editorPolicy(value: LayerClosureGeneratorSpec['parameters']['spread']): Record<string, unknown> {
  return value.kind === 'fixed'
    ? { mode: 'fixed', value: value.value }
    : value.min === 0 && value.max === 1
      ? { mode: 'random' }
      : { mode: 'random_range', min: value.min, max: value.max };
}

export function strategyV2ToEditor(strategy: StrategyDefinition, meta: StrategyEditorMeta = {}): EditorStrategy {
  const player = strategy.pipeline.find(stage => stage.type === 'simulate' && stage.policy.id === 'mistake_player') as SimulateStage | undefined;
  const optimal = strategy.pipeline.find(stage => stage.type === 'simulate' && stage.policy.id === 'shortest_current_state') as SimulateStage | undefined;
  const filter = strategy.pipeline.find(stage => stage.type === 'filter') as FilterStage | undefined;
  const close = strategy.generator.parameters.close_rates;
  const colors = strategy.generator.parameters.color_count;
  const allocation = strategy.generator.parameters.color_allocation;
  const gradeConstraints = filter ? Object.fromEntries(Object.entries(filter.constraints).map(([grade, metrics]) => {
    const win = metrics.win_rate ?? {};
    const starvation = metrics.starvation_on_win_per_tile ?? {};
    const remaining = metrics.loss_remaining_ratio ?? {};
    return [grade, {
      ...(win.min != null ? { min_win_rate: win.min } : {}),
      ...(win.min_exclusive != null ? { min_win_rate_exclusive: win.min_exclusive } : {}),
      ...(win.max_exclusive != null ? { max_win_rate_exclusive: win.max_exclusive } : {}),
      ...(starvation.min != null ? { min_win_starvation_per_tile: starvation.min } : {}),
      ...(starvation.max_exclusive != null ? { max_win_starvation_per_tile: starvation.max_exclusive } : {}),
      ...(remaining.max != null ? { max_loss_remaining_ratio: remaining.max } : {}),
    }];
  })) : undefined;
  return {
    meta: {
      strategy_id: strategy.id,
      name: meta.name ?? strategy.id,
      version: strategy.version,
      purpose: strategy.description ?? '',
      status: meta.status ?? 'active',
      notes: meta.notes ?? '',
    },
    scope: {
      terrain_source: 'level_json',
      level_range: '',
      include_levels: strategy.scope.levels,
      exclude_levels: strategy.scope.exclude_levels ?? [],
      levels_dir: strategy.scope.levels_dir,
    },
    target: {
      grades: strategy.target.grades,
      target_count_per_grade: strategy.target.count_per_grade,
      fill_policy: 'all',
      fallback_policy: 'none',
      min_existing_count: 1,
    },
    generation: {
      placement_mode: 'layer-closure',
      closure: close.kind === 'random'
        ? { mode: 'random' }
        : close.kind === 'range'
          ? { mode: 'random_range', min: close.min, max: close.max }
          : { mode: 'per_layer_list', points: close.values },
      color: colors.kind === 'fixed'
        ? { mode: 'fixed_count', value: colors.value }
        : colors.min === colors.max
          ? { mode: colors.jitter ? 'ratio_jitter' : 'ratio', ratio: colors.min, jitter: colors.jitter ?? 0 }
          : { mode: 'range', min: colors.min, max: colors.max, jitter: colors.jitter ?? 0 },
      color_allocation: allocation.mode === 'single_heavy'
        ? { mode: 'single_heavy', ratio: allocation.max_ratio ?? 1 }
        : { mode: 'balanced' },
      spread: editorPolicy(strategy.generator.parameters.spread),
      debt: editorPolicy(strategy.generator.parameters.debt),
    },
    evaluation: {
      grade_strategy: 'strategy2',
      sim_runs: player?.runs ?? 100,
      simulation_engine: player?.engine ?? 'rust',
      threshold_profile: 'current',
      collect_trace: strategy.runtime.trace.enabled,
      trace_sample_rate: strategy.runtime.trace.sample_rate,
      ...(optimal && gradeConstraints ? { acceptance: { optimal: { runs: optimal.runs, grade_constraints: gradeConstraints } } } : {}),
    },
    search: {
      attempts_per_level: strategy.target.max_attempts_per_level,
      concurrency: strategy.runtime.concurrency,
      seed: strategy.runtime.seed,
      resume: false,
      optimal_first: Boolean(optimal),
    },
    outputs: {
      write_csv: true,
      write_replay_json: false,
      write_calibration_xlsx: false,
      write_config_json: true,
      cap_per_level_grade: strategy.target.count_per_grade,
    },
    adapter: { executor: 'run-batch-generation', mode: 'plan_command' },
  };
}

export interface WebBatchConfig {
  terrainPaths: string[];
  closeRates: 'random' | string;
  colorCount: 'random' | number;
  colorCountRatio: number;
  spreadParam: 'random' | number;
  debtPersistenceWeight: 'random' | number;
  simRuns: number;
  targetPerTier: number;
  maxAttempts: number;
  concurrency: number;
  seed?: number;
  targetGrades?: number[];
}

export function webBatchConfigToStrategyV2(config: WebBatchConfig, id: string): StrategyDefinition {
  if (!Array.isArray(config.terrainPaths) || config.terrainPaths.length === 0) throw new Error('请至少加载一个地形');
  const levelsDir = dirname(config.terrainPaths[0]);
  if (config.terrainPaths.some(path => dirname(path) !== levelsDir)) throw new Error('strategy v2 批量任务要求地形来自同一目录');
  const levels = config.terrainPaths.map(path => basename(path, extname(path)));
  const editor: EditorStrategy = {
    meta: { strategy_id: id, version: 1, purpose: '网页批量产关临时策略' },
    scope: { levels_dir: levelsDir, include_levels: levels, exclude_levels: [] },
    target: { grades: config.targetGrades?.length ? config.targetGrades : [0, 1, 2, 3, 4, 5], target_count_per_grade: config.targetPerTier },
    generation: {
      placement_mode: 'layer-closure',
      closure: config.closeRates === 'random'
        ? { mode: 'random' }
        : { mode: 'per_layer_list', points: config.closeRates.split(',').map(value => Number(value.trim())) },
      color: config.colorCount === 'random'
        ? { mode: 'ratio', ratio: config.colorCountRatio }
        : { mode: 'fixed_count', value: config.colorCount },
      color_allocation: { mode: 'balanced' },
      spread: config.spreadParam === 'random' ? { mode: 'random' } : { mode: 'fixed', value: config.spreadParam },
      debt: config.debtPersistenceWeight === 'random' ? { mode: 'random' } : { mode: 'fixed', value: config.debtPersistenceWeight },
    },
    evaluation: { grade_strategy: 'strategy2', sim_runs: config.simRuns, simulation_engine: 'rust' },
    search: { attempts_per_level: config.maxAttempts, concurrency: config.concurrency, seed: config.seed ?? 20260630 },
    outputs: {},
    adapter: { executor: 'strategy-v2' },
  };
  return compileEditorStrategyV2(editor);
}

function summary(record: StrategyRunRecord, stageId: string, variantId: string) {
  return record.stages.find(stage => stage.id === stageId)?.variants?.[variantId];
}

export function strategyRecordToBatchRow(record: StrategyRunRecord, terrainIndex = 0): BatchRow {
  const parameters = record.candidate.generator.parameters;
  const metrics = record.candidate.generator.metrics;
  const sim1 = summary(record, 'player_metrics', 'mistake_01');
  const sim5 = summary(record, 'player_metrics', 'mistake_05');
  const sim15 = summary(record, 'player_metrics', 'mistake_15');
  const optimal = summary(record, 'optimal_metrics', 'default');
  const remainingTiles = optimal && optimal.losses > 0
    ? Math.max(0, record.candidate.tile_count - Number(optimal.steps_on_loss ?? optimal.avg_steps_on_loss))
    : 0;
  return {
    terrainIndex,
    terrainPath: record.candidate.terrain_path,
    levelResId: record.candidate.terrain_id,
    attemptIndex: record.candidate.attempt,
    isMaxGradeProbe: false,
    colorCount: Number(parameters.color_count),
    closeRates: parameters.close_rates as number[],
    spreadParam: Number(parameters.spread),
    debtPersistenceWeight: Number(parameters.debt),
    colorAllocationMode: parameters.color_allocation === 'single-heavy' ? 'single-heavy' : 'balanced',
    colorAllocationMaxRatio: parameters.color_allocation_max_ratio == null ? undefined : Number(parameters.color_allocation_max_ratio),
    heavyColor: metrics.heavyColor,
    colorTripletCounts: metrics.colorTripletCounts,
    freeTiles: metrics.totalTiles,
    totalTiles: record.candidate.tile_count,
    depthCount: metrics.depthCount,
    peakDebt: metrics.peakDebt,
    peakExpDebt: metrics.peakExpDebt,
    oi: metrics.oi,
    consecutiveOI: metrics.consecutiveOI,
    suitSpreadNorm: metrics.suitSpreadNorm,
    isDoomed: metrics.isDoomed,
    actualCloseRates: metrics.actualCloseRates,
    weightedDebtRetentionRate: metrics.weightedDebtRetentionRate,
    replayCode: record.candidate.replay_code,
    grade: record.decision.grade,
    passrate: record.decision.passrate,
    label: record.decision.label,
    simRuns: sim5?.runs ?? sim1?.runs ?? sim15?.runs ?? 0,
    sim1WinRate: sim1?.win_rate ?? 0,
    sim1Wins: sim1?.wins ?? 0,
    sim5WinRate: sim5?.win_rate ?? 0,
    sim5Wins: sim5?.wins ?? 0,
    sim15WinRate: sim15?.win_rate ?? 0,
    sim15Wins: sim15?.wins ?? 0,
    optimalRuns: optimal?.runs,
    optimalWins: optimal?.wins,
    optimalLosses: optimal?.losses,
    optimalWinRate: optimal?.win_rate,
    optimalForcedPickOnWin: optimal?.forced_pick_on_win,
    optimalStarvationOnWin: optimal?.starvation_on_win,
    optimalStepsOnLoss: optimal?.steps_on_loss,
    optimalForcedPickOnLoss: optimal?.forced_pick_on_loss,
    optimalStarvationOnLoss: optimal?.starvation_on_loss,
    optimalRemainingTilesOnLoss: optimal ? remainingTiles : undefined,
    optimalRemainingRatioOnLoss: optimal && record.candidate.tile_count > 0 ? remainingTiles / record.candidate.tile_count : undefined,
    elapsedMs: Math.round(record.elapsed_ms),
    success: true,
  };
}
