import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  buildTileExplorerTerrainView,
  DotNetRandom,
  executeStrategyPipeline,
  generateBoardTileExplorer,
  generateCandidate,
  loadTerrainFromFile,
  LogLevel,
  runTileExplorerGen,
  setLogLevel,
  validateStrategyDefinition,
  type TileExplorerStrategy,
} from '../../src/index.js';
import { strategyRecordToBatchRow } from '../../src/strategy/web-adapter.js';

setLogLevel(LogLevel.Silent);
const terrainPath = resolve('test/fixtures/100075.json');

test('legacy .NET Random sequence and captured-state recovery are exact', () => {
  const rng = new DotNetRandom(0);
  assert.deepEqual(
    Array.from({ length: 8 }, () => rng.next(1_000_000)),
    [726243, 817325, 768022, 558161, 206033, 558884, 906027, 442177],
  );
  const state = rng.state();
  const expected = Array.from({ length: 20 }, () => rng.next(2_000_000_000));
  const restored = DotNetRandom.fromState(state);
  assert.deepEqual(Array.from({ length: 20 }, () => restored.next(2_000_000_000)), expected);
});

test('view_layers are derived from Dependencies in Tile Explorer bottom-to-top order', () => {
  const terrain = loadTerrainFromFile(terrainPath);
  const view = buildTileExplorerTerrainView(terrain);
  assert.deepEqual(view.viewLayers.map(layer => layer.length), [14, 10, 14, 10, 6, 6, 10, 14]);
  assert.deepEqual(view.physicalLayers.map(layer => layer.length), [14, 10, 14, 10, 6, 6, 10, 14]);
  assert.equal(view.depthById.get(1), 1);
  assert.equal(Math.max(...view.depthById.values()), 8);
});

const goldenDigests: Record<TileExplorerStrategy, string> = {
  default: 'a2e1464b965fc0afd41cf753cdfeefc543ac1310e0c26e2c3209da99c6c87dd3',
  top_two_easy: '16be008490a6ac3369e5a4ff940e6a722ab32403124537c1c63eed137326769e',
  sliding_window: '08716b70ba4e62df4325d3de376444f254f24ed31b8a6d212ad18785050305b5',
  limit_layer_random: 'e2a5c30fd2f3271ecd2ddbc645a55e3e7b84ce229994a455af5ce174d53f3d84',
  easy_hard_easy: 'c1a92b10d4e889f32a5964c3efaa2831894d73db46a304fab1010b82c8a0626e',
  solvability_coefficient: '4f578ba4ce3cf2fdad911772a6e59e86a014cf0627510aeb5de18df0d2900827',
  solvability_coefficient_v2: 'b46d9d07a0cedfdb250896a26b298f19de3a6767c4aafa37c03bc42009cae4a8',
  solvability_coefficient_v3: '5555c39c6e0c8339b18ca1f1cbdfbf122753064ab75a2f66fa982cd6e1df52d8',
  color_gradient: 'b96178c0fc0daddab638b235be2f7f09b9b5d1c730366da44629c4e0b37eb2bb',
};

test('all Tile Explorer strategies match independently captured Python golden results', () => {
  const terrain = loadTerrainFromFile(terrainPath);
  for (const strategy of Object.keys(goldenDigests) as TileExplorerStrategy[]) {
    const result = runTileExplorerGen({
      terrain,
      strategy,
      difficulty: 3,
      typeCycle: [1, 2, 3, 4, 5],
      sequenceSeed: 123,
      placementSeed: 456,
      levelHardTag: 1,
      easyLayerCount: 2,
      limitFullFirst: true,
      colorGradientTypeGroups: strategy === 'color_gradient' ? [[1, 2], [3, 4], [5]] : undefined,
    });
    const rows = [...result.assignments]
      .map(([id, suit]) => [id, suit, result.groups.get(id)])
      .sort((left, right) => Number(left[0]) - Number(right[0]));
    const digest = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    assert.equal(digest, goldenDigests[strategy], strategy);
    assert.equal(result.assignments.size, 84);
    assert.equal(result.groups.size % 3, 0);
  }
});

test('weighted type cycle and high-level ReplayCode generation are deterministic', () => {
  const terrain = loadTerrainFromFile(terrainPath);
  const input = {
    terrain,
    strategy: 'default' as const,
    difficulty: 2,
    tileTypeWeights: [2, 1, 3],
    tileTypesCanUse: 3,
    sequenceSeed: 123,
    placementSeed: 456,
  };
  const first = generateBoardTileExplorer(input);
  const second = generateBoardTileExplorer(input);
  assert.deepEqual(first.typeCycle, [1, 1, 3, 2, 3, 3]);
  assert.deepEqual([...first.assignments], [...second.assignments]);
  assert.equal(first.replayCode, second.replayCode);
});

test('invalid dependency direction is rejected before generation', () => {
  const terrain = structuredClone(loadTerrainFromFile(terrainPath));
  terrain.layers[0].tiles[0].dependencies = [terrain.layers[0].tiles[1].id];
  assert.throws(() => buildTileExplorerTerrainView(terrain), /不在更高物理层/);
});

test('tile_explorer is a first-class strategy-v2 generator and enters grading pipeline', () => {
  const definition = validateStrategyDefinition({
    schema_version: 2,
    id: 'tile_explorer_pipeline_test',
    version: 1,
    scope: { levels_dir: resolve('test/fixtures'), levels: ['100075'] },
    target: { grades: [0, 1, 2, 3, 4, 5], count_per_grade: 1, max_attempts_per_level: 2 },
    generator: {
      method: 'tile_explorer',
      version: 1,
      parameters: {
        strategy: 'solvability_coefficient_v2',
        difficulty: { kind: 'fixed', value: 2 },
        color_count: { kind: 'fixed', value: 5 },
      },
    },
    pipeline: [
      {
        id: 'player', type: 'simulate', engine: 'typescript', runs: 1,
        policy: { id: 'mistake_player', version: 1, config: {} },
        variants: [
          { id: 'sim1', config: { mistake_rate: 0.01 } },
          { id: 'sim5', config: { mistake_rate: 0.05 } },
          { id: 'sim15', config: { mistake_rate: 0.15 } },
        ],
      },
      {
        id: 'grade', type: 'grade', method: 'strategy2', source: 'player',
        inputs: { sim1: 'sim1', sim5: 'sim5', sim15: 'sim15' },
      },
    ],
    runtime: { seed: 20260720, concurrency: 1, trace: { enabled: false, sample_rate: 0 } },
    output: { format: 'jsonl' },
  });
  const terrain = loadTerrainFromFile(terrainPath);
  const generated = generateCandidate(terrain, terrainPath, 1, definition.generator, definition.runtime.seed);
  assert.equal(generated.candidate.generator.method, 'tile_explorer');
  assert.equal(generated.candidate.assignments.length, 84);
  const record = executeStrategyPipeline(definition, generated.candidate, generated.game);
  assert.equal(record.stages.at(-1)?.type, 'grade');
  assert.ok(Number.isInteger(record.decision.grade));
  const row = strategyRecordToBatchRow(record);
  assert.equal(row.replayCode, generated.candidate.replay_code);
  assert.equal(row.colorCount, 5);
  assert.deepEqual(row.closeRates, []);
  assert.ok(Number.isFinite(row.spreadParam));
});
