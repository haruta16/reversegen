/**
 * Death Chain Tracer — trace all possible elimination paths step by step
 * until inevitable death, to find the ATOMIC mechanism of death at each depth.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadTerrainFromFile } from '../src/terrain-loader.js';
import { decodeFromString, getCanonicalTileOrder } from '../src/replay-serializer.js';
import { createGame, OfflineGame } from '../src/solver/offline-game.js';
import { buildColorGroupDAG } from '../src/analysis/board-dag.js';
import { computeAllDependencies } from '../src/dependency-graph.js';
import { solveDFS } from '../src/solver/solver-dfs.js';
import { logger, setLogLevel, LogLevel } from '../src/logger.js';
setLogLevel(LogLevel.Error);

const LEVELS_DIR = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
const REPLAYS_DIR = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Replays';
const cacheDir = join(process.cwd(), '.reversegen-cache', 'board-results-v2');

// ============================================
interface StepState {
  step: number;
  /** Colors that can form a triple at this step */
  availableTripleColors: number[];
  /** For each available color: what happens after this triple? */
  branches: BranchResult[];
}

interface BranchResult {
  chosenColor: number;
  /** Colors that can form a triple after this elimination */
  nextTripleColors: number[];
  /** Which colors gained clickable tiles */
  newlyClickable: number[];
  /** Per-color clickable count after elimination */
  clickableAfter: Map<number, number>;
  /** Per-color total tiles remaining */
  tilesRemaining: Map<number, number>;
  /** Why did this branch NOT lead to more triples (if nextTripleColors is empty) */
  bottleneck: string;
  isDead: boolean;
}

interface DeathChainAnalysis {
  levelResId: number;
  freeTiles: number;
  colorCount: number;
  cgEdges: number;
  initialTripleColors: number[];
  /** Full chain trace */
  steps: StepState[];
  /** Maximum depth reached before all branches dead */
  maxDepth: number;
  /** Distribution of death depths */
  deathDepthDist: Map<number, number>;
  /** The atomic death mechanism at each depth */
  deathMechanisms: Map<number, string>;
}

// ============================================

function loadBoard(levelResId: number, replayKey: string) {
  const terrain = loadTerrainFromFile(join(LEVELS_DIR, `${levelResId}.json`));
  const allTiles: any[] = [];
  for (const l of terrain.layers) for (const t of l.tiles) allTiles.push(t);
  const freeTiles = allTiles.filter((t: any) => !t.isConst);
  const co = getCanonicalTileOrder(allTiles);

  const rj = JSON.parse(readFileSync(join(REPLAYS_DIR, `${levelResId}.json`), 'utf-8'));
  let entry: any = null;
  for (const [, entries] of Object.entries(rj.replayInfoDict || {})) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries as any[]) { if (e.ReplayKey === replayKey) { entry = e; break; } }
    if (entry) break;
  }
  if (!entry) throw new Error('ReplayKey not found');

  const rd = decodeFromString(entry.ReplayCode)!;
  const c2t = new Map<number, number>();
  for (let i = 0; i < co.length; i++) c2t.set(i, co[i].id);
  const suitMap = new Map<number, number>();
  for (let i = 0; i < rd.instanceArray.length; i++) {
    const tid = c2t.get(i);
    if (tid !== undefined) suitMap.set(tid, (rd.instanceArray[i] & 0x3F) + 1);
  }
  const game = createGame({ terrainTiles: allTiles, elementValues: suitMap, initialDock: [], eliminatedTileIds: new Set() });
  return { game, freeTiles, allTiles, suitMap };
}

// ============================================
// Trace all possible triples at current state
// ============================================

function traceStep(sim: OfflineGame, suitMap: Map<number, number>, freeTiles: any[], depth: number): StepState {
  const clickable = sim.deskTiles.filter(t => t.isClickable);
  const cc = new Map<number, number[]>();
  for (const t of clickable) {
    const c = suitMap.get(t.id)!;
    if (!cc.has(c)) cc.set(c, []);
    cc.get(c)!.push(t.id);
  }
  const tripleColors = [...cc.entries()].filter(([, ts]) => ts.length >= 3).map(([c]) => c);

  const branches: BranchResult[] = [];

  for (const color of tripleColors) {
    const branch = sim.clone();
    const tiles = cc.get(color)!.slice(0, 3).map(tid => branch.allTiles.get(tid)!).filter(Boolean);

    let failed = false;
    for (const t of tiles) {
      try { branch.collect(t); } catch { failed = true; break; }
    }
    if (failed) continue;

    const after = branch.deskTiles.filter(t => t.isClickable);
    const afterCC = new Map<number, number>();
    for (const t of after) {
      const c = suitMap.get(t.id)!;
      afterCC.set(c, (afterCC.get(c) ?? 0) + 1);
    }
    const nextColors = [...afterCC.entries()].filter(([, n]) => n >= 3).map(([c]) => c);

    // Newly clickable: which colors gained?
    const newlyClickable: number[] = [];
    for (const [c, n] of afterCC) {
      if ((cc.get(c)?.length ?? 0) < 3 && n >= 3) newlyClickable.push(c);
      else if ((cc.get(c)?.length ?? 0) < n) newlyClickable.push(c);
    }

    // Tiles remaining per color
    const tilesRem = new Map<number, number>();
    for (const [, c] of suitMap) {
      if (!tilesRem.has(c)) tilesRem.set(c, 0);
    }
    for (const t of freeTiles) {
      const bt = branch.allTiles.get(t.id);
      if (bt && bt.pileType === 1) { // still on desk
        tilesRem.set(suitMap.get(t.id)!, (tilesRem.get(suitMap.get(t.id)!) ?? 0) + 1);
      }
    }

    let bottleneck = '';
    if (nextColors.length === 0) {
      const reasons: string[] = [];
      // Why no next triple? Show colors closest to 3
      const sorted = [...afterCC.entries()]
        .filter(([, n]) => n > 0 && n < 3)
        .sort((a, b) => b[1] - a[1]);
      for (const [c, n] of sorted.slice(0, 5)) {
        const remaining = tilesRem.get(c) ?? 0;
        reasons.push(`c${c}:${n}clk/${remaining}tot`);
      }
      if (reasons.length === 0) reasons.push('all colors empty or blocked');
      bottleneck = reasons.join(' ');
    }

    branches.push({
      chosenColor: color,
      nextTripleColors: nextColors,
      newlyClickable,
      clickableAfter: afterCC,
      tilesRemaining: tilesRem,
      bottleneck,
      isDead: nextColors.length === 0,
    });
  }

  return { step: depth, availableTripleColors: tripleColors, branches };
}

// ============================================
// Recursive chain trace
// ============================================

function traceChain(
  game: OfflineGame,
  suitMap: Map<number, number>,
  freeTiles: any[],
  maxDepth: number = 10,
): DeathChainAnalysis {
  const steps: StepState[] = [];
  const deathDepths = new Map<number, number>();
  const mechanisms = new Map<number, string>();

  function trace(sim: OfflineGame, depth: number): number {
    if (depth > maxDepth) return depth;

    const step = traceStep(sim, suitMap, freeTiles, depth);

    if (depth === 0) {
      steps.push(step);
    }

    if (step.availableTripleColors.length === 0) {
      // No triple possible at this depth
      deathDepths.set(depth, (deathDepths.get(depth) ?? 0) + 1);
      const mech = depth === 0
        ? 'Type B: no initial triple possible'
        : `Step ${depth}: all remaining colors have <3 clickable`;
      mechanisms.set(depth, mech);
      return depth;
    }

    // For each branch that leads to more triples, trace deeper
    let maxReached = depth;
    for (const branch of step.branches) {
      if (branch.isDead) {
        deathDepths.set(depth + 1, (deathDepths.get(depth + 1) ?? 0) + 1);

        const closeColors = branch.clickableAfter
          ? [...branch.clickableAfter.entries()]
              .filter(([, n]) => n > 0 && n < 3)
              .sort((a, b) => b[1] - a[1])
          : [];

        const mechKey = `Step ${depth + 1}: after c${branch.chosenColor} → no triple. Closest: ${
          closeColors.slice(0, 3).map(([c, n]) => `c${c}:${n}`).join(', ')
        }. ${branch.bottleneck}`;
        mechanisms.set(depth + 1, mechKey);

        maxReached = Math.max(maxReached, depth + 1);
      } else {
        // Continue tracing this branch
        const branchSim = sim.clone();
        const clickableNow = branchSim.deskTiles.filter(t => t.isClickable);
        const ccNow = new Map<number, number[]>();
        for (const t of clickableNow) {
          const c = suitMap.get(t.id)!;
          if (!ccNow.has(c)) ccNow.set(c, []);
          ccNow.get(c)!.push(t.id);
        }

        // Find and eliminate the first triple of branch.chosenColor
        const tilesToClick = ccNow.get(branch.chosenColor)?.slice(0, 3)
          .map(tid => branchSim.allTiles.get(tid)!)
          .filter(Boolean) ?? [];

        let ok = true;
        for (const t of tilesToClick) {
          try { branchSim.collect(t); } catch { ok = false; break; }
        }
        if (!ok) { deathDepths.set(depth + 1, (deathDepths.get(depth + 1) ?? 0) + 1); continue; }

        const childDepth = trace(branchSim, depth + 1);
        maxReached = Math.max(maxReached, childDepth);
      }
    }

    return maxReached;
  }

  const initStep = traceStep(game, suitMap, freeTiles, 0);
  steps[0] = initStep;
  const reachedDepth = trace(game.clone(), 0);

  return {
    levelResId: 0, freeTiles: freeTiles.length, colorCount: new Set(suitMap.values()).size, cgEdges: 0,
    initialTripleColors: initStep.availableTripleColors,
    steps,
    maxDepth: reachedDepth,
    deathDepthDist: deathDepths,
    deathMechanisms: mechanisms,
  };
}

// ============================================
// Main: analyze Type A and Type B boards
// ============================================

function main() {
  const files = readdirSync(cacheDir).filter(f => f.endsWith('.json'));
  const unsolved: any[] = [];
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(join(cacheDir, f), 'utf-8'));
      if (!d.error && d.dfs && !d.dfs.win) unsolved.push(d);
    } catch {}
  }

  console.log(`Tracing death chains for ${unsolved.length} unsolved boards...\n`);

  const analyses: DeathChainAnalysis[] = [];
  let done = 0;

  for (const b of unsolved) {
    try {
      const { game, freeTiles, suitMap } = loadBoard(b.board.levelResId, b.board.replayKey);
      const cgDAG = buildColorGroupDAG(freeTiles, suitMap);

      const analysis = traceChain(game, suitMap, freeTiles, 10);
      analysis.levelResId = b.board.levelResId;
      analysis.cgEdges = cgDAG.edges.length;
      analyses.push(analysis);
    } catch { /* skip */ }
    done++;
    if (done % 10 === 0) console.log(`  ... ${done}/${unsolved.length}`);
  }

  // ── Summary ──
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  DEATH CHAIN SUMMARY (${analyses.length} boards)`);
  console.log(`${'═'.repeat(80)}`);

  // Group by death depth
  const byDepth = new Map<number, DeathChainAnalysis[]>();
  for (const a of analyses) {
    const d = a.maxDepth;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(a);
  }

  console.log(`\nDeath depth distribution:`);
  for (const [depth, boards] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  Depth ${depth}: ${boards.length} boards`);
    // Show a representative board
    if (boards.length > 0) {
      const rep = boards[0];
      console.log(`    Example: Level ${rep.levelResId} (${rep.freeTiles}t, ${rep.colorCount}c, ${rep.cgEdges}e)`);
      console.log(`    Init triples: ${rep.initialTripleColors.length} colors [${rep.initialTripleColors.slice(0,5).join(',')}]`);
    }
  }

  // ── Detailed death mechanisms ──
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  ATOMIC DEATH MECHANISMS BY DEPTH`);
  console.log(`${'═'.repeat(80)}`);

  for (const [depth, boards] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`\n── Depth ${depth} (${boards.length} boards) ──`);

    // Collect all mechanisms at this depth
    const mechs = boards.flatMap(b => [...b.deathMechanisms.entries()]
      .filter(([d]) => d === depth)
      .map(([, m]) => m));

    // Find common patterns
    const noTripleCount = mechs.filter(m => m.includes('no triple')).length;
    const afterColorPattern = new Map<string, number>();
    for (const m of mechs) {
      const match = m.match(/after c(\d+)/);
      if (match) {
        afterColorPattern.set(match[0], (afterColorPattern.get(match[0]) ?? 0) + 1);
      }
    }

    console.log(`  Mechanisms (sample):`);
    for (const m of mechs.slice(0, 3)) {
      console.log(`    ${m}`);
    }

    // What's common to ALL boards at this depth?
    const allCGEdges = boards.map(b => b.cgEdges);
    const allColors = boards.map(b => b.colorCount);
    const avgCgEdges = allCGEdges.reduce((a, b) => a + b, 0) / boards.length;
    const avgColors = allColors.reduce((a, b) => a + b, 0) / boards.length;
    console.log(`  Avg: cgEdges=${avgCgEdges.toFixed(0)}, colors=${avgColors.toFixed(0)}`);
  }

  // ── The critical question: WHY death at this depth? ──
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  DEATH DEPTH vs DAG STRUCTURE`);
  console.log(`${'═'.repeat(80)}`);
  console.log(`  Depth | Boards | Avg cgEdges | Avg colors | Avg initTripleColors`);
  console.log(`  ------|--------|-------------|------------|-------------------`);
  for (const [depth, boards] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    const avgEdges = boards.reduce((s, b) => s + b.cgEdges, 0) / boards.length;
    const avgCol = boards.reduce((s, b) => s + b.colorCount, 0) / boards.length;
    const avgInit = boards.reduce((s, b) => s + b.initialTripleColors.length, 0) / boards.length;
    console.log(`  ${String(depth).padStart(5)} | ${String(boards.length).padStart(6)} | ${avgEdges.toFixed(0).padStart(9)} | ${avgCol.toFixed(0).padStart(10)} | ${avgInit.toFixed(0).padStart(18)}`);
  }
}

main();
