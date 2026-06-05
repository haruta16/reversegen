/**
 * Death Verification — 轻量一步 lookahead。
 *
 * 不运行完整 DFS。只检查: 从死亡步状态出发，是否存在任何
 * 合法的 tile-click 序列能形成 triple？
 *
 * 算法: BFS 探索点击序列，但不递归（不消除 triple）。
 * 只检查: 在死亡的dock状态下，能否凑出任何3张同色tile？
 *
 * 与DFS的区别:
 *   DFS探索整个消除树 → 百万级状态
 *   本模块只探索"从死亡点到第一个triple" → 百级状态
 *
 * 验证命题: "从死亡点出发，无法形成任何合法triple" → 死亡确定
 */

import type { TerrainTile } from './types.js';

// ═══════════════════════════════════════════════════
//  Lightweight death verifier
// ═══════════════════════════════════════════════════

interface DeathVerifyInput {
  /** All free tiles (with dependencies) */
  tiles: TerrainTile[];
  /** tileId → color */
  elementValues: Map<number, number>;
  /** Which tiles are NOT yet eliminated at the death point */
  remainingTileIds: Set<number>;
  /** Max states to explore */
  maxStates?: number;
}

interface DeathVerifyOutput {
  /** Is death CONFIRMED (no triple possible)? */
  deathConfirmed: boolean;
  /** If not confirmed, a counterexample: click sequence that forms a triple */
  counterexample?: number[];
  /** States explored */
  statesExplored: number;
}

/**
 * Verify death at a specific game state.
 *
 * Does BFS over CLICK sequences (not elimination sequences).
 * A click:
 *   1. Moves tile to dock
 *   2. Releases tiles blocked by it (remaining deps reduced)
 *   3. Checks if any color reaches 3 in dock → triple formed → death disproven
 *   4. If no triple possible from ANY click sequence (dock fills or no clickable) → death confirmed
 *
 * State = (remaining deps, dock contents by color)
 * Only explore UNTIL first triple, not after.
 */
export function verifyDeath(input: DeathVerifyInput): DeathVerifyOutput {
  const { tiles, elementValues, remainingTileIds, maxStates = 10000 } = input;

  const tileMap = new Map<number, TerrainTile>();
  for (const t of tiles) tileMap.set(t.id, t);

  // Initial state
  const initialDeps = new Map<number, Set<number>>();
  for (const t of tiles) {
    if (!remainingTileIds.has(t.id)) continue;
    const rd = new Set<number>();
    for (const d of t.dependencies) {
      if (remainingTileIds.has(d)) rd.add(d);
    }
    initialDeps.set(t.id, rd);
  }

  // Initial freed tiles
  const initialFreed: number[] = [];
  for (const [tid, rd] of initialDeps) {
    if (rd.size === 0) initialFreed.push(tid);
  }

  // BFS state: key = sorted_freed_ids + dock_signature (color→count)
  // But since we only go until first triple, states are small
  const visited = new Set<string>();
  let statesExplored = 0;

  interface BFSState {
    freed: number[];           // clickable tile IDs (sorted)
    dock: Map<number, number>; // color → count in dock
    remainingDeps: Map<number, Set<number>>; // tileId → remaining blockers
  }

  function stateKey(s: BFSState): string {
    return s.freed.join(',') + '|' +
      [...s.dock.entries()].sort((a,b)=>a[0]-b[0]).map(([c,n])=>c+':'+n).join(',');
  }

  // Initialize BFS queue
  const queue: { state: BFSState; clicks: number[] }[] = [];
  const initDock = new Map<number, number>();
  const initState: BFSState = { freed: initialFreed, dock: initDock, remainingDeps: initialDeps };
  queue.push({ state: initState, clicks: [] });

  while (queue.length > 0 && statesExplored < maxStates) {
    const { state, clicks } = queue.shift()!;
    statesExplored++;

    const key = stateKey(state);
    if (visited.has(key)) continue;
    visited.add(key);

    // Check: is any color at 2 in dock? If so, clicking a 3rd would form triple
    // → check if any freed tile would complete a triple
    for (const tid of state.freed) {
      const color = elementValues.get(tid) ?? 0;
      const dockCount = state.dock.get(color) ?? 0;
      if (dockCount >= 2) {
        // Clicking this tile forms a triple → death disproven
        return {
          deathConfirmed: false,
          counterexample: [...clicks, tid],
          statesExplored,
        };
      }
    }

    // Check: dock full?
    let totalDock = 0;
    for (const [,n] of state.dock) totalDock += n;
    if (totalDock >= 7) continue; // death — no more clicks possible

    // No clickable tiles?
    if (state.freed.length === 0) continue; // death

    // Branch: click each freed tile
    for (const tid of state.freed) {
      const color = elementValues.get(tid) ?? 0;

      // New state after clicking tid
      const newFreed = state.freed.filter(fid => fid !== tid); // tid leaves freed set
      const newDock = new Map(state.dock);
      newDock.set(color, (newDock.get(color) ?? 0) + 1);

      // Check: does dock now have 3 same-color? → triple formed!
      if ((newDock.get(color) ?? 0) >= 3) {
        return {
          deathConfirmed: false,
          counterexample: [...clicks, tid],
          statesExplored,
        };
      }

      // Release tiles blocked by tid
      const newDeps = new Map(state.remainingDeps);
      const newlyFreed: number[] = [];
      for (const [rtid, rd] of newDeps) {
        if (rd.delete(tid) && rd.size === 0) {
          newlyFreed.push(rtid);
        }
      }

      const nextFreed = [...newFreed, ...newlyFreed].sort((a,b) => a-b);
      const nextState: BFSState = { freed: nextFreed, dock: newDock, remainingDeps: newDeps };

      queue.push({ state: nextState, clicks: [...clicks, tid] });
    }
  }

  // Exhausted queue without finding a triple → death confirmed
  return { deathConfirmed: true, statesExplored };
}

// ═══════════════════════════════════════════════════
//  Quick test
// ═══════════════════════════════════════════════════

// Direct run test
if (process.argv[1]?.endsWith('verify-death.ts') || process.argv[1]?.endsWith('verify-death.js')) {
  console.log('Death Verifier — lightweight 1-step lookahead');
  console.log('Import from generate-v4 to use.');
}
