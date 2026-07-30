import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  executeStrategyPipeline,
  loadTerrainFromFile,
  LogLevel,
  setLogLevel,
} from '../../src/index.js';
import { validateStrategyDefinition } from '../../src/strategy/definition.js';
import { generateCandidate } from '../../src/strategy/generator.js';
import { deriveSeed } from '../../src/strategy/random.js';
import {
  compileEditorStrategyV2,
  strategyRecordToBatchRow,
  strategyV2ToEditor,
  webBatchConfigToStrategyV2,
} from '../../src/strategy/web-adapter.js';

setLogLevel(LogLevel.Silent);

const strategyPath = resolve('strategies/current_calibration/strategy.v2.json');
const terrainPath = resolve('test/fixtures/100075.json');

test('canonical strategy v2 validates', () => {
  const strategy = validateStrategyDefinition(JSON.parse(readFileSync(strategyPath, 'utf8')));
  assert.equal(strategy.schema_version, 2);
  assert.deepEqual(strategy.pipeline.map(stage => stage.type), ['simulate', 'simulate', 'grade', 'filter']);
});

test('old strategy schema is rejected explicitly', () => {
  assert.throws(
    () => validateStrategyDefinition({ schema_version: 1 }),
    /schema_version must be 2/,
  );
});

test('layer_closure candidate generation is deterministic by strategy seed and attempt', () => {
  const strategy = validateStrategyDefinition(JSON.parse(readFileSync(strategyPath, 'utf8')));
  const terrain = loadTerrainFromFile(terrainPath);
  const first = generateCandidate(terrain, terrainPath, 7, strategy.generator, strategy.runtime.seed).candidate;
  const second = generateCandidate(terrain, terrainPath, 7, strategy.generator, strategy.runtime.seed).candidate;
  const next = generateCandidate(terrain, terrainPath, 8, strategy.generator, strategy.runtime.seed).candidate;

  assert.equal(first.seed, second.seed);
  assert.equal(first.replay_code, second.replay_code);
  assert.deepEqual(first.assignments, second.assignments);
  assert.notEqual(first.seed, next.seed);
  assert.equal(first.tile_count, terrain.layers.flatMap(layer => layer.tiles).length);
});

test('stage seeds are stable and namespaced', () => {
  assert.equal(deriveSeed(20260630, '100075', 1, 'player_metrics'), deriveSeed(20260630, '100075', 1, 'player_metrics'));
  assert.notEqual(deriveSeed(20260630, '100075', 1, 'player_metrics'), deriveSeed(20260630, '100075', 1, 'optimal_metrics'));
});

test('strategy editor saves as canonical strategy v2 and round-trips', () => {
  const canonical = validateStrategyDefinition(JSON.parse(readFileSync(strategyPath, 'utf8')));
  const editor = strategyV2ToEditor(canonical, { name: '当前校准', status: 'active' });
  const compiled = compileEditorStrategyV2(editor);
  assert.equal(compiled.schema_version, 2);
  assert.equal(compiled.id, canonical.id);
  assert.equal(compiled.runtime.seed, canonical.runtime.seed);
  assert.deepEqual(compiled.runtime.trace, canonical.runtime.trace);
  assert.deepEqual(compiled.output, canonical.output);
  assert.equal(compiled.generator.method, 'layer_closure');
  assert.deepEqual(compiled.pipeline.map(stage => stage.id), canonical.pipeline.map(stage => stage.id));
});

test('web batch request compiles to the same strategy v2 execution model', () => {
  const definition = webBatchConfigToStrategyV2({
    terrainPaths: [terrainPath],
    closeRates: 'random',
    colorCount: 'random',
    colorCountRatio: 0.6,
    spreadParam: 'random',
    debtPersistenceWeight: 'random',
    simRuns: 20,
    targetPerTier: 2,
    maxAttempts: 10,
    concurrency: 1,
    seed: 12345,
  }, 'batch_test');
  assert.equal(definition.schema_version, 2);
  assert.equal(definition.runtime.seed, 12345);
  assert.equal(definition.pipeline[0].type, 'simulate');
  assert.equal(definition.pipeline[0].type === 'simulate' && definition.pipeline[0].engine, 'rust');
  assert.deepEqual(definition.target.grades, [0, 1, 2, 3, 4, 5]);
});

test('zen_match is a first-class strategy-v2 generator and enters grading pipeline', () => {
  const definition = validateStrategyDefinition({
    schema_version: 2,
    id: 'zen_match_pipeline_test',
    version: 1,
    scope: { levels_dir: resolve('test/fixtures'), levels: ['100075'] },
    target: { grades: [0, 1, 2, 3, 4, 5], count_per_grade: 1, max_attempts_per_level: 2 },
    generator: {
      method: 'zen_match',
      version: 1,
      parameters: {
        generation_strategy: 5,
        color_count: { kind: 'fixed', value: 5 },
      },
    },
    pipeline: [
      {
        id: 'player',
        type: 'simulate',
        engine: 'typescript',
        runs: 1,
        policy: { id: 'mistake_player', version: 1, config: {} },
        variants: [
          { id: 'sim1', config: { mistake_rate: 0.01 } },
          { id: 'sim5', config: { mistake_rate: 0.05 } },
          { id: 'sim15', config: { mistake_rate: 0.15 } },
        ],
      },
      {
        id: 'grade',
        type: 'grade',
        method: 'strategy2',
        source: 'player',
        inputs: { sim1: 'sim1', sim5: 'sim5', sim15: 'sim15' },
      },
    ],
    runtime: { seed: 20260729, concurrency: 1, trace: { enabled: false, sample_rate: 0 } },
    output: { format: 'jsonl' },
  });
  const terrain = loadTerrainFromFile(terrainPath);
  const generated = generateCandidate(
    terrain,
    terrainPath,
    1,
    definition.generator,
    definition.runtime.seed,
  );
  assert.equal(generated.candidate.generator.method, 'zen_match');
  assert.equal(generated.candidate.assignments.length, 84);
  assert.equal(generated.candidate.generator.parameters.generation_strategy, 5);
  const record = executeStrategyPipeline(definition, generated.candidate, generated.game);
  assert.equal(record.stages.at(-1)?.type, 'grade');
  const row = strategyRecordToBatchRow(record);
  assert.equal(row.replayCode, generated.candidate.replay_code);
  assert.equal(row.colorCount, 5);
  assert.deepEqual(row.closeRates, []);
});
