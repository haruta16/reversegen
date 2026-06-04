/**
 * Deep Board Analysis — explore complete path space, cross-reference with DAG.
 *
 * For selected boards, runs exhaustive DFS to map ALL paths (not just first),
 * then correlates DAG structural properties with decision points and death traps.
 *
 * Goal: find deterministic logical rules, not statistical correlations.
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
//  Types
// ═══════════════════════════════════════════════════

interface PathNode {
  tileId: number;
  color: number;
  /** Number of remaining solutions from this state */
  solutionsBelow: number;
  /** Number of dead ends from this state */
  deathsBelow: number;
  /** Dock pressure after this move */
  dockAfter: number;
}

interface DecisionPoint {
  step: number;
  /** Options at this step */
  options: { tileId: number; color: number; leadsToWin: boolean; solutionsBelow: number }[];
  /** DAG state at this step: which color groups are active */
  activeColorGroups: number[];
  /** Why is this a decision point? (structural reason) */
  dagReason: string;
}

interface DeathTrap {
  step: number;
  tileId: number;
  /** How many steps until death */
  deathStep: number;
  /** Why does this move lead to death? */
  reason: string;
}

interface DeepAnalysisResult {
  board: {
    levelResId: number;
    replayKey: string;
    grade: string;
    freeTiles: number;
    totalTiles: number;
  };
  /** Basic stats */
  totalSolutions: number;
  totalStates: number;
  totalDeadStates: number;
  maxPathLength: number;
  minPathLength: number;
  /** DAG summary */
  colorDAG: {
    nodes: number;
    edges: number;
    maxChainLength: number;
    parallelSources: number;
    sinks: number;
    chains: number[][]; // each chain is [colorIdx, ...]
  };
  tripleDAG: {
    nodes: number;
    edges: number;
    depthMax: number;
    layers: number[];
    crossColorEdgeRatio: number;
  };
  /** Path space analysis */
  decisionPoints: DecisionPoint[];
  deathTraps: DeathTrap[];
  /** Deterministic rules that apply to this board */
  applicableRules: string[];
}

// ═══════════════════════════════════════════════════

function main() {
  // Select representative boards
  const targets = selectBoards();
  console.log(`Deep analyzing ${targets.length} boards...\n`);

  const results: DeepAnalysisResult[] = [];

  for (const t of targets) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  ${t.label}: Level ${t.levelResId} / ${t.replayKey}`);
    console.log(`${'='.repeat(60)}`);

    try {
      const result = analyzeDeep(t.levelResId, t.replayKey);
      results.push(result);
      printResult(result);
    } catch (e: any) {
      console.log(`  ERROR: ${e.message}`);
    }
  }

  // Save results
  const outPath = join(process.cwd(), '.reversegen-cache', 'deep-analysis.json');
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n\nResults saved to ${outPath}`);
}

// ═══════════════════════════════════════════════════
//  Board selection
// ═══════════════════════════════════════════════════

function selectBoards(): { levelResId: number; replayKey: string; label: string }[] {
  // Read from cache to find representative boards
  const cacheDir = join(process.cwd(), '.reversegen-cache', 'board-results-v2');
  const selected: { levelResId: number; replayKey: string; label: string }[] = [];

  try {
    const files = readdirSync(cacheDir).filter(f => f.endsWith('.json'));
    const boards: any[] = [];
    for (const f of files.slice(0, 3000)) {
      try {
        const d = JSON.parse(readFileSync(join(cacheDir, f), 'utf-8'));
        if (!d.error && d.dfs) boards.push(d);
      } catch {}
    }

    // Category 1: DFS solved + Greedy solved (simple, greed works)
    const bothWin = boards.filter(b => b.dfs.win && b.greedy?.win);
    if (bothWin.length > 0) {
      // Pick one with moderate complexity
      bothWin.sort((a, b) => a.features.tdagTripleCount - b.features.tdagTripleCount);
      const mid = bothWin[Math.floor(bothWin.length / 2)];
      selected.push({ levelResId: mid.board.levelResId, replayKey: mid.board.replayKey, label: 'BothWin (greedy works)' });
    }

    // Category 2: DFS solved + Greedy failed + low DFS complexity (narrow path, easy for solver)
    const greedyFailEasy = boards.filter(b => b.dfs.win && !b.greedy?.win && b.dfs.statesVisited < 1000);
    if (greedyFailEasy.length > 0) {
      const mid = greedyFailEasy[Math.floor(greedyFailEasy.length / 2)];
      selected.push({ levelResId: mid.board.levelResId, replayKey: mid.board.replayKey, label: 'GreedyFails-Easy (narrow but solvable)' });
    }

    // Category 3: DFS solved + Greedy failed + high DFS complexity (complex path space)
    const greedyFailHard = boards.filter(b => b.dfs.win && !b.greedy?.win && b.dfs.statesVisited > 10000);
    if (greedyFailHard.length > 0) {
      const mid = greedyFailHard[Math.floor(greedyFailHard.length / 2)];
      selected.push({ levelResId: mid.board.levelResId, replayKey: mid.board.replayKey, label: 'GreedyFails-Hard (complex, many paths)' });
    }

    // Category 4: DFS unsolved (the rarest)
    const unsolved = boards.filter(b => !b.dfs.win);
    if (unsolved.length > 0) {
      const mid = unsolved[Math.floor(unsolved.length / 2)];
      selected.push({ levelResId: mid.board.levelResId, replayKey: mid.board.replayKey, label: 'DFS-Unsolvable' });
    }

    // Category 5: Very high cgEdgeCount
    boards.sort((a, b) => (b.features.cgEdgeCount || 0) - (a.features.cgEdgeCount || 0));
    if (boards[0] && !selected.find(s => s.replayKey === boards[0].board.replayKey)) {
      selected.push({ levelResId: boards[0].board.levelResId, replayKey: boards[0].board.replayKey, label: 'Max-cgEdgeCount' });
    }

    // Category 6: Very low cgEdgeCount (simple DAG)
    boards.sort((a, b) => (a.features.cgEdgeCount || 0) - (b.features.cgEdgeCount || 0));
    if (boards[0] && !selected.find(s => s.replayKey === boards[0].board.replayKey)) {
      selected.push({ levelResId: boards[0].board.levelResId, replayKey: boards[0].board.replayKey, label: 'Min-cgEdgeCount' });
    }

  } catch (e) {
    console.error('Selection error:', e);
  }

  return selected;
}

// ═══════════════════════════════════════════════════
//  Deep analysis
// ═══════════════════════════════════════════════════

function analyzeDeep(levelResId: number, replayKey: string): DeepAnalysisResult {
  // Load board
  const { game, suitMap, allTiles, freeTiles, terrain } = loadBoard(levelResId, replayKey);

  // Build DAGs
  const colorDAG = buildColorGroupDAG(freeTiles, suitMap);
  const tripleDAG = buildBoardDAG(freeTiles, suitMap);

  // Extract DAG chains
  const chains = extractChains(colorDAG);

  // Exhaustive DFS — explore ALL paths
  const pathSpace = exploreAllPaths(game, colorDAG);

  // Find decision points
  const decisionPoints = findDecisionPoints(pathSpace, colorDAG);

  // Find death traps
  const deathTraps = findDeathTraps(pathSpace, colorDAG);

  // Derive applicable rules
  const rules = deriveRules(colorDAG, tripleDAG, pathSpace);

  return {
    board: { levelResId, replayKey, grade: '', freeTiles: freeTiles.length, totalTiles: allTiles.length },
    totalSolutions: pathSpace.solutionCount,
    totalStates: pathSpace.stateCount,
    totalDeadStates: pathSpace.deadCount,
    maxPathLength: pathSpace.maxPathLen,
    minPathLength: pathSpace.minPathLen,
    colorDAG: {
      nodes: colorDAG.nodes.length,
      edges: colorDAG.edges.length,
      maxChainLength: colorDAG.maxChainLength,
      parallelSources: colorDAG.parallelGroups,
      sinks: countSinks(colorDAG),
      chains,
    },
    tripleDAG: {
      nodes: tripleDAG.nodes.length,
      edges: tripleDAG.edges.length,
      depthMax: tripleDAG.layers.length - 1,
      layers: tripleDAG.layers.map(l => l.length),
      crossColorEdgeRatio: computeCrossColorRatio(tripleDAG),
    },
    decisionPoints,
    deathTraps,
    applicableRules: rules,
  };
}

// ═══════════════════════════════════════════════════
//  Exhaustive path exploration (limited)
// ═══════════════════════════════════════════════════

interface PathSpace {
  solutionCount: number;
  stateCount: number;
  deadCount: number;
  maxPathLen: number;
  minPathLen: number;
  /** State → { nextTileId → { winCount, deathCount, depth } } */
  stateGraph: Map<string, StateNode>;
  /** States where multiple valid moves exist */
  branchStates: string[];
}

interface StateNode {
  key: string;
  isDead: boolean;
  isWin: boolean;
  children: Map<number, ChildInfo>;
  solutionsBelow: number;
  deathsBelow: number;
}

interface ChildInfo {
  nextStateKey: string;
  solutionsBelow: number;
  deathsBelow: number;
  depth: number;
}

function exploreAllPaths(rootGame: OfflineGame, dag: ColorGroupDAG): PathSpace {
  const MAX_STATES = 500_000;
  const stateGraph = new Map<string, StateNode>();
  const branchStates: string[] = [];

  let solutionCount = 0;
  let deadCount = 0;
  let maxPathLen = 0;
  let minPathLen = Infinity;

  // Post-order traversal for bottom-up counting
  const visited = new Set<string>();
  const computing = new Set<string>();

  function explore(game: OfflineGame, depth: number): { sols: number; deads: number } {
    if (stateGraph.size >= MAX_STATES) return { sols: 0, deads: 0 };

    const key = game.buildStateKey();

    // Cycle detection
    if (computing.has(key)) return { sols: 0, deads: 0 };
    if (visited.has(key)) {
      const existing = stateGraph.get(key)!;
      return { sols: existing.solutionsBelow, deads: existing.deathsBelow };
    }

    computing.add(key);

    // Terminal
    if (game.isWin) {
      computing.delete(key);
      visited.add(key);
      const node: StateNode = { key, isDead: false, isWin: true, children: new Map(), solutionsBelow: 1, deathsBelow: 0 };
      stateGraph.set(key, node);
      solutionCount++;
      if (depth > maxPathLen) maxPathLen = depth;
      if (depth < minPathLen) minPathLen = depth;
      return { sols: 1, deads: 0 };
    }

    if (game.isDead) {
      computing.delete(key);
      visited.add(key);
      const node: StateNode = { key, isDead: true, isWin: false, children: new Map(), solutionsBelow: 0, deathsBelow: 1 };
      stateGraph.set(key, node);
      deadCount++;
      return { sols: 0, deads: 1 };
    }

    // Generate moves
    const dockCounts = game.getDockCounts();
    const clickable = game.deskTiles.filter(t => t.isClickable);
    const moves = clickable.map(t => {
      const sameInDock = dockCounts.get(t.elementValue) ?? 0;
      return {
        tile: t,
        clearScore: sameInDock >= 2 ? 1 : 0,
        pairScore: sameInDock === 1 ? 1 : 0,
        unlockGain: game.countUnlockGain(t.id),
      };
    }).sort((a, b) => {
      if (b.clearScore !== a.clearScore) return b.clearScore - a.clearScore;
      if (b.pairScore !== a.pairScore) return b.pairScore - a.pairScore;
      if (b.unlockGain !== a.unlockGain) return b.unlockGain - a.unlockGain;
      return a.tile.id - b.tile.id;
    });

    if (moves.length === 0) {
      computing.delete(key);
      visited.add(key);
      const node: StateNode = { key, isDead: true, isWin: false, children: new Map(), solutionsBelow: 0, deathsBelow: 1 };
      stateGraph.set(key, node);
      deadCount++;
      return { sols: 0, deads: 1 };
    }

    // Branch detection
    if (moves.length > 1) branchStates.push(key);

    const children = new Map<number, ChildInfo>();
    let totalSols = 0;
    let totalDeads = 0;

    for (const { tile } of moves) {
      const next = game.clone();
      const nextTile = next.allTiles.get(tile.id);
      if (!nextTile) continue;

      try {
        next.collect(nextTile);
        const childResult = explore(next, depth + 1);
        children.set(tile.id, {
          nextStateKey: next.buildStateKey(),
          solutionsBelow: childResult.sols,
          deathsBelow: childResult.deads,
          depth: depth + 1,
        });
        totalSols += childResult.sols;
        totalDeads += childResult.deads;
      } catch {
        children.set(tile.id, { nextStateKey: 'error', solutionsBelow: 0, deathsBelow: 1, depth: depth + 1 });
        totalDeads++;
      }
    }

    computing.delete(key);
    visited.add(key);
    const node: StateNode = { key, isDead: false, isWin: false, children, solutionsBelow: totalSols, deathsBelow: totalDeads };
    stateGraph.set(key, node);

    return { sols: totalSols, deads: totalDeads };
  }

  explore(rootGame.clone(), 0);

  return {
    solutionCount,
    stateCount: stateGraph.size,
    deadCount,
    maxPathLen,
    minPathLen: minPathLen === Infinity ? 0 : minPathLen,
    stateGraph,
    branchStates,
  };
}

// ═══════════════════════════════════════════════════
//  Decision points
// ═══════════════════════════════════════════════════

function findDecisionPoints(pathSpace: PathSpace, dag: ColorGroupDAG): DecisionPoint[] {
  const points: DecisionPoint[] = [];

  for (const stateKey of pathSpace.branchStates.slice(0, 50)) {
    const node = pathSpace.stateGraph.get(stateKey);
    if (!node || node.children.size <= 1) continue;

    const options = [...node.children.entries()].map(([tileId, child]) => ({
      tileId,
      color: 0, // Will be filled from state key parsing
      leadsToWin: child.solutionsBelow > 0,
      solutionsBelow: child.solutionsBelow,
    }));

    // Count winning vs losing branches
    const winningBranches = options.filter(o => o.leadsToWin).length;
    const totalBranches = options.length;

    let dagReason = '';
    if (winningBranches === 1 && totalBranches > 1) {
      dagReason = '唯一正确分支 — 存在"陷阱"选项';
    } else if (winningBranches === totalBranches) {
      dagReason = '所有分支均可达胜利 — 纯自由选择';
    } else {
      dagReason = `混合: ${winningBranches}/${totalBranches} 分支可达胜利`;
    }

    points.push({
      step: 0, // approximate
      options,
      activeColorGroups: [],
      dagReason,
    });
  }

  return points;
}

// ═══════════════════════════════════════════════════
//  Death traps
// ═══════════════════════════════════════════════════

function findDeathTraps(pathSpace: PathSpace, dag: ColorGroupDAG): DeathTrap[] {
  const traps: DeathTrap[] = [];

  // Find states where some children lead to win and some to death
  for (const [key, node] of pathSpace.stateGraph) {
    if (node.isDead || node.isWin) continue;

    const winningChildren = [...node.children.entries()].filter(([, c]) => c.solutionsBelow > 0);
    const losingChildren = [...node.children.entries()].filter(([, c]) => c.solutionsBelow === 0 && c.deathsBelow > 0);

    if (winningChildren.length > 0 && losingChildren.length > 0) {
      for (const [tileId, child] of losingChildren) {
        traps.push({
          step: 0, // approximate
          tileId,
          deathStep: child.deathsBelow,
          reason: `${winningChildren.length}个正确选择存在，此选项导向死路（${child.deathsBelow}个死状态在下）`,
        });
      }
    }
  }

  return traps.slice(0, 30);
}

// ═══════════════════════════════════════════════════
//  Rule derivation
// ═══════════════════════════════════════════════════

function deriveRules(dag: ColorGroupDAG, tdag: BoardDAG, pathSpace: PathSpace): string[] {
  const rules: string[] = [];

  // Rule 1: Chain structure determines path count
  const chains = extractChains(dag);
  const totalNodes = dag.nodes.length;
  const nodesInChains = chains.reduce((s, c) => s + c.length, 0);
  if (nodesInChains === totalNodes && chains.every(c => c.length <= 2)) {
    rules.push('R1: All color groups in short chains → solution count bounded by 2^(chain_count)');
  }

  // Rule 2: Parallel sources = free choice
  if (dag.parallelGroups > 0) {
    const sols = pathSpace.solutionCount;
    const expected = Math.pow(2, dag.parallelGroups); // rough upper bound
    if (sols > 1 && sols <= expected * 10) {
      rules.push(`R2: ${dag.parallelGroups} parallel source groups → up to ${expected} solution orderings (actual: ${sols})`);
    }
  }

  // Rule 3: Sinks = must be last
  const sinkCount = countSinks(dag);
  if (sinkCount === 1) {
    rules.push(`R3: Single sink in color DAG → exactly 1 color group must be last, reducing path possibilities`);
  }

  // Rule 4: Long chain = forced sequential order
  if (dag.maxChainLength >= 3) {
    rules.push(`R4: Chain length ${dag.maxChainLength} → at least ${dag.maxChainLength} color groups have forced sequential order`);
  }

  // Rule 5: Triple-level parallelism = solution multiplicity
  const layers = tdag.layers;
  const maxLayer = layers.length > 0 ? Math.max(...layers.map(l => l.length)) : 0;
  if (maxLayer > 5) {
    rules.push(`R5: Max triple parallelism ${maxLayer} → many parallel triple choices within same color groups`);
  }

  // Rule 6: Cross-color edge ratio
  const crossRatio = computeCrossColorRatio(tdag);
  if (crossRatio > 0.95) {
    rules.push(`R6: ${(crossRatio*100).toFixed(0)}% of triple edges are cross-color → color groups are heavily interleaved`);
  }

  // Rule 7: Path space narrowness
  if (pathSpace.solutionCount === 1) {
    rules.push('R7: Unique solution — board is a "puzzle" with exactly 1 winning path');
  } else if (pathSpace.solutionCount <= 10) {
    rules.push(`R7b: ${pathSpace.solutionCount} solutions — board has few winning paths, high failure risk for random play`);
  }

  return rules;
}

// ═══════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════

function loadBoard(levelResId: number, replayKey: string) {
  const LEVELS_DIR = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
  const REPLAYS_DIR = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Replays';

  const terrain: TerrainData = loadTerrainFromFile(join(LEVELS_DIR, `${levelResId}.json`));
  const allTiles = flattenTiles(terrain);
  const freeTiles = allTiles.filter(t => !t.isConst);
  const canonicalOrder = getCanonicalTileOrder(allTiles);

  const replayJson = JSON.parse(readFileSync(join(REPLAYS_DIR, `${levelResId}.json`), 'utf-8'));
  const infoDict = replayJson.replayInfoDict || {};

  // Find the specific replay entry
  let entry: any = null;
  for (const [, entries] of Object.entries(infoDict)) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries as any[]) {
      if (e.ReplayKey === replayKey) { entry = e; break; }
    }
    if (entry) break;
  }
  if (!entry) throw new Error(`ReplayKey ${replayKey} not found`);

  const replayData = decodeFromString(entry.ReplayCode);
  if (!replayData) throw new Error('Decode failed');

  const cIdxToTerrainId = new Map<number, number>();
  for (let i = 0; i < canonicalOrder.length; i++) cIdxToTerrainId.set(i, canonicalOrder[i].id);

  const elementValues = new Map<number, number>();
  const initialDock: { tileId: number; element: number }[] = [];
  const eliminatedIds = new Set<number>();
  const suitMap = new Map<number, number>();

  for (let i = 0; i < replayData.instanceArray.length; i++) {
    const terrainId = cIdxToTerrainId.get(i);
    if (terrainId === undefined) continue;
    const ev = (replayData.instanceArray[i] & 0x3F) + 1;
    elementValues.set(terrainId, ev);
    suitMap.set(terrainId, ev);
    const st = ((replayData.instanceArray[i] >> 6) & 0x3) as TileState;
    if (st === TileState.InDock) initialDock.push({ tileId: terrainId, element: ev });
    else if (st === TileState.Eliminated) eliminatedIds.add(terrainId);
  }
  for (const de of replayData.dockEntries) {
    const terrainId = cIdxToTerrainId.get(de.tileId);
    if (terrainId !== undefined) {
      initialDock.push({ tileId: terrainId, element: de.element });
      elementValues.set(terrainId, de.element);
      suitMap.set(terrainId, de.element);
    }
  }

  const game = createGame({ terrainTiles: allTiles, elementValues, initialDock, eliminatedTileIds: eliminatedIds });

  return { game, suitMap, allTiles, freeTiles, terrain };
}

function flattenTiles(terrain: TerrainData): TerrainTile[] {
  const tiles: TerrainTile[] = [];
  for (const layer of terrain.layers) for (const tile of layer.tiles) tiles.push(tile);
  return tiles;
}

function extractChains(dag: ColorGroupDAG): number[][] {
  // Find all maximal chains in the DAG
  const chains: number[][] = [];
  const visited = new Set<number>();

  // Start from source nodes (no incoming edges)
  const incoming = new Set<number>();
  for (const [, to] of dag.edges) incoming.add(to);

  for (let i = 0; i < dag.nodes.length; i++) {
    if (incoming.has(i)) continue; // source
    if (visited.has(i)) continue;

    // Follow chain
    const chain: number[] = [i];
    visited.add(i);
    let current = i;

    while (true) {
      const outgoing = dag.edges.filter(([a]) => a === current).map(([, b]) => b);
      if (outgoing.length !== 1) break;
      const next = outgoing[0];
      if (visited.has(next)) { chain.push(next); break; }
      chain.push(next);
      visited.add(next);
      current = next;
    }

    if (chain.length >= 2) chains.push(chain);
  }

  return chains;
}

function countSinks(dag: ColorGroupDAG): number {
  const outgoing = new Set<number>();
  for (const [a] of dag.edges) outgoing.add(a);
  let sinks = 0;
  for (let i = 0; i < dag.nodes.length; i++) {
    if (!outgoing.has(i)) sinks++;
  }
  return sinks;
}

function computeCrossColorRatio(tdag: BoardDAG): number {
  if (tdag.edges.length === 0) return 0;
  let cross = 0;
  for (const e of tdag.edges) {
    if (tdag.nodes[e.from].color !== tdag.nodes[e.to].color) cross++;
  }
  return cross / tdag.edges.length;
}

function printResult(r: DeepAnalysisResult): void {
  console.log(`\n  Solutions: ${r.totalSolutions} | States: ${r.totalStates} | Dead: ${r.totalDeadStates}`);
  console.log(`  Path length: ${r.minPathLen} ~ ${r.maxPathLen}`);
  console.log(`\n  Color DAG: ${r.colorDAG.nodes} nodes, ${r.colorDAG.edges} edges`);
  console.log(`    Max chain: ${r.colorDAG.maxChainLength}, Parallel sources: ${r.colorDAG.parallelSources}, Sinks: ${r.colorDAG.sinks}`);
  if (r.colorDAG.chains.length > 0) {
    console.log(`    Chains: ${r.colorDAG.chains.map(c => `[${c.join('→')}]`).join(', ')}`);
  }
  console.log(`\n  Triple DAG: ${r.tripleDAG.nodes} nodes, ${r.tripleDAG.edges} edges`);
  console.log(`    Depth: 0~${r.tripleDAG.depthMax}, Layers: [${r.tripleDAG.layers.join(', ')}]`);
  console.log(`    Cross-color edges: ${(r.tripleDAG.crossColorEdgeRatio * 100).toFixed(0)}%`);
  console.log(`\n  Decision Points: ${r.decisionPoints.length}`);
  for (const dp of r.decisionPoints.slice(0, 5)) {
    const wins = dp.options.filter(o => o.leadsToWin).length;
    console.log(`    Step ~${dp.step}: ${dp.options.length} options, ${wins} lead to win — ${dp.dagReason}`);
  }
  console.log(`\n  Death Traps: ${r.deathTraps.length}`);
  for (const dt of r.deathTraps.slice(0, 3)) {
    console.log(`    Tile ${dt.tileId}: ${dt.reason}`);
  }
  console.log(`\n  Applicable Rules:`);
  for (const rule of r.applicableRules) {
    console.log(`    ${rule}`);
  }
}

main();
