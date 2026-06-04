/**
 * Deep Analysis v3 — real exhaustive search, provable properties.
 *
 * Fixes from v2:
 *   1. Actually count ALL solutions (continue after finding first)
 *   2. Verify unique-solution claims by exhausting the state space (not hitting limit)
 *   3. Test provable structural rules against a larger sample (20-30 boards)
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TerrainData, TerrainTile } from '../types.js';
import { TileState } from '../types.js';
import { loadTerrainFromFile } from '../terrain-loader.js';
import { decodeFromString, getCanonicalTileOrder } from '../replay-serializer.js';
import { createGame, OfflineGame } from '../solver/offline-game.js';
import { buildColorGroupDAG, buildBoardDAG, type ColorGroupDAG, type BoardDAG } from './board-dag.js';
import { logger, setLogLevel, LogLevel } from '../logger.js';
setLogLevel(LogLevel.Error);

// ═══════════════════════════════════════════════════
//  Enhanced exhaustive DFS — counts ALL solutions
// ═══════════════════════════════════════════════════

interface ExhaustiveResult {
  /** TRUE solution count (exhausted or limited) */
  solutionCount: number;
  /** Total states explored */
  statesExplored: number;
  /** Dead states */
  deadStates: number;
  /** Did we exhaust the space (not hit limit)? */
  exhausted: boolean;
  /** Per-state info */
  stateMap: Map<string, { sols: number; deads: number; children: Map<number, { sols: number; deads: number }> }>;
  /** States where multiple legal moves exist */
  branchStates: { key: string; moveCount: number; winCount: number }[];
  /** Depth range */
  minDepth: number;
  maxDepth: number;
}

/**
 * True exhaustive DFS: count ALL solutions, explore ALL branches.
 * Uses memoization with bottom-up counting.
 */
function exhaustiveSolve(root: OfflineGame, maxStates: number = 2_000_000): ExhaustiveResult {
  const memo = new Map<string, { sols: number; deads: number; children?: Map<number, { sols: number; deads: number }> }>();
  const computing = new Set<string>();
  const branchStates: { key: string; moveCount: number; winCount: number }[] = [];
  let hitLimit = false;

  function explore(game: OfflineGame, depth: number): { sols: number; deads: number } {
    if (memo.size >= maxStates) { hitLimit = true; return { sols: 0, deads: 0 }; }

    const key = game.buildStateKey();

    // Cycle detection
    if (computing.has(key)) return { sols: 0, deads: 0 };

    const cached = memo.get(key);
    if (cached) return cached;

    computing.add(key);

    // Terminal states
    if (game.isWin) {
      computing.delete(key);
      memo.set(key, { sols: 1, deads: 0 });
      return { sols: 1, deads: 0 };
    }
    if (game.isDead) {
      computing.delete(key);
      memo.set(key, { sols: 0, deads: 1 });
      return { sols: 0, deads: 1 };
    }

    // Generate moves (ordered like DFS for efficiency)
    const dockCounts = game.getDockCounts();
    const clickable = game.deskTiles.filter(t => t.isClickable);
    if (clickable.length === 0) {
      computing.delete(key);
      memo.set(key, { sols: 0, deads: 1 });
      return { sols: 0, deads: 1 };
    }

    const moves = clickable.map(t => ({
      tile: t,
      clearScore: (dockCounts.get(t.elementValue) ?? 0) >= 2 ? 1 : 0,
      pairScore: (dockCounts.get(t.elementValue) ?? 0) === 1 ? 1 : 0,
      unlockGain: game.countUnlockGain(t.id),
    })).sort((a, b) => {
      if (b.clearScore !== a.clearScore) return b.clearScore - a.clearScore;
      if (b.pairScore !== a.pairScore) return b.pairScore - a.pairScore;
      if (b.unlockGain !== a.unlockGain) return b.unlockGain - a.unlockGain;
      return a.tile.id - b.tile.id;
    });

    // Branch detection
    if (moves.length > 1) {
      const children = new Map<number, { sols: number; deads: number }>();
      let totalSols = 0, totalDeads = 0;
      let winningMoves = 0;

      for (const { tile } of moves) {
        const next = game.clone();
        const nt = next.allTiles.get(tile.id);
        if (!nt) continue;
        try {
          next.collect(nt);
          const r = explore(next, depth + 1);
          children.set(tile.id, { sols: r.sols, deads: r.deads });
          totalSols += r.sols;
          totalDeads += r.deads;
          if (r.sols > 0) winningMoves++;
        } catch {
          children.set(tile.id, { sols: 0, deads: 1 });
          totalDeads++;
        }
        if (hitLimit) break;
      }

      branchStates.push({ key, moveCount: moves.length, winCount: winningMoves });

      computing.delete(key);
      memo.set(key, { sols: totalSols, deads: totalDeads, children });
      return { sols: totalSols, deads: totalDeads };
    }

    // Single move — just follow it
    const { tile } = moves[0];
    const next = game.clone();
    const nt = next.allTiles.get(tile.id);
    if (!nt) {
      computing.delete(key);
      memo.set(key, { sols: 0, deads: 1 });
      return { sols: 0, deads: 1 };
    }

    try {
      next.collect(nt);
      const r = explore(next, depth + 1);
      computing.delete(key);
      memo.set(key, r);
      return r;
    } catch {
      computing.delete(key);
      memo.set(key, { sols: 0, deads: 1 });
      return { sols: 0, deads: 1 };
    }
  }

  const rootResult = explore(root.clone(), 0);

  // Compute depth stats from memo
  let minDepth = Infinity, maxDepth = 0;
  let totalStates = memo.size;
  let deadStates = 0;

  for (const [, v] of memo) {
    if (v.deads > 0 && v.sols === 0) deadStates++;
  }

  return {
    solutionCount: rootResult.sols,
    statesExplored: totalStates,
    deadStates,
    exhausted: !hitLimit,
    stateMap: memo as any,
    branchStates: branchStates.slice(0, 100),
    minDepth: minDepth === Infinity ? 0 : minDepth,
    maxDepth,
  };
}

// ═══════════════════════════════════════════════════
//  Provable structural rules
// ═══════════════════════════════════════════════════

interface StructuralRule {
  name: string;
  description: string;
  /** Check if the rule predicts a certain property */
  check: (cgDAG: ColorGroupDAG, tDAG: BoardDAG) => boolean;
  property: string;
}

const STRUCTURAL_RULES: StructuralRule[] = [
  {
    name: 'NO_PARALLEL_SOURCES',
    description: 'No color group is free of incoming edges — every group depends on at least one other group',
    check: (cg) => cg.parallelGroups === 0,
    property: 'SingularEntry — 不存在"可以先消"的入口色组',
  },
  {
    name: 'NO_SINKS',
    description: 'No color group is free of outgoing edges — every group blocks at least one other group',
    check: (cg) => {
      const out = new Set<number>();
      for (const [a] of cg.edges) out.add(a);
      for (let i = 0; i < cg.nodes.length; i++) if (!out.has(i)) return false;
      return cg.nodes.length > 0;
    },
    property: 'SingularExit — 不存在"可以最后消"的出口色组',
  },
  {
    name: 'DEADLOCK_CYCLE',
    description: 'No source AND no sink → dependency web with no entry or exit point',
    check: (cg) => {
      const out = new Set<number>(), inc = new Set<number>();
      for (const [a, b] of cg.edges) { out.add(a); inc.add(b); }
      for (let i = 0; i < cg.nodes.length; i++) {
        if (!inc.has(i)) return false; // has source
        if (!out.has(i)) return false; // has sink
      }
      return cg.nodes.length > 0;
    },
    property: 'DeadlockCycle — 依赖关系闭环，无入口无出口',
  },
  {
    name: 'HIGH_EDGE_DENSITY',
    description: 'Edge density > threshold (edges / max_possible_edges)',
    check: (cg) => {
      const n = cg.nodes.length;
      const max = n * (n - 1);
      return max > 0 && cg.edges.length / max > 0.5;
    },
    property: 'DenseDependency — 50%+ 色组对有依赖关系',
  },
  {
    name: 'LONG_CHAIN',
    description: '存在长度 ≥ 3 的依赖链',
    check: (cg) => cg.maxChainLength >= 3,
    property: 'LongChain — 存在需要严格顺序消除的链条',
  },
  {
    name: 'SINGLE_SINK',
    description: '只有一个出口色组',
    check: (cg) => {
      const out = new Set<number>();
      for (const [a] of cg.edges) out.add(a);
      let sinks = 0;
      for (let i = 0; i < cg.nodes.length; i++) if (!out.has(i)) sinks++;
      return sinks === 1;
    },
    property: 'SingleSink — 最后一个色组被锁定',
  },
];

// ═══════════════════════════════════════════════════
//  Load board
// ═══════════════════════════════════════════════════

function loadBoard(levelResId: number, replayKey: string) {
  const LEVELS_DIR = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
  const REPLAYS_DIR = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Replays';

  const terrain: TerrainData = loadTerrainFromFile(join(LEVELS_DIR, `${levelResId}.json`));
  const allTiles: TerrainTile[] = [];
  for (const layer of terrain.layers) for (const tile of layer.tiles) allTiles.push(tile);
  const freeTiles = allTiles.filter(t => !t.isConst);
  const co = getCanonicalTileOrder(allTiles);

  const rj = JSON.parse(readFileSync(join(REPLAYS_DIR, `${levelResId}.json`), 'utf-8'));
  let entry: any = null;
  for (const [, entries] of Object.entries(rj.replayInfoDict || {})) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries as any[]) { if (e.ReplayKey === replayKey) { entry = e; break; } }
    if (entry) break;
  }
  if (!entry) throw new Error(`ReplayKey ${replayKey} not found`);

  const rd = decodeFromString(entry.ReplayCode);
  if (!rd) throw new Error('Decode failed');

  const c2t = new Map<number, number>();
  for (let i = 0; i < co.length; i++) c2t.set(i, co[i].id);

  const ev = new Map<number, number>();
  const dock: { tileId: number; element: number }[] = [];
  const elim = new Set<number>();
  const suitMap = new Map<number, number>();

  for (let i = 0; i < rd.instanceArray.length; i++) {
    const tid = c2t.get(i);
    if (tid === undefined) continue;
    const v = (rd.instanceArray[i] & 0x3F) + 1;
    ev.set(tid, v); suitMap.set(tid, v);
    const st = ((rd.instanceArray[i] >> 6) & 0x3) as TileState;
    if (st === TileState.InDock) dock.push({ tileId: tid, element: v });
    else if (st === TileState.Eliminated) elim.add(tid);
  }
  for (const de of rd.dockEntries) {
    const tid = c2t.get(de.tileId);
    if (tid !== undefined) { dock.push({ tileId: tid, element: de.element }); ev.set(tid, de.element); suitMap.set(tid, de.element); }
  }

  const game = createGame({ terrainTiles: allTiles, elementValues: ev, initialDock: dock, eliminatedTileIds: elim });
  return { game, suitMap, allTiles, freeTiles };
}

// ═══════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════

function main() {
  // Select 30 representative boards
  const cacheDir = join(process.cwd(), '.reversegen-cache', 'board-results-v2');
  const files = readdirSync(cacheDir).filter(f => f.endsWith('.json'));

  const boards: any[] = [];
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(join(cacheDir, f), 'utf-8'));
      if (!d.error && d.dfs && d.features) boards.push(d);
    } catch {}
  }

  // Stratified sampling: pick boards from different cgEdgeCount bins
  const bins = [
    { lo: 0, hi: 30, count: 5, label: 'VeryLow' },
    { lo: 30, hi: 70, count: 5, label: 'Low' },
    { lo: 70, hi: 120, count: 5, label: 'Medium' },
    { lo: 120, hi: 180, count: 5, label: 'High' },
    { lo: 180, hi: 500, count: 5, label: 'VeryHigh' },
  ];

  const selected: { board: any; label: string }[] = [];
  for (const bin of bins) {
    const inBin = boards.filter(b => b.features.cgEdgeCount >= bin.lo && b.features.cgEdgeCount < bin.hi);
    // Random sample
    const sample = inBin.sort(() => Math.random() - 0.5).slice(0, bin.count);
    for (const b of sample) {
      if (!selected.find(s => s.board.board.replayKey === b.board.replayKey)) {
        selected.push({ board: b, label: bin.label });
      }
    }
  }

  // Also add some unsolved boards
  const unsolved = boards.filter(b => !b.dfs.win).slice(0, 5);
  for (const b of unsolved) {
    if (!selected.find(s => s.board.board.replayKey === b.board.replayKey)) {
      selected.push({ board: b, label: 'UNSOLVED' });
    }
  }

  console.log(`Testing ${selected.length} boards (stratified + unsolved)\n`);

  // ── Test structural rules ──
  const ruleResults: Record<string, { total: number; unsolvable: number; solvable: number; solCounts: number[] }> = {};
  for (const rule of STRUCTURAL_RULES) {
    ruleResults[rule.name] = { total: 0, unsolvable: 0, solvable: 0, solCounts: [] };
  }

  console.log(`${'Board'.padEnd(50)} | cgEdges | cgNodes | DFS? | Sols? | ${STRUCTURAL_RULES.map(r => r.name.slice(0, 8)).join(' | ')}`);
  console.log('-'.repeat(50) + '-|-' + '-'.repeat(7) + '-|-' + '-'.repeat(7) + '-|-' + '-'.repeat(4) + '-|-' + '-'.repeat(5) + '-|-' + STRUCTURAL_RULES.map(() => '-'.repeat(8)).join('-|-'));
  console.log();

  for (const { board, label } of selected) {
    const lvl = board.board.levelResId;
    const rk = board.board.replayKey;

    let game, suitMap, allTiles, freeTiles;
    let cgDAG: ColorGroupDAG, tDAG: BoardDAG;
    let exResult: ExhaustiveResult;
    let error: string | null = null;

    try {
      const loaded = loadBoard(lvl, rk);
      game = loaded.game; suitMap = loaded.suitMap; allTiles = loaded.allTiles; freeTiles = loaded.freeTiles;
      cgDAG = buildColorGroupDAG(freeTiles, suitMap);
      tDAG = buildBoardDAG(freeTiles, suitMap);

      // True exhaustive search (2M state limit)
      exResult = exhaustiveSolve(game, 2_000_000);
    } catch (e: any) {
      error = e.message;
      continue;
    }

    if (error) continue;

    const sols = exResult.solutionCount;
    const exhausted = exResult.exhausted;
    const solLabel = exhausted ? String(sols) : `≥${sols}`;

    // Check rules
    const ruleHits: boolean[] = [];
    for (const rule of STRUCTURAL_RULES) {
      const hit = rule.check(cgDAG, tDAG);
      ruleHits.push(hit);
      if (hit) {
        ruleResults[rule.name].total++;
        if (sols === 0) ruleResults[rule.name].unsolvable++;
        else ruleResults[rule.name].solvable++;
        if (exhausted) ruleResults[rule.name].solCounts.push(sols);
      }
    }

    const dfsStatus = board.dfs.win ? '✓' : '✗';
    const boardLabel = `${lvl} ${label}`.padEnd(48).substring(0, 48);
    const hits = ruleHits.map(h => h ? '  ●   ' : '  ·   ').join(' | ');

    console.log(`${boardLabel} | ${String(cgDAG.edges.length).padStart(7)} | ${String(cgDAG.nodes.length).padStart(7)} | ${dfsStatus.padStart(3)}  | ${solLabel.padStart(4)}  | ${hits}`);
  }

  // ── Rule analysis ──
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  STRUCTURAL RULE ANALYSIS`);
  console.log(`${'='.repeat(80)}`);

  for (const rule of STRUCTURAL_RULES) {
    const r = ruleResults[rule.name];
    if (r.total === 0) continue;

    const unsolvableRate = (r.unsolvable / r.total * 100).toFixed(0);
    const avgSols = r.solCounts.length > 0
      ? (r.solCounts.reduce((a, b) => a + b, 0) / r.solCounts.length).toFixed(0)
      : 'N/A';

    console.log(`\n  ${rule.name}`);
    console.log(`    ${rule.description}`);
    console.log(`    Property: ${rule.property}`);
    console.log(`    Hit ${r.total} boards:`);
    console.log(`      - Unsolvable: ${r.unsolvable}/${r.total} (${unsolvableRate}%)`);
    console.log(`      - Solvable:   ${r.solvable}/${r.total} (${(100 - Number(unsolvableRate)).toFixed(0)}%)`);
    console.log(`      - Avg solutions (when solvable & exhausted): ${avgSols}`);

    // Evaluate rule quality
    if (r.unsolvable === r.total && r.total >= 5) {
      console.log(`    ★ DETERMINISTIC: Every board with this property is UNSOLVABLE`);
    } else if (r.unsolvable > 0 && r.unsolvable < r.total) {
      console.log(`    ⚠ PARTIAL: ${r.unsolvable}/${r.total} unsolvable — not deterministic`);
    } else if (r.unsolvable === 0) {
      console.log(`    → All solvable — property does NOT predict unsolvability`);
    }
  }
}

main();
