/**
 * Winning-path diversity for repeated robot simulations.
 *
 * A path is the exact ordered tileId pick sequence of a winning run. Each
 * quarter compares only that interval's picks, rather than the cumulative
 * prefix, so an unchanged count means that interval itself has the same
 * number of distinct click sequences.
 */

export interface SimulationPathResult {
  win: boolean;
  picks: number[];
}

export interface WinningPathInterval {
  startProgress: 0 | 25 | 50 | 75;
  endProgress: 25 | 50 | 75 | 100;
  uniqueSegments: number;
}

export interface WinningPathAnalysis {
  runs: number;
  wins: number;
  losses: number;
  uniqueWinningPaths: number;
  intervals: WinningPathInterval[];
}

const INTERVALS = [
  [0, 25],
  [25, 50],
  [50, 75],
  [75, 100],
] as const;

function pathKey(picks: number[]): string {
  return JSON.stringify(picks);
}

export function analyzeWinningPaths(
  results: readonly SimulationPathResult[],
  totalRuns: number = results.length,
): WinningPathAnalysis {
  const winningPaths = results.filter(result => result.win).map(result => result.picks);

  const intervals = INTERVALS.map(([startProgress, endProgress]) => {
    const segments = new Set<string>();
    for (const path of winningPaths) {
      const start = Math.ceil(path.length * startProgress / 100);
      const end = Math.ceil(path.length * endProgress / 100);
      segments.add(pathKey(path.slice(start, end)));
    }
    const interval: WinningPathInterval = {
      startProgress,
      endProgress,
      uniqueSegments: segments.size,
    };
    return interval;
  });

  const wins = winningPaths.length;
  return {
    runs: totalRuns,
    wins,
    losses: Math.max(0, totalRuns - wins),
    uniqueWinningPaths: new Set(winningPaths.map(pathKey)).size,
    intervals,
  };
}
