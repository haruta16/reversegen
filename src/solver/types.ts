/**
 * Solver framework — core types.
 *
 * Models the game at tile-click granularity (not triple-step).
 * RuntimeDependencies are dynamic: only deps still on Desk.
 */

import type { TileExtra } from '../mechanics/types.js';

// ── Tile flags (bitmask) ──

export enum TileFlag {
  None = 0,
  Clickable = 1 << 0,     // 1
  Destroyed = 1 << 3,     // 8
  PerfectCovered = 1 << 6, // 64  — another tile overlaps ≥90% of this tile's area
  Invisible = 1 << 9,     // 512 — not visible to the player (PerfectCovered or fully projection-covered)
}

// ── Pile location ──

export enum PileType {
  Desk = 1,
  Dock = 2,
  Discard = 9,
}

// ── Tile config (immutable, from terrain) ──

export interface TileConfig {
  id: number;
  layer: number;
  /** Direct dependencies (tile IDs this tile sits on top of) */
  dependencies: number[];
  isConst: boolean;
  constElementValue: number;
  /** Tile center X coordinate (for geometry visibility) */
  posX: number;
  /** Tile center Y coordinate (for geometry visibility) */
  posY: number;
  /** 挂件（特殊机制）列表，缺省为空 */
  extras?: TileExtra[];
}

// ── Offline tile (mutable runtime state) ──

export class OfflineTile {
  readonly config: TileConfig;
  elementValue: number; // 1-based color index
  pileType: PileType = PileType.Desk;
  flags: TileFlag = TileFlag.None;

  /** 挂件列表（运行时可变：泡泡角标会动态追加，对齐 Unity tile.Extras） */
  extras: TileExtra[];

  /** Dynamic: only dependencies still on Desk (not yet collected) */
  runtimeDependencies: Set<number> = new Set();

  constructor(config: TileConfig, elementValue: number) {
    this.config = config;
    this.elementValue = elementValue;
    this.extras = (config.extras ?? []).map(e => ({ ...e }));
  }

  get id(): number {
    return this.config.id;
  }

  get isClickable(): boolean {
    return (this.flags & TileFlag.Clickable) !== 0;
  }

  hasFlag(flag: TileFlag): boolean {
    return (this.flags & flag) !== 0;
  }

  setFlag(flag: TileFlag): void {
    this.flags |= flag;
  }

  removeFlag(flag: number): void {
    this.flags &= ~flag;
  }

  setClickable(v: boolean): void {
    if (v) this.flags |= TileFlag.Clickable;
    else this.flags &= ~TileFlag.Clickable;
  }

  clone(): OfflineTile {
    const t = new OfflineTile(this.config, this.elementValue);
    t.pileType = this.pileType;
    t.flags = this.flags;
    t.extras = this.extras.map(e => ({ ...e }));
    // runtimeDependencies is rebuilt in UpdateTilesState, not cloned
    return t;
  }
}

// ── Revive step (death recovery) ──

/** A single revive operation: eliminate 1 dock tile + 2 matching desk tiles. */
export interface ReviveStep {
  /** Overall step index (0-based, counting both clicks and prior revives) */
  stepIndex: number;
  /** The dock tile eliminated */
  dockTileId: number;
  /** The two desk tiles eliminated */
  deskTileIds: [number, number];
  /** Color (element value) shared by all three tiles */
  color: number;
}

// ── Solver results ──

export interface SolverResult {
  /** Was the board solved? */
  win: boolean;
  /** If not win, why? */
  failReason: string | null;
  /** Sequence of tile IDs clicked */
  picks: number[];
  /** Number of clicks made */
  stepCount: number;
  /** All dead states encountered in DFS (can be analyzed for death points) */
  deadStates: string[];
  /** States visited */
  statesVisited: number;
  /** Elapsed ms */
  elapsedMs: number;
  /** Minimum death recovery points needed to win (-1 if not evaluated) */
  minRevives?: number;
  /** Revive actions in the found path (empty if none used) */
  reviveSteps?: ReviveStep[];
}

export interface GreedyResult {
  win: boolean;
  failReason: string | null;
  picks: number[];
  stepCount: number;
  /** Per-step cost (net new tiles entering dock) */
  costLog: number[];
  /** Per-step dock usage */
  dockLog: number[];
  elapsedMs: number;
}

export interface RandomResult {
  win: boolean;
  failReason: string | null;
  picks: number[];
  stepCount: number;
}

// ── DAG features for a specific board ──

export interface DAGFeatures {
  /** Number of triples (N_free / 3) */
  tripleCount: number;
  /** Number of partial-order edges */
  edgeCount: number;
  /** Dependency depth range */
  depthMin: number;
  depthMax: number;
  /** Per-layer triple counts */
  layerDistribution: Record<number, number>;
  /** Average depSet size */
  avgDepSetSize: number;
  /** Number of triples with zero successors (leaf nodes) */
  leafTripleCount: number;
  /** Number of triples with zero predecessors (root nodes) */
  rootTripleCount: number;
  /** Maximum branching factor at any step (max parallel triples) */
  maxParallelism: number;
  /** Average parallelism per layer */
  avgParallelism: number;
  /** Bottleneck score: tiles appearing in most triples' depSets */
  maxBottleneckScore: number;
  /** depSet overlap density (edges / possible_pairs among same-layer) */
  overlapDensity: number;
  /** Net dock pressure per triple (depSetSize - 3) distribution */
  netPressure: { min: number; max: number; avg: number };
}
