/**
 * 目标旧债跨层保留率 (targetDebtRetention) 测试。
 *
 * 验证：
 * 1. targetDebtRetention 不破坏硬约束（allSuitsClosed、completed）
 * 2. targetDebtRetention=1 保留旧债 >= targetDebtRetention=0（单调性）
 * 3. configuredDebtPersistenceWeight 正确回显
 * 4. debtDurationHistogram 长度 = depthCount，元素非负
 * 5. retainedOldDebtTilesByLayer 长度 = depthCount - 1
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runLayerClosureGen,
  computeDependencyDepth,
  loadTerrainFromFile,
  getAllTiles,
  setLogLevel,
  LogLevel,
} from '../../src/index.js';
import type { LayerClosureInput } from '../../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', 'fixtures', '100075.json');
setLogLevel(LogLevel.Silent);

// 加载地形，算深度，构造 closeRates（中间低 → 产生债务）
const terrain = loadTerrainFromFile(FIXTURE);
const allTiles = getAllTiles(terrain);
const freeTiles = allTiles.filter(t => !t.isConst);
const tileMap = new Map(freeTiles.map(t => [t.id, t]));
const depthMap = computeDependencyDepth(freeTiles, tileMap);
const depthCount = Math.max(...depthMap.values());
// 中间层闭合率低，制造债务；最后一层自动 1.0
const closeRates = Array.from({ length: depthCount - 1 }, (_, i) =>
  i === depthCount - 2 ? 0.7 : 0.35,
);

function run(tdr: number) {
  const input: LayerClosureInput = {
    terrain,
    colorCount: 8,
    dock: 7,
    closeRates,
    targetSuitSpread: 0, // 确定性落色，排除随机干扰
    targetDebtRetention: tdr,
  };
  return runLayerClosureGen(input);
}

describe('目标旧债跨层保留率 targetDebtRetention', () => {
  it('tdr=0 默认行为：完成且花色闭合', () => {
    const r = run(0);
    assert.equal(r.metrics.allSuitsClosed, true);
    assert.equal(r.metrics.configuredDebtPersistenceWeight, 0);
  });

  it('tdr=1 不破坏硬约束（花色闭合）', () => {
    const r = run(1);
    assert.equal(r.metrics.allSuitsClosed, true);
    assert.equal(r.metrics.configuredDebtPersistenceWeight, 1);
  });

  it('tdr=1 保留旧债 tile >= tdr=0（单调性）', () => {
    const r0 = run(0);
    const r1 = run(1);
    assert.ok(
      r1.metrics.totalRetainedOldDebtTiles >= r0.metrics.totalRetainedOldDebtTiles,
      `tdr=1 保留 ${r1.metrics.totalRetainedOldDebtTiles} 应 >= tdr=0 的 ${r0.metrics.totalRetainedOldDebtTiles}`,
    );
    assert.ok(
      r1.metrics.actualDebtRetention >= r0.metrics.actualDebtRetention - 1e-9,
      `tdr=1 保留率 ${r1.metrics.actualDebtRetention} 应 >= tdr=0 的 ${r0.metrics.actualDebtRetention}`,
    );
  });

  it('tdr=0.5 居中：保留量介于 tdr=0 与 tdr=1 之间', () => {
    const r0 = run(0);
    const r05 = run(0.5);
    const r1 = run(1);
    assert.ok(
      r0.metrics.totalRetainedOldDebtTiles <= r05.metrics.totalRetainedOldDebtTiles + 1e-9 &&
      r05.metrics.totalRetainedOldDebtTiles <= r1.metrics.totalRetainedOldDebtTiles + 1e-9,
      `tdr=0.5 保留 ${r05.metrics.totalRetainedOldDebtTiles} 应介于 ${r0.metrics.totalRetainedOldDebtTiles} 与 ${r1.metrics.totalRetainedOldDebtTiles} 之间`,
    );
  });

  it('debtDurationHistogram 长度 = depthCount，元素非负', () => {
    const r = run(0.5);
    const h = r.metrics.debtDurationHistogram;
    assert.equal(h.length, depthCount);
    for (const v of h) assert.ok(v >= 0 && Number.isInteger(v));
  });

  it('retainedOldDebtTilesByLayer 长度 = depthCount - 1', () => {
    const r = run(0.5);
    assert.equal(r.metrics.retainedOldDebtTilesByLayer.length, depthCount - 1);
  });

  it('tdr 不破坏闭合率硬约束（最后一层 actualCloseRate = 1.0）', () => {
    const r = run(1);
    const last = r.metrics.actualCloseRates[r.metrics.actualCloseRates.length - 1];
    assert.ok(last >= 0.999, `最后一层闭合率应为 1.0，实际 ${last}`);
  });
});
