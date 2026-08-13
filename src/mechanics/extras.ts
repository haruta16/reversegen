/**
 * 剩余挂件行为（除魔药/泡泡外）— 与 Unity 各 Extra 实现逐行对齐的确定性移植。
 *
 * 覆盖：衰减挂件（黄金4/日历6/复活节8）、揭示挂件（问号2/202/203、翻转7/207）、
 * 订单38、金币5、蒲公英36 扩散、礼盒37 加权效果、魔法棒目标选择、洗牌（ShuffleAlgo 策略2）。
 * 随机契约：战场派生种子（ExtraDeterministicRandom 同公式），两侧逐位一致。
 */

import { DotNetRandom } from '../tile-explorer/random.js';
import type { OfflineGame } from '../solver/offline-game.js';
import { OfflineTile, PileType, TileFlag } from '../solver/types.js';
import { computeVisibleMatchGroups } from '../solver/solver-player.js';
import {
  DANDELION_CONSTANTS,
  DANDELION_SINGLE_GROUP_PROBABILITY,
  DANDELION_TARGET_WHITELIST,
  GIFTBOX_CONSTANTS,
  GIFTBOX_EFFECTS,
  GIFTBOX_EFFECT_WEIGHTS,
  mechanicInfo,
} from './registry.js';
import type { TileExtra } from './types.js';

// ═══════════════════════════════════════════════════════════
//  派生种子（ExtraDeterministicRandom 同公式，两侧一致）
// ═══════════════════════════════════════════════════════════

function mul397(value: number): number {
  return (value * 397) | 0;
}

/** 战场派生种子：levelId*397^levelResID → ^dock数 → ^desk数 → ^步骤数 → ^盐。 */
export function extraActionSeed(game: OfflineGame, salt: number): number {
  let seed = mul397(game.levelId) ^ game.levelResId;
  seed = mul397(seed) ^ game.dockTiles.length;
  seed = mul397(seed) ^ game.deskTiles.length;
  seed = mul397(seed) ^ game.actionCount;
  seed = mul397(seed) ^ salt;
  return seed | 0;
}

// ═══════════════════════════════════════════════════════════
//  挂件运行时状态初始化与通用判定
// ═══════════════════════════════════════════════════════════

/** 为挂件填充运行时状态（挂载到 tile 时调用一次，对齐各 Extra.Init(param)）。 */
export function initExtraState(extra: TileExtra): void {
  const info = mechanicInfo(extra.extraEnum);
  if (!info) return;
  switch (info.paramSchema) {
    case 'decay': {
      const param = extra.extraParam ?? '';
      extra.countdown = param.length < 2 ? 4 : Number(param[1]);
      extra.isValidCollect = param.length >= 3 && param[2] === '1';
      break;
    }
    case 'reveal': {
      const param = extra.extraParam ?? '';
      extra.isDone = param.length >= 2 && param[1] === '1';
      break;
    }
    default:
      break;
  }
}

/** 挂件是否已消费（对齐 Unity IsMarkCosumed 各实现）。 */
export function isExtraConsumed(tile: OfflineTile, extra: TileExtra): boolean {
  const info = mechanicInfo(extra.extraEnum);
  if (!info) return false;
  switch (info.behavior) {
    case 'reveal': return extra.isDone === true;
    case 'decay': return extra.isValidCollect === true;
    case 'order': return extra.isConsumed === true;
    case 'magic-bottle':
    case 'dandelion':
    case 'giftbox': return tile.hasFlag(TileFlag.Destroyed);
    default: return false;
  }
}

/** 问号挂件是否尚未揭示（对齐 IsUnrevealedUnknownTile = UnknownMark）。 */
export function isUnrevealedUnknownTile(tile: OfflineTile): boolean {
  return tile.extras.some(e =>
    (e.extraEnum === 2 || e.extraEnum === 202 || e.extraEnum === 203) && e.isDone !== true);
}

// ═══════════════════════════════════════════════════════════
//  衰减挂件（黄金/日历/复活节）— OnStep 移植
// ═══════════════════════════════════════════════════════════

/** 每步衰减：Value>0 且可点击时 Value--；日历/复活节跳过魔药步。 */
export function applyDecayStep(game: OfflineGame, stepType: string | null): void {
  for (const tile of game.deskTiles) {
    for (const extra of tile.extras) {
      const info = mechanicInfo(extra.extraEnum);
      if (!info || info.behavior !== 'decay') continue;
      if (extra.countdown === undefined || extra.countdown <= 0) continue;
      if (stepType !== null && (info.decaySkip ?? []).includes(stepType)) continue;
      if (tile.isClickable) extra.countdown -= 1;
    }
  }
}

/** 收集回调钩子表：behavior → 收集语义（新增收集类行为在此登记）。 */
export type CollectHook = (tile: OfflineTile, extra: TileExtra) => void;

export const COLLECT_HOOKS: Partial<Record<string, CollectHook>> = {
  /** 衰减：Value>0 → 有效收集 + 归零 */
  decay: (_tile, extra) => {
    if (extra.countdown !== undefined && extra.countdown > 0) {
      extra.isValidCollect = true;
      extra.countdown = 0;
    }
  },
  /** 揭示：收集即 isDone */
  reveal: (_tile, extra) => { extra.isDone = true; },
  /** 订单：收集即 consumed */
  order: (_tile, extra) => { extra.isConsumed = true; },
};

/** 收集回调（OnCollect）：通过钩子表按 behavior 分发。 */
export function onTileCollected(tile: OfflineTile): void {
  for (const extra of tile.extras) {
    const info = mechanicInfo(extra.extraEnum);
    if (!info) continue;
    COLLECT_HOOKS[info.behavior]?.(tile, extra);
  }
}

// ═══════════════════════════════════════════════════════════
//  蒲公英（36）— GetDandelionTargets 移植
// ═══════════════════════════════════════════════════════════

/** IsDandelionTargetAllowed：无挂件或全部非消费挂件在白名单（仅 None/Empty）内。 */
export function isDandelionTargetAllowed(tile: OfflineTile): boolean {
  for (const extra of tile.extras) {
    if (isExtraConsumed(tile, extra)) continue;
    if (!DANDELION_TARGET_WHITELIST.includes(extra.extraEnum)) return false;
  }
  return true;
}

/** 扩散目标：最低 cost 组池取前 7，两段抽样（单组概率 0.8）。 */
export function selectDandelionTargets(game: OfflineGame, rngSeed: number): OfflineTile[] {
  const groups = computeVisibleMatchGroups(game).filter(group => {
    for (const tile of group.tiles) {
      if (tile.hasFlag(TileFlag.Destroyed)) return false;
      if (!isDandelionTargetAllowed(tile)) return false;
    }
    return true;
  });
  groups.sort((a, b) => a.totalCost !== b.totalCost ? a.totalCost - b.totalCost : a.tiles[0].id - b.tiles[0].id);
  if (groups.length === 0) return [];
  const random = new DotNetRandom(rngSeed);
  const poolA = groups.slice(0, DANDELION_CONSTANTS.TOP_CANDIDATE_POOL_SIZE);
  const selectedA = poolA[random.next(poolA.length)];
  const selectedAIds = new Set(selectedA.tiles.map(t => t.id));
  const nonOverlapping = groups.filter(g => !g.tiles.some(t => selectedAIds.has(t.id)));
  let selectedB: (typeof groups)[0] | null = null;
  if (nonOverlapping.length > 0) selectedB = nonOverlapping[random.next(nonOverlapping.length)];
  const singleGroup = selectedB === null || random.nextDouble() < DANDELION_SINGLE_GROUP_PROBABILITY;
  if (singleGroup) {
    const pickB = selectedB !== null && random.nextDouble() < 0.5;
    return (pickB ? selectedB! : selectedA).tiles;
  }
  return [...selectedA.tiles, ...selectedB!.tiles];
}

/** 蒲公英三消判定：matched 中至少 3 张蒲公英。 */
export function isDandelionMatch(matchedTiles: OfflineTile[]): boolean {
  let count = 0;
  for (const tile of matchedTiles) {
    if (tile.extras.some(e => e.extraEnum === 36)) count += 1;
  }
  return count >= DANDELION_CONSTANTS.TILES_PER_GROUP;
}

// ═══════════════════════════════════════════════════════════
//  魔法棒（礼盒 MagicWand / battle.Magic()）
// ═══════════════════════════════════════════════════════════

/** battle.Magic() 目标：Dock 非空按最多花色（首次位置破平）定向收集；否则 Desk 首牌花色取 3 张。 */
export function selectMagicWandTargets(game: OfflineGame): OfflineTile[] {
  if (game.deskTiles.length === 0) return [];
  if (game.dockTiles.length > 0) {
    const info = new Map<number, { count: number; firstIndex: number }>();
    for (let i = 0; i < game.dockTiles.length; i++) {
      const color = game.dockTiles[i].elementValue;
      const existing = info.get(color);
      if (existing) existing.count += 1;
      else info.set(color, { count: 1, firstIndex: i });
    }
    let maxCount = 0;
    for (const { count } of info.values()) maxCount = Math.max(maxCount, count);
    const selectedColor = [...info.entries()]
      .filter(([, v]) => v.count === maxCount)
      .sort((a, b) => a[1].firstIndex - b[1].firstIndex)[0][0];
    const needCount = 3 - maxCount;
    return game.deskTiles
      .filter(t => t.elementValue === selectedColor)
      .sort((a, b) => (a.extras.length > 0 ? 1 : 0) - (b.extras.length > 0 ? 1 : 0))
      .slice(0, needCount);
  }
  const elementValue = game.deskTiles[0].elementValue;
  return game.deskTiles
    .filter(t => t.elementValue === elementValue)
    .sort((a, b) => (a.extras.length > 0 ? 1 : 0) - (b.extras.length > 0 ? 1 : 0))
    .slice(0, 3);
}

// ═══════════════════════════════════════════════════════════
//  礼盒（37）
// ═══════════════════════════════════════════════════════════

function plainDeskTiles(game: OfflineGame): OfflineTile[] {
  return game.deskTiles.filter(t => !t.hasFlag(TileFlag.Destroyed) && t.extras.length === 0);
}

/** Dock 定向魔法计划（GetDockDirectedMagicPlan，与泡泡共用同一 Unity 实现）。 */
export function dockDirectedMagicPlan(
  game: OfflineGame,
): Array<{ elementValue: number; dockCount: number; deskTiles: OfflineTile[] }> {
  if (game.dockTiles.length === 0) return [];
  const info = new Map<number, { count: number; firstIndex: number }>();
  for (let i = 0; i < game.dockTiles.length; i++) {
    const color = game.dockTiles[i].elementValue;
    const existing = info.get(color);
    if (existing) existing.count += 1;
    else info.set(color, { count: 1, firstIndex: i });
  }
  const plan: Array<{ elementValue: number; dockCount: number; deskTiles: OfflineTile[] }> = [];
  for (const [color, { count, firstIndex }] of
    [...info.entries()].sort((a, b) => a[1].firstIndex - b[1].firstIndex)) {
    const needCount = 3 - count;
    if (needCount <= 0) continue;
    const deskTiles = game.deskTiles
      .filter(t => t.elementValue === color && !t.hasFlag(TileFlag.Destroyed))
      .sort((a, b) => (a.extras.length > 0 ? 1 : 0) - (b.extras.length > 0 ? 1 : 0))
      .slice(0, needCount);
    if (deskTiles.length === needCount) plan.push({ elementValue: color, dockCount: count, deskTiles });
  }
  return plan;
}

/** IsEffectAvailable 移植。 */
export function giftBoxAvailableEffects(game: OfflineGame): number[] {
  const available: number[] = [];
  for (const [effect] of GIFTBOX_EFFECT_WEIGHTS) {
    switch (effect) {
      case GIFTBOX_EFFECTS.AddDockSlot:
        if (game.maxSlotCount < GIFTBOX_CONSTANTS.MAX_DOCK_SLOT) available.push(effect);
        break;
      case GIFTBOX_EFFECTS.MagicWand:
        if (game.deskTiles.length > 0) available.push(effect);
        break;
      case GIFTBOX_EFFECTS.DockAllMagicWand:
        if (dockDirectedMagicPlan(game).length > 0) available.push(effect);
        break;
      case GIFTBOX_EFFECTS.RevealUnknown:
        if (game.deskTiles.some(isUnrevealedUnknownTile)) available.push(effect);
        break;
      case GIFTBOX_EFFECTS.ApplyUnknown:
        if (plainDeskTiles(game).length >= GIFTBOX_CONSTANTS.APPLY_UNKNOWN_MIN_COUNT) available.push(effect);
        break;
      case GIFTBOX_EFFECTS.ApplyFlip:
        if (plainDeskTiles(game).filter(t => !t.isClickable).length >= GIFTBOX_CONSTANTS.APPLY_FLIP_MIN_COUNT) available.push(effect);
        break;
      case GIFTBOX_EFFECTS.ApplyMagicBottle:
        if (giftBoxConvertibleGroups(game).length >= GIFTBOX_CONSTANTS.APPLY_MAGIC_BOTTLE_MIN_GROUP_COUNT) available.push(effect);
        break;
      case GIFTBOX_EFFECTS.Shuffle:
        if (game.deskTiles.length > 0) available.push(effect);
        break;
      default:
        break;
    }
  }
  return available;
}

/** SelectRandomEffect：按权重滚动（EffectWeights 插入顺序）。 */
export function rollGiftBoxEffect(game: OfflineGame, rngSeed: number): number {
  const available = giftBoxAvailableEffects(game);
  if (available.length === 0) return GIFTBOX_EFFECTS.None;
  const weights = new Map(GIFTBOX_EFFECT_WEIGHTS);
  const totalWeight = available.reduce((sum, effect) => sum + (weights.get(effect) ?? 0), 0);
  const randomValue = new DotNetRandom(rngSeed).next(totalWeight);
  let cumulative = 0;
  for (const effect of available) {
    cumulative += weights.get(effect) ?? 0;
    if (randomValue < cumulative) return effect;
  }
  return available[0];
}

/** SelectRandomTiles：GetRandomCount 后按 Random.value 稳定排序取前 N。 */
export function selectRandomTiles(
  candidates: OfflineTile[], minCount: number, maxCount: number, rngSeed: number,
): OfflineTile[] {
  if (candidates.length < minCount) return [];
  const upperBound = Math.min(maxCount, candidates.length);
  const random = new DotNetRandom(rngSeed);
  const selectedCount = random.next(upperBound - minCount + 1) + minCount;
  const keyed = candidates.map(t => ({ t, key: random.nextDouble() }));
  keyed.sort((a, b) => a.key - b.key); // Array.sort 稳定，等价 LINQ OrderBy
  return keyed.slice(0, selectedCount).map(x => x.t);
}

/** Desk-only 组 cost（CalculateDeskOnlyGroupCost）：递归依赖并集 + 自身。 */
function deskOnlyGroupCost(group: OfflineTile[], game: OfflineGame): number {
  const ids = new Set<number>();
  const visited = new Set<number>();
  const collect = (tile: OfflineTile) => {
    for (const depId of tile.runtimeDependencies) {
      if (visited.has(depId)) continue;
      visited.add(depId);
      const dep = game.allTiles.get(depId);
      if (dep && dep.pileType === PileType.Desk && !dep.hasFlag(TileFlag.Destroyed)) {
        ids.add(depId);
        collect(dep);
      }
    }
  };
  for (const tile of group) { collect(tile); ids.add(tile.id); }
  return ids.size;
}

/** GetLowestCostDeskOnlyGroup：同花色按（依赖数+1, ID）排序取 9，枚举三牌组取最小 cost。 */
function lowestCostDeskOnlyGroup(tiles: OfflineTile[], game: OfflineGame): OfflineTile[] {
  if (tiles.length < GIFTBOX_CONSTANTS.GROUP_TILE_COUNT) return [];
  const sorted = [...tiles].sort((a, b) => {
    const depthA = a.runtimeDependencies.size + 1;
    const depthB = b.runtimeDependencies.size + 1;
    return depthA !== depthB ? depthA - depthB : a.id - b.id;
  });
  const takeCount = Math.min(sorted.length, 9);
  let bestGroup: OfflineTile[] = [];
  let bestCost = Number.MAX_SAFE_INTEGER;
  let bestMinId = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < takeCount - 2; i++) {
    for (let j = i + 1; j < takeCount - 1; j++) {
      for (let k = j + 1; k < takeCount; k++) {
        const group = [sorted[i], sorted[j], sorted[k]];
        const cost = deskOnlyGroupCost(group, game);
        const minId = Math.min(...group.map(t => t.id));
        if (cost < bestCost || (cost === bestCost && minId < bestMinId)) {
          bestCost = cost; bestMinId = minId; bestGroup = group;
        }
      }
    }
  }
  return bestGroup;
}

/** GetConvertibleDeskTileGroups：无挂件 Desk 牌按花色取最低 cost 三牌组，按 cost、最小 ID 排序。 */
export function giftBoxConvertibleGroups(game: OfflineGame): OfflineTile[][] {
  const byColor = new Map<number, OfflineTile[]>();
  for (const tile of plainDeskTiles(game)) {
    const list = byColor.get(tile.elementValue);
    if (list) list.push(tile);
    else byColor.set(tile.elementValue, [tile]);
  }
  const groups: OfflineTile[][] = [];
  for (const tiles of byColor.values()) {
    const group = lowestCostDeskOnlyGroup(tiles, game);
    if (group.length === GIFTBOX_CONSTANTS.GROUP_TILE_COUNT) groups.push(group);
  }
  groups.sort((a, b) => {
    const costDiff = deskOnlyGroupCost(a, game) - deskOnlyGroupCost(b, game);
    if (costDiff !== 0) return costDiff;
    return Math.min(...a.map(t => t.id)) - Math.min(...b.map(t => t.id));
  });
  return groups;
}

/** SelectMagicBottleTargetTiles：取 1-2 组转化目标。 */
export function selectGiftBoxMagicBottleGroups(game: OfflineGame, rngSeed: number): OfflineTile[] {
  const groups = giftBoxConvertibleGroups(game);
  if (groups.length < GIFTBOX_CONSTANTS.APPLY_MAGIC_BOTTLE_MIN_GROUP_COUNT) return [];
  const upperBound = Math.min(GIFTBOX_CONSTANTS.APPLY_MAGIC_BOTTLE_MAX_GROUP_COUNT, groups.length);
  const random = new DotNetRandom(rngSeed);
  const selectedCount = random.next(upperBound - GIFTBOX_CONSTANTS.APPLY_MAGIC_BOTTLE_MIN_GROUP_COUNT + 1)
    + GIFTBOX_CONSTANTS.APPLY_MAGIC_BOTTLE_MIN_GROUP_COUNT;
  return groups.slice(0, selectedCount).flat();
}

// ═══════════════════════════════════════════════════════════
//  洗牌 — ShuffleAlgo._internalShuffle2 移植（单一随机流）
// ═══════════════════════════════════════════════════════════

export interface ShufflePacket {
  elementValue: number;
  valueExtras: TileExtra[];
}

/** 洗牌种子：Desk/Dock 状态派生（tile 按 ID 升序），与 Unity ShuffleAlgo.CreateShuffleSeed 一致。 */
export function shuffleBoardSeed(game: OfflineGame): number {
  let seed = 0x5a5a5a5a;
  for (const tile of [...game.deskTiles].sort((a, b) => a.id - b.id)) {
    seed = mul397(seed) ^ tile.id;
    seed = mul397(seed) ^ tile.elementValue;
  }
  for (const tile of [...game.dockTiles].sort((a, b) => a.id - b.id)) {
    seed = mul397(seed) ^ tile.id;
    seed = mul397(seed) ^ tile.elementValue;
  }
  return seed | 0;
}

/** 依赖优先洗牌（策略2）：值挂件随花色包移动；泡泡等非值挂件留在原 tile。 */
export function shuffleBoard(game: OfflineGame, rngSeed: number): void {
  const deskTiles = game.deskTiles;
  const packets: ShufflePacket[] = [];
  for (const tile of deskTiles) {
    const valueExtras = tile.extras.filter(e => mechanicInfo(e.extraEnum)?.isValueExtra === true);
    tile.extras = tile.extras.filter(e => mechanicInfo(e.extraEnum)?.isValueExtra !== true);
    packets.push({ elementValue: tile.elementValue, valueExtras });
  }
  const random = new DotNetRandom(rngSeed);

  // 来源一：Desk 数量最多花色（并列随机选一），放置 min(3, maxCount)
  const deskColorCounts = new Map<number, number>();
  for (const packet of packets) {
    deskColorCounts.set(packet.elementValue, (deskColorCounts.get(packet.elementValue) ?? 0) + 1);
  }
  let maxCount = 0;
  const maxColors: number[] = [];
  for (const [color, count] of deskColorCounts) {
    if (count > maxCount) { maxCount = count; maxColors.length = 0; maxColors.push(color); }
    else if (count === maxCount) maxColors.push(color);
  }
  const deskSelectedColor = maxColors[random.next(maxColors.length)];
  const deskPlaceCount = Math.min(3, maxCount);

  // 来源二：Dock 最多花色（首次位置破平）；2 张 → 抽 1，1 张 → 抽 2
  const dockSelectedIndices: number[] = [];
  if (game.dockTiles.length > 0) {
    const dockColorCounts = new Map<number, number>();
    const dockColorFirstIndex = new Map<number, number>();
    for (let i = 0; i < game.dockTiles.length; i++) {
      const color = game.dockTiles[i].elementValue;
      if (!dockColorCounts.has(color)) dockColorFirstIndex.set(color, i);
      dockColorCounts.set(color, (dockColorCounts.get(color) ?? 0) + 1);
    }
    let dockMaxCount = 0;
    const dockMaxColors: number[] = [];
    for (const [color, count] of dockColorCounts) {
      if (count > dockMaxCount) { dockMaxCount = count; dockMaxColors.length = 0; dockMaxColors.push(color); }
      else if (count === dockMaxCount) dockMaxColors.push(color);
    }
    let dockSelectedColor = dockMaxColors[0];
    let minFirstIndex = dockColorFirstIndex.get(dockSelectedColor)!;
    for (const color of dockMaxColors) {
      const firstIndex = dockColorFirstIndex.get(color)!;
      if (firstIndex < minFirstIndex) { minFirstIndex = firstIndex; dockSelectedColor = color; }
    }
    const dockPlaceCount = dockMaxCount === 2 ? 1 : dockMaxCount === 1 ? 2 : 0;
    for (let i = 0; i < packets.length && dockSelectedIndices.length < dockPlaceCount; i++) {
      if (packets[i].elementValue === dockSelectedColor) dockSelectedIndices.push(i);
    }
  }

  // 合并选中（来源二优先）
  const selectedIndices = new Set<number>();
  const selectedPackets: ShufflePacket[] = [];
  for (const idx of dockSelectedIndices) {
    if (!selectedIndices.has(idx)) { selectedIndices.add(idx); selectedPackets.push(packets[idx]); }
  }
  let deskSelectedCount = 0;
  for (let i = 0; i < packets.length && deskSelectedCount < deskPlaceCount; i++) {
    if (packets[i].elementValue === deskSelectedColor && !selectedIndices.has(i)) {
      selectedIndices.add(i); selectedPackets.push(packets[i]); deskSelectedCount++;
    }
  }
  const remainingPackets: ShufflePacket[] = [];
  for (let i = 0; i < packets.length; i++) {
    if (!selectedIndices.has(i)) remainingPackets.push(packets[i]);
  }

  // 按（剩余依赖数、ID）排序 + 同依赖数组内随机旋转
  const sortedTiles = [...deskTiles].map(tile => ({
    tile,
    depCount: tile.runtimeDependencies.size,
  })).sort((a, b) => a.depCount !== b.depCount ? a.depCount - b.depCount : a.tile.id - b.tile.id);
  let startIdx = 0;
  while (startIdx < sortedTiles.length) {
    const currentDep = sortedTiles[startIdx].depCount;
    let endIdx = startIdx;
    while (endIdx < sortedTiles.length && sortedTiles[endIdx].depCount === currentDep) endIdx++;
    const groupSize = endIdx - startIdx;
    if (groupSize > 1) {
      const offset = random.next(groupSize);
      if (offset > 0) {
        const rotated = sortedTiles.slice(startIdx, endIdx);
        for (let i = 0; i < groupSize; i++) sortedTiles[startIdx + i] = rotated[(i + offset) % groupSize];
      }
    }
    startIdx = endIdx;
  }

  // 选中包放依赖最少位置；剩余包 Fisher-Yates（同一随机流）后放置
  const place = (tile: OfflineTile, packet: ShufflePacket) => {
    tile.elementValue = packet.elementValue;
    for (const extra of packet.valueExtras) if (extra) tile.extras.push(extra);
  };
  for (let i = 0; i < selectedPackets.length; i++) place(sortedTiles[i].tile, selectedPackets[i]);
  const n = remainingPackets.length;
  for (let i = n - 1; i > 0; i--) {
    const j = random.next(i + 1);
    [remainingPackets[i], remainingPackets[j]] = [remainingPackets[j], remainingPackets[i]];
  }
  for (let i = 0; i < remainingPackets.length; i++) place(sortedTiles[i + selectedPackets.length].tile, remainingPackets[i]);
}
