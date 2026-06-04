/**
 * DFS solver with dead-state memoization.
 *
 * Exact port of C# SolverRunner.cs.
 * Searches the tile-click state space for a winning sequence.
 *
 * State key = sorted desk IDs + dock counts by color.
 * Dead states are memoized to prune the search tree.
 */

import { OfflineGame } from './offline-game.js';
import { OfflineTile, type SolverResult } from './types.js';

// ═══════════════════════════════════════════════════
//  DFS Solver
// ═══════════════════════════════════════════════════

export function solveDFS(
  game: OfflineGame,
  opts: {
    maxStates?: number;
    timeoutMs?: number;
    collectDeadStates?: boolean;
  } = {},
): SolverResult {
  const maxStates = opts.maxStates ?? 10_000_000;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const collectDead = opts.collectDeadStates ?? false;

  const deadMemo = new Set<string>();
  const deadStates: string[] = [];
  const startTime = performance.now();
  let statesVisited = 0;

  const picks: number[] = [];

  function solve(g: OfflineGame): boolean {
    statesVisited++;

    // Timeout
    if (performance.now() - startTime > timeoutMs) return false;

    // Limit
    if (statesVisited > maxStates) return false;

    // Terminal states
    if (g.isWin) return true;
    if (g.isDead) {
      if (collectDead) deadStates.push(g.buildStateKey());
      return false;
    }

    // Memoization
    const key = g.buildStateKey();
    if (deadMemo.has(key)) {
      if (collectDead) deadStates.push(key);
      return false;
    }

    // Generate & order actions
    const actions = orderActions(g);
    if (actions.length === 0) {
      deadMemo.add(key);
      if (collectDead) deadStates.push(key);
      return false;
    }

    // DFS with backtracking
    for (const tileId of actions) {
      const next = g.clone();
      const tile = next.allTiles.get(tileId);
      if (!tile || !tile.isClickable) continue;

      next.collect(tile);
      picks.push(tileId);

      if (solve(next)) return true;

      picks.pop();
    }

    deadMemo.add(key);
    if (collectDead) deadStates.push(key);
    return false;
  }

  const root = game.clone();
  const win = solve(root);

  return {
    win,
    failReason: win ? null : 'DFS exhausted; no winning path found',
    picks: [...picks],
    stepCount: picks.length,
    deadStates,
    statesVisited,
    elapsedMs: performance.now() - startTime,
  };
}

// ═══════════════════════════════════════════════════
//  Action ordering (port of OrderActions)
// ═══════════════════════════════════════════════════

/**
 * Order clickable tiles by:
 *   1. ClearScore desc — dock has ≥2 same-color → clicking completes a triple
 *   2. PairScore desc  — dock has exactly 1 same-color → clicking creates a pair
 *   3. UnlockGain desc — how many blocked tiles become clickable
 *   4. Tile ID asc    — stable tiebreaker
 */
function orderActions(game: OfflineGame): number[] {
  const dockCounts = game.getDockCounts();

  return game.deskTiles
    .filter(t => t.isClickable)
    .map(t => {
      const sameInDock = dockCounts.get(t.elementValue) ?? 0;
      const clearScore = sameInDock >= 2 ? 1 : 0;
      const pairScore = sameInDock === 1 ? 1 : 0;
      const unlockGain = game.countUnlockGain(t.id);
      return { tile: t, clearScore, pairScore, unlockGain };
    })
    .sort((a, b) => {
      if (b.clearScore !== a.clearScore) return b.clearScore - a.clearScore;
      if (b.pairScore !== a.pairScore) return b.pairScore - a.pairScore;
      if (b.unlockGain !== a.unlockGain) return b.unlockGain - a.unlockGain;
      return a.tile.id - b.tile.id;
    })
    .map(e => e.tile.id);
}

// ═══════════════════════════════════════════════════
//  Quick checks (without full DFS)
// ═══════════════════════════════════════════════════

/**
 * Check if a board is trivially unsolvable:
 * total tiles of any color not divisible by 3.
 */
export function hasColorParityIssue(elementValues: Map<number, number>): boolean {
  const counts = new Map<number, number>();
  for (const [, color] of elementValues) {
    counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  for (const [, count] of counts) {
    if (count % 3 !== 0) return true;
  }
  return false;
}
