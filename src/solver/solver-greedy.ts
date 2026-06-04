/**
 * Greedy solver — simulates a player who always picks the "easiest" move.
 *
 * At each step, among all clickable tiles:
 *   1. Prefer tiles that complete a triple (dock has ≥2 same-color)
 *   2. Then prefer tiles that create a pair (dock has 1 same-color)
 *   3. Then prefer tiles with smallest cost (fewest new deps released)
 *   4. Tiebreak by tile ID
 *
 * This is the solver that ReverseGen's greedy simulation approximates
 * at the triple-step level. Running this against the real game model
 * reveals the gap between ReverseGen's assumption and reality.
 */

import { OfflineGame } from './offline-game.js';
import type { GreedyResult } from './types.js';

export function solveGreedy(game: OfflineGame, maxSteps: number = 2000): GreedyResult {
  const startTime = performance.now();
  const g = game.clone();
  const picks: number[] = [];
  const costLog: number[] = [];
  const dockLog: number[] = [];

  for (let step = 0; step < maxSteps; step++) {
    if (g.isWin) break;
    if (g.isDead) {
      return {
        win: false,
        failReason: `Dock full at step ${step}`,
        picks,
        stepCount: picks.length,
        costLog,
        dockLog,
        elapsedMs: performance.now() - startTime,
      };
    }

    const dockCounts = g.getDockCounts();
    const clickable = g.clickableTiles;
    if (clickable.length === 0) {
      return {
        win: false,
        failReason: `No clickable tiles at step ${step}`,
        picks,
        stepCount: picks.length,
        costLog,
        dockLog,
        elapsedMs: performance.now() - startTime,
      };
    }

    // Score each clickable tile
    const scored = clickable.map(t => {
      const sameInDock = dockCounts.get(t.elementValue) ?? 0;
      const clearScore = sameInDock >= 2 ? 2 : 0;
      const pairScore = sameInDock === 1 ? 1 : 0;
      // cost = runtimeDependencies size (how many new deps would be unlocked)
      const cost = t.runtimeDependencies.size;
      return { tile: t, clearScore, pairScore, cost };
    });

    // Sort: prefer clearing, then pairing, then lowest cost, then stable ID
    scored.sort((a, b) => {
      if (b.clearScore !== a.clearScore) return b.clearScore - a.clearScore;
      if (b.pairScore !== a.pairScore) return b.pairScore - a.pairScore;
      if (a.cost !== b.cost) return a.cost - b.cost; // LOWER cost first
      return a.tile.id - b.tile.id;
    });

    const chosen = scored[0];
    const prevDeps = g.deskTiles.filter(t => !t.isClickable).length;

    g.collect(chosen.tile);
    picks.push(chosen.tile.id);

    // Record cost (new tiles that became clickable after this move)
    const newDeps = g.deskTiles.filter(t => !t.isClickable).length;
    costLog.push(Math.abs(newDeps - prevDeps));
    dockLog.push(g.dockTiles.length);
  }

  return {
    win: g.isWin,
    failReason: g.isWin ? null : (g.isDead ? 'Dock full' : `Max steps (${maxSteps}) reached`),
    picks,
    stepCount: picks.length,
    costLog,
    dockLog,
    elapsedMs: performance.now() - startTime,
  };
}
