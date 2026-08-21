/**
 * 可读跑关日志测试：动作 → 消除组/机制步骤/大 tile 移除逐行可读、状态判定正确。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfflineGame, OfflineTile } from '../../src/solver/index.js';
import { runSequenceLog } from '../../src/verification/readable-run.js';

function mk(id: number, color: number): OfflineTile {
  return new OfflineTile({ id, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: 0, posY: 0 }, color);
}

test('可读日志：点击/消除组/泡泡级联/结束判定逐行呈现', () => {
  const tiles = Array.from({ length: 30 }, (_, i) => mk(i + 1, (i % 3) + 1));
  const game = new OfflineGame(tiles, [], { levelResId: 200, mechanicConfig: new Map([[39, 3]]) });
  const result = runSequenceLog(game, [1, 4, 7]);
  assert.equal(result.win, false, '未收完');
  assert.equal(result.dead, false);
  assert.ok(result.lines[0].startsWith('初始: 桌面 30 张'), result.lines[0]);
  assert.ok(result.lines.some(l => l.includes('步1 点击 #1(色1)')), result.lines.join('\n'));
  assert.ok(result.lines.some(l => l.includes('消除 #1,#4,#7')), result.lines.join('\n'));
  assert.ok(result.lines.some(l => l.includes('泡泡指派')), result.lines.join('\n'));
  assert.ok(result.lines.some(l => l.includes('泡泡吸取')), result.lines.join('\n'));
  assert.ok(result.lines.some(l => l.includes('魔法棒收集')), result.lines.join('\n'));
  assert.ok(result.lines.at(-1)!.includes('—— 结束: 桌面'), result.lines.at(-1));
});

test('可读日志：胜利判定与不可点击序列终止提示', () => {
  const tiles = [mk(1, 1), mk(2, 1), mk(3, 1)];
  const game = new OfflineGame(tiles, []);
  const result = runSequenceLog(game, [1, 2, 3]);
  assert.equal(result.win, true, '三张同色收完即胜');
  assert.ok(result.lines.at(-1)!.includes('✅ 通关'), result.lines.at(-1));

  const blocked = new OfflineGame([mk(1, 1), mk(2, 1), mk(3, 1)], []);
  const r2 = runSequenceLog(blocked, [3, 3]); // 第二张不可点击（3 已点击过且未成组）
  assert.ok(r2.lines.some(l => l.includes('⚠')), r2.lines.join('\n'));
});

test('可读日志：大 tile 结构移除成行', () => {
  // 直接构造带结构的对局（颜色/坐标与 board-special.test 同款）
  const t1 = new OfflineTile({ id: 1, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: 100, posY: 100 }, 1);
  const t2 = new OfflineTile({ id: 2, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: 200, posY: 100 }, 1);
  const t3 = new OfflineTile({ id: 3, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: 300, posY: 100 }, 1);
  const t4 = new OfflineTile({ id: 4, layer: 1, dependencies: [], isConst: false, constElementValue: 0, posX: 100, posY: 100 }, 2);
  const t5 = new OfflineTile({ id: 5, layer: 1, dependencies: [], isConst: false, constElementValue: 0, posX: 200, posY: 100 }, 2);
  const t6 = new OfflineTile({ id: 6, layer: 1, dependencies: [], isConst: false, constElementValue: 0, posX: 300, posY: 100 }, 2);
  const game = new OfflineGame([t1, t2, t3, t4, t5, t6], [], {
    levelResId: 1,
    boardSpecialStructures: [{
      id: 9, extraEnum: 51, footprint: { width: 2, height: 2 }, layer: 1,
      posX: 100, posY: 100, dependencies: [1, 2], coveredTileIds: [4, 5, 6], isRemoved: false,
    }],
  });
  const result = runSequenceLog(game, [1, 2, 3]);
  assert.ok(result.lines.some(l => l.includes('大型地形 #9 移除')), result.lines.join('\n'));
});
