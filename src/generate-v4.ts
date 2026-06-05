/**
 * Generation Algorithm v4 — DFS-Free 结构锁定。
 *
 * 架构:
 *   Phase 1: assignColors — 消除计划(solvable) 或 拓扑层(death)
 *   Phase 2: computeBranches — 严格层序消除，纯结构计算
 *
 * SOLVABLE: 消除计划驱动 → 计划即证明
 * DEATH:   拓扑层 cutoff → 前层3/色, 后层≤2freed/色 → 层序消除保证death
 */

import type { TerrainTile, TerrainData } from './types.js';
import { getAllTiles, loadTerrainFromFile } from './terrain-loader.js';
import { computeAllDependencies } from './dependency-graph.js';
import { generateReplayCode, getCanonicalTileOrder } from './replay-serializer.js';
import { verifyDeath } from './verify-death.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ═══════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════

interface TileNode { id: number; directDeps: number[]; blocks: number[]; }

export interface GenV4Input { terrain: TerrainData; solvable: boolean; deathStep?: number; }

export interface GenV4Output {
  assignments: Map<number, number>;
  branchLog: number[];
  ok: boolean;
  colorCount: number;
  colorSizes: number[];
  totalSteps: number;
  replayCode: string;
  levelHash: string;
}

// ═══════════════════════════════════════════════════
//  Phase 1: Color assignment
// ═══════════════════════════════════════════════════

function assignColors(
  freeTiles: TerrainTile[],
  totalSteps: number,
  targetDeathStep: number,
): { assignments: Map<number, number>; nodes: Map<number, TileNode>; deathStartColor: number; actualDeathStep: number } {
  const { nodes, topoLayers, depth } = buildGraph(freeTiles);
  const assignments = new Map<number, number>();
  let nextColor = 1;
  const isDeath = targetDeathStep >= 0;

  // ── Plan-driven: create normal colors for first K steps ──
  const planSteps = isDeath ? targetDeathStep : totalSteps;
  const eliminated = new Set<number>();
  const remainingDeps = new Map<number, Set<number>>();
  for (const [tid, n] of nodes) remainingDeps.set(tid, new Set(n.directDeps));

  const getFreedLocal = (): number[] => {
    const f: number[] = [];
    for (const [tid, rd] of remainingDeps) if (!eliminated.has(tid) && rd.size === 0) f.push(tid);
    return f;
  };

  let actualPlanSteps = 0;
  for (let step = 0; step < planSteps; step++) {
    const freed = getFreedLocal();
    if (freed.length < 3) break;
    const triple = pickValidTriple(freed, nodes);
    if (!triple) break;
    for (const tid of triple) { assignments.set(tid, nextColor); eliminated.add(tid); for (const [rtid, rd] of remainingDeps) rd.delete(tid); }
    nextColor++;
    actualPlanSteps++;
  }

  // ── Remaining tiles ──
  const remaining = freeTiles.filter(t => !eliminated.has(t.id));
  const deathStartColor = isDeath ? nextColor : -1;

  if (isDeath && remaining.length > 0) {
    const elimSet = eliminated;
    const isFreed = (tid: number): boolean => {
      const t = freeTiles.find(ft => ft.id === tid);
      if (!t) return false;
      return t.dependencies.every(depId => {
        const dd = depth.get(depId);
        return dd === undefined || elimSet.has(depId);
      });
    };
    const freedRemaining = remaining.filter(t => isFreed(t.id)).map(t => t.id);
    const blockedRemaining = remaining.filter(t => !isFreed(t.id)).map(t => t.id);
    const packed = packDeathColors(freedRemaining, blockedRemaining, assignments, nodes, deathStartColor);

    if (!packed) {
      // Death impossible at target step — too many freed tiles.
      // Adjust deathStep down to the actual plan step count + 1
      // Clear death colors and redo with adjusted target
      for (const t of remaining) assignments.delete(t.id);
      const newDeathStep = actualPlanSteps;
      // Simplest: just reassign remaining as solvable (3/color)
      let c = deathStartColor;
      let batch: number[] = [];
      for (const t of remaining) {
        batch.push(t.id);
        if (batch.length === 3) { for (const tid of batch) assignments.set(tid, c++); batch = []; }
      }
      for (const tid of batch) assignments.set(tid, c++);
      // This makes the board solvable at step newDeathStep, not exactly death.
      // Mark deathStartColor to -1 so computeBranches doesn't filter
      return { assignments, nodes, deathStartColor: -1, actualDeathStep: newDeathStep };
    }
  } else if (!isDeath) {
    let c = nextColor;
    let batch: number[] = [];
    for (const t of remaining) {
      batch.push(t.id);
      if (batch.length === 3) { for (const tid of batch) assignments.set(tid, c++); batch = []; }
    }
    for (const tid of batch) assignments.set(tid, c++);
  }

  return { assignments, nodes, deathStartColor, actualDeathStep: isDeath ? actualPlanSteps : -1 };
}

function buildGraph(freeTiles: TerrainTile[]): { nodes: Map<number, TileNode>; topoLayers: number[][]; depth: Map<number, number> } {
  const tileMap = new Map<number, TerrainTile>();
  for (const t of freeTiles) tileMap.set(t.id, t);
  const nodes = new Map<number, TileNode>();
  for (const t of freeTiles) { nodes.set(t.id, { id: t.id, directDeps: t.dependencies.filter(d => tileMap.has(d)), blocks: [] }); }
  for (const [tid, n] of nodes) { for (const depId of n.directDeps) nodes.get(depId)?.blocks.push(tid); }

  const inDeg = new Map<number, number>();
  for (const [tid, n] of nodes) inDeg.set(tid, n.directDeps.length);
  const depth = new Map<number, number>();
  const queue: number[] = [];
  for (const [tid, d] of inDeg) { if (d === 0) { queue.push(tid); depth.set(tid, 0); } }
  let h = 0;
  while (h < queue.length) {
    const tid = queue[h++]; const cur = depth.get(tid) ?? 0;
    for (const bid of (nodes.get(tid)?.blocks ?? [])) {
      const nd = (inDeg.get(bid) ?? 1) - 1; inDeg.set(bid, nd);
      depth.set(bid, Math.max(depth.get(bid) ?? 0, cur + 1));
      if (nd === 0) queue.push(bid);
    }
  }
  const maxD = Math.max(...depth.values(), 0);
  const topoLayers: number[][] = Array.from({ length: maxD + 1 }, () => []);
  for (const [tid, d] of depth) topoLayers[d].push(tid);
  return { nodes, topoLayers, depth };
}

function mapStepToLayer(layers: number[][], deathStep: number): number {
  let steps = 0;
  for (let l = 0; l < layers.length; l++) {
    const layerSteps = Math.floor(layers[l].length / 3);
    if (steps + layerSteps > deathStep) return l;
    steps += layerSteps;
  }
  return layers.length;
}

// ── Solvable: plan-driven ──
function assignPlan(
  assignments: Map<number, number>, freeTiles: TerrainTile[],
  nodes: Map<number, TileNode>, totalSteps: number, startColor: number,
): number {
  const eliminated = new Set<number>();
  const remainingDeps = new Map<number, Set<number>>();
  for (const [tid, n] of nodes) remainingDeps.set(tid, new Set(n.directDeps));
  const getFreed = (): number[] => {
    const f: number[] = [];
    for (const [tid, rd] of remainingDeps) if (!eliminated.has(tid) && rd.size === 0) f.push(tid);
    return f;
  };
  let c = startColor;
  for (let step = 0; step < totalSteps; step++) {
    const freed = getFreed();
    if (freed.length < 3) break;
    const triple = pickValidTriple(freed, nodes);
    if (!triple) break;
    for (const tid of triple) { assignments.set(tid, c); eliminated.add(tid); for (const [rtid, rd] of remainingDeps) rd.delete(tid); }
    c++;
  }
  return c;
}

// ── Death: layer-cutoff ──
function assignLayers(
  assignments: Map<number, number>, freeTiles: TerrainTile[],
  _nodes: Map<number, TileNode>, layers: number[][], depth: Map<number, number>,
  cutoff: number, startColor: number,
): number {
  let c = startColor;

  // Pre-cutoff layers: normal 3/color
  for (let l = 0; l < cutoff && l < layers.length; l++) {
    let batch: number[] = [];
    for (const tid of layers[l]) {
      if (assignments.has(tid)) continue;
      batch.push(tid);
      if (batch.length === 3) { for (const t of batch) assignments.set(t, c++); batch = []; }
    }
    for (const t of batch) assignments.set(t, c++);
  }

  // Collect ALL death-layer tiles (layers >= cutoff)
  const allDeathTiles: number[] = [];
  for (let l = cutoff; l < layers.length; l++) {
    for (const tid of layers[l]) {
      if (!assignments.has(tid)) allDeathTiles.push(tid);
    }
  }

  if (allDeathTiles.length === 0) return c;

  // Separate into freed vs blocked
  // "freed" = tile whose ALL blockers are in layers < cutoff
  const isDeathFreed = (tid: number): boolean => {
    const t = freeTiles.find(ft => ft.id === tid);
    if (!t) return false;
    return t.dependencies.every(depId => {
      const dd = depth.get(depId);
      return dd === undefined || dd < cutoff;
    });
  };

  const deathFreed = allDeathTiles.filter(isDeathFreed);
  const deathBlocked = allDeathTiles.filter(tid => !isDeathFreed(tid));

  return packDeathColors(deathFreed, deathBlocked, assignments, startColor);
}

// ═══════════════════════════════════════════════════
//  Phase 2: Layer-ordered branch computation
// ═══════════════════════════════════════════════════

function computeBranches(
  freeTiles: TerrainTile[], assignments: Map<number, number>,
  nodes: Map<number, TileNode>, totalSteps: number, deathStartColor: number,
): number[] {
  const eliminated = new Set<number>();
  const remainingDeps = new Map<number, Set<number>>();
  for (const [tid, n] of nodes) remainingDeps.set(tid, new Set(n.directDeps));
  const getFreed = (): Set<number> => {
    const f = new Set<number>();
    for (const [tid, rd] of remainingDeps) if (!eliminated.has(tid) && rd.size === 0) f.add(tid);
    return f;
  };
  const freed = getFreed();
  const branchLog: number[] = [];

  while (branchLog.length < totalSteps) {
    // Count available colors
    const colorCounts = new Map<number, number>();
    for (const tid of freed) {
      if (eliminated.has(tid)) continue;
      const col = assignments.get(tid);
      if (col && col > 0) colorCounts.set(col, (colorCounts.get(col) ?? 0) + 1);
    }
    // Exclude death colors (deathStartColor and above) — they're always suppressed
    const available = [...colorCounts.entries()]
      .filter(([c, n]) => n >= 3 && (deathStartColor < 0 || c < deathStartColor))
      .map(([c]) => c);
    branchLog.push(available.length);
    if (available.length === 0) { while (branchLog.length < totalSteps) branchLog.push(0); break; }

    // Pick smallest color (deterministic)
    available.sort((a,b) => a-b);
    const chosen = available[0];
    const toRemove: number[] = [];
    for (const tid of freed) {
      if (toRemove.length >= 3) break;
      if (!eliminated.has(tid) && assignments.get(tid) === chosen) toRemove.push(tid);
    }
    for (const tid of toRemove) {
      eliminated.add(tid); freed.delete(tid);
      for (const [rtid, rd] of remainingDeps) { if (rd.delete(tid) && rd.size === 0) freed.add(rtid); }
    }
  }
  return branchLog.slice(0, totalSteps);
}

// ═══════════════════════════════════════════════════
//  Death CSP
// ═══════════════════════════════════════════════════

/**
 * Pack remaining tiles into death colors.
 *
 * KEY CONSTRAINT (from DFS testing): freed tiles must NOT block any
 * blocked tile in the same color. Otherwise clicking the freed tile
 * releases the blocked one → accumulates → forms unexpected triple.
 *
 * Strategy: pack freed+blocked into 3-tile groups where:
 *   - ≤2 freed per group
 *   - No freed tile blocks any blocked tile in the same group
 *   - If impossible with ≤2 freed, fall back to solvable assignment
 */
function packDeathColors(
  freedTiles: number[], blockedTiles: number[],
  assignments: Map<number, number>, nodes: Map<number, TileNode>, startColor: number,
): boolean {
  const freed = [...freedTiles], blocked = [...blockedTiles];

  // Precompute: which freed tiles block which blocked tiles
  const freedBlocks = new Map<number, Set<number>>(); // freed tileId → blocked tiles it blocks
  for (const fid of freed) {
    const nd = nodes.get(fid);
    const blocked = new Set<number>();
    if (nd) for (const bid of nd.blocks) {
      if (blockedTiles.includes(bid)) blocked.add(bid);
    }
    freedBlocks.set(fid, blocked);
  }

  // Also: which blocked tiles are blocked by which freed tiles
  const blockedBy = new Map<number, Set<number>>(); // blocked tileId → freed tiles that block it
  for (const bid of blocked) {
    const nd = nodes.get(bid);
    const blockers = new Set<number>();
    if (nd) for (const depId of nd.directDeps) {
      if (freed.includes(depId)) blockers.add(depId);
    }
    blockedBy.set(bid, blockers);
  }

  let c = startColor;

  while (freed.length > 0 || blocked.length > 0) {
    const group: number[] = [];
    const groupFreed: number[] = [];

    // Take up to 2 freed tiles (those that block few blocked tiles first)
    for (let i = 0; i < 2 && freed.length > 0; i++) {
      // Pick the freed tile that blocks the FEWEST blocked tiles (least disruptive)
      let bestIdx = 0, bestBlockCount = Infinity;
      for (let j = 0; j < Math.min(freed.length, 20); j++) {
        const count = freedBlocks.get(freed[j])?.size ?? 0;
        if (count < bestBlockCount) { bestBlockCount = count; bestIdx = j; }
      }
      const fid = freed.splice(bestIdx, 1)[0];
      group.push(fid);
      groupFreed.push(fid);
    }

    // Fill to 3 with blocked tiles that are NOT blocked by any freed tile in the group
    while (group.length < 3 && blocked.length > 0) {
      let found = false;
      for (let j = 0; j < blocked.length && !found; j++) {
        const bid = blocked[j];
        const blockers = blockedBy.get(bid) ?? new Set();
        const blockedByGroupFreed = groupFreed.some(fid => blockers.has(fid));
        if (!blockedByGroupFreed) {
          group.push(blocked.splice(j, 1)[0]);
          found = true;
        }
      }
      if (!found) break; // no compatible blocked tile
    }

    // If group is incomplete (can't fill to 3 without violating constraint):
    // Roll back all death assignments and fall back to solvable
    if (group.length < 3 && groupFreed.length > 0) {
      for (let col = startColor; col < c; col++) {
        for (const [tid, cl] of assignments) { if (cl === col) assignments.delete(tid); }
      }
      return false;
    }

    if (group.length === 0) {
      if (blocked.length > 0) group.push(blocked.shift()!);
      else break;
    }

    for (const tid of group) assignments.set(tid, c);
    c++;
  }

  return true;
}

function fixMod3FreedAware(assignments: Map<number, number>, lo: number, hi: number): void {
  // Collect color tile counts
  const ct = new Map<number, number[]>();
  for (const [tid, col] of assignments) {
    if (col >= lo && col <= hi) { const l = ct.get(col) ?? []; l.push(tid); ct.set(col, l); }
  }
  // Group by remainder
  const m1: {c:number, t:number[]}[] = [], m2: typeof m1 = [];
  for (const [c, t] of ct) {
    if (t.length % 3 === 0) continue;
    if (t.length % 3 === 1) m1.push({c, t}); else m2.push({c, t});
  }
  // Merge: mod1 + mod2 = mod0 (1+2=3)
  while (m1.length > 0 && m2.length > 0) {
    const a = m1.shift()!, b = m2.shift()!;
    for (const tid of b.t) assignments.set(tid, a.c);
  }
  // Merge: 3×mod1 = mod0 (1+1+1=3)
  while (m1.length >= 3) {
    const a = m1.shift()!, b = m1.shift()!, d = m1.shift()!;
    for (const tid of [...b.t, ...d.t]) assignments.set(tid, a.c);
  }
  // Merge: 3×mod2 = mod0 (2+2+2=6)
  while (m2.length >= 3) {
    const a = m2.shift()!, b = m2.shift()!, d = m2.shift()!;
    for (const tid of [...b.t, ...d.t]) assignments.set(tid, a.c);
  }
}

// ═══════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════

function pickValidTriple(candidates: number[], nodes: Map<number, TileNode>): number[] | null {
  if (candidates.length < 3) return null;
  for (let i = 0; i < candidates.length - 2; i++) {
    for (let j = i + 1; j < candidates.length - 1; j++) {
      for (let k = j + 1; k < candidates.length; k++) {
        const t = [candidates[i], candidates[j], candidates[k]];
        let v = true;
        for (const tid of t) { const nd = nodes.get(tid); if (!nd) { v=false; break; } for (const d of nd.directDeps) { if (t.includes(d)) { v=false; break; } } if (!v) break; }
        if (v) return t;
      }
    }
  }
  return null;
}

function validGroup(tileIds: number[], nodes: Map<number, TileNode>): boolean {
  for (const tid of tileIds) { const nd = nodes.get(tid); if (!nd) return false; for (const d of nd.directDeps) { if (tileIds.includes(d)) return false; } }
  return true;
}

// ═══════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════

export function generateV4(input: GenV4Input): GenV4Output {
  const { terrain, solvable=true, deathStep=-1 } = input;
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(t => !t.isConst);
  const totalSteps = Math.floor(freeTiles.length / 3);
  const td = solvable ? -1 : Math.max(0, deathStep ?? 0);

  const { assignments, nodes, deathStartColor, actualDeathStep } = assignColors(freeTiles, totalSteps, td);
  const effectiveDeathStep = deathStartColor >= 0 ? td : actualDeathStep; // if pack failed, use actual
  const branchLog = computeBranches(freeTiles, assignments, nodes, totalSteps, deathStartColor);

  const sizes = new Map<number, number>();
  for (const t of freeTiles) { const col = assignments.get(t.id); if (col) sizes.set(col, (sizes.get(col)??0) + 1); }
  const szArr = [...sizes.values()];
  const allDiv3 = szArr.every(s => s%3===0);

  // ReplayCode
  const elementValues = new Map<number, number>();
  for (const t of allTiles) {
    if (t.isConst && t.constElementValue > 0) elementValues.set(t.id, t.constElementValue);
    else elementValues.set(t.id, assignments.get(t.id) ?? 1);
  }
  const ordered = getCanonicalTileOrder(allTiles);
  const levelHash = terrain.levelHash ?? '';
  const replayCode = generateReplayCode(ordered, elementValues, levelHash);

  let ok: boolean;
  if (solvable) {
    ok = allDiv3 && branchLog.every(b=>b>=1);
  } else {
    const ds = effectiveDeathStep >= 0 ? effectiveDeathStep : td;
    const structuralOk = allDiv3
      && (ds < totalSteps ? branchLog[ds] === 0 : true)
      && branchLog.slice(0, ds).every(b => b >= 1);

    // Lightweight death verification
    let deathConfirmed = structuralOk;
    if (structuralOk && deathStartColor > 0) {
      // Death point: all tiles still on desk (none eliminated)
      // Only death-color tiles matter for the verification
      const remainingTileIds = new Set(
        freeTiles.filter(t => {
          const col = assignments.get(t.id);
          return col && col >= deathStartColor;
        }).map(t => t.id)
      );
      if (remainingTileIds.size > 0) {
        const vrf = verifyDeath({ tiles: freeTiles, elementValues, remainingTileIds, maxStates: 10000 });
        deathConfirmed = vrf.deathConfirmed;
      }
    }

    ok = structuralOk && deathConfirmed;
  }
  return { assignments, branchLog, ok, colorCount: sizes.size, colorSizes: szArr, totalSteps, replayCode, levelHash };
}

// ═══════════════════════════════════════════════════
//  CLI
// ═══════════════════════════════════════════════════

export function main() {
  const D = 'E:/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
  const ids = [100002,100006,100010,100050,100075].filter(id => existsSync(join(D,`${id}.json`)));
  for (const tid of ids) { try {
    const terrain: any = loadTerrainFromFile(join(D,`${tid}.json`));
    const tiles: any[] = []; for (const l of terrain.layers) for (const t of l.tiles) tiles.push(t);
    const free = tiles.filter((t:any)=>!t.isConst); const steps = Math.floor(free.length/3);
    console.log(`\n${'═'.repeat(40)} ${tid} (${free.length}t ${steps}st) ${'═'.repeat(40)}`);
    const s = generateV4({ terrain, solvable: true });
    console.log(`  SOLVABLE: OK=${s.ok} div3=${s.colorSizes.every(x=>x%3===0)} colors=${s.colorCount}`);
    console.log(`    [${s.branchLog.join(',')}]`);
    for (const ds of [0, Math.floor(steps/4), Math.floor(steps/2), steps-1]) {
      const d = generateV4({ terrain, solvable: false, deathStep: ds });
      const pre = d.branchLog.slice(0,ds).every(b=>b>=1);
      const death = ds<d.branchLog.length && d.branchLog[ds]===0;
      console.log(`  DEATH@${ds}/${steps}: OK=${d.ok} preOk=${pre} deathOk=${death} div3=${d.colorSizes.every(x=>x%3===0)}`);
      console.log(`    [${d.branchLog.join(',')}]`);
    }
  } catch(e:any) { console.log(`  Error: ${e.message?.slice(0,100)}`); } }
}

if (process.argv[1]?.endsWith('generate-v4.ts') || process.argv[1]?.endsWith('generate-v4.js')) { main(); }
