import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildGenerationLogicalLayers } from '../../src/logical-layers.js';
import { loadTerrainFromJson } from '../../src/terrain-loader.js';
import { buildTileExplorerTerrainView } from '../../src/tile-explorer/view-layers.js';

function tile(ID: number, Layer = 0, Dependencies: number[] = []) {
  return {
    ID,
    Layer,
    Dependencies,
    IsConst: false,
    ConstElementValue: 0,
    PosX: 0,
    PosY: 0,
  };
}

function structuredTerrainJson(): string {
  const tiles = Array.from({ length: 42 }, (_, index) => tile(index + 1));
  return JSON.stringify({
    levelResId: 500041,
    LevelHash: '5a97ffd0d6892d16',
    layers: [{ tiles }],
    terrainStructures: [
      {
        type: 'transfer',
        id: 1,
        tileIds: Array.from({ length: 15 }, (_, index) => index + 1),
        tileNum: 15,
      },
      ...[16, 25, 34].map((start, index) => ({
        type: 'falling',
        id: index + 2,
        tileIds: Array.from({ length: 9 }, (_, offset) => start + offset),
        tileNum: 9,
        viewLength: 5,
      })),
    ],
  });
}

describe('特殊结构生成逻辑层', () => {
  it('无普通依赖时由 falling 建立简单逻辑层', () => {
    const terrain = loadTerrainFromJson(structuredTerrainJson());
    const logical = buildGenerationLogicalLayers(terrain);

    assert.equal(logical.hasTerrainStructures, true);
    assert.equal(logical.ordinaryDepthCount, 0);
    assert.deepEqual(logical.layers.map(layer => layer.length), [30, 3, 3, 3, 3]);
    assert.equal(logical.depthById.get(1), 1);
    assert.equal(logical.depthById.get(16), 1);
    assert.equal(logical.depthById.get(21), 2);
    assert.equal(logical.depthById.get(24), 5);
    assert.equal(new Set(logical.layers.flat().map(entry => entry.id)).size, 42);
  });

  it('混合普通牌时使用普通深度，并由尾层吸收剩余 falling', () => {
    const terrain = loadTerrainFromJson(JSON.stringify({
      layers: [
        { tiles: [tile(100, 0), tile(1, 0), ...Array.from({ length: 5 }, (_, i) => tile(10 + i, 0))] },
        { tiles: [tile(101, 1, [100]), ...Array.from({ length: 4 }, (_, i) => tile(15 + i, 1))] },
        { tiles: [tile(102, 2, [101])] },
      ],
      terrainStructures: [
        { type: 'transfer', id: 1, tileIds: [1], tileNum: 1 },
        {
          type: 'falling',
          id: 2,
          tileIds: Array.from({ length: 9 }, (_, index) => 10 + index),
          tileNum: 9,
          viewLength: 5,
        },
      ],
    }));

    const logical = buildGenerationLogicalLayers(terrain);
    assert.equal(logical.ordinaryDepthCount, 3);
    assert.deepEqual(logical.layers.map(layer => layer.map(entry => entry.id)), [
      [100, 1, 10, 11, 12, 13, 14],
      [101, 15],
      [102, 16, 17, 18],
    ]);
  });

  it('TileExplorer 使用同一逻辑层并转换为 bottom-to-top 顺序', () => {
    const terrain = loadTerrainFromJson(structuredTerrainJson());
    const logical = buildGenerationLogicalLayers(terrain);
    const tileExplorer = buildTileExplorerTerrainView(terrain);

    assert.deepEqual(
      tileExplorer.viewLayers.map(layer => layer.length),
      [...logical.layers].reverse().map(layer => layer.length),
    );
    assert.deepEqual(tileExplorer.depthById, logical.depthById);
  });

  it('拒绝重复归属和无效 viewLength', () => {
    const terrain = loadTerrainFromJson(JSON.stringify({
      layers: [{ tiles: [tile(1), tile(2), tile(3)] }],
      terrainStructures: [
        { type: 'transfer', tileIds: [1] },
        { type: 'falling', tileIds: [1, 2, 3], viewLength: 0 },
      ],
    }));
    assert.throws(
      () => buildGenerationLogicalLayers(terrain),
      /同时属于多个 terrainStructures|viewLength/,
    );
  });
});
