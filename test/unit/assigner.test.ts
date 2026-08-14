/**
 * 机制分配器测试 — 对齐 Unity TileExtraAssigner 语义：
 * 确定性随机、固定花色约束（3 的倍数）、白名单互斥、驱逐/恢复、自动数量策略、装载集成。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfflineTile } from '../../src/solver/types.js';
import type { TileConfig } from '../../src/solver/types.js';
import {
  AssignerRandom,
  assignTileExtras,
  deriveAssignSeed,
} from '../../src/mechanics/assigner.js';
import { parseMechanicCounts, splitMechanicConfig, validateMechanicCounts } from '../../src/mechanics/spec.js';
import { createGame } from '../../src/solver/offline-game.js';
import type { TerrainTile } from '../../src/types/terrain.js';

function makeTile(id: number, opts: { layer?: number; deps?: number[]; color?: number; extra?: number; posX?: number; posY?: number } = {}): OfflineTile {
  const config: TileConfig = {
    id,
    layer: opts.layer ?? 0,
    dependencies: opts.deps ?? [],
    isConst: false,
    constElementValue: 0,
    posX: opts.posX ?? id,
    posY: opts.posY ?? 0,
    extras: opts.extra !== undefined ? [{ extraEnum: opts.extra, extraParam: '' }] : [],
  };
  return new OfflineTile(config, opts.color ?? 1);
}

function extraEnums(tile: OfflineTile): number[] {
  return tile.extras.map(e => e.extraEnum).sort((a, b) => a - b);
}

// ═══ 确定性随机 ═══

test('AssignerRandom: 同种子序列逐位一致，不同种子不同，范围正确', () => {
  const a = new AssignerRandom(12345);
  const b = new AssignerRandom(12345);
  for (let i = 0; i < 50; i++) assert.equal(a.next(100000), b.next(100000));

  const c = new AssignerRandom(12345);
  const d = new AssignerRandom(54321);
  assert.notDeepEqual(
    [c.next(1000000), c.next(1000000), c.next(1000000)],
    [d.next(1000000), d.next(1000000), d.next(1000000)],
    '不同种子应产生不同序列',
  );

  const e = new AssignerRandom(7);
  for (let i = 0; i < 100; i++) {
    const v = e.nextRange(1, 4);
    assert.ok(v >= 1 && v < 4, `nextRange(1,4) ∈ [1,4): ${v}`);
  }
  // 负种子（C# (ulong)seed 语义）也能正常工作
  const f = new AssignerRandom(-1);
  assert.ok(f.next(10) >= 0 && f.next(10) < 10);
});

test('AssignerRandom: Shuffle 确定性且保元素', () => {
  const src = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const a = new AssignerRandom(42);
  const l1 = [...src];
  a.shuffle(l1);
  const b = new AssignerRandom(42);
  const l2 = [...src];
  b.shuffle(l2);
  assert.deepEqual(l1, l2);
  assert.deepEqual([...l1].sort((x, y) => x - y), src);
});

// ═══ 固定花色约束 ═══

test('固定花色挂件：数量向下取 3 的倍数并改写花色（黄金 4 → 1101）', () => {
  const tiles: OfflineTile[] = [];
  for (let i = 0; i < 9; i++) tiles.push(makeTile(i, { color: (i % 3) + 1 }));
  const summary = assignTileExtras(tiles, parseMechanicCounts('4:4'), 100);
  assert.equal(summary.assignedCounts.get(4), 3, '请求 4 个黄金 → 实际 3（取 3 的倍数）');
  assert.deepEqual(summary.adjusted, [{ value: 4, requested: 4, actual: 3 }]);
  const golden = tiles.filter(t => t.extras.some(e => e.extraEnum === 4));
  assert.equal(golden.length, 3);
  for (const t of golden) assert.equal(t.elementValue, 1101, '黄金固定花色 1101');
});

// ═══ 白名单互斥 ═══

test('白名单互斥：魔药(31)与金币(5)不落在同一张牌上，魔药先分配', () => {
  const tiles: OfflineTile[] = [];
  for (let i = 0; i < 9; i++) tiles.push(makeTile(i, { color: (i % 3) + 1 }));
  assignTileExtras(tiles, parseMechanicCounts('31:3,5:3'), 100);
  const conflicts = tiles.filter(t => {
    const es = t.extras.map(e => e.extraEnum);
    return es.includes(31) && es.includes(5);
  });
  assert.equal(conflicts.length, 0, '同 tile 魔药+金币互斥');
  const bottles = tiles.filter(t => t.extras.some(e => e.extraEnum === 31));
  const coins = tiles.filter(t => t.extras.some(e => e.extraEnum === 5));
  assert.equal(bottles.length, 3);
  assert.equal(coins.length, 3);
  for (const t of bottles) assert.equal(t.elementValue, 1301, '魔药固定花色 1301');
  for (const t of coins) assert.equal(t.elementValue, 1201, '金币固定花色 1201');
});

// ═══ 驱逐 / 恢复 ═══

test('预置可让位挂件：黄金排挤问号（驱逐），金币保留问号（恢复）', () => {
  // 驱逐：A 预置问号(2)；黄金白名单为空 → 只挂空牌，A 的问号被排挤丢弃
  const a = makeTile(0, { extra: 2 });
  const tiles = [a, makeTile(1), makeTile(2)];
  const s1 = assignTileExtras(tiles, parseMechanicCounts('4:3'), 7);
  assert.equal(s1.evictedPreplaced, 1, '问号被黄金排挤');
  assert.deepEqual(extraEnums(a), [4]);

  // 恢复：A 预置问号(2)；金币白名单兼容问号 → 问号恢复共存
  const a2 = makeTile(0, { extra: 2 });
  const tiles2 = [a2, makeTile(1), makeTile(2)];
  const s2 = assignTileExtras(tiles2, parseMechanicCounts('5:3'), 7);
  assert.equal(s2.evictedPreplaced, 0, '金币与问号兼容，问号恢复');
  assert.deepEqual(extraEnums(a2), [2, 5]);
});

// ═══ 自动数量策略 ═══

test('问号(间隔)202：忽略配置数量、自动数量 1..8、每层至多 2 张、确定性', () => {
  const build = (): OfflineTile[] => {
    const tiles: OfflineTile[] = [];
    for (let layer = 0; layer < 3; layer++) {
      for (let i = 0; i < 6; i++) tiles.push(makeTile(layer * 10 + i, { layer }));
    }
    return tiles;
  };
  const t1 = build();
  const s1 = assignTileExtras(t1, parseMechanicCounts('202:0'), 5);
  const count = s1.assignedCounts.get(202) ?? 0;
  assert.ok(count >= 1 && count <= 8, `自动数量应在 1..8，实际 ${count}`);

  const selected = t1.filter(t => t.extras.some(e => e.extraEnum === 202));
  const perLayer = new Map<number, number>();
  for (const t of selected) perLayer.set(t.config.layer, (perLayer.get(t.config.layer) ?? 0) + 1);
  for (const c of perLayer.values()) assert.ok(c <= 2, `每层至多 2 张，实际 ${c}`);

  // 确定性：同种子重建同输入 → 完全相同的落点
  const t2 = build();
  assignTileExtras(t2, parseMechanicCounts('202:0'), 5);
  const ids1 = selected.map(t => t.id).sort((x, y) => x - y);
  const ids2 = t2.filter(t => t.extras.some(e => e.extraEnum === 202)).map(t => t.id).sort((x, y) => x - y);
  assert.deepEqual(ids1, ids2);
});

test('翻转(层)207：忽略配置数量、排除最浅两层、整层全挂', () => {
  const tiles: OfflineTile[] = [];
  for (let layer = 0; layer < 5; layer++) {
    for (let i = 0; i < 4; i++) tiles.push(makeTile(layer * 10 + i, { layer }));
  }
  const s = assignTileExtras(tiles, parseMechanicCounts('207:99'), 3);
  const count = s.assignedCounts.get(207) ?? 0;
  assert.ok(count > 0, '自动数量应 > 0');
  const selected = tiles.filter(t => t.extras.some(e => e.extraEnum === 207));
  for (const t of selected) assert.ok(t.config.layer >= 2, '排除最浅两层 (layer 0/1)');
  const layers = new Set(selected.map(t => t.config.layer));
  assert.equal(layers.size, 1, '整层全挂：只来自同一层');
});

// ═══ 蒲公英：第五低成本三消组 ═══

test('蒲公英(36)：第五低成本三消组策略，固定花色 1402，确定性', () => {
  const build = (): OfflineTile[] => {
    const tiles: OfflineTile[] = [];
    // 同色 9 张，三层链式深度：cost 3 / 6 / 9
    tiles.push(makeTile(1, { color: 1 }), makeTile(2, { color: 1 }), makeTile(3, { color: 1 }));
    tiles.push(makeTile(11, { color: 1, deps: [1] }), makeTile(12, { color: 1, deps: [2] }), makeTile(13, { color: 1, deps: [3] }));
    tiles.push(makeTile(21, { color: 1, deps: [11] }), makeTile(22, { color: 1, deps: [12] }), makeTile(23, { color: 1, deps: [13] }));
    return tiles;
  };
  const t1 = build();
  const s = assignTileExtras(t1, parseMechanicCounts('36:3'), 9);
  assert.equal(s.assignedCounts.get(36), 3);
  const dandelions = t1.filter(t => t.extras.some(e => e.extraEnum === 36));
  assert.equal(dandelions.length, 3);
  for (const t of dandelions) assert.equal(t.elementValue, 1402, '蒲公英固定花色 1402');

  const t2 = build();
  assignTileExtras(t2, parseMechanicCounts('36:3'), 9);
  const ids1 = dandelions.map(t => t.id).sort((x, y) => x - y);
  const ids2 = t2.filter(t => t.extras.some(e => e.extraEnum === 36)).map(t => t.id).sort((x, y) => x - y);
  assert.deepEqual(ids1, ids2, '同种子同输入 → 相同落点');
});

// ═══ 配置拆分与校验 ═══

test('配置拆分（对齐 Unity LoadLevel：泡泡/大型地形拆出）与校验（分配请求语义）', () => {
  const split = splitMechanicConfig(parseMechanicCounts('31:3,39:2,52:1'));
  assert.deepEqual([...split.assignable.entries()], [[31, 3]]);
  assert.deepEqual([...split.bubble.entries()], [[39, 2]]);
  assert.deepEqual([...split.boardSpecial.entries()], [[52, 1]]);

  // 负数量 / 与地形不一致不再是错误（数量由分配器解释：202/207 自动，其余选不到）
  assert.deepEqual(validateMechanicCounts(parseMechanicCounts('31:3,39:2')), []);
  assert.deepEqual(validateMechanicCounts(new Map([[31, -1]])), []);
  assert.deepEqual(validateMechanicCounts(new Map([[31, 99]])), []);
  // 未知枚举（parse 层已拦文本，这里覆盖直接构造 Map 的路径）
  const errs = validateMechanicCounts(new Map([[999, 1]]));
  assert.equal(errs.length, 1);
  assert.equal(errs[0].kind, 'unknown-enum');
});

test('deriveAssignSeed: 同一 replay+机制确定、不同 replay 不同、非负', () => {
  const m = parseMechanicCounts('31:3');
  assert.equal(deriveAssignSeed('CODE_A', m), deriveAssignSeed('CODE_A', m));
  assert.notEqual(deriveAssignSeed('CODE_A', m), deriveAssignSeed('CODE_B', m));
  assert.equal(deriveAssignSeed('CODE_A', m) & 0x80000000, 0, '非负 31 位');
});

// ═══ createGame 装载集成 ═══

test('createGame 集成：机制分配 + 泡泡配置分离 + 同种子确定性', () => {
  const terrainTiles: TerrainTile[] = [];
  for (let i = 0; i < 9; i++) {
    terrainTiles.push({ id: i, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: i, posY: 0 });
  }
  const elementValues = new Map(terrainTiles.map(t => [t.id, (t.id % 3) + 1]));
  const config = parseMechanicCounts('31:3,39:2');

  const g1 = createGame({ terrainTiles, elementValues, levelResId: 1002, mechanicConfig: config, mechanicSeed: 42 });
  const g2 = createGame({ terrainTiles, elementValues, levelResId: 1002, mechanicConfig: config, mechanicSeed: 42 });
  // 泡泡配置进入引擎（行为参数，不参与分配）
  assert.equal(g1.mechanics.bubble.enabled, true);
  assert.equal(g1.mechanics.bubble.configuredCollectCount, 2);

  const layout = (g: ReturnType<typeof createGame>): string =>
    [...g.allTiles.values()].map(t => t.extras.map(e => e.extraEnum).join('.')).join('|');
  assert.equal(layout(g1), layout(g2), '同种子 → 相同分配');

  // 魔药数量与固定花色
  const bottles = [...g1.allTiles.values()].filter(t => t.extras.some(e => e.extraEnum === 31));
  assert.equal(bottles.length, 3);
  for (const t of bottles) assert.equal(t.elementValue, 1301);

  // 不同种子：多试几个，至少一个产生不同布局（碰撞概率极低）
  const base = layout(g1);
  const different = [43, 44, 45, 46].some(seed =>
    layout(createGame({ terrainTiles, elementValues, levelResId: 1002, mechanicConfig: config, mechanicSeed: seed })) !== base);
  assert.equal(different, true, '不同种子应产生不同分配');
});

test('createGame 集成：无机制配置时不分配、无固定花色挂件不动花色', () => {
  const terrainTiles: TerrainTile[] = [];
  for (let i = 0; i < 6; i++) {
    terrainTiles.push({ id: i, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: i, posY: 0 });
  }
  const elementValues = new Map(terrainTiles.map(t => [t.id, (t.id % 3) + 1]));
  const g = createGame({ terrainTiles, elementValues, levelResId: 1002, mechanicConfig: parseMechanicCounts('2:2') });
  assert.equal(g.mechanics.bubble.enabled, false);
  const unknowns = [...g.allTiles.values()].filter(t => t.extras.some(e => e.extraEnum === 2));
  assert.equal(unknowns.length, 2, '问号(2) 无固定花色，按配置 2 张');
  for (const t of [...g.allTiles.values()]) assert.ok(t.elementValue >= 1 && t.elementValue <= 3, '无固定花色挂件不改动花色');
});

test('端到端：魔药(31)三消后触发清除（分配器 → OfflineGame → 跑关）', () => {
  const terrainTiles: TerrainTile[] = [];
  const elementValues = new Map<number, number>();
  for (let i = 0; i < 9; i++) {
    terrainTiles.push({ id: i, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: i, posY: 0 });
    elementValues.set(i, (i % 2) + 1);
  }
  const g = createGame({ terrainTiles, elementValues, levelResId: 1, mechanicConfig: parseMechanicCounts('31:3'), mechanicSeed: 7 });
  const bottles = [...g.allTiles.values()].filter(t => t.extras.some(e => e.extraEnum === 31));
  assert.equal(bottles.length, 3, '注入 3 个魔药');
  for (const b of bottles) assert.equal(b.elementValue, 1301, '魔药固定花色 1301');

  const deskBefore = g.deskTiles.length;
  for (const b of bottles) g.collect(b); // 收集 3 张魔药 → 三消 → 魔药清除
  assert.ok(g.mechanicLog.some(s => s.type === 'magic-bottle-clear'), '魔药三消应触发 magic-bottle-clear');
  assert.ok(g.deskTiles.length < deskBefore, '魔药清除应移除场上牌');
});
