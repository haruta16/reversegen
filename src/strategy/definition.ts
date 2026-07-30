import type {
  LayerClosureGeneratorSpec,
  PipelineStage,
  StrategyDefinition,
  TileExplorerGeneratorSpec,
  ZenMatchGeneratorSpec,
} from './types.js';
import { STRATEGY_SCHEMA_VERSION } from './types.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid strategy v2: ${message}`);
}

function assertFinite(value: unknown, message: string): asserts value is number {
  assert(typeof value === 'number' && Number.isFinite(value), message);
}

function validateRange(value: { min: number; max: number }, path: string, unitInterval = false): void {
  assertFinite(value.min, `${path}.min must be finite`);
  assertFinite(value.max, `${path}.max must be finite`);
  assert(value.min <= value.max, `${path}.min must not exceed max`);
  if (unitInterval) assert(value.min >= 0 && value.max <= 1, `${path} must be within [0,1]`);
}

function validateColorCount(
  value: { kind: 'ratio_range'; min: number; max: number; jitter?: number } | { kind: 'fixed'; value: number },
  path: string,
): void {
  if (value.kind === 'ratio_range') {
    validateRange(value, path, true);
    assert(value.min > 0, `${path} ratio must be greater than zero`);
    assert(value.jitter == null || (Number.isInteger(value.jitter) && value.jitter >= 0), `${path}.jitter must be a non-negative integer`);
  } else {
    assert(value.kind === 'fixed' && Number.isInteger(value.value) && value.value > 0, `${path} fixed value must be positive`);
  }
}

export function validateStrategyDefinition(value: unknown): StrategyDefinition {
  assert(value != null && typeof value === 'object', 'root must be an object');
  const strategy = value as StrategyDefinition;
  assert(strategy.schema_version === STRATEGY_SCHEMA_VERSION, `schema_version must be ${STRATEGY_SCHEMA_VERSION}`);
  assert(typeof strategy.id === 'string' && strategy.id.length > 0, 'id is required');
  assert(Number.isInteger(strategy.version) && strategy.version > 0, 'version must be a positive integer');
  assert(Array.isArray(strategy.scope?.levels) && strategy.scope.levels.length > 0, 'scope.levels is required');
  assert(typeof strategy.scope.levels_dir === 'string' && strategy.scope.levels_dir.length > 0, 'scope.levels_dir is required');
  assert(new Set(strategy.scope.levels.map(String)).size === strategy.scope.levels.length, 'scope.levels contains duplicates');
  assert(Array.isArray(strategy.target?.grades) && strategy.target.grades.length > 0, 'target.grades is required');
  assert(strategy.target.grades.every(grade => Number.isInteger(grade) && grade >= 0 && grade <= 5), 'target.grades must be integers within [0,5]');
  assert(new Set(strategy.target.grades).size === strategy.target.grades.length, 'target.grades contains duplicates');
  assert(Number.isInteger(strategy.target.count_per_grade) && strategy.target.count_per_grade > 0, 'target.count_per_grade must be positive');
  assert(Number.isInteger(strategy.target.max_attempts_per_level) && strategy.target.max_attempts_per_level > 0, 'target.max_attempts_per_level must be positive');
  assert((
    strategy.generator?.method === 'layer_closure'
    || strategy.generator?.method === 'tile_explorer'
    || strategy.generator?.method === 'zen_match'
  ) && strategy.generator.version === 1, 'unsupported generator');
  const parameters = strategy.generator.parameters;
  assert(parameters != null && typeof parameters === 'object', 'generator.parameters is required');
  assert(parameters.color_count != null && typeof parameters.color_count === 'object', 'generator.parameters.color_count is required');
  validateColorCount(parameters.color_count, 'generator.parameters.color_count');
  if (strategy.generator.method === 'layer_closure') {
    const layerParameters = parameters as LayerClosureGeneratorSpec['parameters'];
    assert(layerParameters.close_rates != null && typeof layerParameters.close_rates === 'object', 'generator.parameters.close_rates is required');
    assert(layerParameters.spread != null && typeof layerParameters.spread === 'object', 'generator.parameters.spread is required');
    assert(layerParameters.debt != null && typeof layerParameters.debt === 'object', 'generator.parameters.debt is required');
    assert(layerParameters.color_allocation != null && typeof layerParameters.color_allocation === 'object', 'generator.parameters.color_allocation is required');
    if (layerParameters.close_rates.kind === 'range') validateRange(layerParameters.close_rates, 'generator.parameters.close_rates', true);
    else if (layerParameters.close_rates.kind === 'fixed') {
      assert(layerParameters.close_rates.values.length > 0, 'generator.parameters.close_rates.values is required');
      assert(layerParameters.close_rates.values.every(value => Number.isFinite(value) && value >= 0 && value <= 1), 'fixed close rates must be within [0,1]');
    } else assert(layerParameters.close_rates.kind === 'random', 'unsupported close_rates kind');
    if (layerParameters.spread.kind === 'range') validateRange(layerParameters.spread, 'generator.parameters.spread', true);
    else assert(layerParameters.spread.kind === 'fixed' && layerParameters.spread.value >= 0 && layerParameters.spread.value <= 1, 'fixed spread must be within [0,1]');
    if (layerParameters.debt.kind === 'range') validateRange(layerParameters.debt, 'generator.parameters.debt', true);
    else assert(layerParameters.debt.kind === 'fixed' && layerParameters.debt.value >= 0 && layerParameters.debt.value <= 1, 'fixed debt must be within [0,1]');
    assert(layerParameters.color_allocation.mode === 'balanced' || layerParameters.color_allocation.mode === 'single_heavy', 'unsupported color_allocation mode');
    if (layerParameters.color_allocation.mode === 'single_heavy' && layerParameters.color_allocation.max_ratio != null) {
      assert(layerParameters.color_allocation.max_ratio > 0 && layerParameters.color_allocation.max_ratio <= 1, 'color_allocation.max_ratio must be within (0,1]');
    }
  } else if (strategy.generator.method === 'tile_explorer') {
    const tileParameters = parameters as TileExplorerGeneratorSpec['parameters'];
    const supportedStrategies = new Set([
      'default', 'top_two_easy', 'sliding_window', 'limit_layer_random', 'easy_hard_easy',
      'solvability_coefficient', 'solvability_coefficient_v2', 'solvability_coefficient_v3', 'color_gradient',
    ]);
    assert(supportedStrategies.has(tileParameters.strategy), 'generator.parameters.strategy is unsupported');
    assert(tileParameters.difficulty != null && typeof tileParameters.difficulty === 'object', 'generator.parameters.difficulty is required');
    if (tileParameters.difficulty.kind === 'range') {
      validateRange(tileParameters.difficulty, 'generator.parameters.difficulty');
      assert(Number.isInteger(tileParameters.difficulty.min) && Number.isInteger(tileParameters.difficulty.max) && tileParameters.difficulty.min >= 1, 'difficulty range must contain positive integers');
    } else {
      assert(tileParameters.difficulty.kind === 'fixed' && Number.isInteger(tileParameters.difficulty.value) && tileParameters.difficulty.value >= 1, 'fixed difficulty must be a positive integer');
    }
    if (tileParameters.type_cycle != null) assert(tileParameters.type_cycle.length > 0 && tileParameters.type_cycle.every(value => Number.isInteger(value) && value > 0), 'type_cycle must contain positive integers');
    if (tileParameters.tile_type_weights != null) assert(tileParameters.tile_type_weights.length > 0 && tileParameters.tile_type_weights.every(value => Number.isInteger(value) && value >= 0), 'tile_type_weights must contain non-negative integers');
    if (tileParameters.strategy === 'color_gradient') {
      assert(Array.isArray(tileParameters.color_gradient_type_groups) && tileParameters.color_gradient_type_groups.length > 0, 'color_gradient_type_groups is required for color_gradient');
      assert(tileParameters.color_gradient_type_groups.every(group => Array.isArray(group) && group.length > 0 && group.every(value => Number.isInteger(value) && value > 0)), 'color_gradient_type_groups must contain positive integers');
    }
  } else {
    const zenParameters = parameters as ZenMatchGeneratorSpec['parameters'];
    assert(
      zenParameters.generation_strategy === 4 || zenParameters.generation_strategy === 5,
      'generator.parameters.generation_strategy must be 4 or 5',
    );
    if (zenParameters.color_count.kind === 'fixed') {
      assert(
        zenParameters.color_count.value <= 64,
        'Zen Match fixed color_count must not exceed ReplayCode limit 64',
      );
    }
  }
  assert(Array.isArray(strategy.pipeline) && strategy.pipeline.length > 0, 'pipeline is required');
  assert(Number.isInteger(strategy.runtime?.seed), 'runtime.seed must be an integer');
  assert(strategy.runtime.concurrency === 'auto' || (Number.isInteger(strategy.runtime.concurrency) && strategy.runtime.concurrency > 0), 'runtime.concurrency must be auto or a positive integer');
  assert(typeof strategy.runtime.trace?.enabled === 'boolean', 'runtime.trace.enabled must be boolean');
  assert(strategy.runtime.trace.sample_rate >= 0 && strategy.runtime.trace.sample_rate <= 1, 'runtime.trace.sample_rate must be within [0,1]');
  assert(strategy.output?.format === 'jsonl', 'output.format must be jsonl');

  const stages = new Map<string, PipelineStage>();
  for (const stage of strategy.pipeline) {
    assert(typeof stage.id === 'string' && stage.id.length > 0, 'every stage needs an id');
    assert(!stages.has(stage.id), `duplicate stage id ${stage.id}`);
    if (stage.type === 'simulate') {
      assert(stage.engine === 'rust' || stage.engine === 'typescript', `${stage.id}.engine is unsupported`);
      assert(stage.policy != null && typeof stage.policy === 'object', `${stage.id}.policy is required`);
      assert(stage.policy.config != null && typeof stage.policy.config === 'object' && !Array.isArray(stage.policy.config), `${stage.id}.policy.config must be an object`);
      assert(stage.runs > 0 && Number.isInteger(stage.runs), `${stage.id}.runs must be positive`);
      const supported = stage.engine === 'rust'
        ? stage.policy.id === 'mistake_player'
        : stage.policy.id === 'mistake_player' || stage.policy.id === 'shortest_current_state';
      assert(supported, `${stage.engine} does not implement ${stage.policy.id}@${stage.policy.version}`);
      assert(stage.policy.version === 1, `${stage.id} policy version is unsupported`);
      const variants = stage.variants ?? [{ id: 'default', config: {} }];
      assert(variants.length > 0, `${stage.id} needs at least one variant`);
      assert(new Set(variants.map(variant => variant.id)).size === variants.length, `${stage.id} has duplicate variant ids`);
      for (const variant of variants) {
        assert(typeof variant.id === 'string' && variant.id.length > 0, `${stage.id} has an invalid variant id`);
        assert(variant.config != null && typeof variant.config === 'object' && !Array.isArray(variant.config), `${stage.id}.${variant.id}.config must be an object`);
        if (stage.policy.id === 'mistake_player') {
          const mistakeRate = Number({ ...stage.policy.config, ...variant.config }.mistake_rate);
          assert(Number.isFinite(mistakeRate) && mistakeRate >= 0 && mistakeRate <= 1, `${stage.id}.${variant.id}.mistake_rate must be within [0,1]`);
        }
      }
    } else if (stage.type === 'grade') {
      assert(stage.method === 'strategy2', `${stage.id}.method is unsupported`);
      const source = stages.get(stage.source);
      assert(source?.type === 'simulate', `${stage.id}.source must reference an earlier simulate stage`);
      assert(stage.inputs != null && typeof stage.inputs === 'object', `${stage.id}.inputs is required`);
      const variants = new Set((source.variants ?? [{ id: 'default', config: {} }]).map(variant => variant.id));
      for (const [input, variant] of Object.entries(stage.inputs)) {
        assert(variants.has(variant), `${stage.id}.inputs.${input} references missing variant ${stage.source}.${variant}`);
      }
    } else if (stage.type === 'filter') {
      assert(stage.method === 'grade_metric_constraints', `${stage.id}.method is unsupported`);
      const source = stages.get(stage.source);
      assert(source?.type === 'simulate', `${stage.id}.source must reference an earlier simulate stage`);
      assert(source.variants == null || source.variants.some(variant => variant.id === 'default'), `${stage.id}.source must expose a default variant`);
      assert(stages.get(stage.grade_source)?.type === 'grade', `${stage.id}.grade_source must reference an earlier grade stage`);
      assert(stage.constraints != null && typeof stage.constraints === 'object', `${stage.id}.constraints is required`);
      for (const grade of strategy.target.grades) {
        assert(stage.constraints[String(grade)] != null, `${stage.id}.constraints is missing target grade ${grade}`);
      }
      for (const [grade, metrics] of Object.entries(stage.constraints)) {
        assert(metrics != null && typeof metrics === 'object' && Object.keys(metrics).length > 0, `${stage.id}.constraints.${grade} is empty`);
        for (const [metric, constraint] of Object.entries(metrics)) {
          assert(constraint != null && typeof constraint === 'object', `${stage.id}.${grade}.${metric} must be an object`);
          assert(Object.keys(constraint).length > 0, `${stage.id}.${grade}.${metric} is empty`);
          for (const [operator, value] of Object.entries(constraint)) {
            assert(['min', 'min_exclusive', 'max', 'max_exclusive'].includes(operator), `${stage.id}.${grade}.${metric}.${operator} is unsupported`);
            assertFinite(value, `${stage.id}.${grade}.${metric}.${operator} must be finite`);
          }
          assert(!(constraint.min != null && constraint.min_exclusive != null), `${stage.id}.${grade}.${metric} cannot set both min and min_exclusive`);
          assert(!(constraint.max != null && constraint.max_exclusive != null), `${stage.id}.${grade}.${metric} cannot set both max and max_exclusive`);
          const lower = constraint.min ?? constraint.min_exclusive;
          const upper = constraint.max ?? constraint.max_exclusive;
          if (lower != null && upper != null) {
            const hasExclusiveBound = constraint.min_exclusive != null || constraint.max_exclusive != null;
            assert(hasExclusiveBound ? lower < upper : lower <= upper, `${stage.id}.${grade}.${metric} has an empty range`);
          }
        }
      }
    } else {
      assert(false, `unsupported stage type ${(stage as { type?: string }).type}`);
    }
    stages.set(stage.id, stage);
  }
  assert(strategy.pipeline.filter(stage => stage.type === 'grade').length === 1, 'pipeline needs exactly one grade stage');
  return strategy;
}
