/**
 * LayerClosure · 花色配额模块。
 *
 * 负责把总 triplet 组数按模式分配到各花色（balanced / single-heavy）。
 */

import type { ColorAllocationMode } from '../types.js';

/**
 * 将 totalTriplets 组牌按 mode 分配给 colorCount 种花色。
 *
 * - balanced: 均匀分配，每色约 totalTriplets / colorCount 组，余数摊给前几个花色。
 * - single-heavy: 随机选一个主花色，其余 K-1 色各 1 组，主花色获得 T-K+1 组。
 *
 * 返回值是每色 tile 数（triplet 数 × 3）。
 */
export function assignColorTotals(
  totalTriplets: number,
  colorCount: number,
  mode: ColorAllocationMode = 'balanced',
  rng: () => number = Math.random,
  maxHeavyRatio?: number,
): number[] {
  if (colorCount > totalTriplets) {
    if (mode === 'single-heavy' && totalTriplets === colorCount) {
      // 每色只能一组，退化为均匀分配
      return Array.from({ length: colorCount }, () => 3);
    }
    throw new Error(
      `花色数 ${colorCount} 超过可用 triplet 组数 ${totalTriplets}，无法分配`,
    );
  }

  if (mode === 'single-heavy') {
    // 随机选一个主花色；限制主色后，剩余组数在其他花色间均分。
    const heavyColor = Math.floor(rng() * colorCount);
    const unconstrainedHeavy = totalTriplets - colorCount + 1;
    const ratio = maxHeavyRatio == null ? 1 : Math.max(0, Math.min(1, maxHeavyRatio));
    const cappedHeavy = Math.floor(totalTriplets * ratio);
    const heavyTriplets = colorCount === 1
      ? totalTriplets
      : Math.max(1, Math.min(unconstrainedHeavy, cappedHeavy));
    const rest = totalTriplets - heavyTriplets;
    const otherBase = colorCount > 1 ? Math.floor(rest / (colorCount - 1)) : 0;
    let otherExtra = colorCount > 1 ? rest % (colorCount - 1) : 0;
    const result: number[] = [];
    for (let c = 0; c < colorCount; c++) {
      if (c === heavyColor) {
        result.push(heavyTriplets * 3);
      } else {
        result.push((otherBase + (otherExtra-- > 0 ? 1 : 0)) * 3);
      }
    }
    return result;
  }

  // balanced (默认)
  const base = Math.floor(totalTriplets / colorCount);
  const extra = totalTriplets % colorCount;
  const result: number[] = [];
  for (let c = 0; c < colorCount; c++) {
    result.push((base + (c < extra ? 1 : 0)) * 3);
  }
  return result;
}
