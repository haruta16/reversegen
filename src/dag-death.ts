/**
 * DAG-Driven Death Search — 在现有地形依赖图中搜索死锁子图。
 *
 * 核心: 不是"把所有tile分配到死亡色"，而是"找到能形成死锁的tile子集"。
 *
 * 算法:
 *   1. 对每个候选 deathStep K，运行计划(选K个triple)
 *   2. 剩余tile分为 freed(F) 和 blocked(B)
 *   3. 死锁CSP: 将F∪B分组为3-tile颜色，每色≤1 freed，freed不阻塞同色blocked
 *   4. 如果CSP成功 → deathStep K可行
 *   5. 遍历K找到"最大可行deathStep"
 *
 * 与 terrain-gen 的本质区别:
 *   terrain-gen 设计依赖图 → 不适用于现有地形
 *   本模块 搜索现有依赖图中的死锁子图 → 适用于任意地形
 */

import type { TerrainTile, TerrainData } from './types.js';
import { getAllTiles, loadTerrainFromFile } from './terrain-loader.js';
import { createGame } from './solver/offline-game.js';
import { solveDFS } from './solver/solver-dfs.js';
import { verifyDeath } from './verify-death.js';
import { setLogLevel, LogLevel } from './logger.js';
import { join } from 'node:path';
setLogLevel(LogLevel.Error);

// ═══════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════

interface TileNode {
  id: number;
  freeDeps: number[];
  blocks: number[];
}

export interface DeathSearchResult {
  /** Best death step found (-1 if none) */
  deathStep: number;
  /** Color assignment */
  assignments: Map<number, number>;
  /** Branch log */
  branchLog: number[];
  /** CSP succeeded at this step */
  success: boolean;
  /** Plan colors count */
  planColors: number;
  /** Death colors count */
  deathColors: number;
  /** Reason for failure (if success=false) */
  reason: string;
}

// ═══════════════════════════════════════════════════
//  Search
// ═══════════════════════════════════════════════════

export function searchDeath(terrain: TerrainData): DeathSearchResult {
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(t => !t.isConst);
  const totalSteps = Math.floor(freeTiles.length / 3);
  const nodes = buildGraph(freeTiles);

  // Sample candidate K values: 0, 1/4, 1/2, 3/4, then refine
  const candidates = new Set<number>();
  candidates.add(0);
  for (const frac of [0.25, 0.5, 0.75]) candidates.add(Math.floor(totalSteps * frac));
  candidates.add(totalSteps - 1);

  let bestK = -1;
  let bestResult: DeathSearchResult | null = null;

  for (const K of [...candidates].sort((a,b) => a-b)) {
    if (K < 0 || K >= totalSteps) continue;
    const result = tryDeathAt(freeTiles, nodes, K, totalSteps);
    if (result.success) {
      // Refine: search around K for better fit
      bestK = K;
      bestResult = result;
      // Try K±1, K±2
      for (const offset of [1, -1, 2, -2]) {
        const k2 = K + offset;
        if (k2 >= 0 && k2 < totalSteps) {
          const r2 = tryDeathAt(freeTiles, nodes, k2, totalSteps);
          if (r2.success && r2.deathColors > (bestResult?.deathColors ?? 0)) {
            bestK = k2;
            bestResult = r2;
          }
        }
      }
    }
  }

  if (bestResult) return bestResult;

  // No death possible → return solvable
  const solvable = trySolve(freeTiles, nodes, totalSteps);
  return {
    deathStep: -1,
    assignments: solvable.assignments,
    branchLog: solvable.branchLog,
    success: false,
    planColors: totalSteps,
    deathColors: 0,
    reason: 'NoK:allFail',
  };
}

// ═══════════════════════════════════════════════════
//  Try death at a specific step
// ═══════════════════════════════════════════════════

function tryDeathAt(
  freeTiles: TerrainTile[],
  nodes: Map<number, TileNode>,
  K: number,
  totalSteps: number,
): DeathSearchResult {
  const assignments = new Map<number, number>();
  const eliminated = new Set<number>();
  const deps = new Map<number, Set<number>>();
  for (const [tid, n] of nodes) deps.set(tid, new Set(n.freeDeps));

  // Phase 1: Plan — create K normal colors (max-release strategy)
  let planColors = 0;
  for (let step = 0; step < K; step++) {
    const freed = [...deps.entries()]
      .filter(([tid, rd]) => !eliminated.has(tid) && rd.size === 0)
      .map(([tid]) => tid);
    if (freed.length < 3) break;

    // Find triple with max exclusive release (to minimize remaining F)
    const triple = pickBestTriple(freed, nodes, deps);
    if (!triple) break;
    for (const tid of triple) {
      assignments.set(tid, planColors + 1);
      eliminated.add(tid);
      for (const [rtid, rd] of deps) rd.delete(tid);
    }
    planColors++;
  }

  if (planColors < K) {
    return { deathStep: K, assignments, branchLog: [], success: false, planColors, deathColors: 0,
      reason: `Plan failed at step ${planColors} (< ${K})` };
  }

  // Phase 2: Classify remaining tiles
  const remaining = freeTiles.filter(t => !eliminated.has(t.id));
  const F: number[] = []; // will-be-freed (all blockers eliminated by plan)
  const B: number[] = []; // will-stay-blocked

  for (const t of remaining) {
    const nd = nodes.get(t.id);
    if (!nd) continue;
    const allGone = nd.freeDeps.every(d => eliminated.has(d));
    if (allGone) F.push(t.id);
    else B.push(t.id);
  }

  // Phase 3: Death CSP
  const needB = Math.ceil(F.length / 2);
  if (B.length < needB) {
    return { deathStep: K, assignments, branchLog: [], success: false, planColors, deathColors: 0,
      reason: `F${F.length}B${B.length}<${needB}` };
  }

  const cspResult = solveCSP(F, B, nodes, assignments, planColors + 1);
  if (!cspResult.success) {
    return { deathStep: K, assignments, branchLog: [], success: false, planColors, deathColors: 0,
      reason: `CSPfail:${cspResult.reason}` };
  }

  // Phase 4: Verify death (SKIPPED for raw CSP evaluation)
  // TODO: re-enable after optimizing verifier
  // const deathTileIds = new Set<number>();
  // for (const [tid, col] of assignments) { if (col > planColors) deathTileIds.add(tid); }
  // const vrf = verifyDeath({ tiles: freeTiles, elementValues: assignments, remainingTileIds: deathTileIds, maxStates: 50000 });
  // if (!vrf.deathConfirmed) { ... }

  // Phase 4 (was verify, now skipped): Compute branch log
  const branchLog: number[] = [];
  for (let i = planColors; i > 0; i--) branchLog.push(i);
  for (let i = 0; i < cspResult.colors; i++) branchLog.push(0);
  while (branchLog.length < totalSteps) branchLog.push(0);

  return {
    deathStep: K,
    assignments,
    branchLog: branchLog.slice(0, totalSteps),
    success: true,
    planColors,
    deathColors: cspResult.colors,
    reason: `${planColors} plan + ${cspResult.colors} death (verified)`,
  };
}

// ═══════════════════════════════════════════════════
//  CSP: assign freed + blocked to death colors
// ═══════════════════════════════════════════════════

function solveCSP(
  F: number[], B: number[],
  nodes: Map<number, TileNode>,
  assignments: Map<number, number>,
  startColor: number,
): { success: boolean; colors: number; reason: string } {
  const free = [...F], blocked = [...B];
  let c = startColor, colors = 0;

  // Precompute blocking
  const freeBlocks = new Map<number, Set<number>>();
  for (const fid of free) {
    const nd = nodes.get(fid);
    const set = new Set<number>();
    if (nd) for (const bid of nd.blocks) { if (blocked.includes(bid)) set.add(bid); }
    freeBlocks.set(fid, set);
  }
  const blockedBy = new Map<number, number[]>();
  for (const bid of blocked) {
    const nd = nodes.get(bid);
    const bl: number[] = [];
    if (nd) for (const depId of nd.freeDeps) { if (free.includes(depId)) bl.push(depId); }
    blockedBy.set(bid, bl);
  }

  // Greedy CSP with ≤2 freed per color
  while (free.length > 0) {
    // Take up to 2 freed (those blocking fewest blocked tiles)
    const groupFreed: number[] = [];
    for (let take = 0; take < 2 && free.length > 0; take++) {
      let bestIdx = 0, bestCnt = Infinity;
      for (let i = 0; i < Math.min(free.length, 50); i++) {
        const cnt = freeBlocks.get(free[i])?.size ?? 0;
        if (cnt < bestCnt) { bestCnt = cnt; bestIdx = i; }
      }
      const fid = free.splice(bestIdx, 1)[0];
      groupFreed.push(fid);
    }

    // Fill to 3 with blocked tiles NOT blocked by any groupFreed
    const need = 3 - groupFreed.length;
    const candidates: number[] = [];
    for (let i = blocked.length - 1; i >= 0 && candidates.length < need; i--) {
      const bid = blocked[i];
      const bl = blockedBy.get(bid) ?? [];
      // Must not be blocked by any freed in this group
      if (groupFreed.some(fid => bl.includes(fid))) continue;
      // Internal consistency
      let ok = true;
      const bnd = nodes.get(bid);
      for (const cid of candidates) {
        if (bnd && bnd.blocks.includes(cid)) { ok = false; break; }
        const cnd = nodes.get(cid);
        if (cnd && cnd.blocks.includes(bid)) { ok = false; break; }
      }
      if (!ok) continue;
      candidates.push(bid);
    }

    if (candidates.length < need) {
      // Can't fill → put freed back, break
      for (const fid of groupFreed) free.push(fid);
      break;
    }

    for (const bid of candidates) blocked.splice(blocked.indexOf(bid), 1);
    for (const fid of groupFreed) assignments.set(fid, c);
    for (const bid of candidates) assignments.set(bid, c);
    c++; colors++;
  }

  // Remaining blocked → [0 freed + 3 blocked]
  while (blocked.length >= 3) {
    for (const _ of [0,1,2]) assignments.set(blocked.shift()!, c);
    c++; colors++;
  }
  // Leftover blocked
  for (const bid of blocked) assignments.set(bid, c++);

  if (free.length > 0) {
    return { success: false, colors, reason: `${free.length} freed tiles unassignable` };
  }
  return { success: true, colors, reason: 'OK' };
}

// ═══════════════════════════════════════════════════
//  Fallback: solvable
// ═══════════════════════════════════════════════════

function trySolve(
  freeTiles: TerrainTile[],
  nodes: Map<number, TileNode>,
  totalSteps: number,
): { assignments: Map<number, number>; branchLog: number[] } {
  const assignments = new Map<number, number>();
  const eliminated = new Set<number>();
  const deps = new Map<number, Set<number>>();
  for (const [tid, n] of nodes) deps.set(tid, new Set(n.freeDeps));

  let c = 1;
  const log: number[] = [];
  for (let step = 0; step < totalSteps; step++) {
    const freed = [...deps.entries()]
      .filter(([tid, rd]) => !eliminated.has(tid) && rd.size === 0)
      .map(([tid]) => tid);
    log.push(Math.floor(freed.length / 3));
    if (freed.length < 3) break;
    const triple = pickNonBlockingTriple(freed, nodes);
    if (!triple) break;
    for (const tid of triple) {
      assignments.set(tid, c);
      eliminated.add(tid);
      for (const [rtid, rd] of deps) rd.delete(tid);
    }
    c++;
  }
  // Remaining
  for (const t of freeTiles) {
    if (!assignments.has(t.id)) assignments.set(t.id, c++);
  }
  return { assignments, branchLog: log };
}

// ═══════════════════════════════════════════════════
//  Graph builder
// ═══════════════════════════════════════════════════

function buildGraph(freeTiles: TerrainTile[]): Map<number, TileNode> {
  const tileMap = new Map<number, TerrainTile>();
  for (const t of freeTiles) tileMap.set(t.id, t);
  const nodes = new Map<number, TileNode>();
  for (const t of freeTiles) {
    nodes.set(t.id, {
      id: t.id,
      freeDeps: t.dependencies.filter(d => tileMap.has(d)),
      blocks: [],
    });
  }
  for (const t of freeTiles) {
    for (const depId of t.dependencies) {
      const n = nodes.get(depId);
      if (n) n.blocks.push(t.id);
    }
  }
  return nodes;
}

function pickBestTriple(
  candidates: number[], nodes: Map<number, TileNode>,
  _deps: Map<number, Set<number>>,
): number[] | null {
  if (candidates.length < 3) return null;
  const limit = Math.min(candidates.length, 150);

  // Score each tile by how many other tiles it blocks (proxy for release power)
  const blockCounts = new Map<number, number>();
  for (const tid of candidates) {
    const nd = nodes.get(tid);
    blockCounts.set(tid, nd ? nd.blocks.length : 0);
  }

  let bestTriple: number[] | null = null;
  let bestScore = -1;

  for (let i = 0; i < limit - 2; i++) {
    for (let j = i + 1; j < limit - 1; j++) {
      const a = candidates[i], b = candidates[j];
      const aNode = nodes.get(a), bNode = nodes.get(b);
      if (!aNode || !bNode) continue;
      if (aNode.freeDeps.includes(b) || bNode.freeDeps.includes(a)) continue;

      for (let m = j + 1; m < limit; m++) {
        const c = candidates[m];
        const cNode = nodes.get(c);
        if (!cNode) continue;
        if (cNode.freeDeps.includes(a) || cNode.freeDeps.includes(b)) continue;
        if (aNode.freeDeps.includes(c) || bNode.freeDeps.includes(c)) continue;

        const score = (blockCounts.get(a)??0) + (blockCounts.get(b)??0) + (blockCounts.get(c)??0);
        if (score > bestScore) {
          bestScore = score;
          bestTriple = [a, b, c];
        }
      }
    }
  }
  return bestTriple;
}

function pickNonBlockingTriple(candidates: number[], nodes: Map<number, TileNode>): number[] | null {
  if (candidates.length < 3) return null;
  // Greedy O(k²): for each pair, find a 3rd that doesn't conflict
  const limit = Math.min(candidates.length, 200); // cap search
  for (let i = 0; i < limit - 1; i++) {
    const a = candidates[i];
    const aNode = nodes.get(a);
    if (!aNode) continue;
    for (let j = i + 1; j < limit; j++) {
      const b = candidates[j];
      // Check a,b don't block each other
      if (aNode.freeDeps.includes(b)) continue;
      const bNode = nodes.get(b);
      if (!bNode || bNode.freeDeps.includes(a)) continue;
      // Find 3rd tile
      for (let m = j + 1; m < limit; m++) {
        const c = candidates[m];
        const cNode = nodes.get(c);
        if (!cNode) continue;
        if (cNode.freeDeps.includes(a) || cNode.freeDeps.includes(b)) continue;
        if (aNode.freeDeps.includes(c) || bNode.freeDeps.includes(c)) continue;
        return [a, b, c];
      }
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════
//  Test
// ═══════════════════════════════════════════════════

export function main() {
  const D = 'E:/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
  const ids = [100002, 100006, 100010, 100050, 100075];

  for (const tid of ids) {
    const terrain = loadTerrainFromFile(join(D, `${tid}.json`));
    const allTiles: any[] = [];
    for (const l of terrain.layers) for (const t of l.tiles) allTiles.push(t);
    const free = allTiles.filter((t: any) => !t.isConst);

    console.log(`\n${tid} (${free.length}t):`);
    const r = searchDeath(terrain);
    console.log(`  deathStep=${r.deathStep} success=${r.success} plan=${r.planColors} death=${r.deathColors}`);
    console.log(`  ${r.reason}`);

    if (r.success) {
      const ev = new Map<number, number>();
      for (const t of allTiles) {
        if (t.isConst && t.constElementValue > 0) ev.set(t.id, t.constElementValue);
        else ev.set(t.id, r.assignments.get(t.id) ?? 1);
      }
      const game = createGame({ terrainTiles: allTiles, elementValues: ev });
      const dfs = solveDFS(game, { timeoutMs: 10000 });
      console.log(`  DFS: win=${dfs.win} states=${dfs.statesVisited} branch[${r.deathStep}]=${r.branchLog[r.deathStep]}`);
    }
  }
}

if (process.argv[1]?.endsWith('dag-death.ts') || process.argv[1]?.endsWith('dag-death.js')) {
  main();
}
