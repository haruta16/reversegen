/**
 * dagT 模板族测试 —— 移植正确性的 golden 锚。
 *
 * 锚定参考实现 dag_geometry.py 的结论：
 *  - 12t3l 最小族 24 变体：E=10、四色闭包全 = 8；
 *  - minimal_y（l=3 定理最优）：边数表 y=4..12 → 10 11 13 14 15 16 21 22 23；
 *  - minimal_y_deep（l≥4 塔式族）：l=4 → y=4..6: 9 10 11；l≥5 同；
 *  - 数学存在性前提：n≥4、层数 ≥3。
 * 另用项目内 solveDFS 对规范 12t3l 模板复核「纯玩法不可通关」。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDagTVariants,
  canonicalVariant,
  minimal12tVariants,
  minimalEdgeCount3L,
  minimalYDeepVariant,
  minimalYVariant,
} from '../../src/deadlock/family.js';
import { colorClosures, isGuaranteedDead } from '../../src/deadlock/closures.js';
import type { DagTVariant } from '../../src/deadlock/types.js';
import { solveDFS } from '../../src/solver/solver-dfs.js';
import { OfflineGame } from '../../src/solver/offline-game.js';
import { OfflineTile } from '../../src/solver/types.js';
import { LogLevel, setLogLevel } from '../../src/index.js';

setLogLevel(LogLevel.Silent);

/** 模板自身（全部节点为所选集合）的逐色闭包。 */
function templateClosures(variant: DagTVariant): Map<number, number> {
  const depsOf = new Map<number, number[]>();
  const colorOf = new Map<number, number>();
  for (const n of variant.nodes) {
    depsOf.set(n.id, [...n.deps]);
    colorOf.set(n.id, n.color);
  }
  return colorClosures({
    chosenIds: new Set(variant.nodes.map(n => n.id)),
    depsOf,
    colorOf,
  });
}

function assertDead(variant: DagTVariant): void {
  const closures = templateClosures(variant);
  assert.ok(isGuaranteedDead(closures), `${variant.id} 闭包应全 ≥8: ${[...closures.values()]}`);
}

test('12t3l：24 变体全部 E=10、逐色闭包全 = 8', () => {
  const variants = minimal12tVariants();
  assert.equal(variants.length, 24);
  const ids = new Set(variants.map(v => v.id));
  assert.equal(ids.size, 24, '变体 id 应互不相同');
  for (const v of variants) {
    assert.equal(v.tileCount, 12);
    assert.equal(v.layerLimit, 3);
    assert.equal(v.edges, 10, `${v.id} 边数应为 10`);
    const closures = templateClosures(v);
    assert.deepEqual([...closures.values()].sort((a, b) => a - b), [8, 8, 8, 8], `${v.id} 闭包应全 = 8`);
  }
});

test('canonicalVariant(12,3) 为规范变体 12t3l-h0-a0-p0', () => {
  const canonical = canonicalVariant(12, 3);
  assert.equal(canonical.id, '12t3l-h0-a0-p0');
  assertDead(canonical);
});

test('minimal_y：l=3 任意 y≥4，边数与定理表一致、闭包 ≥8', () => {
  const expected: Record<number, number> = {
    4: 10, 5: 11, 6: 13, 7: 14, 8: 15, 9: 16,
    10: 21, 11: 22, 12: 23, 13: 24, 14: 25,
  };
  for (const [yStr, edges] of Object.entries(expected)) {
    const y = Number(yStr);
    const variant = minimalYVariant(y);
    assert.equal(variant.tileCount, 3 * y);
    assert.equal(variant.layerLimit, 3);
    assert.equal(variant.edges, edges, `y=${y} 边数`);
    assert.equal(minimalEdgeCount3L(y), edges, `y=${y} 闭式边数`);
    assertDead(variant);
    // 每色恰 3 张
    const colorCounts = new Map<number, number>();
    for (const n of variant.nodes) colorCounts.set(n.color, (colorCounts.get(n.color) ?? 0) + 1);
    assert.deepEqual([...colorCounts.values()].sort((a, b) => a - b),
      new Array(y).fill(3), `y=${y} 每色应恰 3 张`);
  }
});

test('minimal_y_deep：l=4 与 l≥5 塔式族，边数与表一致、闭包 ≥8', () => {
  const expected: Record<number, Record<number, number>> = {
    4: { 4: 9, 5: 10, 6: 11 },
    5: { 4: 9, 5: 10, 6: 11 },
  };
  for (const [layersStr, table] of Object.entries(expected)) {
    const layers = Number(layersStr);
    for (const [yStr, edges] of Object.entries(table)) {
      const y = Number(yStr);
      const variant = minimalYDeepVariant(y, layers);
      assert.equal(variant.tileCount, 3 * y);
      assert.equal(variant.layerLimit, layers);
      assert.equal(variant.edges, edges, `y=${y},l=${layers} 边数`);
      assertDead(variant);
    }
  }
});

test('参数校验：n<4、tileCount 非 3 的倍数、层数 <3 报错', () => {
  assert.throws(() => buildDagTVariants(11, 3), /3 的倍数/);
  assert.throws(() => buildDagTVariants(9, 3), /至少 4 色/);
  assert.throws(() => buildDagTVariants(12, 2), /1 层必可解/);
  assert.throws(() => minimalYDeepVariant(4, 3), /layers ≥ 4/);
});

test('solveDFS 复验：规范 12t3l 模板纯玩法不可通关', () => {
  const variant = canonicalVariant(12, 3);
  const tiles = variant.nodes.map(n => new OfflineTile(
    {
      id: n.id,
      layer: n.layer - 1,
      dependencies: [...n.deps],
      isConst: false,
      constElementValue: 0,
      posX: 100 * n.id,
      posY: 100,
    },
    n.color + 1,
  ));
  const game = new OfflineGame(tiles, [], {});
  const result = solveDFS(game, { maxStates: 1_000_000, timeoutMs: 10_000 });
  assert.equal(result.win, false, '必死模板应无通关序');
});
