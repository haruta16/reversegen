/**
 * 机制引擎 — Unity 挂件（Extra）运行语义的确定性移植。
 *
 * 覆盖：
 *  - 彩色魔药（31）：参与三消后按花色交错清除 6 组 × 3 张（MagicBottleExtra）
 *  - 泡泡（39）：轮次指派 → Dock 空时吸取（入 Dock 后照常结算三消）→
 *    Dock 定向魔法（逐花色 MagicStep 链，TileMatchBubbleCollectMgr）
 *  - 三消分发表（MATCH_BEHAVIORS）：魔药/蒲公英/礼盒各自触发（含礼盒 Win 态守卫）
 *
 * 确定性约定：
 *  - 魔药索敌洗牌种子 = CreateShuffleRandomSeed（levelResID^dock数^桌面花色，unchecked int32）
 *  - 泡泡每轮收集数：extraConfig[39]=0 时为随机 2-3（Unity 原用 Random.Range(2,4)，
 *    已改为战场派生种子的 System.Random，两侧同公式）
 *  - 帧级冷却（0.5s 等）映射为步进时钟：每次动作（collect/机制步）视为一次 tick，
 *    冷却以 tick 数计。这是与 Unity 的对齐契约。
 */

import { DotNetRandom } from '../tile-explorer/random.js';
import type { OfflineGame } from '../solver/offline-game.js';
import { OfflineTile, PileType, TileFlag } from '../solver/types.js';
import { captureAnalyzerGroups, computeAnalyzerMatchGroups, type AnalyzerGroupSnapshot } from '../solver/solver-player.js';
import {
  selectDandelionTargets,
  isDandelionMatch,
  isUnrevealedUnknownTile,
  rollGiftBoxEffect,
  selectMagicWandTargets,
  dockDirectedMagicPlan,
  selectRandomTiles,
  selectGiftBoxMagicBottleGroups,
} from './extras.js';
import { extraActionSeed, extraActionSeedFromCounts, magicBottleShuffleSeed, mul397 } from './seed.js';
import {
  BUBBLE_CONSTANTS,
  GIFTBOX_CONSTANTS,
  GIFTBOX_EFFECTS,
  MAGIC_BOTTLE_CONSTANTS,
  MAGIC_BOTTLE_TARGET_WHITELIST,
  MECHANIC_SEED_SALTS,
} from './registry.js';
import type { MechanicStep, TileExtra } from './types.js';

// ═══════════════════════════════════════════════════════════
//  公共辅助：int32 与派生种子（对齐 C# unchecked 语义）
// ═══════════════════════════════════════════════════════════

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
  shuffleInPlace(deskOnly, magicBottleShuffleSeed(game.levelResId, game.dockTiles.length, deskOnly));
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
  // Unity DefaultBubbleTileSelector 每次都会 Analyze()，使用 AnalyzerMgr 的全量候选组。
  const groups = computeAnalyzerMatchGroups(game).filter(g => g.color === elementValue);
  return groups.length > 0 ? groups[0].totalCost : Number.MAX_SAFE_INTEGER;
}

/** DefaultBubbleTileSelector.SelectTiles 移植。 */
export function selectBubbleAssignTargets(game: OfflineGame, count: number): OfflineTile[] {
  if (count <= 0) return [];
  const candidates = game.deskTiles
    .filter(isBubbleAssignCandidate)
    .sort((a, b) => {
      // OrderBy(IsUnrevealedUnknownTile ? 1 : 0)：未揭示问号排后
      const unknownA = isUnrevealedUnknownTile(a) ? 1 : 0;
      const unknownB = isUnrevealedUnknownTile(b) ? 1 : 0;
      if (unknownA !== unknownB) return unknownA - unknownB;
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
// ═══════════════════════════════════════════════════════════
//  三消分发策略表（MATCH_BEHAVIORS）
// ═══════════════════════════════════════════════════════════

/** 一次三消分发时，Unity 实际读取的“非当前最新状态”快照。 */
export interface MechanicMatchContext {
  /** collect 前 AnalyzerMgr.MatchGroups 对应的旧候选组快照。 */
  preMoveGroups?: AnalyzerGroupSnapshot[];
}

export type MatchBehavior = (
  game: OfflineGame,
  matchedTiles: OfflineTile[],
  context: MechanicMatchContext,
) => MechanicStep[];

/** 魔药：matchedTiles[0] 带魔药挂件时触发交错清除。 */
function magicBottleMatchBehavior(
  game: OfflineGame,
  matchedTiles: OfflineTile[],
  _context: MechanicMatchContext,
): MechanicStep[] {
  const step = magicBottleOnMatch(game, matchedTiles);
  return step ? [step] : [];
}

/** 蒲公英：至少 3 张蒲公英参与本次三消时扩散转化。 */
function dandelionMatchBehavior(
  game: OfflineGame,
  matchedTiles: OfflineTile[],
  context: MechanicMatchContext,
): MechanicStep[] {
  if (!isDandelionMatch(matchedTiles)) return [];
  // Unity 在 matched 移出 Dock 前同步触发蒲公英：
  // Dock 数要加回本次匹配的 3 张；步数仍是当前步提交前的 actionCount。
  const dandelionDockCount = game.dockTiles.length + matchedTiles.length;
  const rngSeed = extraActionSeedFromCounts(
    game.levelResId,
    dandelionDockCount,
    game.deskTiles.length,
    game.actionCount,
    MECHANIC_SEED_SALTS.DANDELION_TARGETS,
  );
  const targets = selectDandelionTargets(game, rngSeed, context.preMoveGroups);
  if (targets.length === 0) return [];
  return [{ type: 'dandelion-spread', tileIds: targets.map(t => t.id) }];
}

/** 礼盒：加权随机效果 → 步骤列表。 */
function giftBoxMatchBehavior(
  game: OfflineGame,
  matchedTiles: OfflineTile[],
  _context: MechanicMatchContext,
): MechanicStep[] {
  // 对齐 Unity：动画后异步执行前检查 Win 态（battleState == Win 提前返回），胜局不再触发效果。
  if (game.isWin) return [];
  // Unity 礼盒在动画后、当前 step 已 Append 后才取随机，因此步数要 +1。
  const giftboxActionCount = game.actionCount + 1;
  const effect = rollGiftBoxEffect(
    game,
    extraActionSeedFromCounts(
      game.levelResId,
      game.dockTiles.length,
      game.deskTiles.length,
      giftboxActionCount,
      MECHANIC_SEED_SALTS.GIFTBOX_EFFECT,
    ),
  );
  switch (effect) {
    case GIFTBOX_EFFECTS.AddDockSlot:
      return [{ type: 'giftbox-add-dock-slot' }];
    case GIFTBOX_EFFECTS.MagicWand:
      // 对齐 battle.Magic：目标为空也照常 AppendStep（步骤计数 +1，不影响棋盘）。
      return [{ type: 'magic-step', tileIds: selectMagicWandTargets(game).map(t => t.id) }];
    case GIFTBOX_EFFECTS.DockAllMagicWand: {
      // 对齐 ExecuteDockAllMagicWandCore：计划快照一次，按 Dock 花色序逐个执行真实 MagicStep。
      const plan = dockDirectedMagicPlan(game);
      return plan.map(target => ({
        type: 'magic-step' as const,
        tileIds: target.deskTiles.map(t => t.id),
      }));
    }
    case GIFTBOX_EFFECTS.RevealUnknown:
      return [{ type: 'giftbox-reveal-unknown' }];
    case GIFTBOX_EFFECTS.Shuffle:
      return [{ type: 'giftbox-shuffle' }];
    case GIFTBOX_EFFECTS.ApplyUnknown: {
      const tiles = selectRandomTiles(
        game.deskTiles.filter(t => !t.hasFlag(TileFlag.Destroyed) && t.extras.length === 0),
        GIFTBOX_CONSTANTS.APPLY_UNKNOWN_MIN_COUNT,
        GIFTBOX_CONSTANTS.APPLY_UNKNOWN_MAX_COUNT,
        extraActionSeedFromCounts(
          game.levelResId,
          game.dockTiles.length,
          game.deskTiles.length,
          giftboxActionCount,
          MECHANIC_SEED_SALTS.GIFTBOX_APPLY_UNKNOWN,
        ),
      );
      return tiles.length > 0 ? [{ type: 'giftbox-apply-unknown', tileIds: tiles.map(t => t.id) }] : [];
    }
    case GIFTBOX_EFFECTS.ApplyFlip: {
      const tiles = selectRandomTiles(
        game.deskTiles.filter(t => !t.hasFlag(TileFlag.Destroyed) && t.extras.length === 0 && !t.isClickable),
        GIFTBOX_CONSTANTS.APPLY_FLIP_MIN_COUNT,
        GIFTBOX_CONSTANTS.APPLY_FLIP_MAX_COUNT,
        extraActionSeedFromCounts(
          game.levelResId,
          game.dockTiles.length,
          game.deskTiles.length,
          giftboxActionCount,
          MECHANIC_SEED_SALTS.GIFTBOX_APPLY_FLIP,
        ),
      );
      return tiles.length > 0 ? [{ type: 'giftbox-apply-flip', tileIds: tiles.map(t => t.id) }] : [];
    }
    case GIFTBOX_EFFECTS.ApplyMagicBottle: {
      const tiles = selectGiftBoxMagicBottleGroups(
        game,
        extraActionSeedFromCounts(
          game.levelResId,
          game.dockTiles.length,
          game.deskTiles.length,
          giftboxActionCount,
          MECHANIC_SEED_SALTS.GIFTBOX_APPLY_MAGIC_BOTTLE,
        ),
      );
      return tiles.length > 0 ? [{ type: 'giftbox-apply-magic-bottle', tileIds: tiles.map(t => t.id) }] : [];
    }
    default:
      return [];
  }
}

/** 三消分发表：extraEnum → 行为（新增机制在此登记一行）。 */
export const MATCH_BEHAVIORS: Map<number, MatchBehavior> = new Map([
  [31, magicBottleMatchBehavior],
  [36, dandelionMatchBehavior],
  [37, giftBoxMatchBehavior],
]);

// ═══════════════════════════════════════════════════════════
//  MechanicEngine — OfflineGame 的机制驱动
// ═══════════════════════════════════════════════════════════

export class MechanicEngine {
  /** Unity 泡泡管理器在 Init 时创建一次并持续复用的 System.Random 的等价物。 */
  private bubbleRandom: DotNetRandom | null = null;

  /** 当前三消分发前捕获的 Unity 旧状态快照。 */
  private pendingMatchContext?: MechanicMatchContext;
  readonly bubble: BubbleState;
  /** 礼盒开放效果集（对齐 s3Kit.GiftBoxExtra.IsEffectOpen）；null = 全部开放。 */
  giftboxOpenEffects: Set<number> | null;

  constructor(readonly game: OfflineGame, bubbleConfig?: Map<number, number>, giftboxOpenEffects?: Set<number>) {
    this.giftboxOpenEffects = giftboxOpenEffects ?? null;
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
    if (this.bubble.useRandomCollectCount) {
      this.bubbleRandom = new DotNetRandom(this.bubbleCollectCountSeed());
    }
  }


  /** 未发生三消时清除暂存快照，避免脏上下文影响后续直接 onMatch。 */
  clearPendingMatchContext(): void {
    this.pendingMatchContext = undefined;
  }
  /** 在 collect / magic 状态变更前调用，捕获 Unity AnalyzerMgr 的旧快照。 */
  capturePreMoveContext(): void {
    const hasDandelion = [...this.game.allTiles.values()]
      .some(tile => tile.extras.some(extra => extra.extraEnum === 36));
    this.pendingMatchContext = {
      // 快照是只读拷贝，不会引用后续会被 collect 修改的原始 Tile 对象。
      preMoveGroups: hasDandelion
        ? captureAnalyzerGroups(this.game)
        : undefined,
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
    this.giftboxOpenEffects = source.giftboxOpenEffects;
    this.bubbleRandom = source.bubbleRandom
      ? DotNetRandom.fromState(source.bubbleRandom.state())
      : null;
  }

  /** 状态指纹（并入 DFS 状态键，保证记忆化不剪错枝）。 */
  fingerprint(): string {
    const b = this.bubble;
    const rng = this.bubbleRandom ? JSON.stringify(this.bubbleRandom.state()) : '';
    return [
      b.enabled ? 1 : 0,
      b.completedCollectRounds,
      b.activeRoundCounted ? 1 : 0,
      [...b.activeBubbleTileIds].sort((a, c) => a - c).join('.'),
      rng,
    ].join('|');
  }

  /**
   * OnMatch 分发（由 OfflineGame 在三消后调用）。
   * 对齐 Unity：matchedTiles[0] 的每个挂件各自触发（去重守卫），
   * 行为通过 MATCH_BEHAVIORS 策略表分发——新增机制只需登记一行。
   */
  onMatch(matchedTiles: OfflineTile[]): MechanicStep[] {
    const steps: MechanicStep[] = [];
    const context = this.pendingMatchContext ?? {};
    if (matchedTiles.length === 0) {
      this.pendingMatchContext = undefined;
      return steps;
    }
    const leader = matchedTiles[0];
    for (const extra of leader.extras) {
      const behavior = MATCH_BEHAVIORS.get(extra.extraEnum);
      if (behavior) steps.push(...behavior(this.game, matchedTiles, context));
    }
    this.pendingMatchContext = undefined;
    return steps;
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
      // 无存活角标 → Dock 定向魔法（逐花色 MagicStep 链，见 dockMagicPass）。
      // 完成后冷却置 0：下一 tick 用魔法后的最新棋盘状态立即进入指派
      // （对齐 Unity TryClearDockAfterBubbleTilesConsumed 末尾的立即 TryAssignCollectableTiles）。
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
      ? this.nextBubbleCollectCount() // Unity 复用同一个 _bubbleRandom 流
      : bubble.configuredCollectCount;
    // CanAssignForRemainingTileCount: targetCount + 1 < remaining / 3f
    const remaining = game.deskTiles.length;
    if (!(targetCount + 1 < remaining / 3)) return [];
    const targets = selectBubbleAssignTargets(game, targetCount);
    if (targets.length < BUBBLE_CONSTANTS.MIN_COLLECT_COUNT) return [];
    return [{ type: 'bubble-assign', tileIds: targets.map(t => t.id) }];
  }

  /** 泡泡随机收集数种子：共享战场派生种子（盐 39）+ 轮次数（与 Unity 修复后公式一致）。 */
  private bubbleCollectCountSeed(): number {
    let seed = extraActionSeed(this.game, MECHANIC_SEED_SALTS.BUBBLE_COLLECT_COUNT);
    seed = mul397(seed) ^ this.bubble.completedCollectRounds;
    return seed | 0;
  }

  /** 从持久 Random 流中取下一个收集数；每次 TryAssign 都会消费一次，与 Unity 一致。 */
  private nextBubbleCollectCount(): number {
    if (!this.bubbleRandom) {
      this.bubbleRandom = new DotNetRandom(this.bubbleCollectCountSeed());
    }
    return this.bubbleRandom.next(2) + 2;
  }

  /**
   * TryClearDockAfterBubbleTilesConsumed → Dock 定向魔法。
   * 对齐 ExecuteDockAllMagicWandCoreAsync：计划快照一次，按 Dock 花色序逐个执行真实
   * MagicStep（进 Dock → 结算三消 → 可链式触发）；空计划不产生步骤。
   * Unity 完成流程末尾无论计划是否为空都立即 TryAssign，故冷却置 0。
   */
  private dockMagicPass(): MechanicStep[] {
    const game = this.game;
    const bubble = this.bubble;
    // HasLiveActiveBubbleTile：仍有角标牌留在 Desk 时不触发
    const hasLiveOnDesk = [...bubble.activeBubbleTileIds].some(id => {
      const tile = game.allTiles.get(id);
      return tile && tile.pileType === PileType.Desk && !tile.hasFlag(TileFlag.Destroyed);
    });
    if (hasLiveOnDesk) return [];

    const plan = dockDirectedMagicPlan(game);
    bubble.activeBubbleTileIds.clear();
    bubble.activeRoundCounted = false;
    bubble.cooldownTicks = 0;
    return plan.map(target => ({
      type: 'magic-step' as const,
      tileIds: target.deskTiles.map(t => t.id),
    }));
  }
}

/** 从地形挂件字段构造 tile 挂件列表（Empty/None 无挂件）。 */
export function tileExtrasFromTerrain(extraEnum: number | undefined, extraParam: string | undefined): TileExtra[] {
  const value = extraEnum ?? 0;
  if (value === 0 || value === -1) return [];
  return [{ extraEnum: value, extraParam: extraParam ?? '' }];
}
