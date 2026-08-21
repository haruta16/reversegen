/**
 * 机制感知失误画像测试：
 * 未揭示问号/翻转与大tile覆盖视为不可见、魔药组 cost 达标必选、失误概率与基础一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfflineGame, OfflineTile } from '../../src/solver/index.js';
import {
  solvePlayerMistakeMechanic,
  solvePlayerMistakeMechanicBatch,
} from '../../src/solver/solver-player-mistake-mechanic.js';

function mk(id: number, color: number, extra?: number): OfflineTile {
  const tile = new OfflineTile(
    { id, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: 0, posY: 0 },
    color,
  );
  if (extra !== undefined) tile.extras.push({ extraEnum: extra, extraParam: '' });
  return tile;
}

test('未揭示问号组视为不可见：无安全组时走 fallback（forcedPick 计数）', () => {
  const build = () => new OfflineGame([
    mk(1, 1, 2), mk(2, 1), mk(3, 1),       // 色1 三连，但 #1 是未揭示问号
    mk(4, 2), mk(5, 2),                    // 色2 只有两张
    mk(6, 3), mk(7, 3),                    // 色3 只有两张
  ], [], { levelResId: 1 });

  const hidden = solvePlayerMistakeMechanic(build(), 7, { mistakeRate: 0 });
  assert.ok(hidden.forcedRandomPickCount >= 1, '问号组被隐藏后无安全组 → forced pick');

  const visible = solvePlayerMistakeMechanic(build(), 7, { mistakeRate: 0, hideUnrevealed: false });
  assert.ok([1, 2, 3].includes(visible.picks[0]), `不隐藏时首步选问号组内牌，实际 ${visible.picks[0]}`);
});

test('未揭示翻转同样视为不可见', () => {
  const build = () => new OfflineGame([
    mk(1, 1, 7), mk(2, 1), mk(3, 1),
    mk(4, 2), mk(5, 2),
  ], [], { levelResId: 1 });
  const hidden = solvePlayerMistakeMechanic(build(), 7, { mistakeRate: 0 });
  assert.ok(hidden.forcedRandomPickCount >= 1, '翻转组被隐藏后无安全组');
});

test('魔药优先：cost ≤ remain 时必选魔药组', () => {
  const build = () => new OfflineGame([
    mk(1, 1301, 31), mk(2, 1301), mk(3, 1301),  // 魔药组
    mk(4, 1), mk(5, 1), mk(6, 1),                // 普通组
  ], [], { levelResId: 1 });

  const priority = solvePlayerMistakeMechanic(build(), 9, { mistakeRate: 0 });
  assert.equal(priority.picks[0], 1, '必选魔药组（组内最小 ID）');

  const off = solvePlayerMistakeMechanic(build(), 9, { mistakeRate: 0, magicBottlePriority: false });
  assert.ok([1, 4].includes(off.picks[0]), '关闭优先后随机选安全组');
});

test('大 tile 覆盖视为不可见：覆盖组不再构成安全组', () => {
  const t1 = new OfflineTile({ id: 1, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: 100, posY: 100 }, 1);
  const t2 = new OfflineTile({ id: 2, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: 200, posY: 100 }, 1);
  const t4 = new OfflineTile({ id: 4, layer: 1, dependencies: [], isConst: false, constElementValue: 0, posX: 100, posY: 100 }, 2);
  const t5 = new OfflineTile({ id: 5, layer: 1, dependencies: [], isConst: false, constElementValue: 0, posX: 200, posY: 100 }, 2);
  const t6 = new OfflineTile({ id: 6, layer: 1, dependencies: [], isConst: false, constElementValue: 0, posX: 300, posY: 100 }, 2);
  const t7 = new OfflineTile({ id: 7, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: 300, posY: 100 }, 3);
  const t8 = new OfflineTile({ id: 8, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: 400, posY: 100 }, 3);
  const game = new OfflineGame([t1, t2, t4, t5, t6, t7, t8], [], {
    levelResId: 1,
    boardSpecialStructures: [{
      id: 9, extraEnum: 51, footprint: { width: 2, height: 2 }, layer: 1,
      posX: 100, posY: 100, dependencies: [1, 2], coveredTileIds: [4, 5, 6], isRemoved: false,
    }],
  });
  const result = solvePlayerMistakeMechanic(game, 11, { mistakeRate: 0 });
  assert.ok(result.forcedRandomPickCount >= 1, '覆盖组被隐藏后无安全组 → forced pick');
});

test('失误概率与基础一致：mistakeRate=1 全随机、确定性重跑', () => {
  const build = () => new OfflineGame(Array.from({ length: 30 }, (_, i) => mk(i + 1, (i % 3) + 1)), [], { levelResId: 1 });
  const allRandom = solvePlayerMistakeMechanic(build(), 3, { mistakeRate: 1 });
  assert.ok(allRandom.picks.length > 0, '全随机仍能跑');

  const a = solvePlayerMistakeMechanic(build(), 5, { mistakeRate: 0.3 });
  const b = solvePlayerMistakeMechanic(build(), 5, { mistakeRate: 0.3 });
  assert.deepEqual(a.picks, b.picks, '同种子同结果');

  const batch = solvePlayerMistakeMechanicBatch(build(), 10, 1, { mistakeRate: 0.1, collectTrace: false });
  assert.equal(batch.wins + batch.losses, 10);
  assert.ok(batch.winRate >= 0 && batch.winRate <= 1);
});
