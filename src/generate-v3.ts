/**
 * Generation Algorithm v3 — forward construction with step-lookahead.
 *
 * Core principle: construct the elimination sequence FORWARD.
 * At each step, select 3 tiles to form a triple (unique color).
 * One-step lookahead guarantees correctness — no backtracking, no post-verification.
 *
 * Input parameters:
 *   - terrain: tile layout
 *   - solvable: whether the board should be solvable
 *   - deathStep: if unsolvable, which step dies (0 = immediate death)
 *   - freedomProfile: per-step number of colors with ≥3 clickable (parallel options)
 *   - colorMode: 'unique' (each triple unique color) | 'shared' (merge triples later)
 */
import type { TerrainTile, TerrainData } from './types.js';
import { computeAllDependencies } from './dependency-graph.js';
import { logger, setLogLevel, LogLevel } from './logger.js';

// ═══════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════

export interface GenV3Input {
  terrain: TerrainData;
  /** Whether the board should be solvable (default true) */
  solvable?: boolean;
  /** If unsolvable, which step dies (0 = no initial triple) */
  deathStep?: number;
  /** Per-step number of parallel triple options (freedom) */
  freedomProfile?: number[] | 'auto';
  /** Unique color per triple, or shared later */
  colorMode?: 'unique' | 'shared';
}

export interface GenV3Output {
  /** tileId → color (1-based) */
  assignments: Map<number, number>;
  /** The "main path" triple sequence */
  mainPath: number[][];
  /** Per-step actual freedom (how many colors had ≥3 clickable) */
  actualFreedom: number[];
  /** Total steps */
  totalSteps: number;
  /** Was solvability achieved as requested? */
  solvable: boolean;
  /** Actual death step (if unsolvable) */
  actualDeathStep: number;
}

// ═══════════════════════════════════════════════════
//  Core: one-step lookahead
// ═══════════════════════════════════════════════════

/**
 * Given a set of tiles still on desk and their blocked status,
 * compute: after eliminating `pickedIds`, which tiles become clickable?
 *
 * Returns per-color count of tiles that would be clickable AFTER elimination.
 */
function predictAfterStep(
  deskTiles: TerrainTile[],
  pickedIds: Set<number>,
  tileColor: Map<number, number>, // assigned colors so far (incomplete during construction)
  tileDeps: Map<number, number[]>, // static dependencies (from terrain)
): Map<number, number> {
  const afterCount = new Map<number, number>();

  for (const tile of deskTiles) {
    if (pickedIds.has(tile.id)) continue; // tile was eliminated

    // Check if this tile is already clickable
    // A tile is clickable if ALL its dependencies are NOT on desk
    let blocked = false;
    for (const depId of tileDeps.get(tile.id) ?? []) {
      if (pickedIds.has(depId)) continue; // this blocker is being eliminated
      // Is this blocker still on desk?
      const stillOnDesk = deskTiles.some(t => t.id === depId);
      if (stillOnDesk) { blocked = true; break; }
    }

    if (!blocked) {
      const c = tileColor.get(tile.id) ?? 0;
      if (c > 0) {
        afterCount.set(c, (afterCount.get(c) ?? 0) + 1);
      }
    }
  }

  return afterCount;
}

/**
 * Find which colors (assigned so far) have ≥3 clickable tiles after step.
 */
function findAvailableColors(afterCount: Map<number, number>): number[] {
  return [...afterCount.entries()]
    .filter(([, n]) => n >= 3)
    .map(([c]) => c);
}

// ═══════════════════════════════════════════════════
//  Main generation
// ═══════════════════════════════════════════════════

export function generateV3(input: GenV3Input): GenV3Output {
  const { terrain, solvable = true, deathStep, freedomProfile = 'auto', colorMode = 'unique' } = input;

  // ── Flatten tiles ──
  const allTiles: TerrainTile[] = [];
  for (const layer of terrain.layers) {
    for (const tile of layer.tiles) {
      allTiles.push(tile);
    }
  }
  const freeTiles = allTiles.filter(t => !t.isConst);
  const constTiles = allTiles.filter(t => t.isConst);

  const totalSteps = Math.floor(freeTiles.length / 3);
  const allDeps = computeAllDependencies(allTiles);

  // ── Static dependency lookup ──
  const tileDeps = new Map<number, number[]>();
  for (const tile of freeTiles) {
    tileDeps.set(tile.id, [...tile.dependencies]);
  }

  // ── State ──
  const assignments = new Map<number, number>(); // tileId → color
  const mainPath: number[][] = []; // sequence of [tile1, tile2, tile3]

  // Const tiles: assign their fixed colors
  for (const t of constTiles) {
    if (t.constElementValue > 0) {
      assignments.set(t.id, t.constElementValue);
    }
  }

  // Desk tiles (not yet eliminated)
  let deskTileIds = new Set(freeTiles.map(t => t.id));

  // Colors assigned so far
  let nextColor = 1;
  // Skip const colors
  for (const [, c] of assignments) { if (c >= nextColor) nextColor = c + 1; }

  // ── Per-step tracking ──
  const actualFreedom: number[] = [];
  let actualDeathStep = -1;
  let boardSolvable = false;

  // ── Freedom profile resolution ──
  const fp: number[] = freedomProfile === 'auto'
    ? Array(totalSteps).fill(1) // default: exactly 1 option per step (unique path)
    : freedomProfile;

  // ── Main construction loop ──
  for (let step = 0; step < totalSteps; step++) {
    // Build current desk tile list
    const deskTiles = freeTiles.filter(t => deskTileIds.has(t.id));

    // Get currently clickable tiles (consider assigned colors)
    const clickableNow = deskTiles.filter(t => {
      const deps = tileDeps.get(t.id) ?? [];
      return deps.every(d => !deskTileIds.has(d));
    });

    // Group clickable tiles by their assigned color (or unassigned)
    const byColor = new Map<number, number[]>();
    for (const t of clickableNow) {
      const c = assignments.get(t.id) ?? 0;
      if (!byColor.has(c)) byColor.set(c, []);
      byColor.get(c)!.push(t.id);
    }

    // Colors with ≥3 clickable
    const availableColors = [...byColor.entries()]
      .filter(([, ids]) => ids.length >= 3)
      .map(([c]) => c);

    // For unassigned tiles (color=0), we can form NEW colors
    const unassignedClickable = byColor.get(0) ?? [];

    // Target freedom for this step
    const targetFreedom = Math.min(fp[Math.min(step, fp.length - 1)], Math.floor(unassignedClickable.length / 3) + availableColors.length);

    // ── Death check ──
    if (step >= totalSteps - 1) {
      // Last step: must be able to finish
      if (availableColors.length === 0 && unassignedClickable.length < 3) {
        actualDeathStep = step;
        boardSolvable = false;
        break;
      }
    }

    if (availableColors.length === 0 && unassignedClickable.length < 3) {
      actualDeathStep = step;
      boardSolvable = false;
      break;
    }

    // ── Select triple for main path ──
    let pickedIds: number[];

    if (availableColors.length > 0) {
      // Use an existing color
      const chosenColor = availableColors[0];
      pickedIds = byColor.get(chosenColor)!.slice(0, 3);
    } else {
      // Create new color from unassigned clickable tiles
      pickedIds = unassignedClickable.slice(0, 3);
      const newColor = nextColor++;

      // Assign
      for (const id of pickedIds) {
        assignments.set(id, newColor);
      }
    }

    mainPath.push(pickedIds);

    // ── One-step lookahead: what happens after this elimination? ──
    const pickedSet = new Set(pickedIds);
    const afterCount = predictAfterStep(deskTiles, pickedSet, assignments, tileDeps);
    const nextAvailable = findAvailableColors(afterCount);
    actualFreedom.push(Math.max(1, nextAvailable.length));

    // ── Also count unassigned clickable tiles for freedom ──
    const remainingDesk = deskTiles.filter(t => !pickedSet.has(t.id));
    const remainingClickable = remainingDesk.filter(t => {
      const deps = tileDeps.get(t.id) ?? [];
      return deps.every(d => !deskTiles.some(dt => dt.id === d && !pickedSet.has(d)));
    });
    const remainingUnassigned = remainingClickable.filter(t => !assignments.has(t.id));
    const potentialNewColors = Math.floor(remainingUnassigned.length / 3);
    const totalFreedom = nextAvailable.length + potentialNewColors;

    // Update desk
    for (const id of pickedIds) {
      deskTileIds.delete(id);
    }

    // ── Target freedom enforcement ──
    if (totalFreedom < targetFreedom && !solvable && step === (deathStep ?? -1)) {
      // We want death here — freedom < target is expected
    }

    // ── Solvability: we need to be able to finish ──
    const remainingTiles = freeTiles.filter(t => deskTileIds.has(t.id));
    if (remainingTiles.length === 0) {
      boardSolvable = true;
      break;
    }
  }

  // ── Assign remaining tiles ──
  const remainingTiles = freeTiles.filter(t => deskTileIds.has(t.id));
  for (const tile of remainingTiles) {
    if (!assignments.has(tile.id)) {
      // Assign to a random color (for unsolvable case, this creates dead ends)
      assignments.set(tile.id, nextColor++);
    }
  }

  // Group remaining colors to keep color count manageable
  // For now, just leave as unique

  return {
    assignments,
    mainPath,
    actualFreedom,
    totalSteps,
    solvable: boardSolvable,
    actualDeathStep,
  };
}
