import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  buildTileExplorerProductionTasks,
  productionRecordToReplaySelection,
  serializeTileExplorerProductionRecord,
  tileExplorerPlacementSeed,
  validateTileExplorerProductionInput,
  type TileExplorerProductionInput,
  type TileExplorerProductionRecord,
} from '../../src/tile-explorer/production.js';

function input(): TileExplorerProductionInput {
  return {
    schema_version: 1,
    production_id: 'tile_explorer_test',
    strategy: 'default',
    levels_dir: resolve('test/fixtures'),
    root_seed: 20260720,
    target_count_per_variant: 30,
    max_attempts_per_task: 120,
    levels: [{
      output_level_id: 100075,
      terrain_id: 100075,
      variants: [
        { difficulty: 2, color_count: 3, tile_type_weights: [1, 2, 1] },
        { difficulty: 3, color_count: 4, tile_type_weights: [1, 1, 1, 1] },
      ],
    }],
  };
}

test('production input expands one deterministic task per output level and difficulty', () => {
  const tasks = buildTileExplorerProductionTasks(input());
  assert.deepEqual(tasks.map(task => task.id), ['100075_d2', '100075_d3']);
  assert.deepEqual(tasks[0].tile_type_weights, [1, 2, 1]);
  assert.equal(tasks[0].target_count, 30);
  assert.equal(tasks[0].max_attempts, 120);
  assert.equal(tasks[0].sequence_seed, buildTileExplorerProductionTasks(input())[0].sequence_seed);
  assert.equal(tileExplorerPlacementSeed(input().root_seed, tasks[0], 7), tileExplorerPlacementSeed(input().root_seed, tasks[0], 7));
  assert.notEqual(tileExplorerPlacementSeed(input().root_seed, tasks[0], 7), tileExplorerPlacementSeed(input().root_seed, tasks[0], 8));
});

test('production input rejects ambiguous tasks and invalid TypeWeight', () => {
  const duplicate = input();
  duplicate.levels[0].variants.push({ difficulty: 2, color_count: 3, tile_type_weights: [1, 1, 1] });
  assert.throws(() => validateTileExplorerProductionInput(duplicate), /duplicate output_level_id \+ difficulty/);

  const wrongLength = input();
  wrongLength.levels[0].variants[0].tile_type_weights = [1, 1];
  assert.throws(() => validateTileExplorerProductionInput(wrongLength), /length must equal color_count/);

  const zeroWeight = input();
  zeroWeight.levels[0].variants[0].tile_type_weights = [1, 0, 1];
  assert.throws(() => validateTileExplorerProductionInput(zeroWeight), /must contain positive integers/);

  const extendedDifficulty = input();
  extendedDifficulty.levels[0].variants[0].difficulty = 10;
  assert.doesNotThrow(() => validateTileExplorerProductionInput(extendedDifficulty));

  const excessiveDifficulty = input();
  excessiveDifficulty.levels[0].variants[0].difficulty = 100;
  assert.throws(() => validateTileExplorerProductionInput(excessiveDifficulty), /Replay grade limit 99/);

  const duplicateOptOut = input() as TileExplorerProductionInput & {
    levels: Array<TileExplorerProductionInput['levels'][number] & {
      variants: Array<TileExplorerProductionInput['levels'][number]['variants'][number] & { allow_duplicate_replay_codes?: boolean }>;
    }>;
  };
  duplicateOptOut.levels[0].variants[0].allow_duplicate_replay_codes = true;
  assert.throws(() => validateTileExplorerProductionInput(duplicateOptOut), /allow_duplicate_replay_codes is not supported/);
});

test('production record projects to the unchanged Replay selection contract', () => {
  const record: TileExplorerProductionRecord = {
    schema_version: 1,
    production_id: 'tile_explorer_test',
    task_id: '100075_d3',
    output_level_id: 100075,
    terrain_id: '100075',
    terrain_path: resolve('test/fixtures/100075.json'),
    strategy: 'default',
    difficulty: 3,
    grade: 3,
    color_count: 4,
    tile_type_weights: [1, 1, 1, 1],
    type_cycle: [2, 1, 4, 3],
    sequence_seed: 123,
    placement_seed: 456,
    attempt: 0,
    replay_key: '1-2-3-4-',
    replay_code: 'REPLAY',
    level_hash: 'hash',
    element_count: 4,
    generated_group_count: 28,
    view_layer_count: 8,
    elapsed_ms: 1.25,
    replay_element_count: 4,
  };
  const selection = productionRecordToReplaySelection(record);
  assert.equal(selection.grade, 3);
  assert.equal(selection.passrate, 0);
  assert.equal(selection.ElementCount, 4);
  assert.equal(selection.ReplayKey, '1-2-3-4-');
  assert.match(serializeTileExplorerProductionRecord(record), /1\|1\|1\|1/);
});
