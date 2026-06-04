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
   * Rebuild RuntimeDependencies for all Desk tiles.
   * A dependency counts only if the dep tile is still on Desk (not collected).
   * If RuntimeDependencies is empty → tile is Clickable.
   */
  private updateTilesState(): void {
    for (const tile of this.allTiles.values()) {
      tile.runtimeDependencies.clear();

      if (tile.pileType !== PileType.Desk || (tile.flags & TileFlag.Destroyed) !== 0) {
        tile.setClickable(false);
        continue;
      }

      for (const depId of tile.config.dependencies) {
        const dep = this.allTiles.get(depId);
        if (dep && dep.pileType === PileType.Desk && (dep.flags & TileFlag.Destroyed) === 0) {
          tile.runtimeDependencies.add(depId);
        }
      }

      tile.setClickable(tile.runtimeDependencies.size === 0);
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
