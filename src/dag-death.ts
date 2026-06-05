/**
 * DAG-Driven Death Constructor — 色组DAG驱动的死亡牌局构造。
 *
 * 核心: 不是"分配花色到现有tile"，而是"从地形中选择满足DAG死锁条件的tile分组"。
 *
 * 理论:
 *   死锁的充要条件: 存在一个色组集合，其中每色 ≤1 初始自由tile，
 *   且该自由tile不阻塞同色的任何blocked tile。
 *   这样: 点击该自由tile最多释放1个同色tile → dock ≤2 → 永不形成triple。
 *
 * 约束满足问题:
 *   输入: 地形(依赖图) + 目标死亡深度K
 *   变量: 每个free tile的颜色, 每个blocked tile的颜色
 *   约束:
 *     1. 每色 ≤1 freed tile
 *     2. freed tile不阻塞同色的blocked tile
 *     3. 每色恰好3张tile (mod3 ✓)
 *     4. 前K步消除: 有正常triple (可选 — 用于部分死亡)
 *   目标: 最大化死亡颜色数, 最小化"遗漏的>3自由tile的颜色数"
 */

import type { TerrainTile, TerrainData } from './types.js';
import { getAllTiles, loadTerrainFromFile } from './terrain-loader.js';
import { computeAllDependencies } from './dependency-graph.js';
import { createGame } from './solver/offline-game.js';
import { solveDFS } from './solver/solver-dfs.js';
import { setLogLevel, LogLevel } from './logger.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

setLogLevel(LogLevel.Error);

interface TileNode {
  id: number;
  freeDeps: number[];  // direct deps that are free tiles
  blocks: number[];    // free tiles this tile blocks
  isInitiallyFree: boolean;
}

interface DeathCSP {
  nodes: Map<number, TileNode>;
  freeTiles: number[];
  blockedTiles: number[];
  assignment: Map<number, number>; // tileId → color
  nextColor: number;
}

export interface DAGDeathOutput {
  assignments: Map<number, number>;
  success: boolean;
  deathColors: number;
  reason: string;
}

/**
 * Build DAG-driven death assignments.
 *
 * Algorithm:
 *   1. Build tile dependency graph
 *   2. CSP: assign tiles to colors satisfying death constraints
 *   3. Verify: check no color can form ≥3 freed tiles after any click sequence
 *
 * @param deathStep - how many normal triples to create before death (0 = immediate death)
 */
export function constructDeath(
  terrain: TerrainData,
  deathStep: number = 0,
): DAGDeathOutput {
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(t => !t.isConst);

  const { nodes, freeIds, blockedIds } = buildTileGraph(freeTiles);
  const totalColors = Math.floor(freeTiles.length / 3);

  const assignments = new Map<number, number>();
  let nextColor = 1;

  // Phase 1: Normal triples for first `deathStep` steps
  const eliminated = new Set<number>();
  const deps = new Map<number, Set<number>>();
  for (const [tid, n] of nodes) deps.set(tid, new Set(n.freeDeps));

  for (let step = 0; step < deathStep; step++) {
    const freed = [...deps.entries()]
      .filter(([tid, rd]) => !eliminated.has(tid) && rd.size === 0)
      .map(([tid]) => tid);
    if (freed.length < 3) break;
    const triple = pickNonBlockingTriple(freed, nodes);
    if (!triple) break;
    for (const tid of triple) {
      assignments.set(tid, nextColor);
      eliminated.add(tid);
      for (const [rtid, rd] of deps) rd.delete(tid);
    }
    nextColor++;
  }

  // Phase 2: Death CSP on remaining tiles
  const remaining = freeTiles.filter(t => !eliminated.has(t.id));
  const remainingNodes = new Map<number, TileNode>();
  for (const t of remaining) {
    const n = nodes.get(t.id);
    if (n) remainingNodes.set(t.id, n);
  }

  // Recompute freed/blocked after plan eliminations
  const remFree: number[] = [];
  const remBlocked: number[] = [];
  for (const t of remaining) {
    const nd = remainingNodes.get(t.id);
    if (!nd) continue;
    // Check if ALL free-tile deps are eliminated
    const allBlockersGone = nd.freeDeps.every(d => eliminated.has(d));
    if (allBlockersGone) remFree.push(t.id);
    else remBlocked.push(t.id);
  }

  const F = remFree.length, B = remBlocked.length;

  // Necessary condition: B ≥ 2F (for ≤1 free per 3-tile color)
  if (B < 2 * F) {
    return {
      assignments,
      success: false,
      deathColors: 0,
      reason: `Cannot death: F=${F} freed tiles need B≥${2*F} blocked (have ${B}). Reduce deathStep.`,
    };
  }

  // CSP: assign tiles to death colors with DAG constraints
  const cspResult = solveDeathCSP(remFree, remBlocked, remainingNodes, assignments, nextColor);

  if (!cspResult.success) {
    return {
      assignments,
      success: false,
      deathColors: 0,
      reason: `CSP failed: ${cspResult.reason}`,
    };
  }

  return {
    assignments,
    success: true,
    deathColors: cspResult.colors,
    reason: `${cspResult.colors} death colors (${remFree.length} free + ${remBlocked.length} blocked)`,
  };
}

// ═══════════════════════════════════════════════════
//  CSP Solver
// ═══════════════════════════════════════════════════

function solveDeathCSP(
  freeTiles: number[],
  blockedTiles: number[],
  nodes: Map<number, TileNode>,
  assignments: Map<number, number>,
  startColor: number,
): { success: boolean; colors: number; reason: string } {
  const free = [...freeTiles];
  const blocked = [...blockedTiles];
  let c = startColor;
  let colors = 0;

  // Precompute: which free tiles block which blocked tiles
  const freeBlocks = new Map<number, Set<number>>();
  for (const fid of free) {
    const nd = nodes.get(fid);
    const set = new Set<number>();
    if (nd) for (const bid of nd.blocks) {
      if (blocked.includes(bid)) set.add(bid);
    }
    freeBlocks.set(fid, set);
  }

  // Precompute: which blocked tiles are blocked by which free tiles
  const blockedBy = new Map<number, number[]>();
  for (const bid of blocked) {
    const nd = nodes.get(bid);
    const blockers: number[] = [];
    if (nd) for (const depId of nd.freeDeps) {
      if (free.includes(depId)) blockers.push(depId);
    }
    blockedBy.set(bid, blockers);
  }

  // Greedy CSP: for each free tile, find 2 compatible blocked tiles
  // Compatible = NOT blocked by this free tile AND not blocking each other

  while (free.length > 0) {
    // Pick the free tile with the FEWEST blocking targets (least disruptive)
    let bestIdx = 0, bestCount = Infinity;
    for (let i = 0; i < Math.min(free.length, 50); i++) {
      const count = freeBlocks.get(free[i])?.size ?? 0;
      if (count < bestCount) { bestCount = count; bestIdx = i; }
    }
    const fid = free.splice(bestIdx, 1)[0];
    const fidBlocks = freeBlocks.get(fid) ?? new Set();

    // Find 2 blocked tiles NOT blocked by fid
    const candidates: number[] = [];
    for (let i = blocked.length - 1; i >= 0 && candidates.length < 3; i--) {
      const bid = blocked[i];
      const bidBlockers = blockedBy.get(bid) ?? [];
      // Condition 1: bid is NOT blocked by fid
      if (bidBlockers.includes(fid)) continue;
      // Condition 2: bid doesn't block other candidates (internal consistency)
      let compatible = true;
      const bidNode = nodes.get(bid);
      for (const cid of candidates) {
        if (bidNode && bidNode.blocks.includes(cid)) { compatible = false; break; }
        const cNode = nodes.get(cid);
        if (cNode && cNode.blocks.includes(bid)) { compatible = false; break; }
      }
      if (!compatible) continue;
      candidates.push(bid);
    }

    if (candidates.length < 2) {
      // Can't find enough compatible blocked tiles → CSP fails
      // Put fid back
      free.push(fid);
      break;
    }

    // Remove selected blocked tiles
    const selected = candidates.slice(0, 2);
    for (const bid of selected) {
      const idx = blocked.indexOf(bid);
      if (idx >= 0) blocked.splice(idx, 1);
    }

    // Assign: 1 free + 2 blocked → same color
    assignments.set(fid, c);
    for (const bid of selected) assignments.set(bid, c);
    c++;
    colors++;
  }

  // Remaining blocked tiles → [0 free + 3 blocked] groups
  while (blocked.length >= 3) {
    const g = blocked.splice(0, 3);
    for (const bid of g) assignments.set(bid, c);
    c++; colors++;
  }

  // Any leftovers
  for (const bid of blocked) assignments.set(bid, c++);

  const remainingFree = free.length;
  if (remainingFree > 0) {
    return { success: false, colors, reason: `${remainingFree} free tiles couldn't be assigned (no compatible blocked tiles)` };
  }

  return { success: true, colors, reason: 'OK' };
}

// ═══════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════

function buildTileGraph(freeTiles: TerrainTile[]): {
  nodes: Map<number, TileNode>;
  freeIds: number[];
  blockedIds: number[];
} {
  const tileMap = new Map<number, TerrainTile>();
  for (const t of freeTiles) tileMap.set(t.id, t);

  const nodes = new Map<number, TileNode>();
  const freeIds: number[] = [];
  const blockedIds: number[] = [];

  for (const t of freeTiles) {
    const freeDeps = t.dependencies.filter(d => tileMap.has(d));
    const isFree = freeDeps.length === 0;
    nodes.set(t.id, {
      id: t.id,
      freeDeps,
      blocks: [],
      isInitiallyFree: isFree,
    });
    if (isFree) freeIds.push(t.id);
    else blockedIds.push(t.id);
  }

  // Build reverse blocking
  for (const t of freeTiles) {
    for (const depId of t.dependencies) {
      const blocker = nodes.get(depId);
      if (blocker) blocker.blocks.push(t.id);
    }
  }

  return { nodes, freeIds, blockedIds };
}

function pickNonBlockingTriple(candidates: number[], nodes: Map<number, TileNode>): number[] | null {
  if (candidates.length < 3) return null;
  for (let i = 0; i < candidates.length - 2; i++) {
    for (let j = i + 1; j < candidates.length - 1; j++) {
      for (let k = j + 1; k < candidates.length; k++) {
        const t = [candidates[i], candidates[j], candidates[k]];
        let valid = true;
        for (const tid of t) {
          const nd = nodes.get(tid);
          if (!nd) { valid = false; break; }
          for (const depId of nd.freeDeps) {
            if (t.includes(depId)) { valid = false; break; }
          }
          if (!valid) break;
        }
        if (valid) return t;
      }
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════
//  Quick test
// ═══════════════════════════════════════════════════

export function main() {
  const D = 'E:/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';

  for (const tid of [100002, 100006, 100010]) {
    const terrain = loadTerrainFromFile(join(D, `${tid}.json`));
    const allTiles: any[] = [];
    for (const l of terrain.layers) for (const t of l.tiles) allTiles.push(t);
    const freeTiles = allTiles.filter((t: any) => !t.isConst);
    const steps = Math.floor(freeTiles.length / 3);

    console.log(`\n${tid} (${freeTiles.length}t ${steps}st):`);

    for (const ds of [0, Math.floor(steps/4)]) {
      const r = constructDeath(terrain, ds);
      if (r.success) {
        const ev = new Map<number, number>();
        for (const t of allTiles) {
          if ((t as any).isConst && (t as any).constElementValue > 0)
            ev.set(t.id, (t as any).constElementValue);
          else ev.set(t.id, r.assignments.get(t.id) ?? 1);
        }
        const game = createGame({ terrainTiles: allTiles, elementValues: ev });
        const dfs = solveDFS(game, { timeoutMs: 10000 });
        console.log(`  D@${ds}: success deathColors=${r.deathColors} DFSwin=${dfs.win} states=${dfs.statesVisited}`);
      } else {
        console.log(`  D@${ds}: FAILED — ${r.reason}`);
      }
    }
  }
}

if (process.argv[1]?.endsWith('dag-death.ts') || process.argv[1]?.endsWith('dag-death.js')) {
  main();
}
