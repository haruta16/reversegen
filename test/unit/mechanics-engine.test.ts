import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfflineGame, OfflineTile } from '../../src/solver/index.js';
import {
  selectMagicBottleTargets,
  magicBottleOnMatch,
  selectBubbleAssignTargets,
  dockMagicPlan,
} from '../../src/mechanics/engine.js';
import { magicBottleShuffleSeed } from '../../src/mechanics/seed.js';

function mk(id: number, color: number, extras: { extraEnum: number; extraParam: string }[] = []) {
  return new OfflineTile({ id, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: 0, posY: 0, extras }, color);
}

test('魔药洗牌种子：int32 unchecked 语义 golden', () => {
  // 手算基线：5*397=1985; 1985^100=1957; (1957*397)^1^... 全链 int32 截断
  assert.equal(magicBottleShuffleSeed(100, 0, [1, 2, 3]), 1568749412);
  // 确定性
  assert.equal(magicBottleShuffleSeed(100, 0, [1, 2, 3]), magicBottleShuffleSeed(100, 0, [1, 2, 3]));
});

test('魔药索敌：交错取组 golden（对齐 GetTiles2Clear）', () => {
  // 12 张牌 4 色，魔药挂 99（色1）。完成魔药三消后：
  // 桌面剩色 2(3,4,5)/色 3(6,7,8)/色 4(9,10,11)，全部为 Desk 独有花色，
  // 派生种子洗牌后花色顺序为 [4,3,2] → 清除名单 [9,10,11,6,7,8,3,4,5]。
  const tiles = [
    mk(99, 1, [{ extraEnum: 31, extraParam: '' }]),
    mk(1, 1), mk(2, 1),
    mk(3, 2), mk(4, 2), mk(5, 2),
    mk(6, 3), mk(7, 3), mk(8, 3),
    mk(9, 4), mk(10, 4), mk(11, 4),
  ];
  const game = new OfflineGame(tiles, [], { levelResId: 100 });
  for (const id of [99, 1, 2]) game.collect(game.allTiles.get(id)!);
  assert.deepEqual(game.mechanicLog, [{
    type: 'magic-bottle-clear',
    tileIds: [3, 4, 5, 9, 10, 11, 6, 7, 8],
    stepIndex: 3,
  }]);
  assert.equal(game.isWin, true, '魔药清场后应胜利');
});

test('魔药触发语义：仅 matchedTiles[0] 携带魔药才触发', () => {
  const tiles = [
    mk(1, 1), mk(2, 1, [{ extraEnum: 31, extraParam: '' }]), mk(3, 1),
    mk(4, 2), mk(5, 2), mk(6, 2),
    mk(7, 3), mk(8, 3), mk(9, 3),
  ];
  const game = new OfflineGame(tiles, [], { levelResId: 2 });
  // 魔药在第 2 张：collect 顺序 1,2,3 → matched[0] 是 tile1（无魔药）→ 不触发
  for (const id of [1, 2, 3]) game.collect(game.allTiles.get(id)!);
  assert.equal(game.mechanicLog.length, 0, '非首张魔药不触发');
});

test('泡泡全流程：指派→吸取→Dock魔法→下一批（golden 级联）', () => {
  // 30 张 3 色（id i → 色 (i-1)%3+1），泡泡配置 39:3。
  // 完成色1 的 1,4,7 三消后级联：
  //  batch1 指派 [10,2,3] → 吸取 → 魔法清 [2,5,8,3,6,9,10,13,16]
  //  batch2 指派 [19,11,12] → 吸取 → 魔法清 [11,14,17,12,15,18,19,22,25]
  //  batch3 因 CanAssign 边界（3+1 < 9/3）终止，剩 9 张。
  const tiles = Array.from({ length: 30 }, (_, i) => mk(i + 1, (i % 3) + 1));
  const game = new OfflineGame(tiles, [], { levelResId: 200, mechanicConfig: new Map([[39, 3]]) });
  for (const id of [1, 4, 7]) game.collect(game.allTiles.get(id)!);
  assert.deepEqual(game.mechanicLog, [
    { type: 'bubble-assign', tileIds: [10, 2, 3], stepIndex: 4 },
    { type: 'bubble-collect', tileIds: [2, 3, 10], stepIndex: 5 },
    { type: 'dock-magic-clear', tileIds: [2, 5, 8, 3, 6, 9, 10, 13, 16], stepIndex: 6 },
    { type: 'bubble-assign', tileIds: [19, 11, 12], stepIndex: 7 },
    { type: 'bubble-collect', tileIds: [11, 12, 19], stepIndex: 8 },
    { type: 'dock-magic-clear', tileIds: [11, 14, 17, 12, 15, 18, 19, 22, 25], stepIndex: 9 },
  ]);
  assert.equal(game.mechanics.bubble.completedCollectRounds, 2);
  assert.equal(game.deskTiles.length, 9);
  assert.equal(game.dockTiles.length, 0);
});

test('泡泡确定性：随机收集数模式（39:0）同状态同结果', () => {
  const run = () => {
    const tiles = Array.from({ length: 30 }, (_, i) => mk(i + 1, (i % 3) + 1));
    const game = new OfflineGame(tiles, [], { levelResId: 200, mechanicConfig: new Map([[39, 0]]) });
    for (const id of [1, 4, 7]) game.collect(game.allTiles.get(id)!);
    return JSON.stringify(game.mechanicLog);
  };
  assert.equal(run(), run(), '派生种子随机必须逐位可复现');
});

test('Dock 魔法计划：按 Dock 出现顺序补齐 Desk 牌', () => {
  // Dock: 色2、色1 各 1 张；色1 桌面上有 2 张（无挂件优先）→ 计划覆盖
  const tiles = [
    mk(1, 1), mk(2, 1), mk(3, 1), mk(4, 2), mk(5, 2), mk(6, 2),
    mk(7, 3), mk(8, 3), mk(9, 3),
  ];
  const game = new OfflineGame(tiles, []);
  game.collect(game.allTiles.get(2)!);  // 色1 进 Dock
  game.collect(game.allTiles.get(4)!);  // 色2 进 Dock
  const plan = dockMagicPlan(game);
  assert.deepEqual(plan.map(p => [p.elementValue, p.dockCount, p.deskTiles.map(t => t.id)]), [
    [1, 1, [1, 3]],  // 色1 先出现（Dock 索引 0），补桌面的 1、3
    [2, 1, [5, 6]],  // 色2 补 5、6
  ]);
});

test('泡泡指派选择器：重复花色优先，每色只取首张', () => {
  const tiles = [
    mk(1, 1), mk(2, 1), mk(3, 1), mk(4, 2), mk(5, 2), mk(6, 2),
    mk(7, 3), mk(8, 3), mk(9, 3), mk(10, 4), mk(11, 4), mk(12, 4),
    mk(13, 5), mk(14, 6),
  ];
  const game = new OfflineGame(tiles, []);
  const targets = selectBubbleAssignTargets(game, 3);
  // 花色 1-4 各 ≥2 张（重复优先），5/6 单张靠后；按 cost/element/ID 排序后
  // 选每色首张：色1→1、色2→4、色3→7
  assert.deepEqual(targets.map(t => t.id), [1, 4, 7]);
});

test('clone 保留机制状态，状态键包含机制指纹', () => {
  const tiles = Array.from({ length: 30 }, (_, i) => mk(i + 1, (i % 3) + 1));
  const game = new OfflineGame(tiles, [], { levelResId: 200, mechanicConfig: new Map([[39, 3]]) });
  for (const id of [1, 4, 7]) game.collect(game.allTiles.get(id)!);
  const copy = game.clone();
  assert.equal(copy.mechanics.bubble.completedCollectRounds, game.mechanics.bubble.completedCollectRounds);
  assert.deepEqual([...copy.mechanics.bubble.activeBubbleTileIds], [...game.mechanics.bubble.activeBubbleTileIds]);
  assert.equal(copy.buildStateKey(), game.buildStateKey());
  // 泡泡角标牌与普通牌状态键不同
  const plain = new OfflineGame(tiles, []);
  assert.notEqual(game.buildStateKey(), plain.buildStateKey());
});
