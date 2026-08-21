/**
 * 跨侧 golden 追踪测试：录制确定性、比对器分歧定位、泡泡指派经 bubble.active 体现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfflineGame, OfflineTile } from '../../src/solver/index.js';
import {
  compareCrossSideTraces,
  recordCrossSideTrace,
  type CrossSideTrace,
} from '../../src/verification/cross-side-trace.js';

function mk(id: number, color: number): OfflineTile {
  return new OfflineTile({ id, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: 0, posY: 0 }, color);
}

function buildGame(): OfflineGame {
  const tiles = Array.from({ length: 30 }, (_, i) => mk(i + 1, (i % 3) + 1));
  return new OfflineGame(tiles, [], { levelResId: 200, mechanicConfig: new Map([[39, 3]]) });
}

test('录制确定性：同一输入两次录制逐位一致（self-check 语义）', () => {
  // 开局帧 tick 已消费两轮泡泡（1~18 被消除），点击剩余可点牌
  const run = () => {
    const game = buildGame();
    const trace = recordCrossSideTrace(game, [19, 20, 21]);
    trace.meta = { levelResId: 200, mechanics: '39:3' };
    return trace;
  };
  const diff = compareCrossSideTraces(run(), run());
  assert.equal(diff.ok, true, diff.message);
});

test('比对器：定位第一处分歧（帧 + 字段路径 + 两侧值）', () => {
  const a = (() => {
    const game = buildGame();
    return recordCrossSideTrace(game, [19, 20, 21]);
  })();
  const b = JSON.parse(JSON.stringify(a)) as CrossSideTrace;
  b.frames[2].dock[0].elementValue = 999;
  const diff = compareCrossSideTraces(a, b);
  assert.equal(diff.ok, false);
  assert.ok(diff.message.includes('frames[2].dock[0].elementValue'), diff.message);
  assert.ok(diff.message.includes('999'), diff.message);
});

test('帧结构：动作数 + 1 帧；开局帧已吸取首轮泡泡（对齐 Unity 步前帧驱动）', () => {
  const game = buildGame();
  const trace = recordCrossSideTrace(game, [19, 20, 21]);
  assert.equal(trace.frames.length, 4, '初始帧 + 每动作一帧');
  // 开局帧 tick 至静止：指派→吸取发生在步1之前（指派不是 Unity 步骤，Steps.Count=1），
  // 角标牌 [1,2,3] 留在 Dock 等玩家配对消耗。
  assert.equal(trace.frames[0].actionCount, 1);
  assert.equal(trace.frames[0].bubble?.rounds, 1);
  assert.equal(trace.frames[0].bubble?.activeRoundCounted, true);
  assert.deepEqual(trace.frames[0].bubble?.active, [1, 2, 3]);
  assert.deepEqual(trace.frames[0].dock.map(t => t.id), [1, 2, 3]);
  assert.deepEqual(trace.frames[0].mechanicSteps, [], '开局帧无增量步骤');
  // 开局吸取是步栈里的第一步，Unity 导出器按 Steps.Skip(0) 会归入首个动作帧
  assert.deepEqual(trace.frames[1].mechanicSteps, [{ type: 'bubble-collect', tileIds: [1, 2, 3] }]);
  assert.equal(trace.frames[1].actionCount, 2);
  assert.deepEqual(trace.frames[1].dock.map(t => t.id), [1, 19, 2, 3], '角标牌留在 Dock，点击牌按花色归组');
  assert.equal(trace.frames[2].actionCount, 3);
  assert.equal(trace.frames[3].actionCount, 4);
  for (const frame of trace.frames) {
    for (const step of frame.mechanicSteps) {
      assert.notEqual(step.type, 'bubble-assign', '泡泡指派不是 Unity 步骤');
    }
  }
  assert.equal(trace.frames[0].bubble?.enabled, true);
});

test('机制步骤序列：魔药清除与泡泡吸取按帧记录', () => {
  const tiles = [
    mk(99, 1, ), mk(1, 1), mk(2, 1),
    mk(3, 2), mk(4, 2), mk(5, 2),
    mk(6, 3), mk(7, 3), mk(8, 3),
    mk(9, 4), mk(10, 4), mk(11, 4),
  ];
  const game = new OfflineGame(tiles, [], { levelResId: 100 });
  game.allTiles.get(99)!.extras.push({ extraEnum: 31, extraParam: '' });
  const trace = recordCrossSideTrace(game, [99, 1, 2]);
  const last = trace.frames[trace.frames.length - 1];
  assert.deepEqual(last.mechanicSteps, [{
    type: 'magic-bottle-clear',
    tileIds: [3, 4, 5, 9, 10, 11, 6, 7, 8],
  }]);
});
