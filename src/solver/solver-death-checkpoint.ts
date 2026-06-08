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
 * === Memory safety ===
 *
 * - maxDeathStates caps the number of death snapshots stored per depth
 *   (each holds a full OfflineGame clone → major memory consumer)
 * - maxReviveActions caps revive combos per death state
 *   (prevents combinatorial explosion when many same-color desk tiles exist)
 *
 * @module solver-death-checkpoint
 */

import { OfflineGame } from './offline-game.js';
import { type SolverResult, type ReviveStep } from './types.js';
import { orderActions } from './solver-dfs.js';

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
  /** FULL click path from root to this death state */
  picksToDeath: number[];
  /** ALL revive steps applied to reach this death state */
  reviveStepsToDeath: ReviveStep[];
}

// ═══════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════

/** Max death snapshots stored per depth. Each holds a full OfflineGame clone.
 *  Beyond this limit new deaths are counted but NOT stored (search becomes incomplete). */
const DEFAULT_MAX_DEATH_STATES = 5000;

/** Max revive actions enumerated per death state.
 *  Without this cap, a color with N desk tiles produces C(N,2) actions. */
const DEFAULT_MAX_REVIVE_ACTIONS = 100;

// ═══════════════════════════════════════════════════
//  Main entry point
// ═══════════════════════════════════════════════════

export function solveDeathCheckpoint(
  game: OfflineGame,
  opts: {
    maxStates?: number;
    timeoutMs?: number;
    /** Max death snapshots stored per depth (default 5000) */
    maxDeathStates?: number;
    /** Max revive actions enumerated per death state (default 100) */
    maxReviveActions?: number;
  } = {},
): SolverResult {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxStates = opts.maxStates ?? 10_000_000;
  const maxDeathStates = opts.maxDeathStates ?? DEFAULT_MAX_DEATH_STATES;
  const maxReviveActions = opts.maxReviveActions ?? DEFAULT_MAX_REVIVE_ACTIONS;
  const totalStart = performance.now();
  let totalStates = 0;

  // ── Data structures ──

  /** deathQueues[d] = death states reached at exactly depth d */
  const deathQueues: DeathEntry[][] = [];
  deathQueues[0] = [];

  /** Total death states FOUND (including those beyond maxDeathStates that were dropped) */
  let totalDeathStatesFound = 0;
  /** Number of death states dropped due to maxDeathStates cap */
  let deathStatesDropped = 0;

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
    if (totalStates > maxStates) return `状态数超限 (${maxStates})`;
    return `超时 (${timeoutMs / 1000}s)`;
  }

  // ═══════════════════════════════════════════════════
  //  DFS (no revives — revive budget already consumed
  //  to reach this state)
  // ═══════════════════════════════════════════════════

  /**
   * Standard DFS with 0 revive budget.
   *
   * On isDead: saves the state into deathQueues[currentDepth] with FULL paths,
   *            then backtracks.  If the queue is at capacity, the death is
   *            counted but NOT stored (search becomes incomplete at this depth).
   * On isWin:  records the FULL winning path (prefix + current) and returns true.
   */
  function dfs(
    g: OfflineGame,
    currentDepth: number,
    picks: number[],
    reviveSteps: ReviveStep[],
    prefixPicks: number[],
    prefixRevives: ReviveStep[],
  ): boolean {
    totalStates++;
    if (exhausted()) return false;

    // ── Terminal ──
    if (g.isWin) {
      winReviveDepth = currentDepth;
      winReviveSteps.length = 0;
      winReviveSteps.push(...prefixRevives);
      winReviveSteps.push(...reviveSteps);
      winPicks.length = 0;
      winPicks.push(...prefixPicks);
      winPicks.push(...picks);
      return true;
    }

    // ── Global visited (by death depth) ──
    const baseKey = g.buildStateKey();
    const prevDepth = globalVisited.get(baseKey);
    if (prevDepth !== undefined && prevDepth <= currentDepth) {
      return false;
    }
    globalVisited.set(baseKey, currentDepth);

    // ── Death: save snapshot (if under cap), backtrack ──
    if (g.isDead) {
      if (!deathQueues[currentDepth]) deathQueues[currentDepth] = [];
      totalDeathStatesFound++;

      if (deathQueues[currentDepth].length < maxDeathStates) {
        deathQueues[currentDepth].push({
          game: g.clone(),
          picksToDeath: [...prefixPicks, ...picks],
          reviveStepsToDeath: [...prefixRevives],
        });
      } else {
        deathStatesDropped++;
      }
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

      if (dfs(next, currentDepth, picks, reviveSteps, prefixPicks, prefixRevives)) return true;

      picks.pop();
    }

    return false;
  }

  // ═══════════════════════════════════════════════════
  //  Phase 0: DFS from root (death depth 0)
  // ═══════════════════════════════════════════════════

  const root = game.clone();
  if (dfs(root, 0, [], [], [], [])) {
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
  if (deathQueues[0].length === 0 && totalDeathStatesFound === 0) {
    return {
      win: false,
      failReason: exhausted()
        ? timeoutReason()
        : 'DFS 耗尽，未发现任何死亡状态（牌局可能存在依赖死锁）',
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
      return buildFailResult(
        `${timeoutReason()}，已搜索到死亡深度 ${d}`,
        totalStates, totalStart,
      );
    }

    const queue = deathQueues[d];
    if (!queue || queue.length === 0) {
      const truncatedNote = deathStatesDropped > 0
        ? `（注：因内存限制，${deathStatesDropped} 个死亡状态未被存储，搜索结果可能不完整）`
        : '';
      return buildFailResult(
        exhausted()
          ? timeoutReason()
          : `死亡深度 ${d} 无可用状态（深度 ${d - 1} 的所有复活分支已穷尽），最少需 >${d} 次复活${truncatedNote}`,
        totalStates, totalStart,
      );
    }

    // Ensure the NEXT depth bucket exists
    if (!deathQueues[d + 1]) deathQueues[d + 1] = [];

    let unrevivableCount = 0;
    let revivedCount = 0;
    const depthDroppedBefore = deathStatesDropped;

    for (let i = 0; i < queue.length; i++) {
      if (exhausted()) break;

      const entry = queue[i];
      const reviveActions = generateReviveActions(entry.game, maxReviveActions);

      if (reviveActions.length === 0) {
        unrevivableCount++;
        continue;
      }

      for (const ra of reviveActions) {
        if (exhausted()) break;

        const next = entry.game.clone();
        try {
          next.revive(ra.dockTileId, ra.deskTileIds[0], ra.deskTileIds[1]);
        } catch (_err) {
          continue;
        }

        revivedCount++;

        const reviveStep: ReviveStep = {
          stepIndex: entry.picksToDeath.length,
          dockTileId: ra.dockTileId,
          deskTileIds: ra.deskTileIds,
          color: ra.color,
        };

        const childPicks: number[] = [];
        const childReviveSteps: ReviveStep[] = [];
        const prefixRevives = [...entry.reviveStepsToDeath, reviveStep];

        if (dfs(next, d + 1, childPicks, childReviveSteps, entry.picksToDeath, prefixRevives)) {
          return {
            win: true,
            failReason: null,
            picks: [...winPicks],
            stepCount: winPicks.length + winReviveSteps.length,
            deadStates: [],
            statesVisited: totalStates,
            elapsedMs: performance.now() - totalStart,
            minRevives: winReviveDepth,
            reviveSteps: [...winReviveSteps],
          };
        }
      }
    }

    // ── Free depth d clones for GC (no longer needed) ──
    deathQueues[d] = undefined!;

    // ── Post-depth diagnostics ──
    if (deathQueues[d + 1].length === 0) {
      const totalInQueue = queue.length;
      const newDropped = deathStatesDropped - depthDroppedBefore;
      const truncatedNote = newDropped > 0
        ? `（注：深度 ${d + 1} 的 DFS 中 ${newDropped} 个死亡状态因内存限制未存储）`
        : '';

      if (unrevivableCount === totalInQueue) {
        return buildFailResult(
          `死亡深度 ${d}: 全部 ${totalInQueue} 个死亡状态均无可用复活动作（Dock 中无可配对的 Desk 同色牌对）`,
          totalStates, totalStart,
        );
      }
      if (revivedCount === 0 && unrevivableCount === 0) {
        return buildFailResult(
          `死亡深度 ${d}: ${totalInQueue} 个死亡状态均无法产生复活动作`,
          totalStates, totalStart,
        );
      }
      // Had revive actions but none led to a solution or new deaths
      return buildFailResult(
        `死亡深度 ${d}: ${totalInQueue} 个死亡状态的所有复活动作均未找到解或新死亡状态${truncatedNote}`,
        totalStates, totalStart,
      );
    }
  }

  const truncatedNote = deathStatesDropped > 0
    ? `（${deathStatesDropped} 个死亡状态因内存限制未存储）`
    : '';
  return buildFailResult(
    `已搜索到死亡深度上限 ${MAX_DEATH_DEPTH}${truncatedNote}`,
    totalStates, totalStart,
  );
}

// ═══════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════

function buildFailResult(
  failReason: string,
  statesVisited: number,
  totalStart: number,
): SolverResult {
  return {
    win: false,
    failReason,
    picks: [],
    stepCount: 0,
    deadStates: [],
    statesVisited,
    elapsedMs: performance.now() - totalStart,
    minRevives: -1,
  };
}

// ═══════════════════════════════════════════════════
//  Revive action generation
// ═══════════════════════════════════════════════════

/**
 * Generate legal revive actions from a death state.
 *
 * Actions are sorted: prefer colors with exactly 2 desk tiles (clean elimination),
 * then by dock count descending (clear dock pressure).
 *
 * @param game  Death state (dock full)
 * @param limit Max actions to return (default: no limit)
 */
function generateReviveActions(game: OfflineGame, limit?: number): ReviveAction[] {
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
        // Early break if we hit the per-color limit
        if (limit !== undefined && actions.length >= limit) break;
      }
      if (limit !== undefined && actions.length >= limit) break;
    }
    if (limit !== undefined && actions.length >= limit) break;
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

  return limit !== undefined ? actions.slice(0, limit) : actions;
}
