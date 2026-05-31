/**
 * Tests for the ReverseGen algorithm.
 *
 * Run: npx tsx --test test/test-reverse-gen.ts
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  runReverseGen,
  generateTestTerrain,
  getAllTiles,
  setLogLevel,
  LogLevel,
} from '../src/index.js';

// Silence logs during tests
setLogLevel(LogLevel.Silent);

describe('ReverseGen Algorithm', () => {
  it('should complete successfully with natural minCost', () => {
    const terrain = generateTestTerrain(2, 9); // 18 free tiles → 6 steps
    const tiles = getAllTiles(terrain);

    const result = runReverseGen({
      tiles,
      costArray: null,
      colorCount: 6,
    });

    assert.equal(result.completed, true);
    assert.equal(result.totalSteps, 6);
    assert.equal(result.costLog.length, 6);
    assert.equal(result.branchLog.length, 6);
    assert.ok(result.assignments.size > 0);
  });

  it('should complete successfully with cost targets', () => {
    const terrain = generateTestTerrain(2, 9); // 18 free tiles → 6 steps
    const tiles = getAllTiles(terrain);

    const result = runReverseGen({
      tiles,
      costArray: [2, 2, 3, 3, 4, 4],
      colorCount: 6,
    });

    assert.equal(result.completed, true);
    assert.equal(result.totalSteps, 6);
    assert.equal(result.costLog.length, 6);
    assert.ok(result.matchRate !== undefined);
    assert.ok(result.deviationCount !== undefined);
  });

  it('should assign exactly 3 tiles per color group', () => {
    const terrain = generateTestTerrain(1, 18); // single layer, 18 tiles → 6 steps
    const tiles = getAllTiles(terrain);

    const result = runReverseGen({
      tiles,
      costArray: null,
      colorCount: 6,
    });

    // Each color should appear exactly 3 times (18/6 = 3)
    const colorCounts = new Map<number, number>();
    for (const [, color] of result.assignments) {
      colorCounts.set(color, (colorCounts.get(color) ?? 0) + 1);
    }

    for (const [color, count] of colorCounts) {
      assert.equal(count, 3, `Color ${color} should have 3 tiles, got ${count}`);
    }
  });

  it('should not assign colors to const tiles', () => {
    const terrain = generateTestTerrain(2, 9);
    const tiles = getAllTiles(terrain);
    // Mark first 3 tiles as const
    tiles[0].isConst = true;
    tiles[0].constElementValue = 999;
    tiles[1].isConst = true;
    tiles[1].constElementValue = 999;
    tiles[2].isConst = true;
    tiles[2].constElementValue = 999;

    const result = runReverseGen({
      tiles,
      costArray: null,
      colorCount: 5,
    });

    // Const tiles should NOT be in assignments
    assert.equal(result.assignments.has(1), false);
    assert.equal(result.assignments.has(2), false);
    assert.equal(result.assignments.has(3), false);

    // steps = (18-3)/3 = 5
    assert.equal(result.totalSteps, 5);
  });

  it('should handle cost targets not matching steps (fallback to minCost)', () => {
    const terrain = generateTestTerrain(2, 9); // 6 steps
    const tiles = getAllTiles(terrain);

    // Cost array with wrong length → should fallback to natural minCost
    const result = runReverseGen({
      tiles,
      costArray: [1, 2, 3], // length 3 != 6 steps
      colorCount: 6,
    });

    assert.equal(result.completed, true);
    assert.equal(result.totalSteps, 6);
    // matchRate/deviationCount should be undefined (no cost targets used)
    assert.equal(result.matchRate, undefined);
    assert.equal(result.deviationCount, undefined);
  });

  it('should reject cost arrays with values < 1', () => {
    const terrain = generateTestTerrain(2, 9);
    const tiles = getAllTiles(terrain);

    const result = runReverseGen({
      tiles,
      costArray: [0, 1, 2, 0, 1, 2], // contains 0
      colorCount: 6,
    });

    // Should fallback to natural minCost
    assert.equal(result.completed, true);
    assert.equal(result.matchRate, undefined);
  });

  it('should handle single layer terrain (no dependencies)', () => {
    const terrain = generateTestTerrain(1, 30); // 10 steps
    const tiles = getAllTiles(terrain);

    const result = runReverseGen({
      tiles,
      costArray: null,
      colorCount: 10,
    });

    assert.equal(result.completed, true);
    assert.equal(result.totalSteps, 10);

    // With no dependencies, all costs should be 3 (just the 3 tiles themselves)
    for (const cost of result.costLog) {
      assert.equal(cost, 3, `Expected cost=3 for independent tiles, got ${cost}`);
    }
  });

  it('should be deterministic for the same input', () => {
    const terrain = generateTestTerrain(2, 9);
    const tiles = getAllTiles(terrain);

    const result1 = runReverseGen({
      tiles: JSON.parse(JSON.stringify(tiles)),
      costArray: [2, 2, 3, 3, 4, 4],
      colorCount: 6,
    });

    const result2 = runReverseGen({
      tiles: JSON.parse(JSON.stringify(tiles)),
      costArray: [2, 2, 3, 3, 4, 4],
      colorCount: 6,
    });

    // Cost logs should be identical
    assert.deepEqual(result1.costLog, result2.costLog);
    assert.deepEqual(result1.branchLog, result2.branchLog);
  });

  it('should handle large terrains', () => {
    const terrain = generateTestTerrain(4, 18); // 72 free tiles → 24 steps
    const tiles = getAllTiles(terrain);

    const result = runReverseGen({
      tiles,
      costArray: null,
      colorCount: 12,
    });

    assert.equal(result.completed, true);
    assert.equal(result.totalSteps, 24);
    assert.equal(result.costLog.length, 24);
  });

  it('should include cost statistics', () => {
    const terrain = generateTestTerrain(2, 9);
    const tiles = getAllTiles(terrain);

    const result = runReverseGen({
      tiles,
      costArray: null,
      colorCount: 6,
    });

    assert.ok(result.stats.min >= 0);
    assert.ok(result.stats.max >= result.stats.min);
    assert.ok(result.stats.avg >= result.stats.min && result.stats.avg <= result.stats.max);
  });
});
