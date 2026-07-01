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
import type { TerrainTile } from '../types.js';

// ═══════════════════════════════════════════════════
//  Game constants
// ═══════════════════════════════════════════════════

const MAX_DOCK_SLOTS = 7;
const TILE_SIZE = 10; // tile is 10×10 units, centered at (posX, posY)

// ═══════════════════════════════════════════════════
//  OfflineGame
// ═══════════════════════════════════════════════════

export class OfflineGame {
  /** All tiles indexed by ID */
  readonly allTiles: Map<number, OfflineTile>;
  /** Tiles currently on Desk */
  deskTiles: OfflineTile[];
  /** Tiles currently in Dock (hand area) */
  dockTiles: OfflineTile[];
  /** Tiles that have been eliminated (discarded) */
  discardTiles: OfflineTile[];

  // ── Construction ──

  constructor(tiles: OfflineTile[]) {
    this.allTiles = new Map();
    this.deskTiles = [];
    this.dockTiles = [];
    this.discardTiles = [];

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

    this.updateTilesState();
  }

  // ── Derived properties ──

  get remainSlotCount(): number {
    return MAX_DOCK_SLOTS - this.dockTiles.length;
  }

  get maxSlotCount(): number {
    return MAX_DOCK_SLOTS;
  }

  get isWin(): boolean {
    return this.deskTiles.length === 0 && this.dockTiles.length === 0;
  }

  get isDead(): boolean {
    return this.dockTiles.length >= MAX_DOCK_SLOTS;
  }

  // ── Clone ──

  clone(): OfflineGame {
    const tiles = [...this.allTiles.values()]
      .sort((a, b) => a.id - b.id)
      .map(t => {
        const c = new OfflineTile(t.config, t.elementValue);
        c.pileType = t.pileType;
        c.flags = t.flags;
        return c;
      });
    return new OfflineGame(tiles);
  }

  // ═══════════════════════════════════════════════════
  //  Core game logic
  // ═══════════════════════════════════════════════════

  /**
   * Collect a clickable tile: Desk → Dock → check match → update state.
   * This is the atomic game action.
   */
  collect(tile: OfflineTile): void {
    if (tile.pileType !== PileType.Desk || !tile.isClickable) {
      throw new Error(`Tile ${tile.id} is not clickable, cannot collect`);
    }

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

    // 4. Update tile states (recompute RuntimeDependencies → Clickable)
    this.updateTilesState();
  }

  /**
   * Revive: eliminate 1 dock tile + 2 matching desk tiles (same color).
   * Used when dock is full to recover from a death state.
   * Does NOT check clickability — desk tiles can be blocked.
   * After elimination, updateTilesState() recomputes all dependencies.
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
  }

  /**
   * Rebuild RuntimeDependencies for all Desk tiles.
   * A dependency counts only if the dep tile is still on Desk (not collected).
   * If RuntimeDependencies is empty → tile is Clickable.
   * Also refreshes PerfectCovered and Invisible flags.
   */
  private updateTilesState(): void {
    // Phase 1: Compute RuntimeDependencies and Clickable
    for (const tile of this.allTiles.values()) {
      tile.runtimeDependencies.clear();

      if (tile.pileType !== PileType.Desk || tile.hasFlag(TileFlag.Destroyed)) {
        tile.removeFlag(TileFlag.Clickable | TileFlag.Invisible | TileFlag.PerfectCovered);
        continue;
      }

      for (const depId of tile.config.dependencies) {
        const dep = this.allTiles.get(depId);
        if (dep && dep.pileType === PileType.Desk && !dep.hasFlag(TileFlag.Destroyed)) {
          tile.runtimeDependencies.add(depId);
        }
      }

      tile.setClickable(tile.runtimeDependencies.size === 0);

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

      const invisible =
        tile.hasFlag(TileFlag.PerfectCovered) ||
        isProjectionFullyCovered(tile, this.allTiles);
      if (invisible) tile.setFlag(TileFlag.Invisible);
      else tile.removeFlag(TileFlag.Invisible);
    }
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
   * Format: "sorted_desk_ids|color1:count1,color2:count2,..."
   */
  buildStateKey(): string {
    const deskIds = this.deskTiles.map(t => t.id).sort((a, b) => a - b).join(',');

    const dockCounts = new Map<number, number>();
    for (const t of this.dockTiles) {
      dockCounts.set(t.elementValue, (dockCounts.get(t.elementValue) ?? 0) + 1);
    }
    const dockSig = [...dockCounts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([color, count]) => `${color}:${count}`)
      .join(',');

    return `${deskIds}|${dockSig}`;
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
    let gain = 0;
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

export interface GameFactoryInput {
  terrainTiles: TerrainTile[];
  /** tileId → element value (1-based color) */
  elementValues: Map<number, number>;
  /** Initial dock entries from replay code */
  initialDock?: { tileId: number; element: number }[];
  /** Already-eliminated tile IDs (from replay code instanceArray) */
  eliminatedTileIds?: Set<number>;
}

/**
 * Create an OfflineGame from terrain + assigned colors + replay data.
 */
export function createGame(input: GameFactoryInput): OfflineGame {
  const { terrainTiles, elementValues, initialDock, eliminatedTileIds } = input;

  const tiles: OfflineTile[] = terrainTiles.map(tt => {
    const config: TileConfig = {
      id: tt.id,
      layer: tt.layer,
      dependencies: [...tt.dependencies],
      isConst: tt.isConst,
      constElementValue: tt.constElementValue,
      posX: tt.posX,
      posY: tt.posY,
    };
    const ev = elementValues.get(tt.id) ?? 1;
    const tile = new OfflineTile(config, ev);

    // Apply initial pile type
    if (initialDock) {
      const dockEntry = initialDock.find(d => d.tileId === tt.id);
      if (dockEntry) {
        tile.pileType = PileType.Dock;
        tile.elementValue = dockEntry.element;
      }
    }
    if (eliminatedTileIds?.has(tt.id)) {
      tile.pileType = PileType.Discard;
    }

    return tile;
  });

  return new OfflineGame(tiles);
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
