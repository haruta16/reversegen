/**
 * Death Checkpoint Solver — BFS by death depth.
 *
 * === Algorithm ===
 *
 * Phase 0: Run standard DFS (0 revives) from the root.
 *   Every time the dock fills (isDead), save the game snapshot as a
 *   "death state at depth 0". Continue exploring other branches.
 *
 * Phase 1+: For each death depth d = 0, 1, 2, ...:
 *   Take every death state at depth d.
 *   Try every legal revive action from it (1 dock + 2 matching desk tiles).
 *   After the revive, run DFS (0 further revives) from the revived state.
 *   If a win is found → d+1 is the minimum revive count.  Done.
 *   If the revived DFS hits new death states → save them at depth d+1.
 *
 * === Key properties ===
 *
 * - BFS-by-depth guarantees the first solution found uses the MINIMUM
 *   number of revives (optimal).
 * - globalVisited (stateKey → depth) prevents re-exploring any state
 *   from a worse (higher) death depth.
 * - Non-death intermediate states are never re-explored across depths.
 *
 * @module solver-death-checkpoint
 */

import { OfflineGame } from './offline-game.js';
import { type SolverResult, type ReviveStep } from './types.js';

// ═══════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════

interface ReviveAction {
  dockTileId: number;
  deskTileIds: [number, number];
  color: number;
}

interface DeathEntry {
  game: OfflineGame;
  /** Clicks that led to this death state */
  picksToDeath: number[];
}

// ═══════════════════════════════════════════════════
//  Main entry point
// ═══════════════════════════════════════════════════

export function solveDeathCheckpoint(
  game: OfflineGame,
  opts: {
    maxStates?: number;
    timeoutMs?: number;
  } = {},
): SolverResult {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxStates = opts.maxStates ?? 10_000_000;
  const totalStart = performance.now();
  let totalStates = 0;

  // ── Data structures ──

  /** deathQueues[d] = death states reached at exactly depth d */
  const deathQueues: DeathEntry[][] = [];
  deathQueues[0] = [];

  /**
   * globalVisited: stateKey → best (lowest) death depth at which
   * this state was reached. A state reached at depth 2 is strictly
   * worse than the same state reached at depth 1 — we prune.
   */
  const globalVisited = new Map<string, number>();

  /** The winning revive steps (populated on success) */
  let winReviveDepth = -1;
  const winReviveSteps: ReviveStep[] = [];
  const winPicks: number[] = [];

  // ── Timeout / limit guards ──

  function exhausted(): boolean {
    if (performance.now() - totalStart > timeoutMs) return true;
    if (totalStates > maxStates) return true;
    return false;
  }

  function timeoutReason(): string {
    if (totalStates > maxStates) return `State limit reached (${maxStates})`;
    return `Timeout (${timeoutMs}ms)`;
  }

  // ═══════════════════════════════════════════════════
  //  DFS (no revives — revive budget already consumed
  //  to reach this state)
  // ═══════════════════════════════════════════════════

  /**
   * Standard DFS with 0 revive budget.
   * On isDead: saves the state into deathQueues[currentDepth],
   *            then backtracks (does NOT return false immediately).
   * On isWin:  records the winning path and returns true.
   */
  function dfs(
    g: OfflineGame,
    /** Which death-depth bucket new deaths belong to */
    currentDepth: number,
    picks: number[],
    reviveSteps: ReviveStep[],
  ): boolean {
    totalStates++;
    if (exhausted()) return false;

    // ── Terminal ──
    if (g.isWin) {
      winReviveDepth = currentDepth;
      winReviveSteps.length = 0;
      winReviveSteps.push(...reviveSteps);
      winPicks.length = 0;
      winPicks.push(...picks);
      return true;
    }

    // ── Global visited (by death depth) ──
    const baseKey = g.buildStateKey();
    const prevDepth = globalVisited.get(baseKey);
    if (prevDepth !== undefined && prevDepth <= currentDepth) {
      return false; // already visited at same or better depth
    }
    globalVisited.set(baseKey, currentDepth);

    // ── Death: save snapshot, backtrack ──
    if (g.isDead) {
      if (!deathQueues[currentDepth]) deathQueues[currentDepth] = [];
      deathQueues[currentDepth].push({
        game: g.clone(),
        picksToDeath: [...picks],
      });
      return false;
    }

    // ── Normal play ──
    const actions = orderActions(g);
    if (actions.length === 0) return false;

    for (const tileId of actions) {
      const next = g.clone();
      const tile = next.allTiles.get(tileId);
      if (!tile || !tile.isClickable) continue;

      next.collect(tile);
      picks.push(tileId);

      if (dfs(next, currentDepth, picks, reviveSteps)) return true;

      picks.pop();
    }

    return false;
  }

  // ═══════════════════════════════════════════════════
  //  Phase 0: DFS from root (death depth 0)
  // ═══════════════════════════════════════════════════

  const root = game.clone();
  if (dfs(root, 0, [], [])) {
    return {
      win: true,
      failReason: null,
      picks: [...winPicks],
      stepCount: winPicks.length,
      deadStates: [],
      statesVisited: totalStates,
      elapsedMs: performance.now() - totalStart,
      minRevives: 0,
      reviveSteps: [],
    };
  }

  // ── If no death states at all, truly unsolvable ──
  if (deathQueues[0].length === 0) {
    return {
      win: false,
      failReason: exhausted()
        ? timeoutReason()
        : 'DFS exhausted; no death states found (board may be dependency-deadlocked)',
      picks: [],
      stepCount: 0,
      deadStates: [],
      statesVisited: totalStates,
      elapsedMs: performance.now() - totalStart,
      minRevives: -1,
    };
  }

  // ═══════════════════════════════════════════════════
  //  Phase 1+: BFS over death depths
  // ═══════════════════════════════════════════════════

  const MAX_DEATH_DEPTH = 50;

  for (let d = 0; d < MAX_DEATH_DEPTH; d++) {
    if (exhausted()) {
      return {
        win: false,
        failReason: `超时，已搜索到死亡深度 ${d}`,
        picks: [],
        stepCount: 0,
        deadStates: [],
        statesVisited: totalStates,
        elapsedMs: performance.now() - totalStart,
        minRevives: -1,
      };
    }

    const queue = deathQueues[d];
    if (!queue || queue.length === 0) {
      // No death states at this depth → can't progress further
      return {
        win: false,
        failReason: exhausted()
          ? timeoutReason()
          : `所有分支在死亡深度 ${d} 耗尽，最少需 >${d} 次复活`,
        picks: [],
        stepCount: 0,
        deadStates: [],
        statesVisited: totalStates,
        elapsedMs: performance.now() - totalStart,
        minRevives: -1,
      };
    }

    // Ensure the NEXT depth bucket exists
    if (!deathQueues[d + 1]) deathQueues[d + 1] = [];

    for (let i = 0; i < queue.length; i++) {
      if (exhausted()) break;

      const entry = queue[i];
      const reviveActions = generateReviveActions(entry.game);

      for (const ra of reviveActions) {
        if (exhausted()) break;

        const next = entry.game.clone();
        next.revive(ra.dockTileId, ra.deskTileIds[0], ra.deskTileIds[1]);

        const reviveStep: ReviveStep = {
          stepIndex: entry.picksToDeath.length,
          dockTileId: ra.dockTileId,
          deskTileIds: ra.deskTileIds,
          color: ra.color,
        };

        const childPicks: number[] = [];
        const childReviveSteps: ReviveStep[] = [reviveStep];

        if (dfs(next, d + 1, childPicks, childReviveSteps)) {
          // Win!  Combine paths: picksToDeath + childPicks
          const fullPicks = [...entry.picksToDeath, ...winPicks];
          const fullReviveSteps = [reviveStep, ...winReviveSteps];
          return {
            win: true,
            failReason: null,
            picks: fullPicks,
            stepCount: fullPicks.length + fullReviveSteps.length,
            deadStates: [],
            statesVisited: totalStates,
            elapsedMs: performance.now() - totalStart,
            minRevives: d + 1,
            reviveSteps: fullReviveSteps,
          };
        }
      }
    }
  }

  return {
    win: false,
    failReason: `已搜索到死亡深度上限 ${MAX_DEATH_DEPTH}`,
    picks: [],
    stepCount: 0,
    deadStates: [],
    statesVisited: totalStates,
    elapsedMs: performance.now() - totalStart,
    minRevives: -1,
  };
}

// ═══════════════════════════════════════════════════
//  Action ordering (same heuristic as solver-dfs)
// ═══════════════════════════════════════════════════

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
//  Revive action generation
// ═══════════════════════════════════════════════════

function generateReviveActions(game: OfflineGame): ReviveAction[] {
  const dockByColor = new Map<number, number[]>();
  for (const t of game.dockTiles) {
    const list = dockByColor.get(t.elementValue);
    if (list) list.push(t.id);
    else dockByColor.set(t.elementValue, [t.id]);
  }

  const deskByColor = new Map<number, number[]>();
  for (const t of game.deskTiles) {
    const list = deskByColor.get(t.elementValue);
    if (list) list.push(t.id);
    else deskByColor.set(t.elementValue, [t.id]);
  }

  const actions: ReviveAction[] = [];

  for (const [color, dockIds] of dockByColor) {
    const deskIds = deskByColor.get(color);
    if (!deskIds || deskIds.length < 2) continue;

    const dockId = dockIds[0]; // only one per color (same resulting state)

    for (let i = 0; i < deskIds.length; i++) {
      for (let j = i + 1; j < deskIds.length; j++) {
        actions.push({
          dockTileId: dockId,
          deskTileIds: [deskIds[i], deskIds[j]],
          color,
        });
      }
    }
  }

  actions.sort((a, b) => {
    const aDesk = (deskByColor.get(a.color) ?? []).length;
    const bDesk = (deskByColor.get(b.color) ?? []).length;
    const aExact2 = aDesk === 2 ? 0 : 1;
    const bExact2 = bDesk === 2 ? 0 : 1;
    if (aExact2 !== bExact2) return aExact2 - bExact2;
    const aDock = (dockByColor.get(a.color) ?? []).length;
    const bDock = (dockByColor.get(b.color) ?? []).length;
    return bDock - aDock;
  });

  return actions;
}
