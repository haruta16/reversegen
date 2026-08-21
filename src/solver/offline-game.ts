/**
 * OfflineGame — core game state machine.
 *
 * Exact port of C# OfflineGame.cs logic:
 *   Collect → CheckDockMatch → UpdateTilesState
 *
 * Key difference from ReverseGen's model:
 *   RuntimeDependencies are DYNAMIC — only deps still on Desk.
 *   A tile becomes clickable when ALL its deps have been collected (not just eliminated).
 */

import { OfflineTile, PileType, TileFlag, type TileConfig } from './types.js';
import type { FallingTerrainStructure, TerrainStructure, TerrainTile } from '../types.js';
import type { BoardSpecialMode, BoardSpecialStructure } from '../board-special/types.js';
import { boardSpecialVictoryCondition } from '../board-special/victory.js';
import { buildPlacementLayers, injectBoardSpecials, resolveBoardSpecialMode, resolveBoardSpecialSeed } from '../board-special/inject.js';
import { MechanicEngine, tileExtrasFromTerrain } from '../mechanics/engine.js';
import { DECAY_STEP_TYPES, STEP_APPLIERS } from '../mechanics/step-appliers.js';
import { applyDecayStep, onTileCollected } from '../mechanics/extras.js';
import type { MechanicStep, MechanicStepRecord } from '../mechanics/types.js';
import { serializeMechanicCounts, splitMechanicConfig } from '../mechanics/spec.js';
import { assignTileExtras, deriveAssignSeed } from '../mechanics/assigner.js';
import { MAX_DOCK_SLOTS } from '../constants.js';
import { logger } from '../logger.js';

// ═══════════════════════════════════════════════════
//  Game constants
// ═══════════════════════════════════════════════════

const TILE_SIZE = 10; // tile is 10×10 units, centered at (posX, posY)

// ═══════════════════════════════════════════════════
//  OfflineGame
// ═══════════════════════════════════════════════════

/** 胜利条件谓词（可插拔：缺省 = 清空可匹配牌；52/53 订单玩法 = 全部棋盘特殊物移除即胜）。 */
export type VictoryCondition = (game: OfflineGame) => boolean;

/** 默认胜利条件：Dock 清空且桌面无可匹配牌（elementValue > 0，障碍牌不参与）。 */
export function defaultVictoryCondition(game: OfflineGame): boolean {
  return game.dockTiles.length === 0 && game.deskTiles.every(t => t.elementValue <= 0);
}

/** OfflineGame 构造选项（机制等可选上下文）。 */
export interface OfflineGameOptions {
  /** 地形资源 ID（机制派生种子基座，对齐 Unity battle.levelResID） */
  levelResId?: number;
  /** 机制配置（extraEnum → 数量/参数，与 Unity extraConfig 同构） */
  mechanicConfig?: Map<number, number>;
  /** 礼盒开放效果集（对齐 s3Kit.GiftBoxExtra.IsEffectOpen）；缺省 = 全部开放 */
  giftboxOpenEffects?: Set<number>;
  /** 装载期注入的棋盘特殊物（51-53 大型地形结构） */
  boardSpecialStructures?: BoardSpecialStructure[];
  /** 胜利条件（缺省 = defaultVictoryCondition，对齐 Unity victoryConditionMgr） */
  victoryCondition?: VictoryCondition;
}

export class OfflineGame {
  /** All tiles indexed by ID */
  readonly allTiles: Map<number, OfflineTile>;
  /** Tiles currently on Desk */
  deskTiles: OfflineTile[];
  /** Tiles currently in Dock (hand area) */
  dockTiles: OfflineTile[];
  /** Tiles that have been eliminated (discarded) */
  discardTiles: OfflineTile[];
  /** Special terrain runtime rules shared by every solver clone. */
  readonly terrainStructures: TerrainStructure[];
  /** 地形资源 ID（派生种子基座） */
  readonly levelResId: number;
  /** 胜利条件（可插拔；缺省 = 清空可匹配牌） */
  readonly victoryCondition: VictoryCondition;
  /** 机制引擎（魔药/泡泡），clone 时深拷贝 */
  readonly mechanics: MechanicEngine;
  /** 机制步骤日志（跑关验证） */
  readonly mechanicLog: MechanicStepRecord[] = [];
  /** 累计动作序号（点击/复活/机制步骤统一计数） */
  actionCount = 0;
  /** Dock 槽位加成（礼盒 AddDockSlot 效果，上限 8） */
  dockSlotBonus = 0;
  /** 棋盘特殊物（51-53 大型地形结构；非 Tile，只做遮挡与自动移除） */
  readonly boardSpecialStructures: BoardSpecialStructure[];
  /** coveredTileId → 覆盖它的活跃结构列表（对齐 BoardSpecialRuntimeSystem 覆盖索引） */
  private readonly boardSpecialCoverage = new Map<number, BoardSpecialStructure[]>();
  private readonly transferTileIds = new Set<number>();
  private readonly fallingGroups: FallingTerrainStructure[] = [];
  private readonly fallingGroupByTileId = new Map<number, FallingTerrainStructure>();

  // ── Construction ──

  constructor(tiles: OfflineTile[], terrainStructures: TerrainStructure[] = [], options: OfflineGameOptions = {}) {
    this.allTiles = new Map();
    this.deskTiles = [];
    this.dockTiles = [];
    this.discardTiles = [];
    this.terrainStructures = terrainStructures.map(structure => ({
      ...structure,
      tileIds: [...structure.tileIds],
    }));
    this.levelResId = options.levelResId ?? 0;
    this.victoryCondition = options.victoryCondition ?? defaultVictoryCondition;
    this.boardSpecialStructures = (options.boardSpecialStructures ?? []).map(s => ({
      ...s,
      dependencies: [...s.dependencies],
      coveredTileIds: [...s.coveredTileIds],
    }));
    this.rebuildBoardSpecialCoverage();

    for (const tile of tiles) {
      this.allTiles.set(tile.id, tile);
      switch (tile.pileType) {
        case PileType.Dock:
          tile.flags = TileFlag.None;
          this.dockTiles.push(tile);
          break;
        case PileType.Discard:
          tile.flags = TileFlag.Destroyed;
          this.discardTiles.push(tile);
          break;
        default:
          tile.pileType = PileType.Desk;
          tile.flags = TileFlag.None;
          this.deskTiles.push(tile);
          break;
      }
    }

    this.mechanics = new MechanicEngine(this, options.mechanicConfig, options.giftboxOpenEffects);

    this.initializeTerrainStructures();
    this.updateTilesState();

    // 对齐 Unity 开局帧驱动：Playing 后、玩家首次点击之前，泡泡管理器按帧 tick 至静止——
    // Dock 为空且 CanAssign 通过时，「指派 → 吸取」发生在第一步之前（Steps.Count 从 1 起）。
    this.runMechanicTicks();
  }

  private initializeTerrainStructures(): void {
    const claimed = new Set<number>();
    for (const structure of this.terrainStructures) {
      if (structure.tileNum != null && structure.tileNum !== structure.tileIds.length) {
        throw new Error(
          `${structure.type}#${structure.id ?? '?'} 的 tileNum=${structure.tileNum}，`
          + `但 tileIds 有 ${structure.tileIds.length} 张`,
        );
      }
      for (const tileId of structure.tileIds) {
        if (!this.allTiles.has(tileId)) {
          throw new Error(`${structure.type}#${structure.id ?? '?'} 引用了不存在的 tile ${tileId}`);
        }
        if (claimed.has(tileId)) throw new Error(`tile ${tileId} 同时属于多个 terrainStructures`);
        claimed.add(tileId);
      }

      if (structure.type === 'transfer') {
        for (const tileId of structure.tileIds) this.transferTileIds.add(tileId);
        continue;
      }
      if (!Number.isInteger(structure.viewLength)
        || structure.viewLength < 1
        || structure.viewLength > structure.tileIds.length) {
        throw new Error(
          `falling#${structure.id ?? '?'} 的 viewLength 必须在 1..${structure.tileIds.length} 之间`,
        );
      }
      this.fallingGroups.push(structure);
      for (const tileId of structure.tileIds) this.fallingGroupByTileId.set(tileId, structure);
    }
  }

  // ── Board special（51-53 大型地形） ──

  /** 重建覆盖索引（对齐 RebuildCoverageIndex）。 */
  private rebuildBoardSpecialCoverage(): void {
    this.boardSpecialCoverage.clear();
    for (const structure of this.boardSpecialStructures) {
      for (const tileId of structure.coveredTileIds) {
        const list = this.boardSpecialCoverage.get(tileId);
        if (list) list.push(structure);
        else this.boardSpecialCoverage.set(tileId, [structure]);
      }
    }
  }

  /** 覆盖指定牌且未移除的结构列表（对齐 GetStructuresCovering）。 */
  getBoardSpecialStructuresCovering(tileId: number): BoardSpecialStructure[] {
    const list = this.boardSpecialCoverage.get(tileId);
    if (!list) return [];
    return list.filter(s => !s.isRemoved);
  }

  /** 是否存在未移除结构覆盖该牌（对齐 HasActiveStructureCovering）。 */
  hasActiveBoardSpecialCovering(tileId: number): boolean {
    const list = this.boardSpecialCoverage.get(tileId);
    if (!list) return false;
    return list.some(s => !s.isRemoved);
  }

  /**
   * 结构自动移除（对齐 ProcessUncovered）：依赖非空且全部离开 Desk → 移除。
   * 返回是否有结构被移除（调用方需刷新状态）。
   */
  processUncoveredBoardSpecials(): boolean {
    let changed = false;
    for (const structure of this.boardSpecialStructures) {
      if (structure.isRemoved) continue;
      if (structure.dependencies.length === 0) continue;
      const blocked = structure.dependencies.some(id => {
        const tile = this.allTiles.get(id);
        return tile && tile.pileType === PileType.Desk && !tile.hasFlag(TileFlag.Destroyed);
      });
      if (blocked) continue;
      structure.isRemoved = true;
      changed = true;
    }
    return changed;
  }

  // ── Derived properties ──

  /** 剩余可用槽位（跟随礼盒加槽，对齐 Unity Dock.RemainSlotCount = MaxSlotCount - Frozen - Current）。 */
  get remainSlotCount(): number {
    return this.maxSlotCount - this.dockTiles.length;
  }

  get maxSlotCount(): number {
    return MAX_DOCK_SLOTS + this.dockSlotBonus;
  }

  /**
   * 胜利判定（可插拔：victoryCondition 决定语义）。
   * 缺省 = Dock 清空且 Desk 无可匹配牌；52/53 订单玩法 = 全部棋盘特殊物移除即胜。
   */
  get isWin(): boolean {
    return this.victoryCondition(this);
  }

  /** 死亡判定跟随当前槽位上限（对齐 Unity Dock.IsMax，礼盒加槽后为 8）。 */
  get isDead(): boolean {
    return this.dockTiles.length >= this.maxSlotCount;
  }

  // ── Clone ──

  clone(): OfflineGame {
    // 按源牌局的实际顺序铺设（Desk 顺序影响稳定排序 tie-break，Dock 顺序决定 matchedTiles[0]），
    // 不能按 id 排序——否则 Dock 顺序被重排、状态键漂移。
    const sourceOrder = [...this.deskTiles, ...this.dockTiles, ...this.discardTiles];
    const tiles = sourceOrder.map(t => {
      const c = new OfflineTile(t.config, t.elementValue);
      c.pileType = t.pileType;
      c.flags = t.flags;
      c.extras = t.extras.map(e => ({ ...e }));
      return c;
    });
    const copy = new OfflineGame(tiles, this.terrainStructures, {
      levelResId: this.levelResId,
      boardSpecialStructures: this.boardSpecialStructures,
      victoryCondition: this.victoryCondition,
    });
    copy.mechanics.copyFrom(this.mechanics);
    // 克隆必须保留动作计数（机制派生种子依赖 actionCount）与槽位加成（死亡阈值依赖 maxSlotCount）。
    copy.actionCount = this.actionCount;
    copy.dockSlotBonus = this.dockSlotBonus;
    return copy;
  }

  // ═══════════════════════════════════════════════════
  //  Mechanism operation surface（行为策略表使用的最小操作面）
  // ═══════════════════════════════════════════════════

  /** 把指定牌移入 Dock（不触发三消）；泡泡吸取/魔法棒等机制收集使用。 */
  mechanicMoveToDock(tileIds: number[]): void {
    for (const id of tileIds) {
      const tile = this.allTiles.get(id);
      if (!tile || tile.pileType !== PileType.Desk) continue;
      const idx = this.deskTiles.indexOf(tile);
      if (idx >= 0) this.deskTiles.splice(idx, 1);
      tile.pileType = PileType.Dock;
      tile.flags = TileFlag.None;
      this.dockTiles.push(tile);
    }
    this.sortDockTiles();
  }

  /** 消除指定牌（Desk/Dock 均可），移入 Discard。 */
  mechanicEliminate(tileIds: number[]): void {
    for (const id of tileIds) {
      const tile = this.allTiles.get(id);
      if (!tile || tile.hasFlag(TileFlag.Destroyed)) continue;
      const deskIdx = tile.pileType === PileType.Desk ? this.deskTiles.indexOf(tile) : -1;
      const dockIdx = tile.pileType === PileType.Dock ? this.dockTiles.indexOf(tile) : -1;
      if (deskIdx >= 0) this.deskTiles.splice(deskIdx, 1);
      if (dockIdx >= 0) this.dockTiles.splice(dockIdx, 1);
      tile.pileType = PileType.Discard;
      tile.flags = TileFlag.Destroyed;
      this.discardTiles.push(tile);
    }
  }

  /** 结算 Dock 三消（一次一组），返回被消除的组（无则 null）。 */
  mechanicResolveDockMatch(): OfflineTile[] | null {
    const matched = this.checkDockMatch();
    if (!matched || matched.length === 0) return null;
    this.mechanicEliminate(matched.map(m => m.id));
    return matched;
  }

  /** Dock 槽位 +1（礼盒 AddDockSlot，上限 8）。 */
  mechanicAddDockSlot(): void {
    if (this.maxSlotCount < 8) this.dockSlotBonus += 1;
  }

  // ═══════════════════════════════════════════════════
  //  Core game logic
  // ═══════════════════════════════════════════════════

  /**
   * Collect a clickable tile: Desk → Dock → check match → update state.
   * This is the atomic game action.
   * 返回本次三消的消除组（无三消为 null），供跑关日志/验证消费；不关心返回值的调用方照常忽略。
   */
  collect(tile: OfflineTile): OfflineTile[] | null {
    if (tile.pileType !== PileType.Desk || !tile.isClickable) {
      throw new Error(`Tile ${tile.id} is not clickable, cannot collect`);
    }
    // Unity 蒲公英读取的是本次 collect 之前的 AnalyzerMgr 旧快照，必须先捕获。
    this.mechanics.capturePreMoveContext();

    // 1. Remove from Desk
    const deskIdx = this.deskTiles.indexOf(tile);
    if (deskIdx >= 0) this.deskTiles.splice(deskIdx, 1);
    else {
      // Tile might not be in deskTiles if it was removed via dock/discard — find by ID
      const found = this.deskTiles.find(t => t.id === tile.id);
      if (found) {
        const idx = this.deskTiles.indexOf(found);
        this.deskTiles.splice(idx, 1);
      }
    }

    // 2. Move to Dock
    tile.pileType = PileType.Dock;
    tile.flags = TileFlag.None; // Clear Clickable etc.
    this.dockTiles.push(tile);
    this.sortDockTiles();

    // 2.5 收集回调（OnCollect）：揭示/衰减有效收集/订单 consumed
    onTileCollected(tile);

    // 3. Check for match (3 same-color in dock)
    const matched = this.checkDockMatch();
    if (matched && matched.length > 0) {
      for (const m of matched) {
        const dockIdx = this.dockTiles.indexOf(m);
        if (dockIdx >= 0) this.dockTiles.splice(dockIdx, 1);
        m.pileType = PileType.Discard;
        m.flags = TileFlag.Destroyed;
        this.discardTiles.push(m);
      }
    }
    if (!matched || matched.length === 0) {
      this.mechanics.clearPendingMatchContext();
    }

    // 3.2 衰减挂件 OnStep —— 对齐 Unity：CollectStep 在 AppendStep 时（UpdateTilesState 之前）
    //    触发 OnStep，此刻其它 desk 牌的可点击状态仍是本步之前的旧快照，
    //    因此本步刚被解除遮挡的牌当步不衰减。
    applyDecayStep(this, 'collect');

    // 4. 刷新状态；Unity 礼盒在动画后、UpdateTilesState 之后才取随机，
    //    因此机制分发前先刷新一次。
    this.updateTilesState();

    // 5. 机制分发：OnMatch（matched 已 Destroyed；魔药/蒲公英/礼盒按守卫各自触发）
    if (matched && matched.length > 0) {
      for (const mechanicStep of this.mechanics.onMatch(matched)) {
        this.applyMechanicStep(mechanicStep);
      }
    }

    // 6. 机制步骤可能改动桌面，再次刷新（recompute RuntimeDependencies → Clickable）
    this.updateTilesState();

    // 7. 动作计数 + 泡泡 tick 至静止（对齐 Unity OnUpdate 的确定性等价）
    this.actionCount += 1;
    this.runMechanicTicks();

    // 8. 棋盘特殊物自动移除（对齐 _processUncoveredBoardSpecialTiles：结构依赖全部离桌即移除）
    if (this.processUncoveredBoardSpecials()) this.updateTilesState();

    return matched && matched.length > 0 ? matched : null;
  }

  /**
   * 应用机制步骤（公开入口：策略表分发 + 日志 + 衰减结算）。
   * 对齐 Unity StepMgr 时序：Apply 先于 AppendStep —— 应用器执行时 actionCount 不含本步
   * （链式蒲公英/魔药同步读取一致；链式礼盒取 actionCount+1 恰为本步 Append 后计数）；
   * 只有 Unity 会 AppendStep 的步骤类型（DECAY_STEP_TYPES）才计入 Steps.Count——
   * 泡泡指派/蒲公英扩散/礼盒计划类效果不增加步数，派生种子读取的 actionCount 因此逐位一致；
   * 衰减 OnStep 同样仅对 AppendStep 类步骤触发，且用本步开始前的旧可点击快照；
   * 状态刷新统一在本步末尾（对齐 Unity 各调用点的 UpdateTilesState）。
   */
  applyMechanicStep(step: MechanicStep): void {
    const decaySnapshot = DECAY_STEP_TYPES.has(step.type)
      ? new Set<number>(this.deskTiles.filter(t => t.isClickable).map(t => t.id))
      : undefined;
    const applier = STEP_APPLIERS[step.type];
    if (applier) applier(this, step);
    if (DECAY_STEP_TYPES.has(step.type)) this.actionCount += 1;
    this.mechanicLog.push({ ...step, stepIndex: this.actionCount });
    if (decaySnapshot) applyDecayStep(this, step.type, decaySnapshot);
    this.updateTilesState();
    if (this.processUncoveredBoardSpecials()) this.updateTilesState();
  }
  /** 循环执行泡泡 tick 直到静止（guard 防病态环）。 */
  private runMechanicTicks(): void {
    for (let guard = 0; guard < 64; guard++) {
      const steps = this.mechanics.tick();
      if (steps.length === 0) break;
      for (const step of steps) this.applyMechanicStep(step);
    }
  }

  /**
   * Revive: eliminate 1 dock tile + 2 matching desk tiles (same color).
   * Used when dock is full to recover from a death state.
   * Does NOT check clickability — desk tiles can be blocked.
   * After elimination, updateTilesState() recomputes all dependencies.
   *
   * 注意：这是求解域的死亡恢复抽象（用于 DFS 的 minRevives 度量），并非 Unity 客户端语义——
   * Unity 复活 = Undo 回退至 Dock ≤ 2 后洗牌（StepMgr.RemoveStep 路径）。重放契约不含 Undo/复活。
   */
  revive(dockTileId: number, deskTileId1: number, deskTileId2: number): void {
    const dockTile = this.allTiles.get(dockTileId);
    if (!dockTile || dockTile.pileType !== PileType.Dock) {
      throw new Error(`Tile ${dockTileId} is not in Dock`);
    }
    const deskTile1 = this.allTiles.get(deskTileId1);
    const deskTile2 = this.allTiles.get(deskTileId2);
    if (!deskTile1 || deskTile1.pileType !== PileType.Desk) {
      throw new Error(`Tile ${deskTileId1} is not on Desk`);
    }
    if (!deskTile2 || deskTile2.pileType !== PileType.Desk) {
      throw new Error(`Tile ${deskTileId2} is not on Desk`);
    }
    const color = dockTile.elementValue;
    if (deskTile1.elementValue !== color || deskTile2.elementValue !== color) {
      throw new Error(
        `Revive color mismatch: dock=${color}, desk=[${deskTile1.elementValue},${deskTile2.elementValue}]`,
      );
    }

    // Eliminate dock tile → Discard
    const dockIdx = this.dockTiles.indexOf(dockTile);
    if (dockIdx >= 0) this.dockTiles.splice(dockIdx, 1);
    dockTile.pileType = PileType.Discard;
    dockTile.flags = TileFlag.Destroyed;
    this.discardTiles.push(dockTile);

    // Eliminate both desk tiles → Discard
    for (const dt of [deskTile1, deskTile2]) {
      const deskIdx = this.deskTiles.indexOf(dt);
      if (deskIdx >= 0) this.deskTiles.splice(deskIdx, 1);
      dt.pileType = PileType.Discard;
      dt.flags = TileFlag.Destroyed;
      this.discardTiles.push(dt);
    }

    // Recompute all tile states (dependencies may have changed)
    this.updateTilesState();
    if (this.processUncoveredBoardSpecials()) this.updateTilesState();
  }

  /**
   * Rebuild RuntimeDependencies for all Desk tiles.
   * A dependency counts only if the dep tile is still on Desk (not collected).
   * If RuntimeDependencies is empty → tile is Clickable.
   * Also refreshes PerfectCovered and Invisible flags.
   */
  /** 重算所有 Desk 牌的 RuntimeDependencies / Clickable / 遮挡标志。 */
  updateTilesState(): void {
    const hiddenFallingTileIds = this.hiddenFallingTileIds();

    // Phase 1: Compute RuntimeDependencies and Clickable
    for (const tile of this.allTiles.values()) {
      tile.runtimeDependencies.clear();

      if (tile.pileType !== PileType.Desk || tile.hasFlag(TileFlag.Destroyed)) {
        tile.removeFlag(TileFlag.Clickable | TileFlag.Invisible | TileFlag.PerfectCovered);
        continue;
      }

      if (hiddenFallingTileIds.has(tile.id)) {
        tile.setClickable(false);
        tile.setFlag(TileFlag.Invisible);
        tile.removeFlag(TileFlag.PerfectCovered);
        continue;
      }

      const specialTile = this.transferTileIds.has(tile.id)
        || this.fallingGroupByTileId.has(tile.id);
      if (specialTile) {
        tile.setClickable(true);
        tile.removeFlag(TileFlag.PerfectCovered);
        continue;
      }

      for (const depId of tile.config.dependencies) {
        const dep = this.allTiles.get(depId);
        if (dep && dep.pileType === PileType.Desk && !dep.hasFlag(TileFlag.Destroyed)) {
          tile.runtimeDependencies.add(depId);
        }
      }

      // 棋盘特殊物覆盖的牌即使无依赖也不可点击（对齐 UpdateTilesState 的 isCoveredByBoardSpecial）
      tile.setClickable(tile.runtimeDependencies.size === 0 && !this.hasActiveBoardSpecialCovering(tile.id));

      // Phase 1.5: Compute PerfectCovered
      tile.removeFlag(TileFlag.PerfectCovered);
      for (const depId of tile.runtimeDependencies) {
        const dep = this.allTiles.get(depId);
        if (dep && dep.pileType === PileType.Desk) {
          if (overlapArea(tile, dep) >= 90) {
            tile.setFlag(TileFlag.PerfectCovered);
            break;
          }
        }
      }
    }

    // Phase 2: Compute Invisible (depends on PerfectCovered + projection coverage)
    // Must run AFTER all PerfectCovered flags are set
    for (const tile of this.allTiles.values()) {
      if (tile.pileType !== PileType.Desk || tile.hasFlag(TileFlag.Destroyed)) {
        tile.removeFlag(TileFlag.Invisible);
        continue;
      }
      if (hiddenFallingTileIds.has(tile.id)) {
        tile.setFlag(TileFlag.Invisible);
        continue;
      }

      const invisible =
        tile.hasFlag(TileFlag.PerfectCovered) ||
        isProjectionFullyCovered(tile, this.allTiles);
      if (invisible) tile.setFlag(TileFlag.Invisible);
      else tile.removeFlag(TileFlag.Invisible);
    }
  }

  /** Falling keeps viewLength tiles exposed and reveals the next ID after any collection. */
  private hiddenFallingTileIds(): Set<number> {
    const hidden = new Set<number>();
    for (const group of this.fallingGroups) {
      let collectedCount = 0;
      for (const tileId of group.tileIds) {
        const tile = this.allTiles.get(tileId)!;
        if (tile.pileType !== PileType.Desk) collectedCount++;
      }
      const revealedCount = Math.min(
        group.tileIds.length,
        group.viewLength + collectedCount,
      );
      for (let index = revealedCount; index < group.tileIds.length; index++) {
        const tile = this.allTiles.get(group.tileIds[index])!;
        if (tile.pileType === PileType.Desk) hidden.add(tile.id);
      }
    }
    return hidden;
  }

  /**
   * Group dock tiles by color, keeping up to 3 per group.
   * Elements grouped together for adjacency.
   */
  private sortDockTiles(): void {
    if (this.dockTiles.length <= 1) return;

    const groups = new Map<number, OfflineTile[]>();
    const order: number[] = [];

    for (const tile of this.dockTiles) {
      let list = groups.get(tile.elementValue);
      if (!list) {
        list = [];
        groups.set(tile.elementValue, list);
        order.push(tile.elementValue);
      }
      list.push(tile);
    }

    this.dockTiles = [];
    for (const element of order) {
      const list = groups.get(element)!;
      for (const tile of list) {
        this.dockTiles.push(tile);
      }
    }
  }

  /**
   * Check if any color group has exactly 3 tiles in dock.
   * Returns the FIRST matching group, or null.
   * Only checks ONE group per call (chain reactions happen across Collect calls).
   */
  private checkDockMatch(): OfflineTile[] | null {
    const dict = new Map<number, OfflineTile[]>();

    for (const tile of this.dockTiles) {
      let list = dict.get(tile.elementValue);
      if (!list) {
        list = [];
        dict.set(tile.elementValue, list);
      }
      if (list.length < 3) {
        list.push(tile);
      }
    }

    for (const [, tiles] of dict) {
      if (tiles.length === 3) {
        return tiles;
      }
    }

    return null;
  }

  // ═══════════════════════════════════════════════════
  //  State key (for DFS memoization)
  // ═══════════════════════════════════════════════════

  /**
   * Build a deterministic state key for memoization.
   * 完整捕获影响未来走向的全部状态：
   * - Desk 牌集合（排序，desk 顺序由规范序决定，不随历史变化）
   * - Dock 牌的【实际顺序】（matchedTiles[0] 决定机制触发）与每张牌的花色、挂件状态
   * - Desk 牌的挂件状态（角标/倒计时/揭示/订单）
   * - 槽位加成（死亡阈值）与机制引擎指纹（泡泡随机流）
   * - actionCount 仅在存在蒲公英(36)/礼盒(37) 时纳入（它们的派生种子读取步数）
   */
  buildStateKey(): string {
    const deskIds = this.deskTiles.map(t => t.id).sort((a, b) => a - b).join(',');

    const dockSeq = this.dockTiles.map(t => `${t.id}:${t.elementValue}${extraState(t)}`).join(',');

    const deskExtras = this.deskTiles
      .filter(t => t.extras.length > 0)
      .map(t => `${t.id}:${extraState(t)}`)
      .sort()
      .join(',');

    const seedSensitive = this.hasSeedSensitiveMechanics()
      ? `|a${this.actionCount}`
      : '';

    const structures = this.boardSpecialStructures
      .map(s => `${s.id}:${s.extraEnum}:${s.isRemoved ? 0 : 1}`)
      .sort()
      .join(',');

    return `${deskIds}|${dockSeq}|${deskExtras}|b${this.dockSlotBonus}${seedSensitive}|s${structures}|m${this.mechanics.fingerprint()}`;
  }

  /** 是否存在步数敏感机制（蒲公英/礼盒的派生种子读取 actionCount）。 */
  private hasSeedSensitiveMechanics(): boolean {
    for (const tile of this.allTiles.values()) {
      for (const extra of tile.extras) {
        if (extra.extraEnum === 36 || extra.extraEnum === 37) return true;
      }
    }
    return false;
  }

  // ═══════════════════════════════════════════════════
  //  Queries
  // ═══════════════════════════════════════════════════

  /** Get all clickable tiles on Desk. */
  get clickableTiles(): OfflineTile[] {
    return this.deskTiles.filter(t => t.isClickable);
  }

  /**
   * Count how many blocked tiles would become clickable if `removingTileId` were collected.
   * Port of C# CountUnlockGain.
   */
  countUnlockGain(removingTileId: number): number {
    let gain = this.fallingRevealGain(removingTileId);
    for (const target of this.deskTiles) {
      if (target.id === removingTileId) continue;
      if (target.isClickable) continue;
      if (!target.runtimeDependencies.has(removingTileId)) continue;
      if (this.wouldBecomeClickable(target, removingTileId)) {
        gain++;
      }
    }
    return gain;
  }

  private fallingRevealGain(removingTileId: number): number {
    const group = this.fallingGroupByTileId.get(removingTileId);
    const removing = this.allTiles.get(removingTileId);
    if (!group || !removing || removing.pileType !== PileType.Desk || !removing.isClickable) return 0;

    let collectedCount = 0;
    for (const tileId of group.tileIds) {
      if (this.allTiles.get(tileId)!.pileType !== PileType.Desk) collectedCount++;
    }
    const nextIndex = group.viewLength + collectedCount;
    if (nextIndex >= group.tileIds.length) return 0;
    return this.allTiles.get(group.tileIds[nextIndex])!.pileType === PileType.Desk ? 1 : 0;
  }

  /**
   * Check if target would become clickable after removingTileId is collected.
   */
  private wouldBecomeClickable(target: OfflineTile, removingTileId: number): boolean {
    if (!target.runtimeDependencies.has(removingTileId)) return false;
    for (const depId of target.runtimeDependencies) {
      if (depId === removingTileId) continue;
      const dep = this.allTiles.get(depId);
      if (dep && dep.pileType === PileType.Desk) return false;
    }
    return true;
  }

  /** Get dock count by color. */
  getDockCounts(): Map<number, number> {
    const counts = new Map<number, number>();
    for (const t of this.dockTiles) {
      counts.set(t.elementValue, (counts.get(t.elementValue) ?? 0) + 1);
    }
    return counts;
  }
}

// ═══════════════════════════════════════════════════
//  Factory: terrain + ReplayData → OfflineGame
// ═══════════════════════════════════════════════════

/** 挂件运行时状态编码（状态键用）：extraEnum(countdown.isDone.isConsumed) 串联。 */
function extraState(tile: OfflineTile): string {
  return tile.extras.map(e => {
    const state = [e.countdown ?? '', e.isDone ? 1 : 0, e.isConsumed ? 1 : 0].join('.');
    return `${e.extraEnum}(${state})`;
  }).join('+');
}

export interface GameFactoryInput {
  terrainTiles: TerrainTile[];
  terrainStructures?: TerrainStructure[];
  /** tileId → element value (1-based color) */
  elementValues: Map<number, number>;
  /** Initial dock entries from replay code */
  initialDock?: { tileId: number; element: number }[];
  /** Already-eliminated tile IDs (from replay code instanceArray) */
  eliminatedTileIds?: Set<number>;
  /** 地形资源 ID（机制派生种子基座，对齐 Unity battle.levelResID） */
  levelResId?: number;
  /** ReplayCode 字符串（用于派生分配种子；缺省时为纯机制哈希） */
  replayCode?: string;
  /** 机制配置（extraEnum → 数量/参数，与 Unity extraConfig 同构） */
  mechanicConfig?: Map<number, number>;
  /** 礼盒开放效果集（对齐 s3Kit.GiftBoxExtra.IsEffectOpen）；缺省 = 全部开放 */
  giftboxOpenEffects?: Set<number>;
  /** 棋盘边界（LevelWidth × LevelHeight；缺省时大型地形注入回退到地形包围盒） */
  boardBounds?: { width: number; height: number };
  /**
   * 机制分配种子（调试显式覆盖）。缺省 = deriveAssignSeed(replayCode, mechanicConfig)，
   * 即「地形+replay+机制」的纯函数，零协调。
   */
  mechanicSeed?: number;
}

/**
 * Create an OfflineGame from terrain + assigned colors + replay data.
 */
export function createGame(input: GameFactoryInput): OfflineGame {
  const { terrainTiles, terrainStructures, elementValues, initialDock, eliminatedTileIds, levelResId, replayCode, mechanicConfig, mechanicSeed, giftboxOpenEffects, boardBounds } = input;

  const tiles: OfflineTile[] = terrainTiles.map(tt => {
    const config: TileConfig = {
      id: tt.id,
      layer: tt.layer,
      dependencies: [...tt.dependencies],
      isConst: tt.isConst,
      constElementValue: tt.constElementValue,
      posX: tt.posX,
      posY: tt.posY,
      extras: tileExtrasFromTerrain(tt.extraEnum, tt.extraParam),
    };
    return new OfflineTile(config, elementValues.get(tt.id) ?? 1);
  });

  // ── 装载期机制分配（对齐 Unity LoadLevel/ApplyExtraConfig：先花色后挂件、只分非 const 牌） ──
  // 分配在 Dock/消除状态应用之前进行，全部 tile 为 Desk——与 Unity FixedReplayCode
  // （SetElementValue → ApplyExtraConfig → dockEntries/Eliminated）的装载顺序一致。
  // 泡泡(39)=行为参数交给 MechanicEngine；大型地形(51-53)=装载期棋盘级注入；其余为分配请求。
  let bubbleConfig: Map<number, number> | undefined;
  let boardSpecialStructures: BoardSpecialStructure[] | undefined;
  let boardSpecialMode: BoardSpecialMode | null = null;
  if (mechanicConfig && mechanicConfig.size > 0) {
    const { bubble, assignable, boardSpecial } = splitMechanicConfig(mechanicConfig);
    bubbleConfig = bubble;
    if (boardSpecial.size > 0) {
      boardSpecialMode = resolveBoardSpecialMode(boardSpecial);
      if (boardSpecialMode) {
        boardSpecialStructures = injectBoardSpecialsFromConfig(
          terrainTiles,
          boardSpecialMode,
          mechanicSeed,
          replayCode,
          levelResId,
          boardBounds,
          initialDock,
        );
      }
    }
    if (assignable.size > 0) {
      // 种子只取"分配请求"子集（泡泡/大型地形已拆出）——与 Unity FixedReplayCodeAlgorithm
      // ApplyExtraConfig 收到的 extraConfig 一致，两侧同公式派生同一种子。
      // Tower 判定排除初始 Dock 牌（对齐 IsTerrain: originalPile==1）；51-53 由分配器按 extraEnum 排除。
      const towerExcludedTileIds = initialDock && initialDock.length > 0
        ? new Set<number>(initialDock.map(d => d.tileId))
        : undefined;
      assignTileExtras(
        tiles,
        assignable,
        mechanicSeed ?? deriveAssignSeed(replayCode ?? '', assignable),
        towerExcludedTileIds,
      );
    }
  }

  // Apply initial pile type（对齐 Unity：Dock/已消除状态在花色与挂件之后装载）
  if (initialDock || eliminatedTileIds) {
    for (const tile of tiles) {
      if (initialDock) {
        const dockEntry = initialDock.find(d => d.tileId === tile.id);
        if (dockEntry) {
          tile.pileType = PileType.Dock;
          tile.elementValue = dockEntry.element;
        }
      }
      if (eliminatedTileIds?.has(tile.id)) {
        tile.pileType = PileType.Discard;
      }
    }
  }

  // 胜利条件（对齐 Unity victoryConditionMgr）：52/53 订单玩法 = 全部结构收集即胜；
  // 51 与普通关卡 = 默认清空可匹配牌。无结构注入时回退默认。
  const victoryCondition = boardSpecialStructures && boardSpecialStructures.length > 0
    && (boardSpecialMode === 'pizza' || boardSpecialMode === 'ticket')
    ? boardSpecialVictoryCondition
    : undefined;

  return new OfflineGame(tiles, terrainStructures, {
    levelResId,
    mechanicConfig: bubbleConfig,
    giftboxOpenEffects,
    boardSpecialStructures,
    victoryCondition,
  });
}

/**
 * 大型地形装载期注入（对齐 Unity LoadLevel：algo 之后、Dock/消除装载之前）。
 * 种子 = 显式 mechanicSeed > FNV-1a(replayCode) > levelResId。
 */
function injectBoardSpecialsFromConfig(
  terrainTiles: TerrainTile[],
  mode: BoardSpecialMode,
  mechanicSeed: number | undefined,
  replayCode: string | undefined,
  levelResId: number | undefined,
  boardBounds: { width: number; height: number } | undefined,
  initialDock: { tileId: number; element: number }[] | undefined,
): BoardSpecialStructure[] {
  const byLayer = new Map<number, Array<{ id: number; posX: number; posY: number; extraEnum: number | undefined }>>();
  for (const tile of terrainTiles) {
    const list = byLayer.get(tile.layer);
    if (list) list.push({ id: tile.id, posX: tile.posX, posY: tile.posY, extraEnum: tile.extraEnum });
    else byLayer.set(tile.layer, [{ id: tile.id, posX: tile.posX, posY: tile.posY, extraEnum: tile.extraEnum }]);
  }
  const layers = [...byLayer.entries()].map(([layer, tiles]) => ({ layer, tiles }));
  const initialDockIds = initialDock && initialDock.length > 0 ? new Set(initialDock.map(d => d.tileId)) : undefined;
  const placementLayers = buildPlacementLayers(layers, initialDockIds);
  const maxTileId = terrainTiles.reduce((max, t) => Math.max(max, t.id), 0);
  const seed = resolveBoardSpecialSeed(mechanicSeed, replayCode, levelResId);
  const bounds = boardBounds ?? { width: 0, height: 0 };
  return injectBoardSpecials(
    mode,
    seed,
    placementLayers,
    bounds,
    terrainTiles.map(t => ({ id: t.id, layer: t.layer, posX: t.posX, posY: t.posY, extraEnum: t.extraEnum })),
    maxTileId,
  );
}

// ═══════════════════════════════════════════════════════════════
//  Geometry helpers（移植自 C# Geometry 类）
// ═══════════════════════════════════════════════════════════════

/** 共享覆盖缓冲区，用代数标记避免每次 reset（单线程安全） */
let _coverageGen = 0;
const _coverageBuf = new Uint8Array(TILE_SIZE * TILE_SIZE);

/**
 * 计算两张 10×10 tile 的重叠面积。
 * 每张 tile 的中心在 (posX, posY)，边界从 pos-5 到 pos+5。
 */
function overlapArea(a: OfflineTile, b: OfflineTile): number {
  const aMinX = a.config.posX - 5;
  const aMaxX = a.config.posX + 5;
  const aMinY = a.config.posY - 5;
  const aMaxY = a.config.posY + 5;
  const bMinX = b.config.posX - 5;
  const bMaxX = b.config.posX + 5;
  const bMinY = b.config.posY - 5;
  const bMaxY = b.config.posY + 5;

  const w = Math.min(aMaxX, bMaxX) - Math.max(aMinX, bMinX);
  const h = Math.min(aMaxY, bMaxY) - Math.max(aMinY, bMinY);
  return w <= 0 || h <= 0 ? 0 : w * h;
}

/**
 * 判断 tile 的所有 RuntimeDependencies 在 Desk 上的投影
 * 是否完全覆盖了 tile 的 10×10 区域。
 *
 * 如果所有依赖的投影并集覆盖了 tile 整个区域 → 玩家看不到这张牌。
 *
 * 使用共享缓冲区 + 代数标记避免每次数组分配（DFS 百万状态时 GC 压力巨大）。
 */
function isProjectionFullyCovered(
  tile: OfflineTile,
  allTiles: Map<number, OfflineTile>,
  excludedDepId?: number,
): boolean {
  if (tile.runtimeDependencies.size === 0) return false;

  // 代数标记：在 1..255 之间循环。
  // _coverageBuf 是 Uint8Array，写入值 >255 会被截断 → 比较时 gen 必须也在 0..255 范围。
  // 每次 wrap 回 1 时做一次 fill(0) 清除上一轮残留（100 字节，开销可忽略）。
  _coverageGen = (_coverageGen + 1) & 0xFF;
  if (_coverageGen === 0) {
    _coverageGen = 1;
    _coverageBuf.fill(0);
  }

  const gen = _coverageGen;
  const tileMinX = tile.config.posX - 5;
  const tileMinY = tile.config.posY - 5;
  let contributors = 0;

  for (const depId of tile.runtimeDependencies) {
    if (excludedDepId !== undefined && depId === excludedDepId) continue;

    const dep = allTiles.get(depId);
    if (!dep || dep.pileType !== PileType.Desk) continue;
    contributors++;

    const depMinX = dep.config.posX - 5;
    const depMinY = dep.config.posY - 5;
    const depMaxX = dep.config.posX + 5;
    const depMaxY = dep.config.posY + 5;

    const startX = Math.max(depMinX - tileMinX, 0);
    const startY = Math.max(depMinY - tileMinY, 0);
    const endX = Math.min(depMaxX - tileMinX, TILE_SIZE);
    const endY = Math.min(depMaxY - tileMinY, TILE_SIZE);
    if (startX >= endX || startY >= endY) continue;

    for (let y = startY; y < endY; y++) {
      const row = y * TILE_SIZE;
      for (let x = startX; x < endX; x++) {
        _coverageBuf[row + x] = gen;
      }
    }
  }

  if (contributors === 0) return false;
  for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
    if (_coverageBuf[i] !== gen) return false;
  }
  return true;
}
