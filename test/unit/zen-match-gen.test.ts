import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  decodeFromString,
  generateBoardZenMatch,
  loadTerrainFromFile,
  LogLevel,
  runZenMatchGen,
  setLogLevel,
} from '../../src/index.js';
import type { TerrainData } from '../../src/types.js';

setLogLevel(LogLevel.Silent);
const terrainPath = resolve('test/fixtures/100075.json');

function distribution(values: Iterable<number>): number[] {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.values()].sort((left, right) => left - right);
}

function shiftIds(terrain: TerrainData, offset: number): TerrainData {
  const copy = structuredClone(terrain);
  for (const layer of copy.layers) {
    for (const tile of layer.tiles) {
      tile.id += offset;
      tile.dependencies = tile.dependencies.map(id => id + offset);
    }
  }
  return copy;
}

test('Zen strategies are deterministic and preserve triple-group semantics', () => {
  const terrain = loadTerrainFromFile(terrainPath);
  for (const strategy of [4, 5] as const) {
    const input = { terrain, uniqueCount: 5, seed: 12345, strategy };
    const first = runZenMatchGen(input);
    const second = runZenMatchGen(input);

    assert.deepEqual([...first.assignments], [...second.assignments]);
    assert.equal(first.assignments.size, 84);
    assert.equal(first.topMatchTileIds.length, 3);
    assert.equal(new Set(first.topMatchTileIds.map(id => first.assignments.get(id))).size, 1);
    assert.ok(first.actualColorCount <= 5);
    assert.ok(distribution(first.assignments.values()).every(count => count % 3 === 0));
  }
});

test('Shell ID +1 mapping does not change Zen generation behavior', () => {
  const terrain = loadTerrainFromFile(terrainPath);
  const shifted = shiftIds(terrain, 1);
  const original = runZenMatchGen({ terrain, uniqueCount: 5, seed: 77, strategy: 5 });
  const moved = runZenMatchGen({ terrain: shifted, uniqueCount: 5, seed: 77, strategy: 5 });
  const normalizedMoved = [...moved.assignments].map(([id, value]) => [id - 1, value]);

  assert.deepEqual(normalizedMoved, [...original.assignments]);
  assert.deepEqual(moved.topMatchTileIds.map(id => id - 1), original.topMatchTileIds);
});

test('fixed equality groups are preserved and may merge with generated groups', () => {
  const terrain: TerrainData = {
    levelResId: 1,
    levelHash: '',
    layers: [
      {
        tiles: Array.from({ length: 12 }, (_, index) => ({
          id: index + 1,
          layer: 0,
          dependencies: [],
          isConst: index < 3,
          constElementValue: index < 3 ? 101 : 0,
          posX: index,
          posY: 0,
        })),
      },
    ],
  };
  const result = runZenMatchGen({ terrain, uniqueCount: 2, seed: 9, strategy: 4 });
  const combined = [
    101, 101, 101,
    ...result.assignments.values(),
  ];

  assert.equal(result.assignments.size, 9);
  assert.equal(new Set(combined).size, 2);
  assert.ok(distribution(combined).every(count => count % 3 === 0));
});

test('high-level Zen generation produces a decodable ReplayCode', () => {
  const terrain = loadTerrainFromFile(terrainPath);
  const result = generateBoardZenMatch({
    terrain,
    uniqueCount: 6,
    seed: -123,
    strategy: 4,
  });
  const replay = decodeFromString(result.replayCode);

  assert.equal(replay?.instanceArray.length, 84);
  assert.equal(replay?.elementCount, result.actualColorCount);
  assert.equal(result.levelHash, terrain.levelHash || '(none)');
});

test('Zen generator rejects dynamic Shell terrain structures', () => {
  const terrain = loadTerrainFromFile(terrainPath);
  terrain.terrainStructures = [{ type: 'transfer', tileIds: [1, 2, 3] }];
  assert.throws(
    () => runZenMatchGen({ terrain, uniqueCount: 5, seed: 1, strategy: 4 }),
    /暂不支持 transfer\/falling/,
  );
});

test('Zen generator validates Shell layer placement and fixed color budget', () => {
  const misplaced = loadTerrainFromFile(terrainPath);
  misplaced.layers[0].tiles[0].layer = 1;
  assert.throws(
    () => runZenMatchGen({ terrain: misplaced, uniqueCount: 5, seed: 1 }),
    /与所在 layers\[0\] 不一致/,
  );

  const fixedTerrain: TerrainData = {
    levelResId: 1,
    levelHash: '',
    layers: [{
      tiles: [101, 102, 103].flatMap((type, group) =>
        Array.from({ length: 3 }, (_, index) => ({
          id: group * 3 + index + 1,
          layer: 0,
          dependencies: [],
          isConst: true,
          constElementValue: type,
          posX: group * 3 + index,
          posY: 0,
        }))),
    }],
  };
  assert.throws(
    () => runZenMatchGen({ terrain: fixedTerrain, uniqueCount: 2, seed: 1 }),
    /固定牌已经使用 3 种花色/,
  );
});
