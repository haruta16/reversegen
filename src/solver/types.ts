/**
 * Solver framework — core types.
 *
 * Models the game at tile-click granularity (not triple-step).
 * RuntimeDependencies are dynamic: only deps still on Desk.
 */

// ── Tile flags (bitmask) ──

export enum TileFlag {
  None = 0,
  Clickable = 1 << 0,
  Destroyed = 1 << 3,
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
}

// ── Offline tile (mutable runtime state) ──

export class OfflineTile {
  readonly config: TileConfig;
  elementValue: number; // 1-based color index
  pileType: PileType = PileType.Desk;
  flags: TileFlag = TileFlag.None;

  /** Dynamic: only dependencies still on Desk (not yet collected) */
  runtimeDependencies: Set<number> = new Set();

  constructor(config: TileConfig, elementValue: number) {
    this.config = config;
    this.elementValue = elementValue;
  }

  get id(): number {
    return this.config.id;
  }

  get isClickable(): boolean {
    return (this.flags & TileFlag.Clickable) !== 0;
  }

  setClickable(v: boolean): void {
    if (v) this.flags |= TileFlag.Clickable;
    else this.flags &= ~TileFlag.Clickable;
  }

  clone(): OfflineTile {
    const t = new OfflineTile(this.config, this.elementValue);
    t.pileType = this.pileType;
    t.flags = this.flags;
    // runtimeDependencies is rebuilt in UpdateTilesState, not cloned
    return t;
  }
}

// ── Game state snapshot for memoization ──

export interface GameStateKey {
  /** Sorted desk tile IDs */
  deskIds: number[];
  /** Dock counts by color, e.g. "1:2,3:1" (color → count in dock) */
  dockSignature: string;
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

// ── Board analysis result ──

export interface BoardAnalysis {
  /** Terrain info */
  levelResId?: number;
  levelHash: string;
  totalTiles: number;
  freeTiles: number;

  /** Solver results */
  dfs: SolverResult | null;
  greedy: GreedyResult | null;
  randomResults: RandomResult[];

  /** DAG features (populated later by analysis module) */
  dagFeatures?: DAGFeatures;
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
