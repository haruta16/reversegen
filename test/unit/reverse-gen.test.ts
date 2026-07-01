/**
 * Tests for the ReverseGen algorithm.
 *
 * Uses real terrain fixture from test/fixtures/100075.json (84 tiles, 28 steps).
 *
 * Run: npx tsx --test test/test-reverse-gen.ts
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TerrainTile } from '../../src/types.js';
import {
  runReverseGen,
  loadTerrainFromFile,
  getAllTiles,
  generateCostArray,
  setLogLevel,
  LogLevel,
} from '../../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', 'fixtures', '100075.json');
const SEED = 42;

// Load fixture once — all tests share the same real terrain
const FIXTURE_TILES = getAllTiles(loadTerrainFromFile(FIXTURE));
const FIXTURE_FREE = FIXTURE_TILES.filter(t => !t.isConst);
const STEPS = Math.floor(FIXTURE_FREE.length / 3); // 84 / 3 = 28

// Silence logs during tests
setLogLevel(LogLevel.Silent);

function cloneTiles(): TerrainTile[] {
  return FIXTURE_FREE.map(t => ({ ...t, dependencies: [...t.dependencies] }));
}

function makeCost(): number[] {
  return generateCostArray(STEPS, 1.0, SEED);
}

describe('ReverseGen Algorithm', () => {
  it('should complete successfully with cost targets', () => {
    const tiles = cloneTiles();
    const costArray = makeCost();

    const result = runReverseGen({ tiles, costArray, colorCount: 6 });

    assert.equal(result.completed, true);
    assert.equal(result.totalSteps, STEPS);
    assert.equal(result.costLog.length, STEPS);
    assert.equal(result.branchLog.length, STEPS);
    assert.ok(result.assignments.size > 0);
    assert.ok(result.matchRate !== undefined);
    assert.ok(result.deviationCount !== undefined);
  });

  it('should assign each free tile exactly once', () => {
    const tiles = cloneTiles();
    const result = runReverseGen({ tiles, costArray: makeCost(), colorCount: 10 });

    assert.equal(result.assignments.size, FIXTURE_FREE.length);

    for (const [, color] of result.assignments) {
      assert.ok(color >= 1 && color <= 10, `Color ${color} out of range`);
    }
  });

  it('should not assign colors to const tiles', () => {
    const tiles = cloneTiles();
    tiles[0].isConst = true; tiles[0].constElementValue = 999;
    tiles[1].isConst = true; tiles[1].constElementValue = 999;
    tiles[2].isConst = true; tiles[2].constElementValue = 999;

    // 3 const tiles reduce steps by 1
    const costForConst = generateCostArray(STEPS - 1, 1.0, SEED);
    const result = runReverseGen({ tiles, costArray: costForConst, colorCount: 5 });

    assert.equal(result.assignments.has(tiles[0].id), false);
    assert.equal(result.assignments.has(tiles[1].id), false);
    assert.equal(result.assignments.has(tiles[2].id), false);
    assert.equal(result.totalSteps, STEPS - 1); // 3 const tiles = 1 less step
  });

  it('should throw on invalid cost values (< 1)', () => {
    const tiles = cloneTiles();
    const badCost = Array(STEPS).fill(0);

    assert.throws(
      () => runReverseGen({ tiles, costArray: badCost, colorCount: 6 }),
      /cost value.*< 1/,
    );
  });

  it('should throw on cost array length mismatch', () => {
    const tiles = cloneTiles();

    assert.throws(
      () => runReverseGen({ tiles, costArray: [3, 3, 2], colorCount: 6 }), // length 3 != STEPS=28
      /length/,
    );
  });

  it('should handle single layer terrain (no dependencies)', () => {
    // All costs should be exactly 3 when tiles have no dependencies
    const N = 30;
    const tiles: TerrainTile[] = [];
    for (let i = 1; i <= N; i++) {
      tiles.push({ id: i, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: 0, posY: 0 });
    }

    const result = runReverseGen({ tiles, costArray: generateCostArray(N / 3, 1.0, SEED), colorCount: 10 });

    assert.equal(result.completed, true);
    assert.equal(result.totalSteps, N / 3);

    for (const cost of result.costLog) {
      assert.equal(cost, 3, `Expected cost=3 for independent tiles, got ${cost}`);
    }
  });

  it('should be deterministic for the same input', () => {
    const tiles = cloneTiles();
    const costArray = makeCost();

    const result1 = runReverseGen({
      tiles: JSON.parse(JSON.stringify(tiles)),
      costArray,
      colorCount: 6,
    });
    const result2 = runReverseGen({
      tiles: JSON.parse(JSON.stringify(tiles)),
      costArray,
      colorCount: 6,
    });

    assert.deepEqual(result1.costLog, result2.costLog);
    assert.deepEqual(result1.branchLog, result2.branchLog);
  });

  it('should handle large terrains', () => {
    const tiles = cloneTiles();
    const result = runReverseGen({ tiles, costArray: makeCost(), colorCount: 12 });

    assert.equal(result.completed, true);
    assert.equal(result.totalSteps, STEPS);
    assert.equal(result.costLog.length, STEPS);
  });

  it('should include cost statistics', () => {
    const tiles = cloneTiles();

    const result = runReverseGen({ tiles, costArray: makeCost(), colorCount: 6 });

    assert.ok(result.stats.min >= 0);
    assert.ok(result.stats.max >= result.stats.min);
    assert.ok(result.stats.avg >= result.stats.min && result.stats.avg <= result.stats.max);
  });
});
