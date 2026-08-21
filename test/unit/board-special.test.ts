/**
 * 大型地形（51-53 棋盘特殊物）测试：
 * 稳定种子 golden、放置计划确定性、注入依赖/覆盖语义、覆盖遮挡与自动移除、
 * 胜利判定（障碍不参与）、分析器成本穿透、状态键含结构状态。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfflineGame, OfflineTile, createGame } from '../../src/solver/index.js';
import type { BoardSpecialStructure } from '../../src/board-special/types.js';
import {
  getStableBoardSpecialSeed,
  resolveBoardSpecialMode,
  injectBoardSpecialStructures,
  buildPlacementLayers,
} from '../../src/board-special/inject.js';
import { buildStandardPlan, buildPizzaPlan, buildTicketPlan } from '../../src/board-special/placement.js';
import { resolveBoardSpecialSeed } from '../../src/board-special/inject.js';
import { boardSpecialVictoryCondition } from '../../src/board-special/victory.js';
import { boardSpecialBounds } from '../../src/board-special/geometry.js';
import { loadTerrainFromFile, getAllTiles } from '../../src/terrain-loader.js';
import { join } from 'node:path';
import { computeAnalyzerMatchGroups } from '../../src/solver/solver-player.js';
import { assignTileExtras } from '../../src/mechanics/assigner.js';
import { parseMechanicCounts } from '../../src/mechanics/spec.js';

function mk(id: number, layer: number, posX: number, posY: number, color: number): OfflineTile {
  return new OfflineTile(
    { id, layer, dependencies: [], isConst: false, constElementValue: 0, posX, posY },
    color,
  );
}

function structure(partial: Partial<BoardSpecialStructure> & { id: number }): BoardSpecialStructure {
  return {
    extraEnum: 51,
    footprint: { width: 2, height: 2 },
    layer: 1,
    posX: 100,
    posY: 100,
    dependencies: [],
    coveredTileIds: [],
    isRemoved: false,
    ...partial,
  };
}

test('稳定种子 golden（对齐 GetStableSeed：FNV-1a 32，不截高位）', () => {
  assert.equal(getStableBoardSpecialSeed('a'), -468965076);
  assert.equal(getStableBoardSpecialSeed(''), -2128831035); // 0x811c9dc5
  assert.equal(getStableBoardSpecialSeed('abc'), getStableBoardSpecialSeed('abc'));
});

test('模式解析：53 > 52 > 51 优先级（对齐 _resolveBoardSpecialMode）', () => {
  assert.equal(resolveBoardSpecialMode(new Map([[51, 0]])), 'standard');
  assert.equal(resolveBoardSpecialMode(new Map([[51, 0], [52, 1]])), 'pizza');
  assert.equal(resolveBoardSpecialMode(new Map([[51, 0], [52, 1], [53, 2]])), 'ticket');
  assert.equal(resolveBoardSpecialMode(undefined), null);
  assert.equal(resolveBoardSpecialMode(new Map([[39, 3]])), null);
});

test('放置计划：同种子确定性，不同种子可能不同', () => {
  const layers = [
    { layer: 0, tiles: [
      { id: 1, posX: 100, posY: 100, extraEnum: 0 }, { id: 2, posX: 200, posY: 100, extraEnum: 0 },
      { id: 3, posX: 300, posY: 100, extraEnum: 0 }, { id: 4, posX: 100, posY: 200, extraEnum: 0 },
    ] },
    { layer: 1, tiles: [
      { id: 5, posX: 150, posY: 100, extraEnum: 0 }, { id: 6, posX: 250, posY: 100, extraEnum: 0 },
      { id: 7, posX: 150, posY: 200, extraEnum: 0 }, { id: 8, posX: 250, posY: 200, extraEnum: 0 },
    ] },
  ];
  const placementLayers = buildPlacementLayers(layers, undefined);
  const a = buildStandardPlan(placementLayers, 2, 7);
  const b = buildStandardPlan(placementLayers, 2, 7);
  assert.deepEqual(a, b, '同种子同计划');
  assert.ok(a.length > 0, '两层地形应产出计划');
  // 每项 footprint 为 2 或 3 的方形
  for (const p of a) {
    assert.equal(p.footprint.width, p.footprint.height);
    assert.ok(p.footprint.width === 2 || p.footprint.width === 3);
  }
  // Pizza/Ticket 同种子确定性
  const bounds = { xMin: 0, yMin: 0, xMax: 400, yMax: 300 };
  assert.deepEqual(buildPizzaPlan(placementLayers, bounds, 5), buildPizzaPlan(placementLayers, bounds, 5));
  assert.deepEqual(buildTicketPlan(placementLayers, bounds, 5), buildTicketPlan(placementLayers, bounds, 5));
});

test('注入语义：依赖 = 下层覆盖 ≥ 半格(5)；覆盖 = 上层正面积相交', () => {
  // 10 单位网格：tile 宽 10、半格 5；结构 2×2 包围盒 = ±10
  const allTiles = [
    { id: 1, layer: 0, posX: 100, posY: 100, extraEnum: 0 },   // 与结构中心重合 → 覆盖 10 ≥ 5 → 依赖
    { id: 2, layer: 0, posX: 110, posY: 100, extraEnum: 0 },   // 相邻半重叠 → 覆盖 5 ≥ 5 → 依赖
    { id: 3, layer: 0, posX: 130, posY: 100, extraEnum: 0 },   // 无重叠 → 非依赖
    { id: 4, layer: 1, posX: 100, posY: 100, extraEnum: 0 },   // 正面积相交 → 被覆盖
    { id: 5, layer: 1, posX: 140, posY: 100, extraEnum: 0 },   // 不相交 → 不被覆盖
  ];
  const placementLayers = buildPlacementLayers([
    { layer: 0, tiles: allTiles.slice(0, 3) },
    { layer: 1, tiles: allTiles.slice(3) },
  ], undefined);
  const plan = [{ sourceLayerIndex: 0, footprint: { width: 2, height: 2 }, posX: 100, posY: 100 }];
  const structures = injectBoardSpecialStructures(plan, 51, placementLayers, allTiles, 9);
  assert.equal(structures.length, 1);
  const s = structures[0];
  assert.equal(s.layer, 1, '注入层 = 源层 + 1');
  assert.deepEqual(s.dependencies, [1, 2], '下层覆盖 ≥ 半格(5) 的牌为依赖');
  assert.deepEqual(s.coveredTileIds, [4], '上层正面积相交的牌被覆盖（5 不相交）');
});

test('覆盖遮挡与自动移除：依赖全部离桌后结构移除、被覆盖牌解锁', () => {
  const tiles = [
    mk(1, 0, 100, 100, 1), mk(2, 0, 200, 100, 1), mk(3, 0, 300, 100, 1),
    mk(4, 1, 100, 100, 2), mk(5, 1, 200, 100, 2), mk(6, 1, 300, 100, 2),
  ];
  const game = new OfflineGame(tiles, [], {
    levelResId: 1,
    boardSpecialStructures: [structure({ id: 9, dependencies: [1, 2], coveredTileIds: [4, 5, 6] })],
  });
  assert.equal(game.allTiles.get(4)!.isClickable, false, '被覆盖牌初始不可点击');
  assert.equal(game.isWin, false);

  // 依赖 [1,2] 随同色三消一起离桌（Dock 结算后为空）→ 结构自动移除
  game.collect(game.allTiles.get(1)!);
  game.collect(game.allTiles.get(2)!);
  game.collect(game.allTiles.get(3)!);
  assert.equal(game.boardSpecialStructures[0].isRemoved, true, '依赖全部离桌 → 自动移除');
  assert.equal(game.allTiles.get(4)!.isClickable, true, '结构移除后被覆盖牌解锁');

  // 收掉剩余三张同色 → 胜利（障碍语义：isWin 只看可匹配牌）
  game.collect(game.allTiles.get(4)!);
  game.collect(game.allTiles.get(5)!);
  game.collect(game.allTiles.get(6)!);
  assert.equal(game.isWin, true);
});

test('分析器成本穿透：组 cost 计入棋盘特殊物依赖', () => {
  const tiles = [
    mk(1, 0, 100, 100, 1), mk(2, 0, 200, 100, 1), mk(3, 0, 300, 100, 1),
    mk(4, 1, 100, 100, 2), mk(5, 1, 200, 100, 2), mk(6, 1, 300, 100, 2),
  ];
  const game = new OfflineGame(tiles, [], {
    levelResId: 1,
    boardSpecialStructures: [structure({ id: 9, dependencies: [1, 2], coveredTileIds: [4, 5, 6] })],
  });
  const groups = computeAnalyzerMatchGroups(game).filter(g => g.color === 2);
  assert.ok(groups.length > 0);
  assert.equal(groups[0].totalCost, 5, 'cost = 依赖{1,2} + 自身{4,5,6}？——同色三张 + 两条依赖 = 5');
  assert.ok(groups[0].path.has(1) && groups[0].path.has(2), '路径穿透结构依赖');
});

test('状态键包含结构状态；clone 保留结构', () => {
  const tiles = [mk(1, 0, 100, 100, 1), mk(2, 0, 200, 100, 1), mk(4, 1, 100, 100, 2), mk(5, 1, 200, 100, 2), mk(6, 1, 300, 100, 2)];
  const game = new OfflineGame(tiles, [], {
    levelResId: 1,
    boardSpecialStructures: [structure({ id: 9, dependencies: [1, 2], coveredTileIds: [4, 5] })],
  });
  const before = game.buildStateKey();
  const copy = game.clone();
  assert.equal(copy.boardSpecialStructures.length, 1);
  assert.equal(copy.buildStateKey(), before, 'clone 键一致');
  copy.collect(copy.allTiles.get(1)!);
  copy.collect(copy.allTiles.get(2)!);
  assert.equal(copy.boardSpecialStructures[0].isRemoved, true);
  assert.notEqual(copy.buildStateKey(), before, '结构移除后键改变');
});

test('createGame 装载注入：同 replay+配置 → 同结构；分配器不碰棋盘特殊物牌', () => {
  const terrainTiles = [
    { id: 1, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: 100, posY: 100, extraEnum: 0, extraParam: '' },
    { id: 2, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: 200, posY: 100, extraEnum: 0, extraParam: '' },
    { id: 3, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: 300, posY: 100, extraEnum: 0, extraParam: '' },
    { id: 4, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: 100, posY: 200, extraEnum: 0, extraParam: '' },
    { id: 5, layer: 1, dependencies: [], isConst: false, constElementValue: 0, posX: 150, posY: 100, extraEnum: 0, extraParam: '' },
    { id: 6, layer: 1, dependencies: [], isConst: false, constElementValue: 0, posX: 250, posY: 100, extraEnum: 0, extraParam: '' },
    { id: 7, layer: 1, dependencies: [], isConst: false, constElementValue: 0, posX: 150, posY: 200, extraEnum: 0, extraParam: '' },
    { id: 8, layer: 1, dependencies: [], isConst: false, constElementValue: 0, posX: 250, posY: 200, extraEnum: 0, extraParam: '' },
  ];
  const elementValues = new Map(terrainTiles.map(t => [t.id, ((t.id - 1) % 3) + 1]));
  const build = () => createGame({
    terrainTiles,
    elementValues,
    levelResId: 100,
    replayCode: 'TESTCODE',
    mechanicConfig: parseMechanicCounts('51:0'),
    boardBounds: { width: 400, height: 300 },
  });
  const a = build();
  const b = build();
  assert.ok(a.boardSpecialStructures.length > 0, '两层地形注入出结构');
  assert.deepEqual(
    JSON.stringify(a.boardSpecialStructures),
    JSON.stringify(b.boardSpecialStructures),
    '同 replay+配置 → 同结构（种子派生）',
  );
  // 被覆盖牌不可点击
  const covered = new Set(a.boardSpecialStructures.flatMap(s => s.coveredTileIds));
  for (const id of covered) {
    assert.equal(a.allTiles.get(id)!.isClickable, false, `tile ${id} 被覆盖不可点击`);
  }
});

test('分配器跳过棋盘特殊物牌（对齐 emptyTiles.RemoveAll(IsBoardSpecialObstacle)）', () => {
  const obstacle = new OfflineTile(
    { id: 1, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: 0, posY: 0, extras: [{ extraEnum: 51, extraParam: '2' }] },
    0,
  );
  const normal = [mk(2, 0, 100, 100, 1), mk(3, 0, 200, 100, 1), mk(4, 0, 300, 100, 1)];
  const summary = assignTileExtras([obstacle, ...normal], parseMechanicCounts('5:3'), 7);
  assert.equal(summary.assignedCounts.get(5), 3, '金币 3 个全落在普通牌');
  assert.equal(obstacle.extras.length, 1, '障碍牌未获得新挂件');
  assert.equal(obstacle.elementValue, 0, '障碍牌花色不被改写');
});

test('胜利条件可插拔：52/53 订单玩法全部结构移除即胜（桌面仍有牌）', () => {
  const tiles = [
    mk(1, 0, 100, 100, 1), mk(2, 0, 200, 100, 1),
    mk(4, 1, 100, 100, 2), mk(5, 1, 200, 100, 2), mk(6, 1, 300, 100, 2),
  ];
  const game = new OfflineGame(tiles, [], {
    levelResId: 1,
    boardSpecialStructures: [structure({ id: 9, dependencies: [1, 2], coveredTileIds: [4, 5, 6] })],
    victoryCondition: boardSpecialVictoryCondition,
  });
  assert.equal(game.isWin, false, '结构未移除不胜利');
  game.collect(game.allTiles.get(1)!);
  game.collect(game.allTiles.get(2)!);
  assert.equal(game.boardSpecialStructures[0].isRemoved, true);
  assert.equal(game.deskTiles.length, 3, '桌面仍有 4,5,6');
  assert.equal(game.isWin, true, '结构全部收集即胜（对齐 VictoryConditionType.Chicken）');
});

test('胜利条件可插拔：自定义谓词与默认条件共存', () => {
  const tiles = [mk(1, 0, 0, 0, 1), mk(2, 0, 0, 0, 1), mk(3, 0, 0, 0, 1), mk(4, 0, 0, 0, 2), mk(5, 0, 0, 0, 2), mk(6, 0, 0, 0, 2)];
  const custom = new OfflineGame(tiles, [], {
    victoryCondition: g => g.deskTiles.length <= 3,
  });
  assert.equal(custom.isWin, false, '6 张桌面未触发自定义条件');
  custom.collect(custom.allTiles.get(1)!);
  custom.collect(custom.allTiles.get(2)!);
  custom.collect(custom.allTiles.get(3)!);
  assert.equal(custom.isWin, true, '桌面剩 3 张触发自定义条件');
  const copy = custom.clone();
  assert.equal(copy.isWin, true, 'clone 保留胜利条件');
});

test('boardSpecialVictoryCondition：无结构恒 false（调用方回退默认）', () => {
  const plain = new OfflineGame([mk(1, 0, 0, 0, 1), mk(2, 0, 0, 0, 1), mk(3, 0, 0, 0, 1)], [], {
    victoryCondition: boardSpecialVictoryCondition,
  });
  assert.equal(plain.boardSpecialStructures.length, 0);
  assert.equal(plain.isWin, false, '无结构不提前胜利');
});

test('量纲自检：普通牌 10 宽、2×2 结构 20 宽（TileUnit=10 回归防线）', () => {
  const s2 = boardSpecialBounds(100, 100, { width: 2, height: 2 });
  assert.equal(s2.xMax - s2.xMin, 20, '2×2 结构宽 = 2 × TileUnit(10)');
  const s3 = boardSpecialBounds(100, 100, { width: 3, height: 2 });
  assert.equal(s3.xMax - s3.xMin, 30);
  assert.equal(s3.yMax - s3.yMin, 20);
});

test('真实地形回归：100075 三模式计划非空 + 披萨 golden 锁定', () => {
  const terrain = loadTerrainFromFile(join(process.cwd(), 'test', 'fixtures', '100075.json'));
  const tiles = getAllTiles(terrain);
  const byLayer = new Map<number, Array<{ id: number; posX: number; posY: number; extraEnum: number | undefined }>>();
  for (const t of tiles) {
    if (!byLayer.has(t.layer)) byLayer.set(t.layer, []);
    byLayer.get(t.layer)!.push({ id: t.id, posX: t.posX, posY: t.posY, extraEnum: t.extraEnum });
  }
  const layers = [...byLayer.entries()].map(([layer, ts]) => ({ layer, tiles: ts }));
  const placementLayers = buildPlacementLayers(layers, undefined);
  const bounds = { xMin: 0, yMin: 0, xMax: terrain.LevelWidth ?? 0, yMax: terrain.LevelHeight ?? 0 };
  const seed = resolveBoardSpecialSeed(undefined, 'TESTCODE', terrain.levelResId);

  const pizza = buildPizzaPlan(placementLayers, bounds, seed);
  assert.ok(pizza.length > 0, '真实地形披萨计划非空');
  // golden 锁定（防量纲/候选逻辑回归）：同输入逐位一致
  assert.deepEqual(JSON.parse(JSON.stringify(pizza)), [
    { sourceLayerIndex: 2, footprint: { width: 2, height: 2 }, posX: 50, posY: 40 },
    { sourceLayerIndex: 3, footprint: { width: 3, height: 3 }, posX: 15, posY: 35 },
    { sourceLayerIndex: 5, footprint: { width: 2, height: 2 }, posX: 40, posY: 55 },
    { sourceLayerIndex: 6, footprint: { width: 3, height: 3 }, posX: 20, posY: 45 },
    { sourceLayerIndex: 7, footprint: { width: 2, height: 2 }, posX: 15, posY: 55 },
  ]);

  const standard = buildStandardPlan(placementLayers, 8, seed);
  assert.ok(standard.length > 0, '真实地形标准计划非空');

  const ticket = buildTicketPlan(placementLayers, bounds, seed);
  assert.ok(ticket.length > 0, '真实地形奖券计划非空');
  assert.ok(ticket.length <= 3, '奖券计划至多 3 个');
});
