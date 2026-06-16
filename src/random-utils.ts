/**
 * 确定性随机数工具。
 *
 * Mulberry32 — 高速 32 位种子 PRNG。
 * 同一种子始终产生相同的随机数序列，保证跨平台（JS/C#）可复现。
 *
 * 全项目唯一实现，避免分散在各模块中的重复定义。
 */

/** 返回一个 [0, 1) 的确定性随机数生成器 */
export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
