import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfflineGame, OfflineTile, TileFlag } from '../../src/solver/index.js';
import {
  selectMagicBottleTargets,
  magicBottleOnMatch,
  selectBubbleAssignTargets,
} from '../../src/mechanics/engine.js';
import { initExtraState, giftBoxAvailableEffects, dockDirectedMagicPlan } from '../../src/mechanics/extras.js';
import { magicBottleShuffleSeed } from '../../src/mechanics/seed.js';
import { GIFTBOX_EFFECTS } from '../../src/mechanics/registry.js';

function mk(id: number, color: number, extras: { extraEnum: number; extraParam: string }[] = []) {
  const tile = new OfflineTile({ id, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: 0, posY: 0, extras }, color);
  for (const extra of tile.extras) initExtraState(extra);
  return tile;
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

test('泡泡全流程：指派→吸取→Dock定向魔法链→下一批（golden 级联，对齐 Unity 逐花色 MagicStep）', () => {
  // 30 张 3 色（id i → 色 (i-1)%3+1），泡泡配置 39:3。
  // 完成色1 的 1,4,7 三消后级联：
  //  batch1 指派 [10,2,3] → 吸取 → 逐花色 MagicStep 清 Dock 三消（每色一步，只收集 Desk 牌）
  //  batch2 指派 [19,11,12] → 吸取 → 同上
  //  batch3 因 CanAssign 边界（3+1 < 9/3）终止，剩 9 张。
  const tiles = Array.from({ length: 30 }, (_, i) => mk(i + 1, (i % 3) + 1));
  const game = new OfflineGame(tiles, [], { levelResId: 200, mechanicConfig: new Map([[39, 3]]) });
  for (const id of [1, 4, 7]) game.collect(game.allTiles.get(id)!);
  assert.deepEqual(game.mechanicLog, [
    { type: 'bubble-assign', tileIds: [10, 2, 3], stepIndex: 4 },
    { type: 'bubble-collect', tileIds: [2, 3, 10], stepIndex: 5 },
    { type: 'magic-step', tileIds: [5, 8], stepIndex: 6 },
    { type: 'magic-step', tileIds: [6, 9], stepIndex: 7 },
    { type: 'magic-step', tileIds: [13, 16], stepIndex: 8 },
    { type: 'bubble-assign', tileIds: [19, 11, 12], stepIndex: 9 },
    { type: 'bubble-collect', tileIds: [11, 12, 19], stepIndex: 10 },
    { type: 'magic-step', tileIds: [14, 17], stepIndex: 11 },
    { type: 'magic-step', tileIds: [15, 18], stepIndex: 12 },
    { type: 'magic-step', tileIds: [22, 25], stepIndex: 13 },
  ]);
  assert.equal(game.mechanics.bubble.completedCollectRounds, 2);
  assert.equal(game.deskTiles.length, 9);
  assert.equal(game.dockTiles.length, 0);
});

test('泡泡吸取：照常结算 Dock 三消 + 收集钩子（对齐 BubbleCollectStep.Apply）', () => {
  const tiles = [
    mk(1, 1), mk(2, 1), mk(4, 1, [{ extraEnum: 2, extraParam: '' }]),
    mk(5, 2), mk(6, 2), mk(7, 2),
  ];
  const game = new OfflineGame(tiles, [], { levelResId: 5 });
  game.applyMechanicStep({ type: 'bubble-assign', tileIds: [1, 2, 4] });
  game.applyMechanicStep({ type: 'bubble-collect', tileIds: [1, 2, 4] });
  assert.equal(game.dockTiles.length, 0, '同色三张照常三消');
  for (const id of [1, 2, 4]) assert.ok(game.allTiles.get(id)!.hasFlag(TileFlag.Destroyed), `tile ${id} 已消除`);
  assert.equal(game.allTiles.get(4)!.extras[0].isDone, true, '收集钩子揭示问号');
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
  const plan = dockDirectedMagicPlan(game);
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

test('礼盒 Win 态守卫：胜局不触发效果（对齐 battleState==Win 提前返回）', () => {
  const tiles = [mk(1, 1, [{ extraEnum: 37, extraParam: '' }]), mk(2, 1), mk(3, 1)];
  const game = new OfflineGame(tiles, [], { levelResId: 3 });
  for (const id of [1, 2, 3]) game.collect(game.allTiles.get(id)!);
  assert.equal(game.mechanicLog.length, 0, '胜局礼盒不触发');
});

test('礼盒效果开关：未开放效果不参与可用性与滚动（对齐 IsEffectOpen）', () => {
  const tiles = Array.from({ length: 18 }, (_, i) => mk(i + 1, (i % 3) + 1));
  const game = new OfflineGame(tiles, [], {
    levelResId: 300,
    giftboxOpenEffects: new Set([GIFTBOX_EFFECTS.Shuffle]),
  });
  assert.deepEqual(giftBoxAvailableEffects(game), [GIFTBOX_EFFECTS.Shuffle]);
  // clone 保留开关配置
  assert.deepEqual(giftBoxAvailableEffects(game.clone()), [GIFTBOX_EFFECTS.Shuffle]);
});

test('机制步骤衰减：仅 AppendStep 类步骤触发，计划类效果不触发', () => {
  const tiles = [mk(1, 1, [{ extraEnum: 4, extraParam: '04' }]), mk(2, 1), mk(3, 1), mk(4, 2), mk(5, 2), mk(6, 2)];
  const game = new OfflineGame(tiles, [], { levelResId: 1 });
  const golden = game.allTiles.get(1)!.extras[0];
  game.applyMechanicStep({ type: 'giftbox-add-dock-slot' });
  assert.equal(golden.countdown, 4, '计划类效果（加槽）不触发衰减');
  game.applyMechanicStep({ type: 'magic-step', tileIds: [] });
  assert.equal(golden.countdown, 3, 'MagicStep 触发衰减');
});

test('机制步骤衰减用旧可点击快照：本步被揭开的牌当步不衰减', () => {
  const golden = new OfflineTile(
    { id: 1, layer: 0, dependencies: [3], isConst: false, constElementValue: 0, posX: 0, posY: 0, extras: [{ extraEnum: 4, extraParam: '04' }] },
    1,
  );
  initExtraState(golden.extras[0]);
  const game = new OfflineGame([golden, mk(2, 1), mk(3, 1), mk(4, 2), mk(5, 2), mk(6, 2)], [], { levelResId: 1 });
  game.applyMechanicStep({ type: 'magic-step', tileIds: [3] });
  assert.equal(game.allTiles.get(1)!.isClickable, true, '本步已被揭开');
  assert.equal(golden.extras[0].countdown, 4, '旧可点击快照：当步不衰减');
  game.applyMechanicStep({ type: 'magic-step', tileIds: [] });
  assert.equal(golden.extras[0].countdown, 3, '下一步才衰减');
});

test('礼盒加槽后死亡阈值与剩余槽位跟随 maxSlotCount（对齐 Dock.IsMax）', () => {
  // 7 种不同花色 + 3 张重复花色，避免三消干扰
  const tiles = Array.from({ length: 10 }, (_, i) => mk(i + 1, i < 7 ? i + 1 : i - 6));
  const game = new OfflineGame(tiles, [], { levelResId: 1 });
  game.applyMechanicStep({ type: 'giftbox-add-dock-slot' });
  assert.equal(game.maxSlotCount, 8, '加槽后上限 8');
  for (const id of [1, 2, 3, 4, 5, 6, 7]) game.collect(game.allTiles.get(id)!);
  assert.equal(game.dockTiles.length, 7);
  assert.equal(game.isDead, false, '7 张未死（上限 8）');
  assert.equal(game.remainSlotCount, 1);
  game.collect(game.allTiles.get(8)!); // 色1 第 2 张，不成三消
  assert.equal(game.dockTiles.length, 8);
  assert.equal(game.isDead, true, '8 张死亡');
  assert.equal(game.remainSlotCount, 0);
});

test('clone 保留 actionCount 与 dockSlotBonus（机制种子与死亡阈值不漂移）', () => {
  const tiles = Array.from({ length: 12 }, (_, i) => mk(i + 1, (i % 4) + 1));
  const game = new OfflineGame(tiles, [], { levelResId: 7 });
  game.applyMechanicStep({ type: 'giftbox-add-dock-slot' });
  game.applyMechanicStep({ type: 'magic-step', tileIds: [] });
  assert.equal(game.actionCount, 2);
  const copy = game.clone();
  assert.equal(copy.actionCount, game.actionCount, 'actionCount 保留');
  assert.equal(copy.maxSlotCount, game.maxSlotCount, '槽位加成保留');
  assert.equal(copy.buildStateKey(), game.buildStateKey());
});

test('状态键：Dock 顺序/牌身份进键，actionCount 仅在步数敏感机制存在时进键', () => {
  const build = (seq: number[]) => {
    const tiles = [mk(1, 1), mk(2, 1), mk(3, 1), mk(4, 2), mk(5, 3), mk(6, 4)];
    const g = new OfflineGame(tiles, [], { levelResId: 1 });
    for (const id of seq) g.collect(g.allTiles.get(id)!);
    return g;
  };
  // 相同 desk、相同花色计数、但 Dock 顺序不同（matchedTiles[0] 触发不同）→ 键必须不同
  const a = build([1, 4, 2]); // dock 首现序 [色1,色2] → [1,2,4]
  const b = build([4, 1, 2]); // dock 首现序 [色2,色1] → [4,1,2]
  assert.notEqual(a.buildStateKey(), b.buildStateKey(), 'Dock 顺序不同 → 键不同');

  // 存在礼盒牌：actionCount 进键（步数改变派生种子）
  const withGift = new OfflineGame(
    [mk(1, 1, [{ extraEnum: 37, extraParam: '' }]), mk(2, 1), mk(3, 1), mk(4, 2), mk(5, 2), mk(6, 2)],
    [], { levelResId: 1 },
  );
  const k0 = withGift.buildStateKey();
  withGift.applyMechanicStep({ type: 'magic-step', tileIds: [] }); // 棋盘不变、步数 +1
  assert.notEqual(withGift.buildStateKey(), k0, '步数敏感机制存在时 actionCount 进键');

  // 无步数敏感机制：actionCount 不进键（不稀释 DFS 记忆化）
  const plain = new OfflineGame([mk(1, 1), mk(2, 1), mk(3, 1), mk(4, 2), mk(5, 2), mk(6, 2)], []);
  const p0 = plain.buildStateKey();
  plain.applyMechanicStep({ type: 'magic-step', tileIds: [] });
  assert.equal(plain.buildStateKey(), p0, '无步数敏感机制时键不含 actionCount');
});
