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
  const run = () => {
    const game = buildGame();
    const trace = recordCrossSideTrace(game, [1, 4, 7]);
    trace.meta = { levelResId: 200, mechanics: '39:3' };
    return trace;
  };
  const diff = compareCrossSideTraces(run(), run());
  assert.equal(diff.ok, true, diff.message);
});

test('比对器：定位第一处分歧（帧 + 字段路径 + 两侧值）', () => {
  const a = (() => {
    const game = buildGame();
    return recordCrossSideTrace(game, [1, 4, 7]);
  })();
  const b = JSON.parse(JSON.stringify(a)) as CrossSideTrace;
  b.frames[2].dock[0].elementValue = 999;
  const diff = compareCrossSideTraces(a, b);
  assert.equal(diff.ok, false);
  assert.ok(diff.message.includes('frames[2].dock[0].elementValue'), diff.message);
  assert.ok(diff.message.includes('999'), diff.message);
});

test('帧结构：动作数 + 1 帧；泡泡指派不进 mechanicSteps、经帧状态体现', () => {
  const game = buildGame();
  const trace = recordCrossSideTrace(game, [1, 4, 7]);
  assert.equal(trace.frames.length, 4, '初始帧 + 每动作一帧');
  assert.equal(trace.frames[0].actionCount, 0);
  for (const frame of trace.frames) {
    for (const step of frame.mechanicSteps) {
      assert.notEqual(step.type, 'bubble-assign', '泡泡指派不是 Unity 步骤');
    }
  }
  // 帧记录的是"动作 + 机制级联静息后"的状态（对齐 Unity 导出器等待 busy 结束）；
  // 泡泡轮次计数与吸取步骤在帧中体现。
  assert.ok(trace.frames.some(f => f.bubble && f.bubble.rounds > 0), '泡泡轮次在帧中体现');
  assert.ok(trace.frames.some(f => f.mechanicSteps.some(s => s.type === 'bubble-collect')), '泡泡吸取步骤在帧中体现');
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
