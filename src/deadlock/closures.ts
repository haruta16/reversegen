/**
 * 三消闭包 —— 必死判据核心（对齐 DAG理论完整证明.md §2）。
 *
 * closure_direct_chosen(c)：
 *   色 c 的 3 张牌 + 它们在「所选牌直接依赖子图」中的全部传递依赖的并集大小。
 *   「直接依赖子图」= 把依赖边限定为两端都在所选集合内的地形直接依赖边。
 *
 * 判据（§2 定理 2.2 在嵌入场景的等价形式）：
 *   ∀色 闭包 ≥ 8 ⇔ 纯玩法下第 7 张所选牌入槽必死（外部牌穿插亦不破）。
 *   论证：前 k 张所选牌构成的集合 S_k 恒为所选子图的序理想（所选牌可收集
 *   ⇒ 其全部所选依赖已收集）；闭包 ≥ 8 ⇒ 任意 |S_k| ≤ 7 不含完整三色组；
 *   第 7 张入槽时 n≥4 色、每色 ≤2 ⇒ 占用恰 = 7 ⇒ 死亡。
 *
 * 注意：闭包必须在「直接依赖子图」上计算，不能用传递可达代替——模板边若
 * 穿过外部牌（可达包含口径允许），它不构成所选子图内的依赖，不会贡献闭包。
 */

export interface ClosureInput {
  /** 所选 tileId 集合（3n 张） */
  chosenIds: Set<number>;
  /** tileId → 直接依赖（地形全量） */
  depsOf: Map<number, number[]>;
  /** tileId → 花色（模板色号，0 起；仅所选牌需要条目） */
  colorOf: Map<number, number>;
}

/**
 * 逐色三消闭包大小。
 * 对每个所选 tile 做「所选子图可达后代」BFS（边 = 两端均在 chosen 的直接依赖），
 * 再按花色求并集大小。
 */
export function colorClosures(input: ClosureInput): Map<number, number> {
  const { chosenIds, depsOf, colorOf } = input;

  // 所选子图可达后代（含自身）
  const reach = new Map<number, Set<number>>();
  for (const id of chosenIds) {
    const seen = new Set<number>();
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const dep of depsOf.get(cur) ?? []) {
        if (chosenIds.has(dep) && !seen.has(dep)) stack.push(dep);
      }
    }
    reach.set(id, seen);
  }

  // 逐色并集
  const unionSets = new Map<number, Set<number>>();
  for (const [id, color] of colorOf) {
    if (!chosenIds.has(id)) continue;
    let union = unionSets.get(color);
    if (!union) {
      union = new Set<number>();
      unionSets.set(color, union);
    }
    for (const r of reach.get(id) ?? [id]) union.add(r);
  }

  const result = new Map<number, number>();
  for (const [color, set] of unionSets) result.set(color, set.size);
  return result;
}

/** 必死判据：全部色闭包 ≥ 8。 */
export function isGuaranteedDead(closures: Map<number, number>): boolean {
  if (closures.size === 0) return false;
  for (const size of closures.values()) {
    if (size < 8) return false;
  }
  return true;
}

/**
 * 核心骨架的闭包门槛（wildcard 完成前）：
 * 完整闭包 = 核心闭包 + 该色尚未分配的 wildcard 数（每个 wildcard 至少贡献自身），
 * 故核心门槛 = 8 − wildcardCount(色)。
 */
export function coreMeetsThreshold(
  coreClosures: Map<number, number>,
  wildcardColorCounts: Map<number, number>,
): boolean {
  for (const [color, size] of coreClosures) {
    const threshold = 8 - (wildcardColorCounts.get(color) ?? 0);
    if (size < threshold) return false;
  }
  return coreClosures.size > 0;
}
