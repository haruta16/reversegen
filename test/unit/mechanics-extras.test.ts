import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfflineGame, OfflineTile } from '../../src/solver/index.js';
import {
  initExtraState,
  applyDecayStep,
  onTileCollected,
  isUnrevealedUnknownTile,
  selectDandelionTargets,
  isDandelionMatch,
  rollGiftBoxEffect,
  giftBoxAvailableEffects,
  selectMagicWandTargets,
  selectRandomTiles,
  giftBoxConvertibleGroups,
  shuffleBoard,
  shuffleBoardSeed,
  extraActionSeed,
} from '../../src/mechanics/extras.js';
import { GIFTBOX_EFFECTS } from '../../src/index.js';

function mk(id: number, color: number, extras: { extraEnum: number; extraParam: string }[] = []) {
  const tile = new OfflineTile({ id, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: 0, posY: 0, extras }, color);
  for (const extra of tile.extras) initExtraState(extra);
  return tile;
}

test('衰减挂件：Init 参数解析与每步衰减（黄金不跳过魔药步）', () => {
  const tiles = [mk(1, 1, [{ extraEnum: 4, extraParam: '04' }]), mk(2, 1), mk(3, 1), mk(4, 2), mk(5, 2), mk(6, 2)];
  const game = new OfflineGame(tiles, [], { levelId: 1, levelResId: 1 });
  const golden = game.allTiles.get(1)!.extras[0];
  assert.equal(golden.countdown, 4, 'param[1] = 4');
  assert.equal(golden.isValidCollect, false);
  game.collect(game.allTiles.get(2)!);
  assert.equal(golden.countdown, 3, '每步衰减 1');
  // 收集时有效收集：Value>0 → isValidCollect=true, Value=0
  game.collect(game.allTiles.get(1)!);
  assert.equal(golden.isValidCollect, true);
  assert.equal(golden.countdown, 0);
});

test('衰减挂件：日历/复活节跳过魔药清除步骤', () => {
  const tiles = [
    mk(1, 1, [{ extraEnum: 8, extraParam: '04' }]), // 复活节
    mk(2, 1, [{ extraEnum: 6, extraParam: '04' }]), // 日历
    mk(3, 1), mk(4, 2), mk(5, 2), mk(6, 2),
  ];
  const game = new OfflineGame(tiles, [], { levelId: 1, levelResId: 1 });
  const easter = game.allTiles.get(1)!.extras[0];
  const calendar = game.allTiles.get(2)!.extras[0];
  applyDecayStep(game, 'magic-bottle-clear');
  assert.equal(easter.countdown, 4, '魔药步不衰减');
  assert.equal(calendar.countdown, 4, '魔药步不衰减');
  applyDecayStep(game, 'collect');
  assert.equal(easter.countdown, 3, '普通步衰减');
  assert.equal(calendar.countdown, 3);
});

test('揭示挂件：收集 isDone；未揭示问号判定', () => {
  const tiles = [mk(1, 1, [{ extraEnum: 2, extraParam: '' }]), mk(2, 1), mk(3, 1)];
  const game = new OfflineGame(tiles, []);
  const unknown = game.allTiles.get(1)!;
  assert.equal(isUnrevealedUnknownTile(unknown), true);
  game.collect(unknown);
  assert.equal(unknown.extras[0].isDone, true);
});

test('订单挂件：收集即 consumed', () => {
  const tiles = [mk(1, 1, [{ extraEnum: 38, extraParam: '' }]), mk(2, 1), mk(3, 1)];
  const game = new OfflineGame(tiles, []);
  game.collect(game.allTiles.get(1)!);
  assert.equal(game.allTiles.get(1)!.extras[0].isConsumed, true);
});

test('蒲公英扩散目标：白名单 + 派生种子 golden', () => {
  const tiles = Array.from({ length: 18 }, (_, i) => mk(i + 1, (i % 3) + 1));
  const game = new OfflineGame(tiles, [], { levelId: 9, levelResId: 300 });
  const targets = selectDandelionTargets(game, extraActionSeed(game, 36));
  assert.deepEqual(targets.map(t => t.id), [1, 7, 10], 'golden 锁定（种子派生）');
  // 白名单：带泡泡挂件的 tile 不可扩散（39 不在白名单）
  const g2 = new OfflineGame([
    mk(1, 1, [{ extraEnum: 39, extraParam: '' }]), mk(2, 1), mk(3, 1),
    mk(4, 2), mk(5, 2), mk(6, 2), mk(7, 3), mk(8, 3), mk(9, 3),
  ], [], { levelId: 9, levelResId: 300 });
  for (const target of selectDandelionTargets(g2, 123)) {
    assert.ok(!target.extras.some(e => e.extraEnum === 39), '泡泡牌不可扩散');
  }
});

test('蒲公英三消判定：至少 3 张蒲公英参与', () => {
  const matched = [mk(1, 1, [{ extraEnum: 36, extraParam: '' }]), mk(2, 1, [{ extraEnum: 36, extraParam: '' }]), mk(3, 1, [{ extraEnum: 36, extraParam: '' }])];
  assert.equal(isDandelionMatch(matched), true);
  assert.equal(isDandelionMatch(matched.slice(0, 2)), false);
});

test('礼盒效果：可用性过滤与加权滚动 golden', () => {
  const tiles = Array.from({ length: 18 }, (_, i) => mk(i + 1, (i % 3) + 1));
  const game = new OfflineGame(tiles, [], { levelId: 9, levelResId: 300 });
  // Dock 空：DockAllMagicWand 不可用；无问号：RevealUnknown 不可用；全可点击：ApplyFlip 不可用
  assert.deepEqual(giftBoxAvailableEffects(game), [
    GIFTBOX_EFFECTS.AddDockSlot, GIFTBOX_EFFECTS.Shuffle, GIFTBOX_EFFECTS.MagicWand,
    GIFTBOX_EFFECTS.ApplyMagicBottle, GIFTBOX_EFFECTS.ApplyUnknown,
  ]);
  assert.equal(rollGiftBoxEffect(game, extraActionSeed(game, 3700)), GIFTBOX_EFFECTS.ApplyUnknown, 'golden 滚动');
  // 确定性
  assert.equal(rollGiftBoxEffect(game, extraActionSeed(game, 3700)), GIFTBOX_EFFECTS.ApplyUnknown);
});

test('魔法棒目标：Dock 最多花色定向收集 golden', () => {
  const tiles = [mk(1, 1), mk(2, 1), mk(3, 1), mk(4, 1), mk(5, 2), mk(6, 2), mk(7, 2), mk(8, 3), mk(9, 3), mk(10, 3)];
  const game = new OfflineGame(tiles, []);
  game.collect(game.allTiles.get(1)!);
  game.collect(game.allTiles.get(5)!);
  // Dock: 色1×1（idx0）、色2×1（idx1）→ 同频取首次出现 → 色1，补 2 张 [2,3]
  assert.deepEqual(selectMagicWandTargets(game).map(t => t.id), [2, 3]);
});

test('礼盒随机选牌：GetRandomCount + 稳定排序 golden 与确定性', () => {
  const tiles = Array.from({ length: 12 }, (_, i) => mk(i + 1, (i % 4) + 1));
  const game = new OfflineGame(tiles, [], { levelId: 2, levelResId: 2 });
  const pick = selectRandomTiles(game.deskTiles, 3, 4, extraActionSeed(game, 3701));
  assert.equal(pick.length, 3);
  const pick2 = selectRandomTiles(game.deskTiles, 3, 4, extraActionSeed(game, 3701));
  assert.deepEqual(pick.map(t => t.id), pick2.map(t => t.id), '同种子同结果');
});

test('礼盒转化组：无挂件牌按花色取最低 cost 三牌组', () => {
  // 12 张 2 色，无依赖：每组 cost = 3，按最小 ID 排序
  const tiles = Array.from({ length: 12 }, (_, i) => mk(i + 1, (i % 2) + 1));
  const game = new OfflineGame(tiles, []);
  const groups = giftBoxConvertibleGroups(game);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].map(t => t.id), [1, 3, 5], '色1 最低 ID 三牌组');
  assert.deepEqual(groups[1].map(t => t.id), [2, 4, 6]);
});

test('洗牌（依赖优先）：花色多重集保持 + 依赖少者优先 + 确定性 golden', () => {
  const build = () => new OfflineGame([
    mk(1, 1), mk(2, 1), mk(3, 2), mk(4, 2), mk(5, 3), mk(6, 3),
    new OfflineTile({ id: 7, layer: 0, dependencies: [1], isConst: false, constElementValue: 0, posX: 0, posY: 0 }, 1),
    new OfflineTile({ id: 8, layer: 0, dependencies: [2], isConst: false, constElementValue: 0, posX: 0, posY: 0 }, 2),
    new OfflineTile({ id: 9, layer: 0, dependencies: [3], isConst: false, constElementValue: 0, posX: 0, posY: 0 }, 3),
    new OfflineTile({ id: 10, layer: 0, dependencies: [4], isConst: false, constElementValue: 0, posX: 0, posY: 0 }, 1),
    new OfflineTile({ id: 11, layer: 0, dependencies: [5], isConst: false, constElementValue: 0, posX: 0, posY: 0 }, 2),
    new OfflineTile({ id: 12, layer: 0, dependencies: [6], isConst: false, constElementValue: 0, posX: 0, posY: 0 }, 3),
  ], []);
  const game = build();
  const before = game.deskTiles.map(t => [t.id, t.elementValue]);
  shuffleBoard(game, shuffleBoardSeed(game));
  const after = game.deskTiles.map(t => [t.id, t.elementValue]);
  const multiset = (arr: number[][]) => JSON.stringify(arr.map(x => x[1]).sort((a, b) => a - b));
  assert.equal(multiset(before), multiset(after), '花色多重集不变');
  assert.deepEqual(after, [[1, 2], [2, 2], [3, 1], [4, 1], [5, 1], [6, 3], [7, 3], [8, 1], [9, 2], [10, 2], [11, 3], [12, 3]], 'golden 洗牌结果');
  // 确定性重跑
  const game2 = build();
  shuffleBoard(game2, shuffleBoardSeed(game2));
  assert.deepEqual(game2.deskTiles.map(t => [t.id, t.elementValue]), after);
});

test('礼盒端到端：三消触发 → mechanicLog 含礼盒步骤（确定性重跑）', () => {
  const build = () => {
    const tiles = [
      mk(1, 1, [{ extraEnum: 37, extraParam: '' }]),
      mk(2, 1), mk(3, 1),
      ...Array.from({ length: 15 }, (_, i) => mk(4 + i, (i % 3) + 2)),
    ];
    return new OfflineGame(tiles, [], { levelId: 3, levelResId: 3 });
  };
  const run = () => {
    const game = build();
    for (const id of [1, 2, 3]) game.collect(game.allTiles.get(id)!);
    return JSON.stringify(game.mechanicLog);
  };
  const log = JSON.parse(run());
  assert.ok(log.length >= 1, '礼盒触发至少一个步骤');
  assert.equal(run(), JSON.stringify(log), '确定性重跑');
});
