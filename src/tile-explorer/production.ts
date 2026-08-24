import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { deriveSeed } from '../strategy/random.js';
import type { ReplaySelectionRow } from '../replay-selection.js';
import { createReplaySelectionRow, MAX_REPLAY_GRADE } from '../replay-selection.js';

export const TILE_EXPLORER_PRODUCTION_SCHEMA_VERSION = 1 as const;
export const TILE_EXPLORER_PRODUCTION_STRATEGY = 'default' as const;

export interface TileExplorerProductionVariantInput {
  difficulty: number;
  color_count: number;
  tile_type_weights: number[];
  target_count?: number;
}

export interface TileExplorerProductionLevelInput {
  output_level_id: number;
  terrain_id: number | string;
  terrain_path?: string;
  variants: TileExplorerProductionVariantInput[];
}

export interface TileExplorerProductionInput {
  schema_version: typeof TILE_EXPLORER_PRODUCTION_SCHEMA_VERSION;
  production_id: string;
  strategy: typeof TILE_EXPLORER_PRODUCTION_STRATEGY;
  levels_dir?: string;
  root_seed: number;
  target_count_per_variant?: number;
  max_attempts_per_task?: number;
  levels: TileExplorerProductionLevelInput[];
}

export interface TileExplorerProductionTask {
  id: string;
  output_level_id: number;
  terrain_id: string;
  terrain_path: string;
  difficulty: number;
  color_count: number;
  tile_type_weights: number[];
  target_count: number;
  max_attempts: number;
  sequence_seed: number;
}

export interface TileExplorerProductionRecord {
  schema_version: 1;
  production_id: string;
  task_id: string;
  output_level_id: number;
  terrain_id: string;
  terrain_path: string;
  strategy: typeof TILE_EXPLORER_PRODUCTION_STRATEGY;
  difficulty: number;
  grade: number;
  color_count: number;
  tile_type_weights: number[];
  type_cycle: number[];
  sequence_seed: number;
  placement_seed: number;
  attempt: number;
  replay_key: string;
  replay_code: string;
  level_hash: string;
  element_count: number;
  replay_element_count: number;
  generated_group_count: number;
  view_layer_count: number;
  elapsed_ms: number;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid TileExplorer production input: ${message}`);
}

function positiveInteger(value: unknown, path: string): number {
  assert(Number.isInteger(value) && Number(value) > 0, `${path} must be a positive integer`);
  return Number(value);
}

export function readTileExplorerProductionInput(path: string): TileExplorerProductionInput {
  return validateTileExplorerProductionInput(JSON.parse(readFileSync(path, 'utf8')));
}

export function validateTileExplorerProductionInput(value: unknown): TileExplorerProductionInput {
  assert(value != null && typeof value === 'object', 'root must be an object');
  const input = value as TileExplorerProductionInput;
  assert(input.schema_version === TILE_EXPLORER_PRODUCTION_SCHEMA_VERSION, 'schema_version must be 1');
  assert(/^[a-z0-9][a-z0-9_-]{2,79}$/.test(input.production_id), 'production_id is invalid');
  assert(input.strategy === TILE_EXPLORER_PRODUCTION_STRATEGY, 'strategy must be default');
  assert(Number.isInteger(input.root_seed), 'root_seed must be an integer');
  if (input.levels_dir != null) assert(typeof input.levels_dir === 'string' && input.levels_dir.length > 0, 'levels_dir must be a non-empty string');
  const defaultTarget = positiveInteger(input.target_count_per_variant ?? 30, 'target_count_per_variant');
  const defaultMaxAttempts = positiveInteger(input.max_attempts_per_task ?? Math.max(120, defaultTarget), 'max_attempts_per_task');
  assert(defaultMaxAttempts >= defaultTarget, 'max_attempts_per_task must not be smaller than target_count_per_variant');
  assert(Array.isArray(input.levels) && input.levels.length > 0, 'levels must be a non-empty array');

  const keys = new Set<string>();
  const terrainByOutputLevel = new Map<number, string>();
  for (const [levelIndex, level] of input.levels.entries()) {
    const prefix = `levels[${levelIndex}]`;
    const outputLevelId = positiveInteger(level.output_level_id, `${prefix}.output_level_id`);
    assert((typeof level.terrain_id === 'string' && level.terrain_id.length > 0) || Number.isInteger(level.terrain_id), `${prefix}.terrain_id is required`);
    const terrainId = String(level.terrain_id);
    if (level.terrain_path != null) assert(typeof level.terrain_path === 'string' && level.terrain_path.length > 0, `${prefix}.terrain_path must be a non-empty string`);
    const previousTerrain = terrainByOutputLevel.get(outputLevelId);
    assert(previousTerrain == null || previousTerrain === terrainId, `output_level_id ${outputLevelId} maps to both terrain ${previousTerrain} and ${terrainId}`);
    terrainByOutputLevel.set(outputLevelId, terrainId);
    assert(Array.isArray(level.variants) && level.variants.length > 0, `${prefix}.variants must be a non-empty array`);
    for (const [variantIndex, variant] of level.variants.entries()) {
      const variantPrefix = `${prefix}.variants[${variantIndex}]`;
      const difficulty = positiveInteger(variant.difficulty, `${variantPrefix}.difficulty`);
      assert(difficulty <= MAX_REPLAY_GRADE, `${variantPrefix}.difficulty exceeds the Replay grade limit ${MAX_REPLAY_GRADE}`);
      const colorCount = positiveInteger(variant.color_count, `${variantPrefix}.color_count`);
      assert(colorCount <= 99, `${variantPrefix}.color_count must not exceed 99`);
      assert(Array.isArray(variant.tile_type_weights), `${variantPrefix}.tile_type_weights must be an array`);
      assert(variant.tile_type_weights.length === colorCount, `${variantPrefix}.tile_type_weights length must equal color_count`);
      assert(variant.tile_type_weights.every(weight => Number.isInteger(weight) && weight > 0), `${variantPrefix}.tile_type_weights must contain positive integers`);
      const target = positiveInteger(variant.target_count ?? defaultTarget, `${variantPrefix}.target_count`);
      assert(!('allow_duplicate_replay_codes' in variant), `${variantPrefix}.allow_duplicate_replay_codes is not supported; reduce target_count instead`);
      assert(defaultMaxAttempts >= target, `${variantPrefix}.target_count exceeds max_attempts_per_task`);
      const key = `${outputLevelId}:${difficulty}`;
      assert(!keys.has(key), `duplicate output_level_id + difficulty: ${key}`);
      keys.add(key);
    }
  }
  return input;
}

export function buildTileExplorerProductionTasks(input: TileExplorerProductionInput): TileExplorerProductionTask[] {
  const validated = validateTileExplorerProductionInput(input);
  const levelsDir = validated.levels_dir == null ? undefined : resolve(validated.levels_dir);
  const defaultTarget = validated.target_count_per_variant ?? 30;
  const defaultMaxAttempts = validated.max_attempts_per_task ?? Math.max(120, defaultTarget);
  const tasks: TileExplorerProductionTask[] = [];
  for (const level of validated.levels) {
    const terrainId = String(level.terrain_id);
    const terrainPath = level.terrain_path != null
      ? resolve(level.terrain_path)
      : levelsDir != null
        ? resolve(levelsDir, `${terrainId}.json`)
        : '';
    assert(terrainPath.length > 0, `terrain ${terrainId} needs terrain_path or root levels_dir`);
    assert(existsSync(terrainPath), `terrain file does not exist: ${terrainPath}`);
    for (const variant of level.variants) {
      const configKey = `${variant.color_count}:${variant.tile_type_weights.join('|')}`;
      tasks.push({
        id: `${level.output_level_id}_d${variant.difficulty}`,
        output_level_id: level.output_level_id,
        terrain_id: terrainId,
        terrain_path: terrainPath,
        difficulty: variant.difficulty,
        color_count: variant.color_count,
        tile_type_weights: [...variant.tile_type_weights],
        target_count: variant.target_count ?? defaultTarget,
        max_attempts: defaultMaxAttempts,
        sequence_seed: deriveSeed(validated.root_seed, level.output_level_id, terrainId, variant.difficulty, configKey, 'sequence') | 0,
      });
    }
  }
  return tasks;
}

export function tileExplorerPlacementSeed(rootSeed: number, task: TileExplorerProductionTask, attempt: number): number {
  return deriveSeed(rootSeed, task.output_level_id, task.terrain_id, task.difficulty, attempt, 'placement') | 0;
}

export const TILE_EXPLORER_PRODUCTION_CSV_HEADERS = [
  'productionId', 'taskId', 'outputLevelId', 'terrainId', 'terrainPath', 'strategy',
  'difficulty', 'grade', 'colorCount', 'tileTypeWeights', 'typeCycle', 'sequenceSeed',
  'placementSeed', 'attempt', 'ReplayKey', 'ReplayCode', 'levelHash', 'ElementCount',
  'ReplayElementCount', 'generatedGroupCount', 'viewLayerCount', 'elapsedMs',
] as const;

function csvEscape(value: unknown): string {
  const text = String(value);
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text)
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

export function serializeTileExplorerProductionRecord(record: TileExplorerProductionRecord): string {
  const values: Record<(typeof TILE_EXPLORER_PRODUCTION_CSV_HEADERS)[number], unknown> = {
    productionId: record.production_id,
    taskId: record.task_id,
    outputLevelId: record.output_level_id,
    terrainId: record.terrain_id,
    terrainPath: record.terrain_path,
    strategy: record.strategy,
    difficulty: record.difficulty,
    grade: record.grade,
    colorCount: record.color_count,
    tileTypeWeights: record.tile_type_weights.join('|'),
    typeCycle: record.type_cycle.join('|'),
    sequenceSeed: record.sequence_seed,
    placementSeed: record.placement_seed,
    attempt: record.attempt,
    ReplayKey: record.replay_key,
    ReplayCode: record.replay_code,
    levelHash: record.level_hash,
    ElementCount: record.element_count,
    ReplayElementCount: record.replay_element_count,
    generatedGroupCount: record.generated_group_count,
    viewLayerCount: record.view_layer_count,
    elapsedMs: record.elapsed_ms,
  };
  return TILE_EXPLORER_PRODUCTION_CSV_HEADERS.map(header => csvEscape(values[header])).join(',');
}

export function productionRecordToReplaySelection(record: TileExplorerProductionRecord): ReplaySelectionRow {
  return createReplaySelectionRow({
    levelResId: record.output_level_id,
    ReplayCode: record.replay_code,
    grade: record.difficulty,
    passrate: 0,
    ElementCount: record.element_count,
  });
}

export function productionInputExample(levelsDir = 'path/to/levels'): TileExplorerProductionInput {
  return {
    schema_version: 1,
    production_id: 'tile_explorer_default_example',
    strategy: 'default',
    levels_dir: levelsDir,
    root_seed: 20260720,
    target_count_per_variant: 30,
    max_attempts_per_task: 120,
    levels: [{
      output_level_id: 600001,
      terrain_id: 100075,
      variants: [{ difficulty: 2, color_count: 5, tile_type_weights: [1, 1, 1, 1, 1] }],
    }],
  };
}

export function terrainIdFromPath(path: string): string {
  return basename(path).replace(/\.json$/i, '');
}
