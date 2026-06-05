/**
 * Generation Algorithm v3 — Exclusive-Block-Based Construction.
 *
 * Core insight (from analysis): the chain continues with exactly N branches
 * after step K iff step K's triple exclusively blocks ≥3 tiles of N colors.
 *
 * Construction strategy:
 *   Walk the dependency DAG forward. At each step, the tiles that become
 *   newly available are grouped into triples. Each triple = one color.
 *   Control branching by grouping: one triple = single path, multiple = branches.
 *   Control death by releasing <3 tiles total.
 */
import type { TerrainTile, TerrainData } from './types.js';
import { getAllTiles } from './terrain-loader.js';
import { logger } from './logger.js';

export interface GenV3Input {
  terrain: TerrainData;
  solvable?: boolean;
  deathStep?: number;
  /** Desired branching at each step. null = auto (single path) */
  branchAt?: (number | null)[] | 'auto';
}

export interface GenV3Output {
  assignments: Map<number, number>;
  sequence: number[][];
  /** Per-step: actual number of colors with ≥3 clickable after this step */
  branchLog: number[];
  solvable: boolean;
  deathStep: number;
  totalTriples: number;
  colorCount: number;
}

// ═══════════════════════════════════════════════════
//  Frontier
// ═══════════════════════════════════════════════════

interface Frontier {
  onDesk: Set<number>;
  available: Set<number>; // clickable & unassigned
  deps: Map<number, number[]>;
  blocks: Map<number, Set<number>>;
}

function buildFrontier(tiles: TerrainTile[]): Frontier {
  const deps = new Map<number, number[]>();
  const blocks = new Map<number, Set<number>>();
  const onDesk = new Set<number>();
  const available = new Set<number>();

  for (const t of tiles) {
    const fd = t.dependencies.filter(d => tiles.some(ft => ft.id === d));
    deps.set(t.id, fd);
    blocks.set(t.id, new Set());
    onDesk.add(t.id);
  }
  for (const t of tiles) {
    for (const d of deps.get(t.id)!) blocks.get(d)?.add(t.id);
  }
  for (const t of tiles) {
    if (deps.get(t.id)!.length === 0) available.add(t.id);
  }

  return { onDesk, available, deps, blocks };
}

function eliminate(f: Frontier, ids: number[]): number[] {
  const freed: number[] = [];
  for (const id of ids) {
    f.onDesk.delete(id);
    f.available.delete(id);
    for (const bid of f.blocks.get(id) ?? []) {
      if (!f.onDesk.has(bid)) continue;
      if ((f.deps.get(bid) ?? []).every(d => !f.onDesk.has(d))) {
        f.available.add(bid);
        freed.push(bid);
      }
    }
  }
  return freed;
}

function clone(f: Frontier): Frontier {
  return {
    onDesk: new Set(f.onDesk), available: new Set(f.available),
    deps: f.deps, blocks: f.blocks,
  };
}

// ═══════════════════════════════════════════════════
//  Main generation
// ═══════════════════════════════════════════════════

export function generateV3(input: GenV3Input): GenV3Output {
  const { terrain, solvable = true, deathStep = -1, branchAt = 'auto' } = input;

  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(t => !t.isConst);
  const constTiles = allTiles.filter(t => t.isConst);
  const totalTriples = Math.floor(freeTiles.length / 3);

  const deathAt = solvable ? -1 : Math.max(0, Math.min(deathStep, totalTriples - 1));

  const f = buildFrontier(freeTiles);
  const sequence: number[][] = [];
  const branchLog: number[] = [];
  const assignments = new Map<number, number>();
  let nextColor = 1;

  for (const t of constTiles) {
    if (t.constElementValue > 0) {
      assignments.set(t.id, t.constElementValue);
      if (t.constElementValue >= nextColor) nextColor = t.constElementValue + 1;
    }
  }

  // ── Main loop ──
  for (let step = 0; step < totalTriples; step++) {
    const isDeath = (deathAt === step);

    // How many triples can be formed from available tiles?
    const maxTriples = Math.floor(f.available.size / 3);
    branchLog.push(maxTriples);

    if (maxTriples === 0) {
      return { assignments, sequence, branchLog, solvable: false, deathStep: step, totalTriples, colorCount: nextColor - 1 };
    }

    // Select triple(s) to form this step
    const availList = [...f.available];
    let picked: number[][];

    if (isDeath) {
      // Death step: STOP before forming any more triples.
      // Remaining tiles get scattered colors in cleanup → guaranteed death.
      break;
    }

    // Normal step: pick the best triple for continuation
    // Strategy: try all possible triples, pick the one that frees tiles
    // that can form the NEXT step's triple
    const triples = enumerateTriples(availList, maxTriples);

    // Score: how many new triples can be formed from freed tiles?
    let bestTriple = triples[0];
    let bestNext = 0;

    for (const triple of triples) {
      const sim = clone(f);
      const freed = eliminate(sim, triple);
      const nextTriples = Math.floor(sim.available.size / 3);
      // Prefer triples that keep the chain going
      const score = nextTriples > 0 ? nextTriples + freed.length * 0.1 : -1000;
      if (score > bestNext) {
        bestNext = score;
        bestTriple = triple;
      }
    }

    picked = [bestTriple];
    eliminate(f, bestTriple);
    sequence.push(bestTriple);

    const color = nextColor++;
    for (const tid of bestTriple) {
      assignments.set(tid, color);
    }
  }

  // ── Cleanup ──
  for (const tid of f.onDesk) {
    if (!assignments.has(tid)) {
      assignments.set(tid, nextColor++);
    }
  }

  const done = freeTiles.every(t => assignments.has(t.id));
  return {
    assignments, sequence, branchLog,
    solvable: done && deathAt === -1,
    deathStep: done ? -1 : sequence.length,
    totalTriples, colorCount: nextColor - 1,
  };
}

// ═══════════════════════════════════════════════════
//  Triple selection
// ═══════════════════════════════════════════════════

function enumerateTriples(avail: number[], maxTriples: number): number[][] {
  const result: number[][] = [];
  const limit = Math.min(maxTriples, 20);
  for (let i = 0; i < limit; i++) {
    result.push([avail[i * 3], avail[i * 3 + 1], avail[i * 3 + 2]]);
  }
  return result;
}

function pickScatterTriple(f: Frontier): number[] {
  const avail = [...f.available];
  if (avail.length < 3) return avail;

  // Try first N triples, find the one that MINIMIZES next-step availability
  const maxT = Math.min(Math.floor(avail.length / 3), 15);
  let best = [avail[0], avail[1], avail[2]];
  let bestNext = Infinity;

  for (let i = 0; i < maxT; i++) {
    const triple = [avail[i * 3], avail[i * 3 + 1], avail[i * 3 + 2]];
    const sim = clone(f);
    eliminate(sim, triple);
    const next = sim.available.size;
    if (next < bestNext) {
      bestNext = next;
      best = triple;
    }
  }

  return best;
}
