import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGame } from '../../src/solver/offline-game.js';
import { TileFlag } from '../../src/solver/types.js';
import { runSimulationPolicy } from '../../src/strategy/simulation.js';
import type { TerrainStructure, TerrainTile } from '../../src/types.js';

function terrainTile(id: number, dependencies: number[] = []): TerrainTile {
  return {
    id,
    layer: 0,
    dependencies,
    isConst: false,
    constElementValue: 0,
    posX: 0,
    posY: 0,
  };
}

function buildStructuredGame() {
  const terrainTiles = [
    ...Array.from({ length: 3 }, (_, index) => terrainTile(index + 1)),
    ...Array.from({ length: 9 }, (_, index) => terrainTile(index + 10)),
    terrainTile(100, [1]),
  ];
  const terrainStructures: TerrainStructure[] = [
    { type: 'transfer', id: 1, tileIds: [1, 2, 3], tileNum: 3 },
    {
      type: 'falling',
      id: 2,
      tileIds: Array.from({ length: 9 }, (_, index) => index + 10),
      tileNum: 9,
      viewLength: 5,
    },
  ];
  const elementValues = new Map(terrainTiles.map(tile => [tile.id, tile.id]));
  return createGame({ terrainTiles, terrainStructures, elementValues });
}

describe('特殊结构打关状态机', () => {
  it('初始只显示 falling 前 viewLength 张，transfer 全部可点', () => {
    const game = buildStructuredGame();
    assert.deepEqual(
      game.clickableTiles.map(tile => tile.id).sort((a, b) => a - b),
      [1, 2, 3, 10, 11, 12, 13, 14],
    );
    for (const id of [15, 16, 17, 18]) {
      const tile = game.allTiles.get(id)!;
      assert.equal(tile.isClickable, false);
      assert.equal(tile.hasFlag(TileFlag.Invisible), true);
    }
    assert.equal(game.allTiles.get(100)!.isClickable, false);
  });

  it('收集任意可见 falling 后按 ID 顺序补下一张', () => {
    const game = buildStructuredGame();
    assert.equal(game.countUnlockGain(12), 1);

    game.collect(game.allTiles.get(12)!);
    assert.equal(game.allTiles.get(15)!.isClickable, true);
    assert.equal(game.allTiles.get(16)!.isClickable, false);

    game.collect(game.allTiles.get(10)!);
    assert.equal(game.allTiles.get(16)!.isClickable, true);
    assert.equal(game.allTiles.get(17)!.isClickable, false);
  });

  it('收集 transfer 不推进 falling，但会正常解锁普通依赖牌', () => {
    const game = buildStructuredGame();
    game.collect(game.allTiles.get(1)!);

    assert.equal(game.allTiles.get(15)!.isClickable, false);
    assert.equal(game.allTiles.get(100)!.isClickable, true);
  });

  it('clone 保留 falling 进度和特殊结构规则', () => {
    const game = buildStructuredGame();
    game.collect(game.allTiles.get(14)!);
    const clone = game.clone();

    assert.equal(clone.allTiles.get(15)!.isClickable, true);
    assert.equal(clone.allTiles.get(16)!.isClickable, false);
    assert.equal(clone.buildStateKey(), game.buildStateKey());
    clone.collect(clone.allTiles.get(15)!);
    assert.equal(clone.allTiles.get(16)!.isClickable, true);
    assert.equal(game.allTiles.get(16)!.isClickable, false);
  });

  it('结构关卡请求 Rust 时回退到同一套 TypeScript 状态机', () => {
    const result = runSimulationPolicy(buildStructuredGame(), {
      engine: 'rust',
      policy: { id: 'mistake_player', version: 1, config: { mistake_rate: 0 } },
      runs: 1,
      baseSeed: 1,
      collectTrace: true,
      requestId: 'structured-fallback',
    });
    assert.equal(result.summary.runs, 1);
    assert.equal(result.results?.length, 1);
  });

  it('transfer 牌走正常依赖回路（对齐 Unity UpdateTilesState：无依赖才可点击）', () => {
    const terrainTiles = [
      terrainTile(1, [9]),
      terrainTile(2, []),
      terrainTile(9, []),
    ];
    const terrainStructures: TerrainStructure[] = [
      { type: 'transfer', id: 1, tileIds: [1, 2], tileNum: 2 },
    ];
    const elementValues = new Map(terrainTiles.map(tile => [tile.id, 1]));
    const game = createGame({ terrainTiles, terrainStructures, elementValues });
    assert.equal(game.allTiles.get(2)!.isClickable, true, '无依赖 transfer 牌可点击');
    assert.equal(game.allTiles.get(1)!.isClickable, false, '有依赖的 transfer 牌不可点击');
    game.collect(game.allTiles.get(9)!);
    assert.equal(game.allTiles.get(1)!.isClickable, true, '依赖离桌后解锁');
  });
});
