import { gradeStrategy2, type SimResult, type SimSnapshot } from '../grader.js';
import type { OfflineGame } from '../solver/offline-game.js';
import { deriveSeed, seededRandom } from './random.js';
import { runSimulationPolicyVariants } from './simulation.js';
import type {
  CandidateBoard,
  FilterStage,
  GradeStage,
  MetricConstraint,
  SimulateStage,
  SimulationSummary,
  StageResult,
  StrategyDefinition,
  StrategyRunRecord,
} from './types.js';

function asSimResult(summary: SimulationSummary, elapsedMs: number): SimResult {
  return {
    winRate: summary.win_rate,
    wins: summary.wins,
    losses: summary.losses,
    runs: summary.runs,
    elapsedMs,
  };
}

function getStage(results: Map<string, StageResult>, id: string): StageResult {
  const result = results.get(id);
  if (!result) throw new Error(`Pipeline result ${id} is unavailable`);
  return result;
}

function runSimulateStage(
  definition: StrategyDefinition,
  candidate: CandidateBoard,
  game: OfflineGame,
  stage: SimulateStage,
): StageResult {
  const started = performance.now();
  const variants = stage.variants ?? [{ id: 'default', config: {} }];
  const summaries: Record<string, SimulationSummary> = {};
  const traces: NonNullable<StageResult['traces']> = {};
  const variantSeeds = Object.fromEntries(variants.map(variant => [
    variant.id,
    deriveSeed(candidate.seed, stage.id, variant.id, 'simulation'),
  ]));
  const results = runSimulationPolicyVariants(game, {
    engine: stage.engine,
    policy: stage.policy,
    variants: variants.map(variant => ({
      ...variant,
      baseSeed: variantSeeds[variant.id],
      collectTrace: definition.runtime.trace.enabled
        && seededRandom(candidate.seed, stage.id, variant.id, 'trace')() < definition.runtime.trace.sample_rate,
    })),
    runs: stage.runs,
    maxSteps: stage.max_steps,
    requestId: `${definition.id}:${candidate.terrain_id}:${candidate.attempt}:${stage.id}`,
  });

  for (const variant of variants) {
    const result = results[variant.id];
    summaries[variant.id] = result.summary;
    if (result.results) traces[variant.id] = result.results;
  }

  return {
    id: stage.id,
    type: stage.type,
    implementation: `${stage.policy.id}@${stage.policy.version}`,
    engine: stage.engine,
    seed: deriveSeed(candidate.seed, stage.id, 'simulation'),
    variant_seeds: variantSeeds,
    elapsed_ms: performance.now() - started,
    variants: summaries,
    traces: Object.keys(traces).length > 0 ? traces : undefined,
  };
}

function runGradeStage(results: Map<string, StageResult>, stage: GradeStage): StageResult {
  const started = performance.now();
  const source = getStage(results, stage.source);
  if (!source.variants) throw new Error(`${stage.id}: source ${stage.source} has no simulation variants`);
  const summary = (variantId: string): SimulationSummary => {
    const value = source.variants?.[variantId];
    if (!value) throw new Error(`${stage.id}: variant ${stage.source}.${variantId} is unavailable`);
    return value;
  };
  const snapshot: SimSnapshot = {
    sim1: asSimResult(summary(stage.inputs.sim1), source.elapsed_ms),
    sim5: asSimResult(summary(stage.inputs.sim5), source.elapsed_ms),
    sim15: asSimResult(summary(stage.inputs.sim15), source.elapsed_ms),
  };
  const verdict = gradeStrategy2(snapshot);
  return {
    id: stage.id,
    type: stage.type,
    implementation: `${stage.method}@1`,
    elapsed_ms: performance.now() - started,
    metrics: {
      grade: verdict.grade,
      passrate: verdict.passrate,
      label: verdict.label,
    },
  };
}

function constraintPasses(value: number, constraint: MetricConstraint): boolean {
  if (constraint.min != null && value < constraint.min) return false;
  if (constraint.min_exclusive != null && value <= constraint.min_exclusive) return false;
  if (constraint.max != null && value > constraint.max) return false;
  if (constraint.max_exclusive != null && value >= constraint.max_exclusive) return false;
  return true;
}

function runFilterStage(
  candidate: CandidateBoard,
  results: Map<string, StageResult>,
  stage: FilterStage,
): StageResult {
  const started = performance.now();
  const source = getStage(results, stage.source);
  const gradeSource = getStage(results, stage.grade_source);
  const summary = source.variants?.default;
  if (!summary) throw new Error(`${stage.id}: source ${stage.source} must expose the default variant`);
  const grade = Number(gradeSource.metrics?.grade);
  if (!Number.isInteger(grade)) throw new Error(`${stage.id}: grade source ${stage.grade_source} has no grade`);

  const metrics: Record<string, number> = {
    ...summary,
    starvation_on_win_per_tile: candidate.tile_count > 0
      ? (summary.starvation_on_win ?? 0) / candidate.tile_count
      : 0,
    loss_remaining_ratio: summary.losses > 0 && candidate.tile_count > 0
      ? Math.max(0, candidate.tile_count - (summary.steps_on_loss ?? summary.avg_steps_on_loss)) / candidate.tile_count
      : 0,
  };
  const constraints = stage.constraints[String(grade)];
  const reasons: string[] = [];
  if (!constraints) {
    reasons.push(`grade ${grade} has no constraints`);
  } else {
    for (const [metric, constraint] of Object.entries(constraints)) {
      const value = metrics[metric];
      if (!Number.isFinite(value)) reasons.push(`${metric} is unavailable`);
      else if (!constraintPasses(value, constraint)) reasons.push(`${metric}=${value} is outside constraint`);
    }
  }

  return {
    id: stage.id,
    type: stage.type,
    implementation: `${stage.method}@1`,
    elapsed_ms: performance.now() - started,
    metrics,
    accepted: reasons.length === 0,
    reasons,
  };
}

export function executeStrategyPipeline(
  definition: StrategyDefinition,
  candidate: CandidateBoard,
  game: OfflineGame,
): StrategyRunRecord {
  const started = performance.now();
  const stageResults: StageResult[] = [];
  const resultsById = new Map<string, StageResult>();

  for (const stage of definition.pipeline) {
    const result = stage.type === 'simulate'
      ? runSimulateStage(definition, candidate, game, stage)
      : stage.type === 'grade'
        ? runGradeStage(resultsById, stage)
        : runFilterStage(candidate, resultsById, stage);
    stageResults.push(result);
    resultsById.set(stage.id, result);
  }

  const gradeResult = [...stageResults].reverse().find(result => result.type === 'grade');
  if (!gradeResult) throw new Error('Pipeline produced no grade result');
  const grade = Number(gradeResult.metrics?.grade);
  const passrate = Number(gradeResult.metrics?.passrate);
  const label = String(gradeResult.metrics?.label ?? '');
  const reasons = stageResults.flatMap(result => result.type === 'filter' ? result.reasons ?? [] : []);
  if (!definition.target.grades.includes(grade)) reasons.push(`grade ${grade} is outside target grades`);

  return {
    schema_version: 2,
    strategy: { id: definition.id, version: definition.version },
    candidate,
    stages: stageResults,
    decision: {
      grade,
      passrate,
      label,
      accepted: reasons.length === 0,
      reasons,
    },
    elapsed_ms: performance.now() - started,
  };
}
