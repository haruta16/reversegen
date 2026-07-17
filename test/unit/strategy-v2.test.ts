import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { loadTerrainFromFile, LogLevel, setLogLevel } from '../../src/index.js';
import { validateStrategyDefinition } from '../../src/strategy/definition.js';
import { generateCandidate } from '../../src/strategy/generator.js';
import { deriveSeed } from '../../src/strategy/random.js';
import {
  compileEditorStrategyV2,
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
