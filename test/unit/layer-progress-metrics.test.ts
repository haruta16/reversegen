import assert from 'node:assert/strict';
import test from 'node:test';
import { computeLayerProgressMetrics } from '../../src/layer-closure-gen.js';
import type { TerrainTile } from '../../src/types.js';

function tile(id: number): TerrainTile {
  return {
    id, layer: 0, dependencies: [], isConst: false,
    constElementValue: 0, posX: 0, posY: 0,
  };
}

test('逐层花色使用率和债务 tile 保留率', () => {
  const layers = [
    [tile(1), tile(2), tile(3)],
    [tile(4), tile(5)],
    [tile(6), tile(7), tile(8), tile(9)],
  ];
  const assignments = new Map<number, number>([
    [1, 1], [2, 1], [3, 2],
    [4, 1], [5, 3],
    [6, 2], [7, 2], [8, 3], [9, 3],
  ]);

  const result = computeLayerProgressMetrics(assignments, layers);

  assert.deepEqual(result.colorUsageRates, [2 / 3, 1, 1]);
  assert.equal(result.averageColorActivationLayer, 4 / 3);
  assert.deepEqual(result.debtTileCountsByLayer, [3, 2, 0]);
  assert.deepEqual(result.debtRetentionRates, [1 / 3, 0]);
  assert.equal(result.weightedDebtRetentionRate, 1 / 5);
});
