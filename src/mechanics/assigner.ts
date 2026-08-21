/**
 * 机制分配器 — Unity _InnerTileMatchAlgo/RuleBasedAlgo/TileExtraAssigner 的确定性移植。
 *
 * 对齐契约（与 Unity 逐位一致）：
 * - 输入：非 const 牌列表 + extraConfig（enum→数量，是"分配请求"而非校验对象）+ 种子
 * - 确定性随机：Xorshift128+（SplitMix64 种子扩展），即 Unity DeterministicRandom
 * - 分配顺序：按约束强度（order）升序，同 order 按枚举升序；约束强的先占位
 * - 固定花色挂件：数量向下取 3 的倍数（三消约束），并直接改写 tile 花色
 * - 白名单互斥；预置可让位挂件（问号/翻转）先驱逐、后按白名单恢复
 * - 202/207 忽略配置数量（自动数量）；泡泡(39)与大型地形(51-53)由调用方先 splitMechanicConfig 拆出
 *
 * 随机消费顺序 = 输入 tile 列表顺序；与 Unity 对齐时需以 getCanonicalTileOrder 顺序传入
 * （buildGameFromReplay 即如此）。
 */

import { logger } from '../logger.js';
import { PileType, TileFlag } from '../solver/types.js';
import type { OfflineTile } from '../solver/types.js';
import { initExtraState } from './extras.js';
import { mechanicInfo } from './registry.js';
import { serializeMechanicCounts } from './spec.js';
import type { MechanicCounts } from './spec.js';
import type { TileExtra } from './types.js';

// ═══════════════════════════════════════════════════════════
//  确定性随机 — Xorshift128+（对齐 Unity DeterministicRandom.cs）
// ═══════════════════════════════════════════════════════════

const U64 = (1n << 64n) - 1n;
const SPLITMIX_GOLDEN = 0x9E3779B97F4A7C15n;
const SPLITMIX_M1 = 0xBF58476D1CE4E5B9n;
const SPLITMIX_M2 = 0x94D049BB133111EBn;

/** 确定性随机数生成器 — Xorshift128+（SplitMix64 种子扩展），与 Unity DeterministicRandom 逐位一致。 */
export class AssignerRandom {
  private s0: bigint;
  private s1: bigint;

  constructor(seed: number) {
    // SplitMix64：把 32 位种子扩展为 128 位初始状态（C# (ulong)seed 语义，负数取补码）
    let state = BigInt(seed) & U64;
    state = (state + SPLITMIX_GOLDEN) & U64;
    let z = state;
    z = ((z ^ (z >> 30n)) * SPLITMIX_M1) & U64;
    z = ((z ^ (z >> 27n)) * SPLITMIX_M2) & U64;
    this.s0 = (z ^ (z >> 31n)) & U64;
    state = (state + SPLITMIX_GOLDEN) & U64;
    z = state;
    z = ((z ^ (z >> 30n)) * SPLITMIX_M1) & U64;
    z = ((z ^ (z >> 27n)) * SPLITMIX_M2) & U64;
    this.s1 = (z ^ (z >> 31n)) & U64;
    // 避免全 0 状态（Xorshift 的致命缺陷）
    if (this.s0 === 0n && this.s1 === 0n) {
      this.s0 = 0x123456789ABCDEFn;
      this.s1 = 0xFEDCBA987654321n;
    }
  }

  /** Xorshift128+ 核心：64 位无符号随机数。 */
  private next64(): bigint {
    const s1 = this.s0;
    const s0 = this.s1;
    const result = (s0 + s1) & U64;
    this.s0 = s0;
    let t = s1;
    t = (t ^ (t << 23n)) & U64;
    this.s1 = (t ^ s0 ^ (t >> 18n) ^ (s0 >> 5n)) & U64;
    return result;
  }

  /** [0, maxValue) 整数（对齐 DeterministicRandom.Next(int)）。 */
  next(maxValue: number): number {
    if (maxValue <= 0) return 0;
    return Number(this.next64() % BigInt(maxValue));
  }

  /** [minValue, maxValue) 整数（对齐 DeterministicRandom.Next(int, int)）。 */
  nextRange(minValue: number, maxValue: number): number {
    if (minValue >= maxValue) return minValue;
    const range = maxValue - minValue;
    return minValue + Number(this.next64() % BigInt(range));
  }

  /** Fisher-Yates 原地洗牌（对齐 DeterministicRandom.Shuffle(List)）。 */
  shuffle<T>(list: T[]): void {
    for (let i = list.length - 1; i > 0; i--) {
      const j = this.next(i + 1);
      [list[i], list[j]] = [list[j], list[i]];
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  分配策略配置（对齐 Unity TileExtraAssigner.ExtraConfig）
// ═══════════════════════════════════════════════════════════

export type AssignerStrategy =
  | 'most-frequent-first'
  | 'least-frequent-first'
  | 'random'
  | 'random-top-layer'
  | 'random-non-clickable'
  | 'random-non-clickable-most-dense-layer-excluding-top'
  | 'fifth-lowest-cost-group'
  | 'each-layer-two-bottom-first'
  | 'random-layer-less-tile';

interface ExtraAssignConfig {
  /** 分配顺序：越小越先（约束强的先占位，避免自由挂件占位导致严格挂件无处可放） */
  order: number;
  strategy: AssignerStrategy;
  /** 预置时是否可暂移让位（true = 无固定花色 + 兼容性强，不影响颜色约束） */
  canEvacuate: boolean;
}

/** 注册在分配器上的机制 → 策略配置（其余 tile-count 机制走默认 MostFrequentFirst、order 最大）。 */
export const EXTRA_ASSIGN_CONFIG: Record<number, ExtraAssignConfig> = {
  4:   { order: 0, strategy: 'least-frequent-first', canEvacuate: false }, // 黄金挂件
  8:   { order: 0, strategy: 'least-frequent-first', canEvacuate: false }, // 复活节挂件
  31:  { order: 1, strategy: 'most-frequent-first', canEvacuate: false },  // 魔药
  36:  { order: 1, strategy: 'fifth-lowest-cost-group', canEvacuate: false }, // 蒲公英
  5:   { order: 2, strategy: 'least-frequent-first', canEvacuate: false }, // 金币
  37:  { order: 3, strategy: 'most-frequent-first', canEvacuate: false },  // 礼盒
  2:   { order: 4, strategy: 'random', canEvacuate: true },                // 问号
  202: { order: 4, strategy: 'each-layer-two-bottom-first', canEvacuate: true }, // 问号(间隔策略)
  7:   { order: 5, strategy: 'random-non-clickable', canEvacuate: true },  // 翻转
  207: { order: 5, strategy: 'random-layer-less-tile', canEvacuate: true },// 翻转(层策略)
};

/** 同 tile 多挂件白名单（单向配置 → 双向映射；对齐 Unity WhitelistConfig/BuildWhitelist）。 */
const EXTRA_WHITELIST_CONFIG: Array<[number, number[]]> = [
  [4, []],                                    // 黄金：不与任何挂件共存
  [8, []],                                    // 复活节：不与任何挂件共存
  [5, [2, 202, 7, 207]],                      // 金币：可搭问号/翻转
  [31, [7, 207, 2, 202]],                     // 魔药：可搭问号/翻转
  [36, [7, 207, 2, 202]],                     // 蒲公英：可搭问号/翻转
  [2, [5]], [202, [5]], [7, [5]], [207, [5]], // 问号/翻转：可搭金币
];

function buildWhitelist(): Map<number, Set<number>> {
  const map = new Map<number, Set<number>>();
  for (const [owner, allowed] of EXTRA_WHITELIST_CONFIG) {
    let ownerSet = map.get(owner);
    if (!ownerSet) { ownerSet = new Set(); map.set(owner, ownerSet); }
    for (const a of allowed) ownerSet.add(a);
    for (const a of allowed) {
      let aSet = map.get(a);
      if (!aSet) { aSet = new Set(); map.set(a, aSet); }
      aSet.add(owner);
    }
  }
  return map;
}
const EXTRA_WHITELIST = buildWhitelist();

/** Tower 检测坐标单位（对齐 Unity LargeTerrainTileUtils.TileUnit = tile 宽度 10）。 */
const TILE_UNIT = 10;

// ═══════════════════════════════════════════════════════════
//  分配入口
// ═══════════════════════════════════════════════════════════

interface AssignRequest {
  value: number;
  count: number;
  fixedColor: number;
  strategy: AssignerStrategy;
}

export interface AssignExtrasSummary {
  /** 每种机制实际分配到 tile 上的数量 */
  assignedCounts: Map<number, number>;
  /** 固定花色约束调整（原请求 → 实际，向下取 3 的倍数） */
  adjusted: Array<{ value: number; requested: number; actual: number }>;
  /** 被严格挂件排挤丢弃的预置可让位挂件数量 */
  evictedPreplaced: number;
}

/** FNV-1a 32-bit（确定性纯函数，用作分配种子哈希）。 */
function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/**
 * 分配种子 = hash(replayCode + 分配请求文本) 的低 31 位（纯函数，零协调）。
 *
 * 跨侧契约（与 Unity FixedReplayCodeAlgorithm 逐位一致）：
 * - mechanics 必须是"可分配子集"（已由 splitMechanicConfig 拆出泡泡 39 / 大型地形 51-53），
 *   与 Unity ApplyExtraConfig 收到的 extraConfig 同构；
 * - 文本 = replayCode + "|" + 按枚举升序的 "31:3,36:3" 逗号连接（serializeMechanicCounts）；
 * - 哈希 = FNV-1a 32 位，取低 31 位。
 * 同一关（地形+replay+机制）→ 同一种子 → 同一挂件布局；不同 replay/机制 → 大概率不同布局。
 * 地形身份已内嵌在 replayCode 的 levelHash 中，无需单独传入。
 */
export function deriveAssignSeed(replayCode: string, mechanics: MechanicCounts): number {
  const text = replayCode + '|' + serializeMechanicCounts(mechanics);
  return fnv1a32(text) & 0x7fffffff;
}

/** 棋盘特殊物障碍牌（51-53）：不参与花色/挂件分配（对齐 Unity emptyTiles.RemoveAll(IsBoardSpecialObstacle)）。 */
function isBoardSpecialObstacle(tile: OfflineTile): boolean {
  return tile.extras.some(e => e.extraEnum === 51 || e.extraEnum === 52 || e.extraEnum === 53);
}

/**
 * 装载期机制分配（对齐 Unity ApplyExtraConfig → AssignExtrasWithColorConstraints）。
 * 就地改写 tiles 的 extras 与固定花色，返回分配摘要。
 * 调用方需先 splitMechanicConfig 拆出泡泡(39)与大型地形(51-53)。
 * 输入 tile 顺序 = 随机消费顺序；与 Unity 对齐时传 getCanonicalTileOrder 顺序。
 * towerExcludedTileIds：Tower 判定应排除的非地形牌（对齐 IsTerrain：
 * originalPile==1 的初始 Dock 牌 + 51-53 棋盘特殊物）。
 */
export function assignTileExtras(
  tiles: OfflineTile[],
  extraConfig: MechanicCounts,
  seed: number,
  towerExcludedTileIds?: ReadonlySet<number>,
): AssignExtrasSummary {
  const summary: AssignExtrasSummary = { assignedCounts: new Map(), adjusted: [], evictedPreplaced: 0 };
  const assignable = tiles.filter(t => !t.config.isConst && !isBoardSpecialObstacle(t));
  if (assignable.length === 0 || extraConfig.size === 0) return summary;

  const requests = parseConfig(extraConfig);
  if (requests.length === 0) return summary;
  requests.sort((a, b) => assignOrder(a.value) - assignOrder(b.value) || a.value - b.value);

  const rng = new AssignerRandom(seed);
  const evacuated = evacuateFreeExtras(assignable);
  const constraints = adjustAndBuildConstraints(requests, assignable.length, summary);
  for (const req of requests) assignRequest(assignable, req, rng, summary, towerExcludedTileIds);
  const evicted = restoreEvacuatedExtras(evacuated);
  summary.evictedPreplaced = evicted;
  validateFinalDistribution(assignable, constraints);

  const assigned = [...summary.assignedCounts.entries()].map(([v, c]) => v + 'x' + c).join(', ');
  const adjusted = summary.adjusted.length
    ? ' | 固定花色取整: ' + summary.adjusted.map(a => a.value + ':' + a.requested + '→' + a.actual).join(', ')
    : '';
  logger.info('机制分配完成 [seed=' + seed + ']: ' + (assigned || '(无)') + adjusted + (evicted ? ' | 驱逐预置挂件 ' + evicted : ''));
  return summary;
}

function assignOrder(value: number): number {
  return EXTRA_ASSIGN_CONFIG[value]?.order ?? Number.MAX_SAFE_INTEGER;
}

/** 解析配置为请求对象：过滤未知枚举与 None/Empty；数量不做过滤（202/207 自动数量策略自行解释）。 */
function parseConfig(extraConfig: MechanicCounts): AssignRequest[] {
  const requests: AssignRequest[] = [];
  for (const [value, count] of extraConfig) {
    const info = mechanicInfo(value);
    if (!info || value === 0 || value === -1) continue;
    requests.push({
      value,
      count,
      fixedColor: info.fixedElementValue ?? 0,
      strategy: EXTRA_ASSIGN_CONFIG[value]?.strategy ?? 'most-frequent-first',
    });
  }
  return requests;
}

/** 移出预置的可让位挂件（问号/翻转），为严格挂件清空场地；返回暂存列表供恢复。 */
function evacuateFreeExtras(tiles: OfflineTile[]): Array<{ tile: OfflineTile; extra: TileExtra }> {
  const evacuated: Array<{ tile: OfflineTile; extra: TileExtra }> = [];
  for (const tile of tiles) {
    for (let i = tile.extras.length - 1; i >= 0; i--) {
      if (EXTRA_ASSIGN_CONFIG[tile.extras[i].extraEnum]?.canEvacuate) {
        evacuated.push({ tile, extra: tile.extras[i] });
        tile.extras.splice(i, 1);
      }
    }
  }
  return evacuated;
}

/** 固定花色约束：数量取 min(请求, 剩余) 并向下取 3 的倍数；记录调整并累计各花色期望总数。 */
function adjustAndBuildConstraints(requests: AssignRequest[], tileCount: number, summary: AssignExtrasSummary): Map<number, number> {
  const constraints = new Map<number, number>();
  let remaining = tileCount;
  for (const req of requests) {
    if (req.fixedColor <= 0 || req.count <= 0) continue;
    let allowed = Math.min(req.count, remaining);
    allowed -= allowed % 3;
    if (allowed !== req.count) summary.adjusted.push({ value: req.value, requested: req.count, actual: allowed });
    req.count = allowed;
    remaining -= allowed;
    constraints.set(req.fixedColor, (constraints.get(req.fixedColor) ?? 0) + allowed);
  }
  return constraints;
}

/** 执行单个请求：白名单筛选候选（207 额外排除 Tower 成员）→ 按策略选 tile → 附加挂件/固定花色。 */
function assignRequest(
  tiles: OfflineTile[],
  req: AssignRequest,
  rng: AssignerRandom,
  summary: AssignExtrasSummary,
  towerExcludedTileIds?: ReadonlySet<number>,
): void {
  const candidates = tiles.filter(t => canAttach(req.value, t.extras));
  if (req.value === 207) {
    const towerIds = detectTowerTileIds(tiles, towerExcludedTileIds);
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (towerIds.has(candidates[i].id)) candidates.splice(i, 1);
    }
  }
  if (candidates.length === 0) return;

  const selected = selectTiles(rng, tiles, candidates, req);
  for (const tile of selected) {
    if (req.fixedColor > 0) tile.elementValue = req.fixedColor;
    attachExtra(tile, req.value);
  }
  if (selected.length > 0) summary.assignedCounts.set(req.value, selected.length);
}

/** 白名单兼容性检查：空 tile 恒可挂；非空时同 tile 现有挂件必须全部在白名单内。 */
function canAttach(type: number, existing: TileExtra[]): boolean {
  if (existing.length === 0) return true;
  const whitelist = EXTRA_WHITELIST.get(type);
  if (!whitelist || whitelist.size === 0) return false;
  return existing.every(e => whitelist.has(e.extraEnum));
}

/** 附加挂件（对齐 AttachExtra：Init 运行时状态后挂载）。 */
function attachExtra(tile: OfflineTile, value: number): void {
  const extra: TileExtra = { extraEnum: value, extraParam: '' };
  initExtraState(extra);
  tile.extras.push(extra);
}

/** 恢复被移出的预置挂件：与当前挂件白名单兼容则复原，否则被排挤丢弃。 */
function restoreEvacuatedExtras(evacuated: Array<{ tile: OfflineTile; extra: TileExtra }>): number {
  let evicted = 0;
  for (const { tile, extra } of evacuated) {
    if (canAttach(extra.extraEnum, tile.extras)) tile.extras.push(extra);
    else evicted++;
  }
  return evicted;
}

/** 校验最终花色分布（仅日志，对齐 Unity ValidateFinalDistribution）。 */
function validateFinalDistribution(tiles: OfflineTile[], constraints: Map<number, number>): void {
  if (constraints.size === 0) return;
  const actual = new Map<number, number>();
  for (const t of tiles) actual.set(t.elementValue, (actual.get(t.elementValue) ?? 0) + 1);
  const mismatches: string[] = [];
  for (const [color, expected] of constraints) {
    const got = actual.get(color) ?? 0;
    if (got !== expected) mismatches.push('色' + color + ':期望' + expected + ',实际' + got);
  }
  if (mismatches.length > 0) logger.warn('机制分配后花色分布不符: ' + mismatches.join('; '));
}

// ═══════════════════════════════════════════════════════════
//  TileSelector 策略实现（对齐 Unity TileSelector，含 ExtraAssignmentAnalyzer）
// ═══════════════════════════════════════════════════════════

function selectTiles(rng: AssignerRandom, tiles: OfflineTile[], candidates: OfflineTile[], req: AssignRequest): OfflineTile[] {
  if (candidates.length === 0) return [];
  const target = Math.min(req.count, candidates.length);
  switch (req.strategy) {
    case 'most-frequent-first': return selectByFrequency(rng, candidates, target, req.fixedColor, true);
    case 'least-frequent-first': return selectByFrequency(rng, candidates, target, req.fixedColor, false);
    case 'random-top-layer': return selectTopLayer(rng, candidates, target);
    case 'random-non-clickable': return selectNonClickable(rng, candidates, target);
    case 'random-non-clickable-most-dense-layer-excluding-top':
      return selectNonClickableInMostDenseLayerExcludingTop(rng, candidates, target);
    case 'fifth-lowest-cost-group': return selectByFifthLowestCostGroup(tiles, candidates, target);
    case 'each-layer-two-bottom-first': return selectEachLayerTwoBottomFirst(rng, candidates, target);
    case 'random-layer-less-tile': return selectRandomLayerLessTile(rng, candidates, target);
    default: return selectRandom(rng, candidates, target);
  }
}

function selectRandom(rng: AssignerRandom, list: OfflineTile[], count: number): OfflineTile[] {
  const shuffled = [...list];
  rng.shuffle(shuffled);
  return shuffled.slice(0, count);
}

function selectTopLayer(rng: AssignerRandom, candidates: OfflineTile[], count: number): OfflineTile[] {
  const minLayer = Math.min(...candidates.map(t => t.config.layer));
  return selectRandom(rng, candidates.filter(t => t.config.layer === minLayer), count);
}

/** 点击判定（对齐 IsClickable：优先 flag，其次运行时依赖，最后结构依赖）。 */
function isClickable(t: OfflineTile): boolean {
  if (t.hasFlag(TileFlag.Clickable)) return true;
  if (t.runtimeDependencies.size > 0) return false;
  return t.config.dependencies.length === 0;
}

/** 优先不可点击 tile；全部可点击时退化为随机（保证数量）。 */
function selectNonClickable(rng: AssignerRandom, candidates: OfflineTile[], count: number): OfflineTile[] {
  const nonClickable = candidates.filter(t => !isClickable(t));
  return nonClickable.length === 0 ? selectRandom(rng, candidates, count) : selectRandom(rng, nonClickable, count);
}

/** 排除最浅层后，优先选不可点击 tile 最多的层；30% 差距内以随机平局；逐级回退到随机。 */
function selectNonClickableInMostDenseLayerExcludingTop(rng: AssignerRandom, candidates: OfflineTile[], count: number): OfflineTile[] {
  if (candidates.length === 0) return [];
  const topLayer = Math.min(...candidates.map(t => t.config.layer));
  const filtered = candidates.filter(t => t.config.layer !== topLayer);
  if (filtered.length === 0) return selectNonClickable(rng, candidates, count);

  const groups = new Map<number, OfflineTile[]>();
  for (const t of filtered) {
    if (isClickable(t)) continue;
    let g = groups.get(t.config.layer);
    if (!g) { g = []; groups.set(t.config.layer, g); }
    g.push(t);
  }
  const ranked = [...groups.entries()]
    .map(([layer, tiles]) => ({ layer, tiles, count: tiles.length }))
    .sort((a, b) => b.count - a.count || a.layer - b.layer);
  if (ranked.length === 0) return selectNonClickable(rng, filtered, count);

  const primary = ranked[0];
  if (ranked.length === 1 || primary.count <= 0) return selectRandom(rng, primary.tiles, count);
  const secondary = ranked[1];
  const countDelta = primary.count - secondary.count;
  const withinThirtyPercent = countDelta <= primary.count * 0.3;
  // 注意：与 Unity 一致，不满足 30% 条件时不消费随机数（短路）
  const targetLayer = withinThirtyPercent && rng.next(2) === 1 ? secondary : primary;
  return selectRandom(rng, targetLayer.tiles, count);
}

// ── 蒲公英：第五低成本三消组 ──

/** 牌深度（Dock=0，否则依赖数+1；对齐 GetTileDepth）。 */
function tileDepth(t: OfflineTile): number {
  if (t.pileType === PileType.Dock) return 0;
  const depCount = t.runtimeDependencies.size > 0 ? t.runtimeDependencies.size : t.config.dependencies.length;
  return depCount + 1;
}

interface MatchGroup {
  matchTiles: OfflineTile[];
  totalCost: number;
}

function collectDependencies(tile: OfflineTile, acc: Set<number>, allTiles: Map<number, OfflineTile>): void {
  const deps = tile.runtimeDependencies.size > 0 ? [...tile.runtimeDependencies] : tile.config.dependencies;
  for (const depId of deps) {
    if (acc.has(depId)) continue;
    acc.add(depId);
    const dep = allTiles.get(depId);
    if (dep) collectDependencies(dep, acc, allTiles);
  }
}

/** 三消组成本 = 依赖闭包大小（Dock 牌跳过，含自身；对齐 CalculateCost）。 */
function matchGroupCost(matchTiles: OfflineTile[], allTiles: Map<number, OfflineTile>): number {
  const allDeps = new Set<number>();
  for (const tile of matchTiles) {
    if (tile.pileType === PileType.Dock) continue;
    collectDependencies(tile, allDeps, allTiles);
    allDeps.add(tile.id);
  }
  return allDeps.size;
}

function minId(tiles: OfflineTile[]): number {
  let m = Number.POSITIVE_INFINITY;
  for (const t of tiles) if (t.id < m) m = t.id;
  return m;
}

/** 按花色生成同色三消组（每色取深度排序前 9 张的全组合），按成本/最小 ID 升序（对齐 ExtraAssignmentAnalyzer）。 */
function getMatchGroups(candidates: OfflineTile[], allTiles: Map<number, OfflineTile>): MatchGroup[] {
  if (candidates.length < 3) return [];
  const byColor = new Map<number, OfflineTile[]>();
  for (const t of candidates) {
    let g = byColor.get(t.elementValue);
    if (!g) { g = []; byColor.set(t.elementValue, g); }
    g.push(t);
  }
  const groups: MatchGroup[] = [];
  for (const [, sameColor] of byColor) {
    const ordered = [...sameColor]
      .sort((a, b) => tileDepth(a) - tileDepth(b) || a.id - b.id)
      .slice(0, 9);
    if (ordered.length < 3) continue;
    for (let i = 0; i < ordered.length - 2; i++) {
      for (let j = i + 1; j < ordered.length - 1; j++) {
        for (let k = j + 1; k < ordered.length; k++) {
          const matchTiles = [ordered[i], ordered[j], ordered[k]];
          groups.push({ matchTiles, totalCost: matchGroupCost(matchTiles, allTiles) });
        }
      }
    }
  }
  groups.sort((a, b) => a.totalCost - b.totalCost || minId(a.matchTiles) - minId(b.matchTiles));
  return groups;
}

/** 按成本升序取第五低成本三消组；组数不足 5 时取成本最高一组；循环直到剩余不足 3 张。 */
function selectByFifthLowestCostGroup(tiles: OfflineTile[], candidates: OfflineTile[], count: number): OfflineTile[] {
  if (count < 3 || candidates.length < 3) return [];
  const allTiles = new Map(tiles.map(t => [t.id, t]));
  const remaining = [...candidates];
  const result: OfflineTile[] = [];
  while (result.length + 3 <= count) {
    const groups = getMatchGroups(remaining, allTiles);
    if (groups.length === 0) break;
    const chosen = groups[Math.min(4, groups.length - 1)].matchTiles;
    result.push(...chosen);
    const chosenIds = new Set(chosen.map(t => t.id));
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (chosenIds.has(remaining[i].id)) remaining.splice(i, 1);
    }
  }
  return result;
}

// ── 问号(间隔) 202：动态数量 + 每层至多 2 张，从底层向顶层 ──

/** 等权随机低/中/高区间（对齐 RollDynamicUnknownIntervalCount，200+ 关区间）。 */
function rollDynamicUnknownIntervalCount(rng: AssignerRandom): number {
  const stage = rng.next(3);
  if (stage === 0) return rng.nextRange(1, 4);
  if (stage === 1) return rng.nextRange(4, 7);
  return rng.nextRange(7, 9);
}

function selectEachLayerTwoBottomFirst(rng: AssignerRandom, candidates: OfflineTile[], _target: number): OfflineTile[] {
  const count = rollDynamicUnknownIntervalCount(rng);
  if (count <= 0 || candidates.length === 0) return [];
  const byLayer = new Map<number, OfflineTile[]>();
  for (const t of candidates) {
    let g = byLayer.get(t.config.layer);
    if (!g) { g = []; byLayer.set(t.config.layer, g); }
    g.push(t);
  }
  const layers = [...byLayer.entries()].sort((a, b) => b[0] - a[0]);
  const selected: OfflineTile[] = [];
  for (const [, tiles] of layers) {
    if (selected.length >= count) break;
    const list = [...tiles];
    rng.shuffle(list);
    const take = Math.min(2, count - selected.length);
    selected.push(...list.slice(0, take));
  }
  return selected;
}

// ── 翻转(层) 207：随机约 10% 层（至少 1 层，排除最浅两层），整层全挂 ──
function selectRandomLayerLessTile(rng: AssignerRandom, candidates: OfflineTile[], _target: number): OfflineTile[] {
  if (candidates.length === 0) return [];
  const eligible = [...new Set(candidates.map(t => t.config.layer))]
    .filter(l => l >= 2)
    .sort((a, b) => a - b);
  if (eligible.length === 0) return [];
  const layerCount = Math.max(1, Math.round(eligible.length * 0.1));
  const keys = eligible.map(() => rng.next(0x7fffffff));
  const picked = new Set(
    eligible
      .map((layer, i) => [layer, keys[i]] as [number, number])
      .sort((a, b) => a[1] - b[1])
      .slice(0, layerCount)
      .map(p => p[0]),
  );
  return candidates.filter(t => picked.has(t.config.layer));
}

// ── 按花色频率（黄金/复活节/金币/魔药/礼盒 等） ──

/**
 * 按花色频率选择：优先目标花色（固定花色挂件），再按频率升降序、随机序、最小 ID 定序；
 * 组内再随机洗牌。随机消费顺序与 Unity LINQ 一致（每组一个随机键 + 全量洗牌）。
 */
function selectByFrequency(rng: AssignerRandom, candidates: OfflineTile[], count: number, targetColor: number, descending: boolean): OfflineTile[] {
  const byColor = new Map<number, OfflineTile[]>();
  for (const t of candidates) {
    let g = byColor.get(t.elementValue);
    if (!g) { g = []; byColor.set(t.elementValue, g); }
    g.push(t);
  }
  const groups: Array<{ color: number; tiles: OfflineTile[]; randomOrder: number; minId: number }> = [];
  for (const [color, tiles] of byColor) {
    let m = Number.POSITIVE_INFINITY;
    for (const t of tiles) if (t.id < m) m = t.id;
    groups.push({ color, tiles: [...tiles], randomOrder: rng.next(0x7fffffff), minId: m });
  }
  groups.sort((a, b) => {
    const aTarget = a.color === targetColor ? 1 : 0;
    const bTarget = b.color === targetColor ? 1 : 0;
    if (aTarget !== bTarget) return bTarget - aTarget;
    const ka = descending ? a.tiles.length : -a.tiles.length;
    const kb = descending ? b.tiles.length : -b.tiles.length;
    if (ka !== kb) return kb - ka;
    if (a.randomOrder !== b.randomOrder) return a.randomOrder - b.randomOrder;
    return a.minId - b.minId;
  });
  const result: OfflineTile[] = [];
  for (const g of groups) {
    const list = [...g.tiles];
    rng.shuffle(list);
    result.push(...list);
  }
  return result.slice(0, count);
}

// ═══════════════════════════════════════════════════════════
//  Tower 成员识别（对齐 Unity TowerDetector，仅 207 使用）
//  判定口径：相邻实际层中中心点曼哈顿距离恰为 1 的一对 Tile 组成候选链，
//  且该链必须贯穿空间相连地形组的全部实际层，才认定为 Tower 成员。
//  非地形牌不参与判定（对齐 IsTerrain）：towerExcludedTileIds（初始 Dock 牌，
//  originalPile==1）与 51-53 棋盘特殊物（IsBoardSpecialExtra）。
// ═══════════════════════════════════════════════════════════

function towerDistance(a: OfflineTile, b: OfflineTile): number {
  return Math.abs(a.config.posX - b.config.posX) + Math.abs(a.config.posY - b.config.posY);
}

function areSameTerrainGroup(a: OfflineTile, b: OfflineTile): boolean {
  return Math.abs(a.config.posX - b.config.posX) <= TILE_UNIT &&
         Math.abs(a.config.posY - b.config.posY) <= TILE_UNIT;
}

/** 对齐 Unity TowerDetector.IsTerrain：非初始 Dock 牌且非棋盘特殊物。 */
function isTerrainTile(t: OfflineTile, towerExcludedTileIds?: ReadonlySet<number>): boolean {
  if (towerExcludedTileIds?.has(t.id)) return false;
  return !t.extras.some(e => e.extraEnum === 51 || e.extraEnum === 52 || e.extraEnum === 53);
}

function detectTowerTileIds(tiles: OfflineTile[], towerExcludedTileIds?: ReadonlySet<number>): Set<number> {
  const result = new Set<number>();
  if (tiles.length === 0) return result;

  const byLayer = new Map<number, OfflineTile[]>();
  for (const t of tiles) {
    if (!isTerrainTile(t, towerExcludedTileIds)) continue;
    let g = byLayer.get(t.config.layer);
    if (!g) { g = []; byLayer.set(t.config.layer, g); }
    g.push(t);
  }
  const layers = [...byLayer.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
  if (layers.length < 2) return result;

  const adjacentPairs: Array<[OfflineTile, OfflineTile]> = [];
  for (let i = 0; i < layers.length - 1; i++) {
    for (const upper of layers[i]) {
      for (const lower of layers[i + 1]) {
        if (towerDistance(upper, lower) === 1) adjacentPairs.push([upper, lower]);
      }
    }
  }
  if (adjacentPairs.length === 0) return result;

  const candidateIds = new Set<number>();
  for (const [u, l] of adjacentPairs) { candidateIds.add(u.id); candidateIds.add(l.id); }

  const neighbors = new Map<number, Set<number>>();
  for (const t of tiles) neighbors.set(t.id, new Set());
  for (const [u, l] of adjacentPairs) {
    neighbors.get(u.id)!.add(l.id);
    neighbors.get(l.id)!.add(u.id);
  }
  for (const layer of layers) {
    for (let i = 0; i < layer.length; i++) {
      for (let j = i + 1; j < layer.length; j++) {
        const a = layer[i];
        const b = layer[j];
        if (!areSameTerrainGroup(a, b)) continue;
        neighbors.get(a.id)!.add(b.id);
        neighbors.get(b.id)!.add(a.id);
      }
    }
  }

  const remaining = new Set(tiles.map(t => t.id));
  while (remaining.size > 0) {
    const rootId = remaining.values().next().value as number;
    remaining.delete(rootId);
    const component = new Set<number>([rootId]);
    const queue: number[] = [rootId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const neighborId of neighbors.get(id)!) {
        if (!remaining.delete(neighborId)) continue;
        component.add(neighborId);
        queue.push(neighborId);
      }
    }
    if (![...component].some(id => candidateIds.has(id))) continue;

    const componentLayerIndices: number[] = [];
    for (let i = 0; i < layers.length; i++) {
      if (layers[i].some(t => component.has(t.id))) componentLayerIndices.push(i);
    }
    const firstLayerIndex = componentLayerIndices[0];
    const lastLayerIndex = componentLayerIndices[componentLayerIndices.length - 1];

    // 自顶向下：仅保留能从首层沿曼哈顿距离 1 链到达的成员
    const reachable: Set<number>[] = [
      new Set(layers[firstLayerIndex].filter(t => component.has(t.id)).map(t => t.id)),
    ];
    for (let layerIndex = firstLayerIndex + 1; layerIndex <= lastLayerIndex; layerIndex++) {
      const previous = layers[layerIndex - 1];
      const prevReachable = reachable[reachable.length - 1];
      reachable.push(new Set(
        layers[layerIndex]
          .filter(t => component.has(t.id) && previous.some(u => prevReachable.has(u.id) && towerDistance(u, t) === 1))
          .map(t => t.id),
      ));
    }

    // 自底向上：仅保留能沿链回到末层的成员（贯穿全部实际层才算 Tower）
    const complete: Set<number>[] = reachable.map(() => new Set<number>());
    complete[complete.length - 1] = reachable[reachable.length - 1];
    for (let offset = complete.length - 2; offset >= 0; offset--) {
      const layerIndex = firstLayerIndex + offset;
      complete[offset] = new Set(
        layers[layerIndex]
          .filter(t => reachable[offset].has(t.id) && layers[layerIndex + 1].some(lower =>
            complete[offset + 1].has(lower.id) && towerDistance(t, lower) === 1))
          .map(t => t.id),
      );
    }
    for (const layerMembers of complete) {
      for (const id of layerMembers) result.add(id);
    }
  }
  return result;
}
