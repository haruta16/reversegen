/**
 * Procedural Terrain Generator.
 *
 * 不依赖外部地形——直接生成 tile 依赖图 + 花色分配。
 * 通过设计依赖结构本身，构造性地保证可解性/死亡/分支数。
 *
 * 三种模式:
 *   SOLVABLE: 线性层链 (每层N色，消除完一层释放下一层)
 *   DEATH:    死锁环 (每色2 surface + 1 anchor，anchors互锁)
 *   HYBRID:   前K步线性链 + 后续死锁环 (第K步开始死亡)
 */

import type { TerrainData, TerrainTile, TerrainLayer } from './types.js';
import { createGame } from './solver/offline-game.js';
import { solveDFS } from './solver/solver-dfs.js';
import { setLogLevel, LogLevel } from './logger.js';
setLogLevel(LogLevel.Error);

// ═══════════════════════════════════════════════════
//  Spec
// ═══════════════════════════════════════════════════

export interface TerrainGenSpec {
  /** Total free tiles (3的倍数) */
  totalTiles: number;
  solvable: boolean;
  /** Death step (-1 = solvable, 0 = immediate death, K = death after K steps) */
  deathStep?: number;
  /** Per-step branch count. If provided, distributes colors across layers to match */
  branchSpec?: number[];
}

export interface GeneratedBoard {
  terrain: TerrainData;
  assignments: Map<number, number>;
  branchLog: number[];
  totalSteps: number;
}

// ═══════════════════════════════════════════════════
//  Construction
// ═══════════════════════════════════════════════════

export function generateTerrain(spec: TerrainGenSpec): GeneratedBoard {
  const { totalTiles, solvable, deathStep = 0, branchSpec } = spec;
  const totalSteps = totalTiles / 3;
  const totalColors = totalSteps;

  if (solvable) {
    return constructSolvable(totalTiles, branchSpec);
  }

  // Death/hybrid
  const ds = Math.max(0, deathStep ?? 0);
  if (ds === 0) {
    return constructDeathRing(totalColors);
  }

  // Hybrid: first K steps solvable chain + death ring for remainder
  return constructHybrid(totalTiles, ds);
}

// ═══════════════════════════════════════════════════
//  Mode 1: Solvable chain
// ═══════════════════════════════════════════════════

function constructSolvable(
  totalTiles: number, branchSpec?: number[],
): GeneratedBoard {
  const totalColors = totalTiles / 3;

  // Determine layers from branchSpec
  let layers: number[]; // layers[i] = colors in layer i
  if (branchSpec && branchSpec.length > 0) {
    // Group consecutive same branch counts into layers
    // branchSpec[i] = available colors at step i
    // Each color in a layer contributes `layerSize` steps with `layerSize` branches
    layers = inferLayers(branchSpec, totalColors);
  } else {
    // Default: single layer, all colors
    layers = [totalColors];
  }

  const tiles: TerrainTile[] = [];
  const assignments = new Map<number, number>();
  let nextId = 1;
  const layerTileIds: number[][] = []; // layerTileIds[l] = tiles in layer l

  // Generate tiles: each layer gets `layers[l]` colors × 3 tiles
  for (let l = 0; l < layers.length; l++) {
    const colorCount = layers[l];
    const layerIds: number[] = [];

    for (let c = 0; c < colorCount; c++) {
      const color = (layerTileIds.reduce((s, ids) => s + ids.length, 0) / 3) + c + 1;
      for (let t = 0; t < 3; t++) {
        const id = nextId++;
        const deps: number[] = [];
        if (l > 0) {
          // Depend on all tiles from previous layer
          deps.push(...layerTileIds[l - 1]);
        }
        tiles.push({ id, layer: l, dependencies: deps, isConst: false, constElementValue: 0 });
        layerIds.push(id);
        assignments.set(id, color);
      }
    }
    layerTileIds.push(layerIds);
  }

  // Compute branch log
  const branchLog = computeSolvableBranchLog(layers);

  return wrapResult(tiles, assignments, branchLog, totalTiles / 3);
}

/**
 * Infer layer counts from target branch sequence.
 * Example: branchSpec=[3,3,2,2,2,1,1,1,1] → layers=[3,2,4]
 * (3 colors in layer 0 give 3 steps of branch 3, etc.)
 */
function inferLayers(branchSpec: number[], totalColors: number): number[] {
  const layers: number[] = [];
  let i = 0;
  while (i < branchSpec.length) {
    const b = branchSpec[i];
    layers.push(b);
    i += b; // skip b steps (one per color in this layer)
  }
  // Validate
  const sum = layers.reduce((a, b) => a + b, 0);
  if (sum !== totalColors) {
    // Adjust last layer to match total
    layers[layers.length - 1] += totalColors - sum;
  }
  return layers.filter(l => l > 0);
}

function computeSolvableBranchLog(layers: number[]): number[] {
  const log: number[] = [];
  for (const colorCount of layers) {
    for (let c = colorCount; c > 0; c--) {
      log.push(c);
    }
  }
  return log;
}

// ═══════════════════════════════════════════════════
//  Mode 2: Death ring (all colors in deadlock)
// ═══════════════════════════════════════════════════

function constructDeathRing(N: number): GeneratedBoard {
  const tiles: TerrainTile[] = [];
  const assignments = new Map<number, number>();
  let nextId = 1;

  // Layer 1: surface tiles (2 per color, no deps)
  for (let c = 0; c < N; c++) {
    for (let s = 0; s < 2; s++) {
      tiles.push({ id: nextId++, layer: 1, dependencies: [], isConst: false, constElementValue: 0 });
      assignments.set(nextId - 1, c + 1);
    }
  }

  // Layer 0: anchor tiles (1 per color, ring dependencies — fill after creation)
  const anchors: number[] = [];
  for (let c = 0; c < N; c++) {
    const id = nextId++;
    tiles.push({ id, layer: 0, dependencies: [], isConst: false, constElementValue: 0 });
    anchors.push(id);
    assignments.set(id, c + 1);
  }

  // Set anchor dependencies: anchor i depends on (i+1) and (i+2) mod N
  for (let i = 0; i < N; i++) {
    const anchorTile = tiles.find(t => t.id === anchors[i])!;
    anchorTile.dependencies = [
      anchors[(i + 1) % N],
      anchors[(i + 2) % N],
    ];
  }

  const branchLog = Array(N).fill(0);

  return wrapResult(tiles, assignments, branchLog, N);
}

// ═══════════════════════════════════════════════════
//  Mode 3: Hybrid (K steps solvable + death ring)
// ═══════════════════════════════════════════════════

function constructHybrid(totalTiles: number, deathStep: number): GeneratedBoard {
  const totalColors = totalTiles / 3;
  const deathColors = totalColors - deathStep; // colors in death ring

  if (deathColors < 3) {
    // Not enough colors for a ring (need ≥3). Fall back to solvable.
    return constructSolvable(totalTiles);
  }

  // Phase 1: Solvable chain for first `deathStep` colors
  const chainColors = deathStep;
  const tiles: TerrainTile[] = [];
  const assignments = new Map<number, number>();
  let nextId = 1;

  // Chain tiles (layer 2): 3 per color, all free
  const chainTileIds: number[] = [];
  for (let c = 0; c < chainColors; c++) {
    for (let t = 0; t < 3; t++) {
      const id = nextId++;
      tiles.push({ id, layer: 2, dependencies: [], isConst: false, constElementValue: 0 });
      chainTileIds.push(id);
      assignments.set(id, c + 1);
    }
  }

  // Death ring tiles
  // Layer 1: surface tiles (2 per death color, deps on chain tiles)
  const surfaceTileIds: number[] = [];
  for (let c = 0; c < deathColors; c++) {
    for (let s = 0; s < 2; s++) {
      const id = nextId++;
      tiles.push({
        id, layer: 1,
        dependencies: [], // free after chain tiles are eliminated? No — surface tiles are free from start
        isConst: false, constElementValue: 0,
      });
      surfaceTileIds.push(id);
      assignments.set(id, chainColors + c + 1);
    }
  }

  // Layer 0: anchor tiles (1 per death color, ring + chain deps)
  const anchors: number[] = [];
  for (let c = 0; c < deathColors; c++) {
    const id = nextId++;
    tiles.push({ id, layer: 0, dependencies: [], isConst: false, constElementValue: 0 });
    anchors.push(id);
    assignments.set(id, chainColors + c + 1);
  }

  // Anchor dependencies: ring + chain barrier
  for (let i = 0; i < deathColors; i++) {
    const anchorTile = tiles.find(t => t.id === anchors[i])!;
    // Anchor i depends on anchor (i+1), anchor (i+2), AND all chain tiles
    anchorTile.dependencies = [
      anchors[(i + 1) % deathColors],
      anchors[(i + 2) % deathColors],
      ...chainTileIds, // also blocked by chain tiles
    ];
  }

  // Branch log: chain steps (decreasing) + death steps (zeros)
  const branchLog: number[] = [];
  for (let i = chainColors; i > 0; i--) branchLog.push(i);
  for (let i = 0; i < deathColors; i++) branchLog.push(0);

  return wrapResult(tiles, assignments, branchLog, totalColors);
}

// ═══════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════

function wrapResult(
  tiles: TerrainTile[], assignments: Map<number, number>,
  branchLog: number[], totalSteps: number,
): GeneratedBoard {
  const layerMap = new Map<number, TerrainTile[]>();
  for (const t of tiles) {
    const l = layerMap.get(t.layer) ?? [];
    l.push(t);
    layerMap.set(t.layer, l);
  }
  const layers: TerrainLayer[] = [...layerMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([_, tls]) => ({ tiles: tls.sort((a, b) => a.id - b.id) }));

  const terrain: TerrainData = { levelResId: 0, levelHash: '', layers };

  return { terrain, assignments, branchLog, totalSteps };
}

// ═══════════════════════════════════════════════════
//  Test
// ═══════════════════════════════════════════════════

function testBoard(spec: TerrainGenSpec, label: string) {
  const r = generateTerrain(spec);
  const ev = new Map<number, number>();
  const allTiles: any[] = [];
  for (const l of r.terrain.layers) for (const t of l.tiles) {
    allTiles.push(t);
    ev.set(t.id, r.assignments.get(t.id) ?? 1);
  }
  const game = createGame({ terrainTiles: allTiles, elementValues: ev });
  const dfs = solveDFS(game, { timeoutMs: 10000 });
  const mod3ok = [...new Set(r.assignments.values())].every(c => {
    let cnt = 0;
    for (const [, cc] of r.assignments) if (cc === c) cnt++;
    return cnt % 3 === 0;
  });

  const status = (spec.solvable ? dfs.win : !dfs.win) ? '✅' : '❌';
  console.log(`${status} ${label.padEnd(40)} DFSwin=${String(dfs.win).padEnd(5)} states=${String(dfs.statesVisited).padStart(6)} branch=[${r.branchLog.slice(0,6).join(',')}${r.branchLog.length>6?'...':''}] mod3=${mod3ok}`);
  return spec.solvable ? dfs.win : !dfs.win;
}

export function main() {
  console.log('Terrain Generator — Full Test Suite\n');

  let passed = 0, total = 0;

  // SOLVABLE
  console.log('── SOLVABLE ──');
  total++; if (testBoard({ totalTiles: 12, solvable: true }, '12t flat (4 colors)')) passed++;
  total++; if (testBoard({ totalTiles: 24, solvable: true }, '24t flat (8 colors)')) passed++;
  total++; if (testBoard({ totalTiles: 36, solvable: true }, '36t flat (12 colors)')) passed++;
  total++; if (testBoard({ totalTiles: 30, solvable: true, branchSpec: [3,3,3,2,2,2,1,1,1,1] },
    '30t 3-layer [3,2,4]')) passed++;

  // DEATH ring
  console.log('\n── DEATH ring ──');
  for (const N of [3, 4, 5, 8, 12, 20]) {
    total++; if (testBoard({ totalTiles: N * 3, solvable: false, deathStep: 0 },
      `Death ring N=${N} (${N*3}t)`)) passed++;
  }

  // HYBRID
  console.log('\n── HYBRID (chain + ring) ──');
  total++; if (testBoard({ totalTiles: 21, solvable: false, deathStep: 3 },
    '21t: 3 chain + 4 death')) passed++;
  total++; if (testBoard({ totalTiles: 30, solvable: false, deathStep: 5 },
    '30t: 5 chain + 5 death')) passed++;
  total++; if (testBoard({ totalTiles: 39, solvable: false, deathStep: 6 },
    '39t: 6 chain + 7 death')) passed++;
  total++; if (testBoard({ totalTiles: 60, solvable: false, deathStep: 10 },
    '60t: 10 chain + 10 death')) passed++;

  console.log(`\n${'═'.repeat(40)}`);
  console.log(`  ${passed}/${total} passed`);
}

if (process.argv[1]?.endsWith('terrain-gen.ts') || process.argv[1]?.endsWith('terrain-gen.js')) {
  main();
}
