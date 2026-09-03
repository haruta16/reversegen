/**
 * LayerClosure · 逐层约束满足模块。
 *
 * 每层决策"当前完成 X 组、目标 Y 组 → 还需闭合几组"，在容量与
 * 花色余量约束下构建 M[color][depth] 分配矩阵。
 */

/**
 * 逐层分配。每层做一次简单的决策：
 *   "当前完成了 X 个 triplet，目标是 Y 个 → 需要多完成几个 triplet"
 *
 * 决策在容量（该层方块数）和物理（颜色剩余牌数）约束下进行。
 * 不保证完美命中，但会往目标方向尽力。
 *
 * 闭合率的单位是 triplet（组），不是颜色。花色是手段，闭合率是结果。
 *
 * 兼容旧版的债务持续权重 p 控制"下一层债务中保留多少旧债务 tile"：
 *   目标保留 = round(p × min(本层旧债务 tile 数, 下一层债务 tile 数))
 *   p=0 → 优先闭合旧债务色（清旧债）；p=1 → 优先闭合非债务色（留旧债）。
 *   p 是软目标，closeRate(数量)与 mod3 闭合预算(硬约束)优先。
 * 新版 debtPersistenceLayers 则按后续逻辑层数控制债务持续：达到上限后优先
 * 在当前层闭合；若当层容量/闭合率目标与之冲突，以牌面完整落位为最终硬约束。
 *
 * @returns { matrix, actualCloseRates, retainedOldDebtTilesByLayer }
 */
export function buildMatrixByCloseRates(
  colorTotalTiles: number[],
  freeTilesPerDepth: number[],
  allTilesPerDepth: number[],
  closeRates: number[],
  debtPersistenceWeight: number,
  debtPersistenceLayers?: number,
): { matrix: number[][]; actualCloseRates: number[]; retainedOldDebtTilesByLayer: number[] } {
  const C = colorTotalTiles.length;
  const D = freeTilesPerDepth.length;
  const p = debtPersistenceWeight;
  const maxDebtLayers = debtPersistenceLayers == null
    ? undefined
    : Math.max(0, Math.trunc(debtPersistenceLayers));

  // 活跃颜色（有牌的）
  const active = new Set<number>();
  for (let c = 0; c < C; c++) {
    if (colorTotalTiles[c] > 0) active.add(c);
  }

  // 补全 closeRates
  const fullRates = [...closeRates];
  while (fullRates.length < D) fullRates.push(1.0);

  // 状态追踪
  const cumulative = new Array(C).fill(0); // 已分配数
  const remaining = [...colorTotalTiles];   // 剩余待分配
  const M: number[][] = Array.from({ length: C }, () => new Array(D).fill(0));
  const actualCloseRates: number[] = [];
  const retainedOldDebtTilesByLayer: number[] = [];
  // 债务年龄：刚在上一层产生的债务为 0；每跨过一层仍未闭合则 +1。
  const debtAge = new Array(C).fill(0);

  // 全量累积牌数（用于 P = ⌊全量 ÷ 3⌋，闭合率分母包含 const）
  let allCumulative = 0;

  for (let d = 0; d < D; d++) {
    const capacity = freeTilesPerDepth[d]; // 本层分配容量（仅自由牌）

    // ── 目标完成 triplet 数 ──
    // P = 本层后的 triplet 总数上限（分母：全量累积，含 const）
    const allTilesAfter = allCumulative + allTilesPerDepth[d];
    const P = Math.floor(allTilesAfter / 3);
    const target = d === D - 1
      ? P  // 最后一层：全部完成
      : clamp(Math.round(fullRates[d] * P), 0, P);

    // 当前已完成 triplet 数
    const currentlyCompleted = countCompletedTriplets(cumulative);

    // ── 决策：需要多完成几个 triplet ──
    // 每关闭 1 个颜色 = 完成 1 个 triplet
    const toClose: number[] = []; // 需要完成 triplet 的颜色
    const toOpen: number[] = [];  // 需要"打开"的颜色（target < current 时极少触发）
    const oldDebt = [...active].filter(c => cumulative[c] % 3 !== 0 && remaining[c] > 0);
    const overdueDebt = maxDebtLayers == null
      ? []
      : oldDebt.filter(c => debtAge[c] >= maxDebtLayers);
    const noReopen = new Set(overdueDebt);
    if (maxDebtLayers != null) toClose.push(...overdueDebt);

    if (target > currentlyCompleted) {
      const need = Math.max(0, target - currentlyCompleted - toClose.length);

      // ── 债务持续限制/权重：决定本层闭合哪些旧债务色 ──
      // oldDebtTiles = 进入本层前的旧债务 tile 总数（Σ cum%3，非0项）
      // nextDebtTiles = 本层末债务 tile 总数（累计 tile − 已闭合 tile）
      // targetRetained = round(p × min(oldDebtTiles, nextDebtTiles))
      // oldDebtToClear = oldDebtTiles − targetRetained（本层应清掉的旧债务 tile 数）
      const oldDebtTiles = oldDebt.reduce((s, c) => s + (cumulative[c] % 3), 0);
      const nextDebtTiles = Math.max(0, allTilesAfter - target * 3);
      const targetRetained = Math.round(p * Math.min(oldDebtTiles, nextDebtTiles));
      const oldDebtToClear = Math.max(0, oldDebtTiles - targetRetained);

      // 旧债务色按 r=cum%3 降序（r=2 先清，单色清 2 tile 且只需 1 张牌，性价比高）
      oldDebt.sort((a, b) => (cumulative[b] % 3) - (cumulative[a] % 3));

      // 新版先强制关闭达到最大跨层数的债务；旧版则按权重计算清理目标。
      const toCloseOld: number[] = [];
      let clearedTiles = 0;
      const oldDebtCandidates = (maxDebtLayers == null ? oldDebt : overdueDebt)
        .filter(c => !toClose.includes(c));
      for (const c of oldDebtCandidates) {
        if (toCloseOld.length >= need) break;
        if (maxDebtLayers == null && clearedTiles >= oldDebtToClear) break;
        toCloseOld.push(c);
        clearedTiles += cumulative[c] % 3;
      }

      // 2) 补足 need：优先非债务色（cum%3=0，闭合不动旧债 → 保留旧债）
      //    非债务色需 remaining≥3 才能凑出一个 triplet
      const nonDebt = [...active].filter(c =>
        cumulative[c] % 3 === 0 && remaining[c] >= 3 && !toClose.includes(c) && !toCloseOld.includes(c));
      const toCloseNew: number[] = [];
      for (const c of nonDebt) {
        if (toCloseOld.length + toCloseNew.length >= need) break;
        toCloseNew.push(c);
      }

      // 3) 仍不够（非债务色余量不足）→ 被迫从剩余旧债务色补（动旧债，实际保留 < 目标）
      if (toCloseOld.length + toCloseNew.length < need) {
        for (const c of oldDebt) {
          if (toClose.includes(c) || toCloseOld.includes(c)) continue;
          if (toCloseOld.length + toCloseNew.length >= need) break;
          toCloseOld.push(c);
        }
      }

      toClose.push(...toCloseOld, ...toCloseNew);
    } else if (target < currentlyCompleted) {
      // 已完成的 triplet 无法撤销。target 是软目标，不做状态变更。
      // toOpen 留空，仅通过 safe-fill 填充本层。
    }

    // ── 闭合预算检查：后续容量必须足够闭合所有花色 ──
    // 这是 mod3 硬约束的前瞻保障：确保后续容量足以消除所有不完整 triplet 的债务。
    if (d < D - 1) {
      let projectedDebt = 0;
      for (const c of active) {
        projectedDebt += (3 - (cumulative[c] % 3)) % 3;
      }
      for (const c of toClose) {
        projectedDebt -= closeCost(cumulative[c]);
      }
      for (const _ of toOpen) {
        projectedDebt += 2; // 闭合→开放：产生 2 张牌的债务
      }
      let futureCapacity = 0;
      for (let dd = d + 1; dd < D; dd++) {
        futureCapacity += freeTilesPerDepth[dd];
      }
      if (projectedDebt > futureCapacity) {
        let excess = projectedDebt - futureCapacity;
        const forceCloseCandidates = [...active]
          .filter(c => cumulative[c] % 3 !== 0 && remaining[c] > 0 && !toClose.includes(c))
          .sort((a, b) => closeCost(cumulative[a]) - closeCost(cumulative[b]));
        for (const c of forceCloseCandidates) {
          if (excess <= 0) break;
          excess -= closeCost(cumulative[c]);
          if (!toClose.includes(c)) toClose.push(c);
        }
      }
    }

    // ── 记录本层保留的旧债务 tile 数（实际值，供输出校验）──
    // 在 forceClose 之后计算，计入强制闭合的旧债务色（也算清掉）。
    // d=0 无"进入本层前的旧债"，不计入。
    if (d > 0) {
      let retainedThisLayer = 0;
      for (const c of active) {
        const r = cumulative[c] % 3;
        if (r === 0) continue;
        // 旧债务色：未被 toClose 选中 → 保留全部 r；被选中 → 清 0
        retainedThisLayer += toClose.includes(c) ? 0 : r;
      }
      retainedOldDebtTilesByLayer.push(retainedThisLayer);
    }

    // ── 分配：先满足状态变更，再填满容量 ──
    const plan: number[] = new Array(C).fill(0);
    let used = 0;

    // 第一轮：状态变更的最小需求
    for (const c of toClose) {
      // 完成 1 个 triplet 所需牌数：cum%3=0→3张，cum%3=1→2张，cum%3=2→1张
      const need = (3 - (cumulative[c] % 3)) % 3 || 3;
      const give = Math.min(need, remaining[c], capacity - used);
      if (give > 0) {
        plan[c] += give;
        used += give;
      }
    }
    for (const c of toOpen) {
      const need = 1; // 最小 1 张即可把关变开
      const give = Math.min(need, remaining[c], capacity - used);
      if (give > 0) {
        plan[c] += give;
        used += give;
      }
    }

    // 第二轮：给还没被满足的状态变更补票（如果容量够）
    for (const c of toClose) {
      const cur = cumulative[c] + plan[c];
      const stillNeed = (3 - (cur % 3)) % 3;
      // stillNeed === 0 表示已在 triplet 边界（已完成），无需补票
      if (stillNeed > 0) {
        const give = Math.min(stillNeed, remaining[c] - plan[c], capacity - used);
        if (give > 0) {
          plan[c] += give;
          used += give;
        }
      }
    }

    // 第三轮：填满剩余容量
    if (used < capacity) {
      let slack = capacity - used;

      const byRemaining = [...active].sort((a, b) =>
        (remaining[b] - plan[b]) - (remaining[a] - plan[a]),
      );

      if (d === D - 1) {
        // ── 最后一层：闭合优先（close-fill），绝不做 safe-fill ──
        // Step A: 闭合所有仍开着的花色
        for (const c of byRemaining) {
          if (slack <= 0) break;
          const cur = cumulative[c] + plan[c];
          const need = (3 - (cur % 3)) % 3;
          if (need > 0) {
            const maxAdd = remaining[c] - plan[c];
            const give = Math.min(need, maxAdd, slack);
            if (give > 0) {
              plan[c] += give;
              used += give;
              slack -= give;
            }
          }
        }
        // Step B: 剩余容量只给 3 的倍数（保持闭合，绝不重新打开）
        for (const c of byRemaining) {
          if (slack <= 0) break;
          const maxAdd = remaining[c] - plan[c];
          if (maxAdd < 3) continue;
          const triplets = Math.floor(maxAdd / 3);
          const give = Math.min(triplets * 3, slack);
          if (give > 0) {
            plan[c] += give;
            used += give;
            slack -= give;
          }
        }
      } else {
        // ── 中间层：safe-fill（尽量不破坏目标闭合状态）──
        //
        // 在 triplet 口径下，给 3 的倍数 = +1 完成 triplet（与旧模型的"颜色 mod3 闭合"不同）。
        // 因此 safe-fill Step A 必须有目标上限：只补到 target，超过后只做 Step B。

        // 计算 toClose 两轮后的已完成 triplet 数（基于 projected cumulative）
        const projectedCum = cumulative.map((c, i) => c + plan[i]);
        const completedAfterRounds = countCompletedTriplets(projectedCum);
        const remainingToTarget = target - completedAfterRounds; // 还可以完成几个 triplet

        // Step A: 每次 1 个 triplet，放完重排序存，避免单色独吞
        if (remainingToTarget > 0) {
          let tripletsAdded = 0;
          while (tripletsAdded < remainingToTarget && slack >= 3) {
            // 重排序存，选当前库存最大的颜色
            const sorted = [...active]
              .map(c => ({ c, stock: remaining[c] - plan[c] }))
              .filter(x => x.stock >= 3)
              .sort((a, b) => b.stock - a.stock);
            if (sorted.length === 0) break; // 无人有能力收 triplet
            const pick = sorted[0].c;
            plan[pick] += 3;
            used += 3;
            slack -= 3;
            tripletsAdded++;
          }
        }

        // Step B: safe-fill — 在 triplet 口径下，safe 值确保不增加 floor(cum/3)
        //
        // curMod=0: safe=[1,2]（+1/+2 不跨边界）
        // curMod=1: safe=[1]  （只有+1不跨边界）
        // curMod=2: safe=[]   （任何正数都跨边界，只能跳过）
        if (slack > 0) {
          for (const c of byRemaining.filter(c => !noReopen.has(c))) {
            if (slack <= 0) break;
            let maxAdd = remaining[c] - plan[c];
            if (maxAdd <= 0) continue;
            let curMod = (cumulative[c] + plan[c]) % 3;
            const safe = curMod === 0 ? [1, 2] : curMod === 1 ? [1] : [];
            for (const s of safe) {
              if (slack <= 0) break;
              // ★ 每次重算：plan[c] 已在上轮 s 迭代中更新
              maxAdd = remaining[c] - plan[c];
              curMod = (cumulative[c] + plan[c]) % 3;
              const give = Math.min(s, maxAdd, slack);
              if (give > 0 && (curMod + give) % 3 !== 0) {
                plan[c] += give;
                used += give;
                slack -= give;
              }
            }
          }
        }
      }

      // ── 兜底：如果仍填不满，强制填满（闭合率是软目标，mod3 是硬约束）──
      if (slack > 0) {
        for (const c of byRemaining) {
          if (noReopen.has(c)) continue;
          if (slack <= 0) break;
          const maxAdd = remaining[c] - plan[c];
          if (maxAdd <= 0) continue;
          const give = Math.min(maxAdd, slack);
          plan[c] += give;
          used += give;
          slack -= give;
        }
        // 已达到跨层上限的债务色只允许继续添加完整三元组，避免同层重新开债。
        for (const c of byRemaining) {
          if (!noReopen.has(c) || slack <= 0) continue;
          const maxAdd = remaining[c] - plan[c];
          const give = Math.min(Math.floor(Math.max(0, maxAdd) / 3) * 3, slack);
          if (give > 0) {
            plan[c] += give;
            used += give;
            slack -= give;
          }
        }
        // 若其他颜色没有足够的安全容量，仍需把本层牌全部落位；这是容量硬约束下
        // 对跨层上限的最后让步，后续层仍会优先闭合该债务。
        for (const c of byRemaining) {
          if (slack <= 0) break;
          const maxAdd = remaining[c] - plan[c];
          if (maxAdd <= 0) continue;
          const give = Math.min(maxAdd, slack);
          plan[c] += give;
          used += give;
          slack -= give;
        }
      }
    }

    // ── 应用计划 ──
    for (let c = 0; c < C; c++) {
      const assign = Math.min(plan[c], remaining[c]);
      M[c][d] = assign;
      const hadDebt = cumulative[c] % 3 !== 0;
      cumulative[c] += assign;
      remaining[c] -= assign;
      const hasDebt = cumulative[c] % 3 !== 0;
      if (!hasDebt) debtAge[c] = 0;
      else if (!hadDebt) debtAge[c] = 0;
      else debtAge[c] += 1;
    }
    allCumulative += allTilesPerDepth[d];

    // ── 记录实际闭合率（triplet 口径）──
    const actualCompleted = countCompletedTriplets(cumulative);
    actualCloseRates.push(P > 0 ? actualCompleted / P : 0);
  }

  return { matrix: M, actualCloseRates, retainedOldDebtTilesByLayer };
}

/** 完成 1 个 triplet 的成本：需要几张牌才能让 floor(cum/3) 增加 1 */
function tripletCost(cum: number): number {
  return cum % 3 === 0 ? 3 : 3 - (cum % 3);
}

/** 不完整 triplet 的债务：还需要几张牌才能消除当前不完整的 triplet 组（用于 debt check） */
function closeCost(cum: number): number {
  const r = cum % 3;
  return r === 0 ? 0 : 3 - r;
}

/** 统计已完成的 triplet 数：Σ⌊cum[c] ÷ 3⌋ */
function countCompletedTriplets(cumulative: number[]): number {
  let n = 0;
  for (const cum of cumulative) n += Math.floor(cum / 3);
  return n;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
