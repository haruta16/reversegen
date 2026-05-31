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
import type { TerrainTile } from '../src/types.js';
import {
  runReverseGen,
  loadTerrainFromFile,
  getAllTiles,
  setLogLevel,
  LogLevel,
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', '100075.json');

// Silence logs during tests
setLogLevel(LogLevel.Silent);

/** Load the real terrain fixture (100075: 84 tiles, 28 steps) */
function loadFixture(): TerrainTile[] {
  return getAllTiles(loadTerrainFromFile(FIXTURE));
}

describe('ReverseGen Algorithm', () => {
  it('should complete successfully with natural minCost', () => {
    const tiles = loadFixture();

    const result = runReverseGen({ tiles, costArray: null, colorCount: 6 });

    assert.equal(result.completed, true);
    assert.equal(result.totalSteps, 28);
    assert.equal(result.costLog.length, 28);
    assert.equal(result.branchLog.length, 28);
    assert.ok(result.assignments.size > 0);
  });

  it('should complete successfully with cost targets', () => {
    const tiles = loadFixture();
    // 28 steps, mean=3
    const costArray = Array(28).fill(3);

    const result = runReverseGen({ tiles, costArray, colorCount: 6 });

    assert.equal(result.completed, true);
    assert.equal(result.totalSteps, 28);
    assert.equal(result.costLog.length, 28);
    assert.ok(result.matchRate !== undefined);
    assert.ok(result.deviationCount !== undefined);
  });

  it('should assign each free tile exactly once', () => {
    const tiles = loadFixture();
    const result = runReverseGen({ tiles, costArray: null, colorCount: 10 });

    // All 84 free tiles should be assigned
    assert.equal(result.assignments.size, 84);

    // Each assignment should be a valid color [1..colorCount]
    for (const [, color] of result.assignments) {
      assert.ok(color >= 1 && color <= 10, `Color ${color} out of range`);
    }
  });

  it('should not assign colors to const tiles', () => {
    const tiles = loadFixture();
    // Mark first 3 tiles as const
    tiles[0].isConst = true; tiles[0].constElementValue = 999;
    tiles[1].isConst = true; tiles[1].constElementValue = 999;
    tiles[2].isConst = true; tiles[2].constElementValue = 999;

    const result = runReverseGen({ tiles, costArray: null, colorCount: 5 });

    assert.equal(result.assignments.has(tiles[0].id), false);
    assert.equal(result.assignments.has(tiles[1].id), false);
    assert.equal(result.assignments.has(tiles[2].id), false);
    // steps = (84-3)/3 = 27
    assert.equal(result.totalSteps, 27);
  });

  it('should handle cost targets not matching steps (fallback to minCost)', () => {
    const tiles = loadFixture();

    const result = runReverseGen({
      tiles,
      costArray: [1, 2, 3], // length 3 != 28 steps
      colorCount: 6,
    });

    assert.equal(result.completed, true);
    assert.equal(result.totalSteps, 28);
    assert.equal(result.matchRate, undefined);
    assert.equal(result.deviationCount, undefined);
  });

  it('should reject cost arrays with values < 1', () => {
    const tiles = loadFixture();

    // contains 0 → should fallback to natural minCost
    const costArray = Array(28).fill(0);

    const result = runReverseGen({ tiles, costArray, colorCount: 6 });

    assert.equal(result.completed, true);
    assert.equal(result.matchRate, undefined);
  });

  it('should handle single layer terrain (no dependencies)', () => {
    // 30 independent tiles, single layer — all costs should be exactly 3
    const tiles: TerrainTile[] = [];
    for (let i = 1; i <= 30; i++) {
      tiles.push({ id: i, layer: 0, dependencies: [], isConst: false, constElementValue: 0 });
    }

    const result = runReverseGen({ tiles, costArray: null, colorCount: 10 });

    assert.equal(result.completed, true);
    assert.equal(result.totalSteps, 10);

    for (const cost of result.costLog) {
      assert.equal(cost, 3, `Expected cost=3 for independent tiles, got ${cost}`);
    }
  });

  it('should be deterministic for the same input', () => {
    const tiles = loadFixture();
    const costArray = Array(28).fill(3);

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
    // 100075 is already 84 tiles/28 steps — verify it completes
    const tiles = loadFixture();
    const result = runReverseGen({ tiles, costArray: null, colorCount: 12 });

    assert.equal(result.completed, true);
    assert.equal(result.totalSteps, 28);
    assert.equal(result.costLog.length, 28);
  });

  it('should include cost statistics', () => {
    const tiles = loadFixture();

    const result = runReverseGen({ tiles, costArray: null, colorCount: 6 });

    assert.ok(result.stats.min >= 0);
    assert.ok(result.stats.max >= result.stats.min);
    assert.ok(result.stats.avg >= result.stats.min && result.stats.avg <= result.stats.max);
  });
});
