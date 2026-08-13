/**
 * 机制引擎 — Unity 挂件（Extra）运行语义的确定性移植。
 *
 * 覆盖：
 *  - 彩色魔药（31）：参与三消后按花色交错清除 6 组 × 3 张（MagicBottleExtra）
 *  - 泡泡（39）：轮次指派 → Dock 空时吸取 → Dock 魔法补齐清除（TileMatchBubbleCollectMgr）
 *
 * 确定性约定：
 *  - 魔药索敌洗牌种子 = CreateShuffleRandomSeed（levelId*397^levelResID^dock数^桌面花色，unchecked int32）
 *  - 泡泡每轮收集数：extraConfig[39]=0 时为随机 2-3（Unity 原用 Random.Range(2,4)，
 *    已改为战场派生种子的 System.Random，两侧同公式）
 *  - 帧级冷却（0.5s 等）映射为步进时钟：每次动作（collect/机制步）视为一次 tick，
 *    冷却以 tick 数计。这是与 Unity 的对齐契约。
 */

import { DotNetRandom } from '../tile-explorer/random.js';
import type { OfflineGame } from '../solver/offline-game.js';
import { OfflineTile, PileType, TileFlag } from '../solver/types.js';
import { computeVisibleMatchGroups } from '../solver/solver-player.js';
import {
  BUBBLE_CONSTANTS,
  MAGIC_BOTTLE_CONSTANTS,
  MAGIC_BOTTLE_TARGET_WHITELIST,
} from './registry.js';
import type { MechanicStep, TileExtra } from './types.js';

// ═══════════════════════════════════════════════════════════
//  公共辅助：int32 与派生种子（对齐 C# unchecked 语义）
// ═══════════════════════════════════════════════════════════

/** C# unchecked 的 int32 乘法（JS 数值乘法后截断）。 */
function mul397(value: number): number {
  return (value * 397) | 0;
}

/** 对齐 MagicBottleExtra.CreateShuffleRandomSeed。 */
export function magicBottleShuffleSeed(
  levelId: number,
  levelResId: number,
  dockSlotCount: number,
  deskOnlyElementValues: number[],
): number {
  let seed = mul397(levelId) ^ levelResId;
  seed = mul397(seed) ^ dockSlotCount;
  for (const elementValue of deskOnlyElementValues) {
    seed = mul397(seed) ^ elementValue;
  }
  return seed | 0;
}

/** 对齐 C# ShuffleInPlace（System.Random 种子洗牌）。 */
function shuffleInPlace(values: number[], seed: number): void {
  const random = new DotNetRandom(seed);
  for (let i = values.length - 1; i > 0; i--) {
    const swapIndex = random.next(i + 1);
    [values[i], values[swapIndex]] = [values[swapIndex], values[i]];
  }
}

// ═══════════════════════════════════════════════════════════
//  彩色魔药（31）— MagicBottleExtra.GetTiles2Clear 移植
// ═══════════════════════════════════════════════════════════

/** IsPotionTargetExtraAllowed：挂件必须在白名单内（无挂件 = 允许）。 */
export function isPotionTargetAllowed(tile: OfflineTile): boolean {
  for (const extra of tile.extras) {
    if (!MAGIC_BOTTLE_TARGET_WHITELIST.includes(extra.extraEnum)) return false;
  }
  return true;
}

/** GetActiveTiles：Desk + Dock 中未销毁且白名单允许的牌。 */
function magicBottleActiveTiles(game: OfflineGame): OfflineTile[] {
  return [...game.deskTiles, ...game.dockTiles]
    .filter(t => !t.hasFlag(TileFlag.Destroyed) && isPotionTargetAllowed(t));
}

/** BuildColorGroups：按花色分组（≥3 张），组内 Dock 优先、再按 ID。 */
function magicBottleColorGroups(
  activeTiles: OfflineTile[],
): Map<number, OfflineTile[]> {
  const byColor = new Map<number, OfflineTile[]>();
  for (const tile of activeTiles) {
    const list = byColor.get(tile.elementValue);
    if (list) list.push(tile);
    else byColor.set(tile.elementValue, [tile]);
  }
  const groups = new Map<number, OfflineTile[]>();
  for (const [color, tiles] of byColor) {
    if (tiles.length < MAGIC_BOTTLE_CONSTANTS.TILES_PER_GROUP) continue;
    tiles.sort((a, b) => {
      const aDock = a.pileType === PileType.Dock ? 0 : 1;
      const bDock = b.pileType === PileType.Dock ? 0 : 1;
      if (aDock !== bDock) return aDock - bDock;
      return a.id - b.id;
    });
    groups.set(color, tiles);
  }
  return groups;
}

/** BuildElementValueOrder：Dock 花色按 Dock 出现顺序；Desk 独有花色按派生种子洗牌。 */
function magicBottleElementOrder(
  game: OfflineGame,
  groups: Map<number, OfflineTile[]>,
): number[] {
  const ordered: number[] = [];
  const seen = new Set<number>();
  for (const tile of game.dockTiles) {
    if (groups.has(tile.elementValue) && !seen.has(tile.elementValue)) {
      seen.add(tile.elementValue);
      ordered.push(tile.elementValue);
    }
  }
  const deskOnly: number[] = [];
  for (const tile of game.deskTiles) {
    if (groups.has(tile.elementValue) && !seen.has(tile.elementValue)) {
      seen.add(tile.elementValue);
      deskOnly.push(tile.elementValue);
    }
  }
  shuffleInPlace(deskOnly, magicBottleShuffleSeed(
    game.levelId, game.levelResId, game.dockTiles.length, deskOnly));
  ordered.push(...deskOnly);
  return ordered;
}

/** SelectTilesWithInterleavedStrategy：按花色交错取组，每轮每色最多 1 组（3 张）。 */
function magicBottleInterleavedSelect(
  groups: Map<number, OfflineTile[]>,
  orderedElementValues: number[],
): OfflineTile[] {
  const queues = new Map<number, OfflineTile[]>();
  for (const [color, tiles] of groups) queues.set(color, [...tiles]);
  const selected: OfflineTile[] = [];
  let groupsAdded = 0;
  while (groupsAdded < MAGIC_BOTTLE_CONSTANTS.TARGET_GROUP_COUNT) {
    let addedThisRound = false;
    for (const elementValue of orderedElementValues) {
      const queue = queues.get(elementValue);
      if (!queue || queue.length < MAGIC_BOTTLE_CONSTANTS.TILES_PER_GROUP) continue;
      for (let i = 0; i < MAGIC_BOTTLE_CONSTANTS.TILES_PER_GROUP; i++) {
        selected.push(queue.shift()!);
      }
      groupsAdded++;
      addedThisRound = true;
      if (groupsAdded >= MAGIC_BOTTLE_CONSTANTS.TARGET_GROUP_COUNT) break;
    }
    if (!addedThisRound) break;
  }
  return selected;
}

/** GetTiles2Clear 完整移植：返回魔药触发时要清除的牌（保持 Unity 选择顺序）。 */
export function selectMagicBottleTargets(game: OfflineGame): OfflineTile[] {
  const activeTiles = magicBottleActiveTiles(game);
  if (activeTiles.length === 0) return [];
  const groups = magicBottleColorGroups(activeTiles);
  if (groups.size === 0) return [];
  const ordered = magicBottleElementOrder(game, groups);
  return magicBottleInterleavedSelect(groups, ordered);
}

/** OnMatch 触发判定：仅当魔药挂件是 matchedTiles[0] 的挂件时触发（对齐 bindTile != matchedTiles[0] 提前返回）。 */
export function magicBottleOnMatch(
  game: OfflineGame,
  matchedTiles: OfflineTile[],
): MechanicStep | null {
  if (matchedTiles.length === 0) return null;
  const leader = matchedTiles[0];
  if (!leader.extras.some(e => e.extraEnum === 31)) return null;
  const targets = selectMagicBottleTargets(game);
  if (targets.length === 0) return null;
  return { type: 'magic-bottle-clear', tileIds: targets.map(t => t.id) };
}
// ═══════════════════════════════════════════════════════════
//  泡泡（39）— TileMatchBubbleCollectMgr 移植
// ═══════════════════════════════════════════════════════════

/** 泡泡管理器状态（对齐 Unity 字段；表现层字段省略）。 */
export interface BubbleState {
  enabled: boolean;
  /** extraConfig[39]：每轮收集数（0 = 随机 2-3） */
  configuredCollectCount: number;
  useRandomCollectCount: boolean;
  completedCollectRounds: number;
  activeBubbleTileIds: Set<number>;
  activeRoundCounted: boolean;
  /** 帧级冷却（0.5s）→ tick 时钟映射 */
  cooldownTicks: number;
}

/** IsCandidate（指派候选）：Desk + Clickable + 未销毁 + 尚无泡泡挂件。 */
export function isBubbleAssignCandidate(tile: OfflineTile): boolean {
  return tile.pileType === PileType.Desk
    && tile.isClickable
    && !tile.hasFlag(TileFlag.Destroyed)
    && !tile.extras.some(e => e.extraEnum === 39);
}

/** GetElementCost：该花色最佳三连组的 totalCost（无组则 int.MaxValue）。 */
function bubbleElementCost(game: OfflineGame, elementValue: number): number {
  const groups = computeVisibleMatchGroups(game).filter(g => g.color === elementValue);
  return groups.length > 0 ? groups[0].totalCost : Number.MAX_SAFE_INTEGER;
}

/** DefaultBubbleTileSelector.SelectTiles 移植。 */
export function selectBubbleAssignTargets(game: OfflineGame, count: number): OfflineTile[] {
  if (count <= 0) return [];
  const candidates = game.deskTiles
    .filter(isBubbleAssignCandidate)
    .sort((a, b) => {
      // OrderBy(IsUnrevealedUnknownTile ? 1 : 0) — reversegen 暂未建模 UnknownMark，恒为 0
      const costA = bubbleElementCost(game, a.elementValue);
      const costB = bubbleElementCost(game, b.elementValue);
      if (costA !== costB) return costA - costB;
      if (a.elementValue !== b.elementValue) return a.elementValue - b.elementValue;
      return a.id - b.id;
    });
  // 重复花色优先（每色取首张），单张花色补足
  const groups = new Map<number, OfflineTile[]>();
  for (const tile of candidates) {
    const list = groups.get(tile.elementValue);
    if (list) list.push(tile);
    else groups.set(tile.elementValue, [tile]);
  }
  const duplicated: OfflineTile[][] = [];
  const single: OfflineTile[][] = [];
  for (const list of groups.values()) {
    if (list.length > 1) duplicated.push(list);
    else single.push(list);
  }
  const selected: OfflineTile[] = [];
  for (const list of [...duplicated, ...single]) {
    if (selected.length >= count) break;
    selected.push(list[0]);
  }
  return selected.slice(0, count);
}

/** IsCollectCandidate：Desk + Clickable + 未销毁 + 已有泡泡挂件。 */
export function isBubbleCollectCandidate(tile: OfflineTile): boolean {
  return tile.pileType === PileType.Desk
    && tile.isClickable
    && !tile.hasFlag(TileFlag.Destroyed)
    && tile.extras.some(e => e.extraEnum === 39);
}

/** GetDockDirectedMagicPlan：按 Dock 出现顺序的花色，补齐需要清除的 Desk 牌。 */
export function dockMagicPlan(
  game: OfflineGame,
): Array<{ elementValue: number; dockCount: number; deskTiles: OfflineTile[] }> {
  if (game.dockTiles.length === 0) return [];
  const info = new Map<number, { count: number; firstIndex: number }>();
  for (let i = 0; i < game.dockTiles.length; i++) {
    const elementValue = game.dockTiles[i].elementValue;
    const existing = info.get(elementValue);
    if (existing) existing.count += 1;
    else info.set(elementValue, { count: 1, firstIndex: i });
  }
  const plan: Array<{ elementValue: number; dockCount: number; deskTiles: OfflineTile[] }> = [];
  const entries = [...info.entries()].sort((a, b) => a[1].firstIndex - b[1].firstIndex);
  for (const [elementValue, { count }] of entries) {
    const needCount = 3 - count;
    if (needCount <= 0) continue;
    const deskTiles = game.deskTiles
      .filter(t => t.elementValue === elementValue)
      .filter(t => !t.hasFlag(TileFlag.Destroyed))
      .sort((a, b) => (a.extras.length > 0 ? 1 : 0) - (b.extras.length > 0 ? 1 : 0))
      .slice(0, needCount);
    if (deskTiles.length === needCount) {
      plan.push({ elementValue, dockCount: count, deskTiles });
    }
  }
  return plan;
}
// ═══════════════════════════════════════════════════════════
//  MechanicEngine — OfflineGame 的机制驱动
// ═══════════════════════════════════════════════════════════

export class MechanicEngine {
  readonly bubble: BubbleState;

  constructor(readonly game: OfflineGame, bubbleConfig?: Map<number, number>) {
    const config = bubbleConfig?.get(39);
    this.bubble = {
      enabled: config !== undefined,
      configuredCollectCount: config === undefined || config === 0
        ? BUBBLE_CONSTANTS.DEFAULT_COLLECT_COUNT
        : Math.max(BUBBLE_CONSTANTS.MIN_COLLECT_COUNT, Math.min(BUBBLE_CONSTANTS.MAX_COLLECT_COUNT, config)),
      useRandomCollectCount: config === 0,
      completedCollectRounds: 0,
      activeBubbleTileIds: new Set<number>(),
      activeRoundCounted: false,
      cooldownTicks: 0,
    };
  }

  /** 深拷贝机制状态到目标引擎（OfflineGame.clone 使用）。 */
  copyFrom(source: MechanicEngine): void {
    this.bubble.enabled = source.bubble.enabled;
    this.bubble.configuredCollectCount = source.bubble.configuredCollectCount;
    this.bubble.useRandomCollectCount = source.bubble.useRandomCollectCount;
    this.bubble.completedCollectRounds = source.bubble.completedCollectRounds;
    this.bubble.activeBubbleTileIds = new Set(source.bubble.activeBubbleTileIds);
    this.bubble.activeRoundCounted = source.bubble.activeRoundCounted;
    this.bubble.cooldownTicks = source.bubble.cooldownTicks;
  }

  /** 状态指纹（并入 DFS 状态键，保证记忆化不剪错枝）。 */
  fingerprint(): string {
    const b = this.bubble;
    return [
      b.enabled ? 1 : 0,
      b.completedCollectRounds,
      b.activeRoundCounted ? 1 : 0,
      [...b.activeBubbleTileIds].sort((a, c) => a - c).join('.'),
    ].join('|');
  }

  /** 魔药 OnMatch 分发（由 OfflineGame 在三消后调用）。 */
  onMatch(matchedTiles: OfflineTile[]): MechanicStep | null {
    return magicBottleOnMatch(this.game, matchedTiles);
  }

  /**
   * 泡泡 tick：对齐 Unity OnUpdate 的确定性等价。
   * 每次动作（collect / 机制步应用）后调用，直到返回空数组（静止）。
   */
  tick(): MechanicStep[] {
    const steps: MechanicStep[] = [];
    const game = this.game;
    const bubble = this.bubble;
    if (!bubble.enabled) return steps;

    if (bubble.activeBubbleTileIds.size > 0) {
      const liveOnDesk = [...bubble.activeBubbleTileIds].some(id => {
        const tile = game.allTiles.get(id);
        return tile && tile.pileType === PileType.Desk && !tile.hasFlag(TileFlag.Destroyed);
      });
      if (liveOnDesk) {
        if (game.dockTiles.length === 0) {
          const tiles = game.deskTiles.filter(isBubbleCollectCandidate).sort((a, b) => a.id - b.id);
          if (tiles.length > 0) steps.push({ type: 'bubble-collect', tileIds: tiles.map(t => t.id) });
        }
        return steps;
      }
      // 无存活角标 → Dock 魔法清除。清除非空时冷却置 0，下一 tick 直接进入
      // 指派（对齐 Unity TryClearDockAfterBubbleTilesConsumed 末尾绕过冷却的
      // 直接 TryAssignCollectableTiles，且基于魔法执行后的最新棋盘状态）。
      steps.push(...this.dockMagicPass());
      return steps;
    }

    if (bubble.cooldownTicks > 0) {
      bubble.cooldownTicks -= 1;
      return steps;
    }
    if (game.dockTiles.length > 0) return steps;

    const collectables = game.deskTiles.filter(isBubbleCollectCandidate).sort((a, b) => a.id - b.id);
    if (collectables.length === 0) return this.tryAssign();
    if (!bubble.activeRoundCounted && bubble.completedCollectRounds >= BUBBLE_CONSTANTS.MAX_COLLECT_ROUNDS) {
      return steps;
    }
    steps.push({ type: 'bubble-collect', tileIds: collectables.map(t => t.id) });
    return steps;
  }

  /** TryAssignCollectableTiles 移植（含 CanAssignForRemainingTileCount 与随机收集数）。 */
  private tryAssign(): MechanicStep[] {
    const game = this.game;
    const bubble = this.bubble;
    if (bubble.completedCollectRounds >= BUBBLE_CONSTANTS.MAX_COLLECT_ROUNDS) return [];
    const targetCount = bubble.useRandomCollectCount
      ? new DotNetRandom(this.bubbleCollectCountSeed()).next(2) + 2 // Next(2,4) ≡ [2,3]
      : bubble.configuredCollectCount;
    // CanAssignForRemainingTileCount: targetCount + 1 < remaining / 3f
    const remaining = game.deskTiles.length;
    if (!(targetCount + 1 < remaining / 3)) return [];
    const targets = selectBubbleAssignTargets(game, targetCount);
    if (targets.length < BUBBLE_CONSTANTS.MIN_COLLECT_COUNT) return [];
    return [{ type: 'bubble-assign', tileIds: targets.map(t => t.id) }];
  }

  /** 泡泡随机收集数种子：与 Unity 修复后的公式一致（levelId*397^levelResID^dock数^轮次）。 */
  private bubbleCollectCountSeed(): number {
    const game = this.game;
    let seed = mul397(game.levelId) ^ game.levelResId;
    seed = mul397(seed) ^ game.dockTiles.length;
    seed = mul397(seed) ^ this.bubble.completedCollectRounds;
    return seed | 0;
  }

  /** TryClearDockAfterBubbleTilesConsumed → Dock 魔法清除（对齐 GetDockDirectedMagicPlan + Execute）。 */
  private dockMagicPass(): MechanicStep[] {
    const game = this.game;
    const bubble = this.bubble;
    // HasLiveActiveBubbleTile：仍有角标牌留在 Desk 时不触发
    const hasLiveOnDesk = [...bubble.activeBubbleTileIds].some(id => {
      const tile = game.allTiles.get(id);
      return tile && tile.pileType === PileType.Desk && !tile.hasFlag(TileFlag.Destroyed);
    });
    if (hasLiveOnDesk) {
      return [];
    }
    const plan = dockMagicPlan(game);
    bubble.activeBubbleTileIds.clear();
    bubble.activeRoundCounted = false;
    // Unity 两分支都设 0.5s 冷却；非空分支末尾直接指派绕过冷却，
    // 因此这里非空时置 0，让下一 tick 用魔法后的棋盘状态立即指派。
    bubble.cooldownTicks = plan.length === 0 ? 1 : 0;
    if (plan.length === 0) return [];
    const tileIds: number[] = [];
    for (const target of plan) {
      for (const tile of game.dockTiles) {
        if (tile.elementValue === target.elementValue && !tileIds.includes(tile.id)) {
          tileIds.push(tile.id);
        }
      }
      for (const tile of target.deskTiles) {
        if (!tileIds.includes(tile.id)) tileIds.push(tile.id);
      }
    }
    return [{ type: 'dock-magic-clear', tileIds }];
  }
}

/** 从地形挂件字段构造 tile 挂件列表（Empty/None 无挂件）。 */
export function tileExtrasFromTerrain(extraEnum: number | undefined, extraParam: string | undefined): TileExtra[] {
  const value = extraEnum ?? 0;
  if (value === 0 || value === -1) return [];
  return [{ extraEnum: value, extraParam: extraParam ?? '' }];
}
