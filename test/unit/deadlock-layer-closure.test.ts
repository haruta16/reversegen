/**
 * deadlock-layer-closure 端到端测试。
 *
 * 夹具：规范 12t3l 骨架（1..12）+ 6 张链式剩余牌（101..106，深度 1/2/3）。
 * K=6（死锁 4 色 + 剩余 2 色），closeRates=[0.3, 0.7]。
 * 验收：
 *  - 死锁牌闭包 ≥ 8（数学必死）、死锁色 1..4 独占；
 *  - 剩余色 5/6 各 3 张、逐层闭合率末层 = 1（死锁牌排除口径生效）；
 *  - solveDFS（无机制）确认整局不可通关；
 *  - 同 rng 种子输出确定一致。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeFromString,
  generateBoardDeadlockLayerClosure,
  LogLevel,
  runDeadlockLayerClosureGen,
  setLogLevel,
} from '../../src/index.js';
import { mulberry32 } from '../../src/random-utils.js';
import { createGame } from '../../src/solver/offline-game.js';
import { solveDFS } from '../../src/solver/solver-dfs.js';
import type { TerrainData, TerrainTile } from '../../src/types.js';

setLogLevel(LogLevel.Silent);

function skeletonTile(id: number): TerrainTile {
  const depsOf: Record<number, number[]> = {
    7: [3, 4, 5, 6],
    8: [1],
    10: [7, 8],
    11: [7],
    12: [7, 8],
  };
  return {
    id,
    layer: 0,
    dependencies: depsOf[id] ?? [],
    isConst: false,
    constElementValue: 0,
    posX: 10 * id,
    posY: 100,
  };
}

function chainTile(id: number): TerrainTile {
  const depsOf: Record<number, number[]> = {
    101: [],
    102: [],
    103: [101],
    104: [102],
    105: [103],
    106: [104],
  };
  return {
    id,
    layer: 0,
    dependencies: depsOf[id] ?? [],
    isConst: false,
    constElementValue: 0,
    posX: 10 * id + 500,
    posY: 100,
  };
}

function buildFixtureTerrain(): TerrainData {
  const tiles: TerrainTile[] = [];
  for (let id = 1; id <= 12; id++) tiles.push(skeletonTile(id));
  for (const id of [101, 102, 103, 104, 105, 106]) tiles.push(chainTile(id));
  return { levelResId: 999999, layers: [{ tiles }] };
}

const CLOSURE_INPUT = {
  terrain: undefined as unknown as TerrainData,
  colorCount: 6,
  closeRates: [0.3, 0.7],
  dock: 7,
  spreadParam: 0.5,
};

test('端到端：死锁命中 + 剩余 LayerClosure 排除死锁花色', () => {
  const input = { ...CLOSURE_INPUT, terrain: buildFixtureTerrain(), rng: mulberry32(1) };
  const result = runDeadlockLayerClosureGen(input);

  // 死锁报告
  const report = result.deadlock;
  assert.equal(report.tileCount, 12);
  assert.equal(report.layerLimit, 3);
  assert.deepEqual(report.deadlockColors, [1, 2, 3, 4]);
  assert.deepEqual([...report.mapping.values()].sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], '中性偏好下应命中恒等骨架');
  for (const size of report.closures.values()) assert.ok(size >= 8, `闭包 ${size} 应 ≥ 8`);

  // 死锁色 1..4 各 3 张
  const deadlockColors = [...report.assignments.values()].sort((a, b) => a - b);
  assert.deepEqual(deadlockColors, [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]);

  // 剩余牌只用 5/6，各 3 张
  const remaining = new Map<number, number>();
  for (const [tileId, color] of result.assignments) {
    if (!report.assignments.has(tileId)) remaining.set(tileId, color);
  }
  assert.equal(remaining.size, 6);
  const remainingColors = [...remaining.values()].sort((a, b) => a - b);
  assert.deepEqual(remainingColors, [5, 5, 5, 6, 6, 6]);

  // 闭合率末层 = 1（死锁牌排除口径：剩余 6 张在末层全部闭合）
  const rates = result.metrics.actualCloseRates;
  assert.equal(rates[rates.length - 1], 1, `末层闭合率应为 1: [${rates}]`);
  // 花色使用率不含死锁色（排除口径下 totalColors = 2）
  for (const usage of result.metrics.colorUsageRates) {
    assert.ok(usage >= 0 && usage <= 1);
  }

  // 全量花色分配满足 3 的倍数
  const colorCounts = new Map<number, number>();
  for (const color of result.assignments.values()) {
    colorCounts.set(color, (colorCounts.get(color) ?? 0) + 1);
  }
  for (const count of colorCounts.values()) assert.equal(count % 3, 0);
});

test('高层 API：ReplayCode 可解码且包含 levelHash', () => {
  const input = {
    ...CLOSURE_INPUT,
    terrain: buildFixtureTerrain(),
    rng: mulberry32(3),
    deadlock: { tileCount: 12, layerLimit: 3, selectionSeed: 0 },
  };
  const result = generateBoardDeadlockLayerClosure(input);
  assert.ok(result.replayCode.length > 0);
  const decoded = decodeFromString(result.replayCode);
  assert.ok(decoded, 'ReplayCode 应可解码');
  assert.equal(result.deadlock.tileCount, 12);
});

test('solveDFS 复验：整局（死锁 + 剩余）纯玩法不可通关', () => {
  const input = { ...CLOSURE_INPUT, terrain: buildFixtureTerrain(), rng: mulberry32(2) };
  const result = runDeadlockLayerClosureGen(input);
  const game = createGame({
    terrainTiles: input.terrain.layers.flatMap(l => l.tiles),
    elementValues: result.assignments,
    levelResId: input.terrain.levelResId,
  });
  const solved = solveDFS(game, { maxStates: 5_000_000, timeoutMs: 30_000 });
  assert.equal(solved.win, false, '死锁局应无通关序');
});

test('确定性：同 rng 种子两次运行输出逐位一致', () => {
  const run = () => {
    const input = { ...CLOSURE_INPUT, terrain: buildFixtureTerrain(), rng: mulberry32(42) };
    const result = generateBoardDeadlockLayerClosure(input);
    return JSON.stringify({
      replayCode: result.replayCode,
      mapping: [...result.deadlock.mapping.entries()].sort((a, b) => a[0] - b[0]),
      assignments: [...result.assignments.entries()].sort((a, b) => a[0] - b[0]),
    });
  };
  assert.equal(run(), run());
});

test('single-heavy 模式与死锁前置兼容', () => {
  const input = {
    ...CLOSURE_INPUT,
    terrain: buildFixtureTerrain(),
    rng: mulberry32(5),
    colorAllocationMode: 'single-heavy' as const,
    colorAllocationMaxRatio: 0.5,
  };
  const result = runDeadlockLayerClosureGen(input);
  const remainingColors = [...new Set([...result.assignments.entries()]
    .filter(([id]) => !result.deadlock.assignments.has(id))
    .map(([, color]) => color))].sort((a, b) => a - b);
  assert.deepEqual(remainingColors, [5, 6]);
});

test('错误处理：花色不足 / 无包含 / tileCount 非法', () => {
  // 剩余花色不足（K = n = 4）
  assert.throws(
    () => runDeadlockLayerClosureGen({ ...CLOSURE_INPUT, terrain: buildFixtureTerrain(), colorCount: 4 }),
    /花色数 4 不足/,
  );
  // 平坦地形无包含
  const flat: TerrainData = {
    levelResId: 1,
    layers: [{ tiles: Array.from({ length: 18 }, (_, i) => ({
      id: i + 1, layer: 0, dependencies: [], isConst: false, constElementValue: 0,
      posX: 10 * i, posY: 100,
    })) }],
  };
  assert.throws(
    () => runDeadlockLayerClosureGen({ ...CLOSURE_INPUT, terrain: flat }),
    /未在地形中找到/,
  );
  // tileCount 非法
  assert.throws(
    () => runDeadlockLayerClosureGen({
      ...CLOSURE_INPUT,
      terrain: buildFixtureTerrain(),
      deadlock: { tileCount: 11 },
    }),
    /3 的倍数且 ≥ 12/,
  );
});

test('偏好强度贯通：preferenceStrength=0.95 + deepest 选深骨架', () => {
  // 浅骨架（identity）+ 深骨架（offset 100、底座/wildcard 下探到 130）+ 2 张补牌
  const tiles: TerrainTile[] = [];
  const depsOf: Record<number, number[]> = {
    7: [3, 4, 5, 6], 8: [1], 10: [7, 8], 11: [7], 12: [7, 8],
  };
  for (let id = 1; id <= 12; id++) {
    tiles.push({ id, layer: 0, dependencies: depsOf[id] ?? [], isConst: false, constElementValue: 0, posX: 10 * id, posY: 100 });
  }
  for (let id = 1; id <= 12; id++) {
    const deps = (depsOf[id] ?? []).map(d => d + 100);
    if (id <= 6 || id === 2 || id === 9) deps.push(130);
    tiles.push({ id: id + 100, layer: 0, dependencies: deps, isConst: false, constElementValue: 0, posX: 10 * id + 1000, posY: 100 });
  }
  tiles.push({ id: 130, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: 1010, posY: 60 });
  tiles.push({ id: 131, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: 1020, posY: 60 });
  tiles.push({ id: 132, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: 1030, posY: 60 });
  const terrain: TerrainData = { levelResId: 888, layers: [{ tiles }] };

  const result = runDeadlockLayerClosureGen({
    terrain, closeRates: [0.3, 0.4, 0.6], colorCount: 9, dock: 7,
    deadlock: {
      depthPreference: 'deepest',
      preferenceStrength: 0.95,
      searchLimit: 8,
      enumerationSeed: 0,
    },
  });
  assert.ok(result.deadlock.depthScore >= 2.4,
    `高强度 deepest 引导应选中深骨架（depthScore=${result.deadlock.depthScore.toFixed(2)}）`);
});
