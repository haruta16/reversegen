/**
 * LayerClosure · 花色配额模块。
 *
 * 负责把总 triplet 组数按模式分配到各花色（balanced / single-heavy），
 * 以及为“先生成唯一三元组、再整组改色”的 single-heavy 流程生成改色计划。
 */

import type { ColorAllocationMode } from '../types.js';

export interface SingleHeavyTripletPlan {
  /** 源花色（1..totalTriplets）到最终花色（1..colorCount）的映射。 */
  colorBySourceTriplet: number[];
  /** 最终主花色（1-based）。 */
  heavyColor: number;
  /** 目标比例换算出的主色组数；可能因保留目标花色数而下调。 */
  requestedHeavyTriplets: number;
  /** 最终实际主色组数。 */
  heavyTriplets: number;
  /** 最终每种花色的三元组数。 */
  colorTripletCounts: number[];
}

function shuffleInPlace<T>(values: T[], rng: () => number): void {
  for (let index = values.length - 1; index > 0; index--) {
    const sample = Math.max(0, Math.min(0.9999999999999999, rng()));
    const swap = Math.floor(sample * (index + 1));
    [values[index], values[swap]] = [values[swap], values[index]];
  }
}

/**
 * 为最大花色牌局生成整组三元组改色计划。
 *
 * 初始牌局中每个三元组各用一种花色（共 totalTriplets 种）。先随机挑选
 * 目标比例的三元组覆盖为主色，再从剩余三元组随机保留 K-1 个锚点花色，
 * 其余三元组随机替换为某个锚点花色。这样既保留“全局随机选三元组/花色”
 * 的语义，也能保证最终恰好使用
 * colorCount 种花色，且每种花色牌数仍为 3 的倍数。
 */
export function buildSingleHeavyTripletPlan(
  totalTriplets: number,
  colorCount: number,
  targetRatio: number = 1,
  rng: () => number = Math.random,
): SingleHeavyTripletPlan {
  if (!Number.isInteger(totalTriplets) || totalTriplets < 1) {
    throw new Error(`triplet 组数必须是正整数，收到 ${totalTriplets}`);
  }
  if (!Number.isInteger(colorCount) || colorCount < 1) {
    throw new Error(`花色数必须是正整数，收到 ${colorCount}`);
  }
  if (colorCount > totalTriplets) {
    throw new Error(`花色数 ${colorCount} 超过可用 triplet 组数 ${totalTriplets}，无法分配`);
  }
  if (!Number.isFinite(targetRatio) || targetRatio <= 0 || targetRatio > 1) {
    throw new Error(`主色目标占比必须在 0 到 1 之间，收到 ${targetRatio}`);
  }

  const requestedHeavyTriplets = Math.max(1, Math.ceil(totalTriplets * targetRatio));
  // 除主色外，每个目标花色至少保留一组；比例过高时主色取可行最大值。
  const maxHeavyTriplets = totalTriplets - colorCount + 1;
  const heavyTriplets = Math.min(requestedHeavyTriplets, maxHeavyTriplets);
  const sourceColors = Array.from({ length: totalTriplets }, (_, index) => index + 1);
  shuffleInPlace(sourceColors, rng);

  const targetColors = Array.from({ length: colorCount }, (_, index) => index + 1);
  shuffleInPlace(targetColors, rng);
  const heavyColor = targetColors[0];
  const otherColors = targetColors.slice(1);
  const colorBySourceTriplet = new Array<number>(totalTriplets);
  const colorTripletCounts = new Array<number>(colorCount).fill(0);

  let sourceOffset = 0;
  for (; sourceOffset < heavyTriplets; sourceOffset++) {
    colorBySourceTriplet[sourceColors[sourceOffset] - 1] = heavyColor;
  }
  colorTripletCounts[heavyColor - 1] = heavyTriplets;

  if (otherColors.length > 0) {
    // 每个非主色先随机保留一个锚点三元组，确保最终花色数精确命中。
    for (const color of otherColors) {
      colorTripletCounts[color - 1] = 1;
      colorBySourceTriplet[sourceColors[sourceOffset++] - 1] = color;
    }
    // 剩余三元组不再均衡摊配，而是逐组随机替换到某个已保留的非主色。
    while (sourceOffset < sourceColors.length) {
      const sample = Math.max(0, Math.min(0.9999999999999999, rng()));
      const color = otherColors[Math.floor(sample * otherColors.length)];
      colorBySourceTriplet[sourceColors[sourceOffset++] - 1] = color;
      colorTripletCounts[color - 1] += 1;
    }
  }

  return {
    colorBySourceTriplet,
    heavyColor,
    requestedHeavyTriplets,
    heavyTriplets,
    colorTripletCounts,
  };
}

/**
 * 将 totalTriplets 组牌按 mode 分配给 colorCount 种花色。
 *
 * - balanced: 均匀分配，每色约 totalTriplets / colorCount 组，余数摊给前几个花色。
 * - single-heavy: 按目标比例随机选主花色，剩余三元组随机归并到其他花色。
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
    return buildSingleHeavyTripletPlan(
      totalTriplets,
      colorCount,
      maxHeavyRatio ?? 1,
      rng,
    ).colorTripletCounts.map(count => count * 3);
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
