/** Latest G1-G11 Replay grade policy shared by the GUI grader and search. */

export interface LatestReplayGradeVerdict {
  grade: number;
  label: string;
  passrate: number;
  passed: boolean;
  reason?: string;
  optimalWinRate: number;
  optimalLossRemainingRatio: number;
  remainingRatioLimit: number;
}

/** G1 is 90-100%; each following grade is the next 10-point sim1 band. */
function gradeBySim1Decile(sim1WinRate: number): number {
  const rate = Math.max(0, Math.min(1, sim1WinRate));
  return Math.min(10, Math.max(1, 10 - Math.floor(rate * 10)));
}

/**
 * G1-G10 use sim1 deciles. G11 overrides the decile when Optimal <=5% and
 * sim1 <=20%. Every accepted G5-G11 board must also have an Optimal loss
 * remaining ratio strictly below the configured shared limit (25% by default).
 */
export function gradeLatestReplayPolicy(
  sim1WinRate: number,
  optimalWinRate: number,
  optimalLossRemainingRatio: number,
  remainingRatioLimit: number = 0.25,
): LatestReplayGradeVerdict {
  if (![sim1WinRate, optimalWinRate, optimalLossRemainingRatio, remainingRatioLimit].every(Number.isFinite)) {
    throw new Error('latest Replay grade metrics must be finite');
  }
  if (remainingRatioLimit <= 0 || remainingRatioLimit > 1) {
    throw new Error('remainingRatioLimit must be within (0,1]');
  }
  const sim1 = Math.max(0, Math.min(1, sim1WinRate));
  const optimal = Math.max(0, Math.min(1, optimalWinRate));
  const remaining = Math.max(0, Math.min(1, optimalLossRemainingRatio));
  const limitLabel = `${(remainingRatioLimit * 100).toFixed(1).replace(/\.0$/, '')}%`;

  if (optimal <= 0.05 && sim1 <= 0.20) {
    const passed = remaining < remainingRatioLimit;
    return {
      grade: 11,
      label: 'G11 · Optimal≤5% / sim1≤20%',
      passrate: sim1,
      passed,
      ...(passed ? {} : {
        reason: `G5-G11 要求 Optimal 败局剩余率 <${limitLabel}，G11 实际 ${(remaining * 100).toFixed(1)}%`,
      }),
      optimalWinRate: optimal,
      optimalLossRemainingRatio: remaining,
      remainingRatioLimit,
    };
  }

  const grade = gradeBySim1Decile(sim1);
  const low = Math.max(0, 1 - grade / 10);
  const high = grade === 1 ? 1 : 1 - (grade - 1) / 10;
  const remainingPassed = grade <= 4 || remaining < remainingRatioLimit;
  return {
    grade,
    label: `G${grade} · sim1 ${(low * 100).toFixed(0)}-${(high * 100).toFixed(0)}%`,
    passrate: sim1,
    passed: remainingPassed,
    ...(remainingPassed ? {} : {
      reason: `G5-G11 要求 Optimal 败局剩余率 <${limitLabel}，G${grade} 实际 ${(remaining * 100).toFixed(1)}%`,
    }),
    optimalWinRate: optimal,
    optimalLossRemainingRatio: remaining,
    remainingRatioLimit,
  };
}
