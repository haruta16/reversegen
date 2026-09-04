/**
 * 死锁包含搜索测试 —— 可达口径 + 直接依赖子图闭包过滤 + 偏好选择。
 *
 * 合成地形以规范 12t3l 骨架为基准：
 *   角色   deps
 *   A(7)   {3,4,5,6}   B(8) {1}   C(10) {7,8}   D(11) {7}   E(12) {7,8}
 *   wildcard: t2（色1）、t9（色0）
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalVariant } from '../../src/deadlock/family.js';
import {
  preferenceStrengthToBias,
  searchDeadlockCores,
  searchGenericCoresImpl,
  verifyFullEmbedding,
  weightedSampleOrder,
} from '../../src/deadlock/search.js';
import { mulberry32 } from '../../src/random-utils.js';
import { selectDeadlockEmbedding, type SelectionContext } from '../../src/deadlock/selection.js';
import type { DagTVariant } from '../../src/deadlock/types.js';
import { computeDependencyDepth } from '../../src/logical-layers.js';
import type { TerrainTile } from '../../src/types.js';
import { LogLevel, setLogLevel } from '../../src/index.js';

setLogLevel(LogLevel.Silent);

interface TileSpec {
  id: number;
  deps?: number[];
  pos?: [number, number];
  isConst?: boolean;
}

/** 合成地形 + 全地形传递后代/祖先。 */
function buildTerrain(specs: TileSpec[]): {
  tiles: TerrainTile[];
  depsOf: Map<number, number[]>;
  descendants: Map<number, Set<number>>;
  ancestors: Map<number, Set<number>>;
} {
  const tiles: TerrainTile[] = specs.map(s => ({
    id: s.id,
    layer: 0,
    dependencies: s.deps ?? [],
    isConst: s.isConst ?? false,
    constElementValue: 0,
    posX: s.pos?.[0] ?? 10 * s.id,
    posY: s.pos?.[1] ?? 100,
  }));
  const depsOf = new Map<number, number[]>();
  for (const t of tiles) depsOf.set(t.id, [...t.dependencies]);

  const descendants = new Map<number, Set<number>>();
  const ancestors = new Map<number, Set<number>>();
  for (const t of tiles) {
    const desc = new Set<number>();
    const stack = [...t.dependencies];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (desc.has(cur)) continue;
      desc.add(cur);
      stack.push(...(depsOf.get(cur) ?? []));
    }
    descendants.set(t.id, desc);
    ancestors.set(t.id, new Set());
  }
  for (const [id, desc] of descendants) {
    for (const d of desc) ancestors.get(d)!.add(id);
  }
  return { tiles, depsOf, descendants, ancestors };
}

/** 规范 12t3l 骨架的角色依赖（模板节点 id 1..12）。 */
function skeletonDeps(id: number): number[] {
  switch (id) {
    case 7: return [3, 4, 5, 6];
    case 8: return [1];
    case 10: return [7, 8];
    case 11: return [7];
    case 12: return [7, 8];
    default: return [];
  }
}

function identitySkeleton(offset = 0): TileSpec[] {
  const specs: TileSpec[] = [];
  for (let id = 1; id <= 12; id++) {
    specs.push({
      id: id + offset,
      deps: skeletonDeps(id).map(d => d + offset),
      pos: [10 * id + 1000 * (offset > 0 ? 1 : 0), 100],
    });
  }
  return specs;
}

function ctx(
  terrain: ReturnType<typeof buildTerrain>,
  overrides: Partial<SelectionContext> = {},
): SelectionContext {
  const tileMap = new Map(terrain.tiles.map(t => [t.id, t]));
  const depthById = computeDependencyDepth(terrain.tiles, tileMap);
  return {
    depthById,
    posById: new Map(terrain.tiles.map(t => [t.id, { x: t.posX, y: t.posY }])),
    depthPreference: 'neutral',
    densityPreference: 'neutral',
    selectionSeed: 0,
    ...overrides,
  };
}

function searchTerrain(terrain: ReturnType<typeof buildTerrain>, variant: DagTVariant, candidates?: number[]) {
  const tileMap = new Map(terrain.tiles.map(t => [t.id, t]));
  const depthById = computeDependencyDepth(terrain.tiles, tileMap);
  return searchDeadlockCores({
    variant,
    candidateTiles: terrain.tiles.filter(t =>
      (candidates ?? terrain.tiles.filter(x => !x.isConst).map(x => x.id)).includes(t.id)),
    depsOf: terrain.depsOf,
    descendants: terrain.descendants,
    ancestors: terrain.ancestors,
    depthById,
  }, { searchLimit: 256 });
}

const CORE_IDS = [1, 3, 4, 5, 6, 7, 8, 10, 11, 12].join(',');

test('规范骨架：直接依赖命中、核心与完整闭包 ≥ 8', () => {
  const variant = canonicalVariant(12, 3);
  const terrain = buildTerrain(identitySkeleton());
  const cores = searchTerrain(terrain, variant);
  assert.ok(cores.length > 0, '应找到骨架匹配');
  assert.ok(cores.some(c => c.coreTileIds.join(',') === CORE_IDS), '应包含恒等骨架核心');
  for (const core of cores) {
    assert.equal(core.coreMapping.size, 10);
    assert.equal(core.wildcardPool.length, 2);
  }
  const embedding = selectDeadlockEmbedding(variant, cores, terrain.depsOf, ctx(terrain));
  assert.ok(embedding, '应选出完整包含');
  assert.equal(embedding.mapping.size, 12);
  for (const size of embedding.closures.values()) assert.ok(size >= 8);
});

test('模板边穿过不可选牌（const）→ 闭包过滤拒绝', () => {
  const variant = canonicalVariant(12, 3);
  const specs = identitySkeleton();
  // A(7) 的依赖改为经由 const 牌 100 下探到 3：7→100→3。100 不可作为死锁牌，
  // 因此 3 在所选子图内不再是 7 的直接依赖 → hub 色核心闭包 = 6 < 7 → 拒绝。
  const t7 = specs.find(s => s.id === 7)!;
  t7.deps = [100, 4, 5, 6];
  specs.push({ id: 100, deps: [3], pos: [5, 50], isConst: true });
  const terrain = buildTerrain(specs);
  const cores = searchTerrain(terrain, variant);
  assert.equal(cores.length, 0, '穿过不可选牌的骨架不应通过闭包过滤');
});

test('额外直接依赖边（超集语义）不破坏死锁', () => {
  const variant = canonicalVariant(12, 3);
  const specs = identitySkeleton();
  const t10 = specs.find(s => s.id === 10)!;
  t10.deps = [7, 8, 11]; // 模板外的额外边
  const terrain = buildTerrain(specs);
  const cores = searchTerrain(terrain, variant);
  assert.ok(cores.length > 0);
  const embedding = selectDeadlockEmbedding(variant, cores, terrain.depsOf, ctx(terrain));
  assert.ok(embedding);
  for (const size of embedding.closures.values()) assert.ok(size >= 8);
});

test('候选过滤（const / 结构牌）由调用方控制：剔除底座后无匹配', () => {
  const variant = canonicalVariant(12, 3);
  const terrain = buildTerrain(identitySkeleton());
  const allowed = terrain.tiles.filter(t => t.id !== 3 && t.id !== 4).map(t => t.id);
  const cores = searchTerrain(terrain, variant, allowed);
  assert.equal(cores.length, 0);
});

test('深浅偏好：deepest 选择平均逻辑深度更大的包含', () => {
  const variant = canonicalVariant(12, 3);
  // 骨架 B（13..24）整体更深：底座与 wildcard 下探到 30
  const bSpecs = identitySkeleton(12);
  for (const s of bSpecs) {
    if (s.id <= 18 || s.id === 14 || s.id === 21) {
      s.deps = [...(s.deps ?? []), 30];
    }
  }
  bSpecs.push({ id: 30, deps: [], pos: [1010, 50] });
  const terrain = buildTerrain([...identitySkeleton(), ...bSpecs]);

  const cores = searchTerrain(terrain, variant);
  assert.ok(cores.length > 0);
  const deep = selectDeadlockEmbedding(variant, cores, terrain.depsOf, ctx(terrain, { depthPreference: 'deepest' }));
  const shallow = selectDeadlockEmbedding(variant, cores, terrain.depsOf, ctx(terrain, { depthPreference: 'shallowest' }));
  assert.ok(deep && shallow);
  assert.ok(deep.depthScore > shallow.depthScore,
    `deepest=${deep.depthScore} 应大于 shallowest=${shallow.depthScore}`);
});

test('疏密偏好：densest 选择空间聚拢的包含、sparsest 选择分散的', () => {
  const variant = canonicalVariant(12, 3);
  const terrain = buildTerrain([...identitySkeleton(), ...identitySkeleton(12)]);
  const cores = searchTerrain(terrain, variant);
  assert.ok(cores.length > 0);
  const dense = selectDeadlockEmbedding(variant, cores, terrain.depsOf, ctx(terrain, { densityPreference: 'densest' }));
  const sparse = selectDeadlockEmbedding(variant, cores, terrain.depsOf, ctx(terrain, { densityPreference: 'sparsest' }));
  assert.ok(dense && sparse);
  assert.ok(dense.densityScore < sparse.densityScore,
    `densest=${dense.densityScore} 应小于 sparsest=${sparse.densityScore}`);
});

test('无包含：平坦地形返回空匹配、选择返回 null', () => {
  const variant = canonicalVariant(12, 3);
  const terrain = buildTerrain(Array.from({ length: 15 }, (_, i) => ({ id: i + 1 })));
  const cores = searchTerrain(terrain, variant);
  assert.equal(cores.length, 0);
  assert.equal(selectDeadlockEmbedding(variant, cores, terrain.depsOf, ctx(terrain)), null);
});

test('确定性：同输入两次搜索+选择结果逐位一致', () => {
  const variant = canonicalVariant(12, 3);
  const terrain = buildTerrain([...identitySkeleton(), ...identitySkeleton(12)]);
  const run = () => {
    const cores = searchTerrain(terrain, variant);
    const emb = selectDeadlockEmbedding(variant, cores, terrain.depsOf,
      ctx(terrain, { depthPreference: 'deepest', densityPreference: 'densest', selectionSeed: 42 }));
    assert.ok(emb);
    return JSON.stringify({
      mapping: [...emb.mapping.entries()].sort((a, b) => a[0] - b[0]),
      closures: [...emb.closures.entries()].sort((a, b) => a[0] - b[0]),
      scores: [emb.depthScore, emb.densityScore],
    });
  };
  assert.equal(run(), run());
});

test('verifyFullEmbedding：闭包不足时抛错', () => {
  const variant = canonicalVariant(12, 3);
  const terrain = buildTerrain(identitySkeleton());
  const chosenIds = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const colorOf = new Map<number, number>();
  for (const n of variant.nodes) colorOf.set(n.id, n.color);
  const closures = verifyFullEmbedding(chosenIds, colorOf, terrain.depsOf);
  for (const size of closures.values()) assert.equal(size, 8);
});

test('Q1 闭环：底座经 wildcard 桥接的包含不再被遗漏', () => {
  const variant = canonicalVariant(12, 3);
  // A(7) 只依赖 100；100 依赖四个底座 3,4,5,6。100 必须被选为 wildcard 桥接。
  const specs: TileSpec[] = identitySkeleton().map(s => (s.id === 7 ? { ...s, deps: [100] } : s));
  specs.push({ id: 100, deps: [3, 4, 5, 6], pos: [15, 50] });
  const terrain = buildTerrain(specs);
  const cores = searchTerrain(terrain, variant);
  // 纯净核心（100 不在核心内）必须被找到
  const clean = cores.find(c => c.coreTileIds.join(',') === CORE_IDS);
  assert.ok(clean, '纯净核心（wildcard 桥接底座）应被枚举');
  // 选择出的完整包含必须含桥接牌 100，且闭包 ≥ 8
  const embedding = selectDeadlockEmbedding(variant, cores, terrain.depsOf, ctx(terrain));
  assert.ok(embedding);
  assert.ok([...embedding.mapping.values()].includes(100), '桥接牌 100 必须被选为 wildcard');
  for (const size of embedding.closures.values()) assert.ok(size >= 8);
});

test('连接式引擎与通用回溯引擎在合成地形上结果一致', () => {
  const variant = canonicalVariant(12, 3);
  const terrain = buildTerrain(identitySkeleton());
  const joinCores = searchTerrain(terrain, variant);
  const genericCores = searchGenericCoresImpl({
    variant,
    candidateTiles: terrain.tiles,
    depsOf: terrain.depsOf,
    descendants: terrain.descendants,
    ancestors: terrain.ancestors,
  }, 256);
  const setsOf = (cores: typeof joinCores) =>
    cores.map(c => c.coreTileIds.join(',')).sort();
  assert.deepEqual(setsOf(joinCores), setsOf(genericCores));
});

test('全部包含：两个互不干扰的骨架都被枚举', () => {
  const variant = canonicalVariant(12, 3);
  // 骨架 B：角色 +100，位置偏移 1000
  const bSpecs = identitySkeleton(100);
  const terrain = buildTerrain([...identitySkeleton(), ...bSpecs]);
  const cores = searchTerrain(terrain, variant);
  const sets = cores.map(c => c.coreTileIds.join(','));
  const coreA = CORE_IDS;
  const coreB = CORE_IDS.split(',').map(id => String(Number(id) + 100)).join(',');
  assert.ok(sets.includes(coreA), '骨架 A 核心应被枚举');
  assert.ok(sets.includes(coreB), '骨架 B 核心应被枚举');
  assert.ok(cores.length >= 2);
});

test('种子随机序枚举：任意种子 × limit≥1 均不丢包含', () => {
  const variant = canonicalVariant(12, 3);
  const terrains = [
    buildTerrain(identitySkeleton()),
    buildTerrain([...identitySkeleton(), ...identitySkeleton(100)]),
    buildTerrain(identitySkeleton().map(s => (s.id === 7 ? { ...s, deps: [300] } : s)).concat([
      { id: 300, deps: [3, 4, 5, 6], pos: [15, 50] },
    ])),
  ];
  for (const terrain of terrains) {
    for (let seed = 0; seed < 12; seed++) {
      for (const limit of [1, 4, 16, 256]) {
        const cores = searchDeadlockCores({
          variant,
          candidateTiles: terrain.tiles,
          depsOf: terrain.depsOf,
          descendants: terrain.descendants,
          ancestors: terrain.ancestors,
        }, { searchLimit: limit, enumerationSeed: seed });
        assert.ok(cores.length >= 1,
          `seed=${seed} limit=${limit} 应至少返回 1 个包含（地形必含 dagT）`);
        assert.ok(cores.length <= limit, '返回数量不得超过上限');
        // 每个返回的核心都必须能通过完整闭包验证（有合法 wildcard 完成）
        const embedding = selectDeadlockEmbedding(variant, cores, terrain.depsOf,
          ctx(terrain, { selectionSeed: seed }));
        assert.ok(embedding, `seed=${seed} limit=${limit} 应能选出合法嵌入`);
        for (const size of embedding.closures.values()) assert.ok(size >= 8);
      }
    }
  }
});

test('枚举种子确定性：同 seed 两次结果逐位一致', () => {
  const variant = canonicalVariant(12, 3);
  const terrain = buildTerrain([...identitySkeleton(), ...identitySkeleton(100)]);
  const run = (seed: number): string => {
    const cores = searchDeadlockCores({
      variant,
      candidateTiles: terrain.tiles,
      depsOf: terrain.depsOf,
      descendants: terrain.descendants,
      ancestors: terrain.ancestors,
    }, { searchLimit: 16, enumerationSeed: seed });
    return JSON.stringify(cores.map(c => c.coreTileIds));
  };
  for (const seed of [0, 1, 7, 42]) {
    assert.equal(run(seed), run(seed), `seed=${seed} 应确定性`);
  }
  // 候选集较大时不同种子应产生不同采样（小候选集洗牌可能同序，属合法情形）
  const wide = buildTerrain([
    ...identitySkeleton(),
    ...identitySkeleton(100),
    ...identitySkeleton(200),
    ...identitySkeleton(300),
  ]);
  const runWide = (seed: number): string => JSON.stringify(searchDeadlockCores({
    variant,
    candidateTiles: wide.tiles,
    depsOf: wide.depsOf,
    descendants: wide.descendants,
    ancestors: wide.ancestors,
  }, { searchLimit: 8, enumerationSeed: seed }).map(c => c.coreTileIds));
  assert.notEqual(runWide(0), runWide(1), '大候选集下不同种子应产生不同采样');
});

test('weightedSampleOrder：确定性 + 首位概率 ≈ 1 − bias', () => {
  // 确定性：同 seed 同序
  const order1 = weightedSampleOrder([1, 2, 3, 4, 5], id => id, 1, mulberry32(7), 0.5);
  const order2 = weightedSampleOrder([1, 2, 3, 4, 5], id => id, 1, mulberry32(7), 0.5);
  assert.deepEqual(order1, order2);
  // 首位 = 得分最高者（dir=1 时 5）的频率 ≈ 1 − bias
  let top = 0;
  const N = 5000;
  for (let i = 0; i < N; i++) {
    const order = weightedSampleOrder([1, 2, 3, 4, 5], id => id, 1, mulberry32(i), 0.1);
    if (order[0] === 5) top++;
  }
  const rate = top / N;
  assert.ok(rate > 0.85 && rate < 0.95, `首位频率 ${rate.toFixed(3)} 应在 [0.85, 0.95]`);
});

test('引导枚举 deepest：深骨架优先命中（bias=0.05, 64 种子 ≥ 50 次）', () => {
  const variant = canonicalVariant(12, 3);
  // 深骨架：offset 100，底座与 wildcard 下探到 130（深度 2-4，均值 ≈2.7）
  const bSpecs = identitySkeleton(100);
  for (const s of bSpecs) {
    if (s.id <= 106 || s.id === 102 || s.id === 109) {
      s.deps = [...(s.deps ?? []), 130];
    }
  }
  bSpecs.push({ id: 130, deps: [], pos: [1010, 50] });
  const terrain = buildTerrain([...identitySkeleton(), ...bSpecs]);
  let deepHits = 0;
  for (let seed = 0; seed < 64; seed++) {
    const cores = searchDeadlockCores({
      variant,
      candidateTiles: terrain.tiles,
      depsOf: terrain.depsOf,
      descendants: terrain.descendants,
      ancestors: terrain.ancestors,
    }, { searchLimit: 1, enumerationSeed: seed, guide: 'deepest', guideBias: 0.05 });
    assert.ok(cores.length >= 1, `seed=${seed} 引导枚举不得丢包含`);
    const embedding = selectDeadlockEmbedding(variant, cores, terrain.depsOf, ctx(terrain));
    assert.ok(embedding);
    if (embedding.depthScore >= 2.4) deepHits++;
  }
  assert.ok(deepHits >= 50, `deepest 引导应显著偏向深骨架（实际 ${deepHits}/64）`);
});

test('引导枚举 densest：同簇命中（bias=0.05, 64 种子 ≥ 50 次）', () => {
  const variant = canonicalVariant(12, 3);
  // 两个骨架相距 1000；密度得分：同簇 ≈ 2860，跨簇 ≥ 20000
  const terrain = buildTerrain([...identitySkeleton(), ...identitySkeleton(100)]);
  let denseHits = 0;
  for (let seed = 0; seed < 64; seed++) {
    const cores = searchDeadlockCores({
      variant,
      candidateTiles: terrain.tiles,
      depsOf: terrain.depsOf,
      descendants: terrain.descendants,
      ancestors: terrain.ancestors,
    }, { searchLimit: 1, enumerationSeed: seed, guide: 'densest', guideBias: 0.05 });
    assert.ok(cores.length >= 1, `seed=${seed} 引导枚举不得丢包含`);
    const embedding = selectDeadlockEmbedding(variant, cores, terrain.depsOf, ctx(terrain, { densityPreference: 'densest' }));
    assert.ok(embedding);
    if (embedding.densityScore < 8000) denseHits++;
  }
  assert.ok(denseHits >= 50, `densest 引导应显著偏向同簇（实际 ${denseHits}/64）`);
});


test('preferenceStrengthToBias：连续强度映射与钳制', () => {
  assert.equal(preferenceStrengthToBias(0.5), 0.5, '默认强度 0.5 → bias 0.5');
  assert.ok(Math.abs(preferenceStrengthToBias(0) - 0.95) < 1e-9, '0 → 接近均匀');
  assert.ok(Math.abs(preferenceStrengthToBias(1) - 0.02) < 1e-9, '1 → 接近严格排序');
  assert.ok(Math.abs(preferenceStrengthToBias(-1) - 0.95) < 1e-9, '越界钳制下界');
  assert.ok(Math.abs(preferenceStrengthToBias(2) - 0.02) < 1e-9, '越界钳制上界');
  // 线性段
  assert.ok(Math.abs(preferenceStrengthToBias(0.8) - 0.2) < 1e-9);
});
