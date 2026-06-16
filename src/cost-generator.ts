/**
 * Cost 数组随机生成器。
 *
 * 约束: r_i = r_{i-1} + c_i - 3,  r_0 = 0, r_N = 0
 *       等价于 Σc_i = 3N（均值恒为 3）
 *       1 ≤ c_i ≤ 8,  r ≥ 0 始终
 *
 * 通过"中性交换"（c_i--, c_j++）在不破坏约束的前提下调整标准差。
 * 入参仅需长度 N 和目标标准差 σ。
 */

import { mulberry32 } from './random-utils.js';

function shuffle<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/** 计算标准差 */
function computeStd(arr: number[]): number {
  const mean = 3; // 恒为 3
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

/** 计算 r-chain: r_0=0, r_i = r_{i-1} + c_i - 3 */
function computeRChain(arr: number[]): number[] {
  const rs = [0];
  for (const c of arr) {
    rs.push(rs[rs.length - 1] + c - 3);
  }
  return rs;
}

/** 检查整个 chain 是否合法: r ≥ 0 且能回到 0 */
function isValid(arr: number[]): boolean {
  let r = 0;
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i];
    if (c < 1 || c > 8) return false;
    r = r + c - 3;
    if (r < 0) return false;
    // 能否在剩余步数内回到 0: r ≤ 2 × 剩余步数
    if (r > 2 * (arr.length - 1 - i)) return false;
  }
  return r === 0;
}

/**
 * 生成一个满足约束的 cost 数组。
 *
 * @param N - 数组长度（= 自由牌 ÷ 3）
 * @param targetStd - 目标标准差
 * @param seed - 随机种子
 * @param maxIter - 最大交换迭代次数
 */
export function generateCostArray(
  N: number,
  targetStd: number,
  seed: number = Date.now() & 0x7fffffff,
  maxIter: number = 2000
): number[] {
  const rng = mulberry32(seed);

  // Step 1: 初始化为全 3（σ = 0, r 恒为 0）
  const arr = new Array(N).fill(3);

  // 如果目标 σ 接近 0，直接返回
  if (targetStd <= 0.05) return arr;

  // Step 2: 随机散射 — 先创建方差，再进行精调
  // 做 N 次随机中性交换，确保至少有一些方差
  for (let scatter = 0; scatter < N * 2; scatter++) {
    const hi = Math.floor(rng() * N);
    const lo = Math.floor(rng() * N);
    if (hi === lo || arr[hi] <= 1 || arr[lo] >= 8) continue;
    const candidate = [...arr];
    candidate[hi] -= 1;
    candidate[lo] += 1;
    if (isValid(candidate)) {
      arr[hi] = candidate[hi];
      arr[lo] = candidate[lo];
    }
  }

  // Step 3: 中性交换精调标准差
  // c_i--, c_j++ 保持 Σc 不变，增加 σ
  // c_i++, c_j-- 减少 σ
  let best = [...arr];
  let bestStd = computeStd(best);

  for (let iter = 0; iter < maxIter; iter++) {
    const currentStd = computeStd(best);
    if (Math.abs(currentStd - targetStd) <= 0.1) break;

    const needMore = currentStd < targetStd;

    // 收集可减 (c > 1) 和可增 (c < 8) 的位置
    const canDecrease: number[] = [];
    const canIncrease: number[] = [];
    for (let i = 0; i < best.length; i++) {
      if (best[i] > 1) canDecrease.push(i);
      if (best[i] < 8) canIncrease.push(i);
    }

    if (canDecrease.length === 0 || canIncrease.length === 0) break;

    shuffle(canDecrease, rng);
    shuffle(canIncrease, rng);

    let found = false;
    for (const hi of canDecrease) {
      for (const lo of canIncrease) {
        if (hi === lo) continue;

        const candidate = [...best];
        if (needMore) {
          // 增大 σ: 让大的更大，小的更小
          if (candidate[hi] <= candidate[lo]) continue;
          candidate[hi] -= 1;
          candidate[lo] += 1;
        } else {
          // 减小 σ: 让大的变小，小的变大
          if (candidate[hi] <= candidate[lo]) continue;
          candidate[hi] -= 1;
          candidate[lo] += 1;
        }

        if (isValid(candidate)) {
          const newStd = computeStd(candidate);
          if (Math.abs(newStd - targetStd) < Math.abs(bestStd - targetStd)) {
            best = candidate;
            bestStd = newStd;
            found = true;
            break;
          }
        }
      }
      if (found) break;
    }
    if (!found) break; // 无法继续优化
  }

  return best;
}

/**
 * 快捷生成: 从地形步数推导 N，其余自动。
 *
 * @param steps - 步数（= 自由牌数 ÷ 3）
 * @param targetStd - 目标标准差
 * @param seed - 随机种子（可选）
 */
export function generateForTerrain(
  steps: number,
  targetStd: number,
  seed?: number
): number[] {
  return generateCostArray(steps, targetStd, seed);
}
