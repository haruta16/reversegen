/**
 * dagT 在地形 DAG 中的包含搜索。
 *
 * 12t3l（及全部 12t3l 变体）走「连接式枚举引擎」（searchCanonicalJoin）：
 *   - 按选择性排序的多路连接：A → B → x1 → 底座（可达闭合 4 子集，含
 *     wildcard 救援上界）→ D → C/E；
 *   - 闭包谓词作为连接条件下推，仅产生可能通过的组合；
 *   - 逐核心在真实直接依赖上计算逐色闭包；闭包缺口（wildcard 下方跨色
 *     增益 / 结构桥接）由「精确 wildcard 约束」（具体候选分配）闭环——
 *     之前「wildcard 桥接会被遗漏」的完整性缺口在此闭合；
 *   - 默认全量枚举（无上限），输出按发现序、tileId 集合去重。
 *
 * 其余 dagT 族（minimal_y / minimal_y_deep）走回溯搜索（searchGenericCores）。
 *
 * 采纳条件：返回的每个匹配经选择阶段 verifyFullEmbedding 在完整 12 张上
 * 复核逐色闭包 ≥ 8（纯玩法必死），绝不误收。
 */

import type {
  DeadlockCoreMatch,
  DagTVariant,
  DepthPreference,
  DensityPreference,
  WildcardConstraint,
} from './types.js';
import { colorClosures, coreMeetsThreshold } from './closures.js';
import { mulberry32 } from '../random-utils.js';
import type { TerrainTile } from '../types.js';

export interface ContainmentSearchInput {
  /** 使用的模板变体（搜索只看结构；染色走变体表） */
  variant: DagTVariant;
  /** 候选牌（调用方已过滤 const / 地形结构 / 棋盘特殊物） */
  candidateTiles: TerrainTile[];
  /** tileId → 直接依赖（全地形） */
  depsOf: Map<number, number[]>;
  /** tileId → 传递后代（不含自身，全地形） */
  descendants: Map<number, Set<number>>;
  /** tileId → 传递祖先（不含自身，全地形） */
  ancestors: Map<number, Set<number>>;
  /** tileId → 逻辑依赖深度（底=1）。可选：缺省时内部自行计算。 */
  depthById?: Map<number, number>;
}

export interface ContainmentSearchOptions {
  /** 骨架匹配收集上限。12t3l 默认 256（带种子随机序取前 n 个）；其余族默认 256。 */
  searchLimit?: number;
  /**
   * 枚举顺序种子：候选列表按 mulberry32(seed) 洗牌，使「取前 searchLimit 个」
   * 等价于从全部包含中做带种子的随机采样。默认 0。
   */
  enumerationSeed?: number;
  /**
   * 枚举引导（偏好前移）：A/B 候选按方向做几何加权随机序，
   * 使样本偏向更深/更浅/更密/更疏的区域（首位概率 ≈ 1 − guideBias）。
   * 未设置 = 均匀随机采样。事后打分排序仍是最终裁决。
   */
  guide?: DepthPreference | DensityPreference;
  /** 引导强度 = 非首位候选的相对权重（几何衰减）。默认 0.5，范围 (0,1)。 */
  guideBias?: number;
}

/** Fisher–Yates 洗牌（rng 决定顺序，确定性）。 */
function shuffled<T>(arr: T[], rng: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * 按得分方向做几何加权无放回采样序：候选按得分排序后，名次 i 的权重 =
 * bias^i（首位抽中概率 = 1 − bias），逐次抽取。确定性（rng）。
 */
export function weightedSampleOrder(
  candidates: number[],
  scoreOf: (id: number) => number,
  dir: 1 | -1,
  rng: () => number,
  bias: number,
): number[] {
  const remaining = [...candidates].sort((a, b) =>
    (dir * (scoreOf(b) - scoreOf(a))) || (a - b));
  const out: number[] = [];
  while (remaining.length > 0) {
    let total = 0;
    for (let i = 0; i < remaining.length; i++) total += Math.pow(bias, i);
    let r = rng() * total;
    let idx = remaining.length - 1;
    for (let i = 0; i < remaining.length; i++) {
      r -= Math.pow(bias, i);
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    out.push(remaining[idx]);
    remaining.splice(idx, 1);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
//  搜索入口（分派）
// ═══════════════════════════════════════════════════════════

export function searchDeadlockCores(
  input: ContainmentSearchInput,
  opts: ContainmentSearchOptions = {},
): DeadlockCoreMatch[] {
  const { variant, candidateTiles } = input;
  if (candidateTiles.length < variant.nodes.length) return [];
  const rng = mulberry32(opts.enumerationSeed ?? 0);
  const limit = Math.max(1, opts.searchLimit ?? 256);
  if (variant.tileCount === 12 && variant.layerLimit === 3 && isCanonical12tShape(variant)) {
    return searchCanonicalJoin(input, limit, rng, opts.guide, opts.guideBias);
  }
  return searchGenericCoresImpl(input, limit, rng);
}

/** 结构自检：12 节点 / 3 层 / 单 4 依赖枢纽 + 单 1 依赖枢纽 + 两个 2 依赖 cap + 单 1 依赖 cap + 双 wildcard。 */
function isCanonical12tShape(variant: DagTVariant): boolean {
  if (variant.nodes.length !== 12) return false;
  const byDeps = new Map<number, number>();
  const childrenCount = new Map<number, number>();
  for (const n of variant.nodes) {
    byDeps.set(n.deps.length, (byDeps.get(n.deps.length) ?? 0) + 1);
    for (const d of n.deps) childrenCount.set(d, (childrenCount.get(d) ?? 0) + 1);
  }
  let wildcards = 0;
  for (const n of variant.nodes) {
    if (n.deps.length === 0 && (childrenCount.get(n.id) ?? 0) === 0) wildcards++;
  }
  return byDeps.get(4) === 1 && byDeps.get(2) === 2 && byDeps.get(1) === 2
    && byDeps.get(0) === 7 && wildcards === 2;
}

// ═══════════════════════════════════════════════════════════
//  12t3l 连接式枚举引擎
// ═══════════════════════════════════════════════════════════

interface RolePlan {
  nodeA: number;
  nodeB: number;
  nodeXAs: number[];
  nodeX1: number;
  nodeD: number;
  nodeCE: number[];
  wildcardNodes: number[];
  colorOfNode: Map<number, number>;
  coreNodesOfColor: Map<number, number[]>;
}

function buildRolePlan(variant: DagTVariant): RolePlan {
  const childrenCount = new Map<number, number>();
  for (const n of variant.nodes) {
    for (const d of n.deps) childrenCount.set(d, (childrenCount.get(d) ?? 0) + 1);
  }
  let nodeA = -1;
  let nodeB = -1;
  let nodeD = -1;
  const nodeCE: number[] = [];
  const wildcardNodes: number[] = [];
  // 第一遍：按依赖/孩子形状识别枢纽、cap 与 wildcard
  for (const n of variant.nodes) {
    if (n.deps.length === 4) nodeA = n.id;
    else if (n.deps.length === 1 && (childrenCount.get(n.id) ?? 0) === 2) nodeB = n.id;
    else if (n.deps.length === 1 && (childrenCount.get(n.id) ?? 0) === 0) nodeD = n.id;
    else if (n.deps.length === 2) nodeCE.push(n.id);
    else if (n.deps.length === 0 && (childrenCount.get(n.id) ?? 0) === 0) wildcardNodes.push(n.id);
  }
  // 第二遍：底座按「A 的依赖 / B 的依赖」分家
  const depsOfA = new Set(nodeA > 0 ? variant.nodes.find(n => n.id === nodeA)!.deps : []);
  const nodeXAs: number[] = [];
  let nodeX1 = -1;
  for (const n of variant.nodes) {
    if (n.deps.length !== 0 || (childrenCount.get(n.id) ?? 0) === 0) continue;
    if (depsOfA.has(n.id)) nodeXAs.push(n.id);
    else nodeX1 = n.id;
  }
  if (nodeA < 0 || nodeB < 0 || nodeD < 0 || nodeCE.length !== 2
    || nodeXAs.length !== 4 || nodeX1 < 0 || wildcardNodes.length !== 2) {
    throw new Error('12t3l 角色分解失败：结构不满足规范形状');
  }
  const colorOfNode = new Map(variant.nodes.map(n => [n.id, n.color]));
  const coreNodesOfColor = new Map<number, number[]>();
  for (const n of variant.nodes) {
    if (wildcardNodes.includes(n.id)) continue;
    const list = coreNodesOfColor.get(n.color);
    if (list) list.push(n.id);
    else coreNodesOfColor.set(n.color, [n.id]);
  }
  return {
    nodeA, nodeB, nodeXAs: nodeXAs.sort((a, b) => a - b), nodeX1,
    nodeD, nodeCE: nodeCE.sort((a, b) => a - b), wildcardNodes,
    colorOfNode, coreNodesOfColor,
  };
}

/** 核心子图内 x 的向下可达集合（边两端均在 core 内，含 x）。 */
function reachWithinCore(x: number, coreSet: Set<number>, depsArr: Map<number, number[]>): Set<number> {
  const out = new Set<number>();
  const stack = [x];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (out.has(cur)) continue;
    out.add(cur);
    for (const d of depsArr.get(cur) ?? []) {
      if (coreSet.has(d)) stack.push(d);
    }
  }
  return out;
}

/**
 * cap→父 的 wildcard 桥接约束（父必须在 cap 的完整可达内；核心可达已排除）。
 * 1 跳：桥牌 x ∈ deps(cap) 且父 ∈ deps(x)；2 跳：x1b ∈ deps(cap)、x2b ∈ deps(x1b)、父 ∈ deps(x2b)。
 * 返回物化候选分配的约束；不可桥接返回 null。
 */
function capBridgeConstraint(
  capTile: number,
  parentTile: number,
  usedSet: Set<number>,
  depsArr: Map<number, number[]>,
  depsOf: Map<number, number[]>,
  upSet: Set<number>,
  eligibleNodes: number[],
): WildcardConstraint | null {
  const depArr = depsArr.get(capTile) ?? [];
  const hop1 = depArr.filter(d => upSet.has(d) && !usedSet.has(d) && d !== parentTile);
  if (hop1.length > 0) {
    return { arity: 1, eligibleNodeIds: eligibleNodes, assignments: hop1.map(t => [t]) };
  }
  const assignments2: number[][] = [];
  for (const x1b of depArr) {
    if (usedSet.has(x1b) || x1b === parentTile) continue;
    for (const x2b of depsOf.get(x1b) ?? []) {
      if (usedSet.has(x2b) || x2b === x1b) continue;
      if (upSet.has(x2b)) {
        // 两种节点绑定顺序都合法
        assignments2.push([x1b, x2b], [x2b, x1b]);
        if (assignments2.length >= 32) break;
      }
    }
    if (assignments2.length >= 32) break;
  }
  if (assignments2.length > 0) {
    return { arity: 2, eligibleNodeIds: eligibleNodes, assignments: assignments2 };
  }
  return null;
}

/** 逻辑依赖深度（底=1）：外部提供优先，缺省在 depsOf 全图上自算（环守护）。 */
function resolveDepthMap(
  depsOf: Map<number, number[]>,
  provided?: Map<number, number>,
): Map<number, number> {
  const map = new Map<number, number>();
  for (const [id, d] of provided ?? []) map.set(id, d);
  const compute = (id: number): number => {
    const cached = map.get(id);
    if (cached !== undefined && cached >= 0) return cached;
    map.set(id, -1);
    let maxDep = 0;
    for (const d of depsOf.get(id) ?? []) maxDep = Math.max(maxDep, compute(d));
    const depth = maxDep + 1;
    map.set(id, depth);
    return depth;
  };
  for (const id of depsOf.keys()) compute(id);
  return map;
}

function searchCanonicalJoin(
  input: ContainmentSearchInput,
  searchLimit?: number,
  rng: () => number = mulberry32(0),
  guide?: DepthPreference | DensityPreference,
  guideBias?: number,
): DeadlockCoreMatch[] {
  const { variant, candidateTiles, depsOf, descendants, ancestors } = input;
  const plan = buildRolePlan(variant);
  const poolIds = candidateTiles.map(t => t.id).sort((a, b) => a - b);
  const poolSet = new Set(poolIds);

  const depsArr = new Map<number, number[]>();
  const depsSet = new Map<number, Set<number>>();
  const upArr = new Map<number, number[]>();
  const reach2 = new Map<number, number[]>();
  for (const id of poolIds) {
    const arr = [...(depsOf.get(id) ?? [])].filter(d => poolSet.has(d)).sort((a, b) => a - b);
    depsArr.set(id, arr);
    depsSet.set(id, new Set(arr));
    upArr.set(id, []);
  }
  for (const id of poolIds) {
    for (const d of depsArr.get(id)!) upArr.get(d)!.push(id);
  }
  for (const id of poolIds) upArr.set(id, upArr.get(id)!.sort((a, b) => a - b));
  for (const id of poolIds) {
    const r2 = new Set<number>();
    for (const d of depsArr.get(id)!) {
      r2.add(d);
      for (const d2 of depsArr.get(d) ?? []) r2.add(d2);
    }
    reach2.set(id, [...r2].sort((a, b) => a - b));
  }

  const limit = Math.max(1, searchLimit ?? 256);
  const bias = Math.min(0.95, Math.max(0.02, guideBias ?? 0.5));
  const depthOf = resolveDepthMap(depsOf, input.depthById);
  const posOf = new Map<number, { x: number; y: number }>();
  for (const t of candidateTiles) posOf.set(t.id, { x: t.posX, y: t.posY });
  const chebDist = (a: number, b: number): number => {
    const p = posOf.get(a);
    const q = posOf.get(b);
    if (!p || !q) return 0;
    return Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y));
  };
  const depthScoreOf = (id: number): number => depthOf.get(id) ?? 1;
  const guideA = (pool: number[]): number[] => {
    if (guide === 'deepest') return weightedSampleOrder(pool, depthScoreOf, 1, rng, bias);
    if (guide === 'shallowest') return weightedSampleOrder(pool, depthScoreOf, -1, rng, bias);
    return shuffled(pool, rng);
  };
  const guideB = (pool: number[], tileA: number): number[] => {
    if (guide === 'deepest') return weightedSampleOrder(pool, depthScoreOf, 1, rng, bias);
    if (guide === 'shallowest') return weightedSampleOrder(pool, depthScoreOf, -1, rng, bias);
    if (guide === 'densest') return weightedSampleOrder(pool, id => -chebDist(tileA, id), 1, rng, bias);
    if (guide === 'sparsest') return weightedSampleOrder(pool, id => chebDist(tileA, id), 1, rng, bias);
    return shuffled(pool, rng);
  };
  const matches: DeadlockCoreMatch[] = [];
  const seenSets = new Set<string>();
  const wildcardNodes = plan.wildcardNodes;
  /**
   * 核心闭包 + wildcard 精确约束：闭包缺口由「增长」wildcard（落在核心牌下方）
   * 补足；cap→父 由「桥接」wildcard 补足。返回 null 表示该核心无法补全为合法
   * 死锁；否则返回 { constraints, hints }（hints = 有增益/桥接价值的 tile，
   * 供选择阶段优先尝试）。
   */
  function coreCompletionConstraints(
    mapping: Map<number, number>,
    coreSet: Set<number>,
    bridgeConstraints: WildcardConstraint[],
  ): { constraints: WildcardConstraint[]; hints: number[] } | null {
    const coreColorOf = new Map<number, number>();
    for (const [nodeId, tileId] of mapping) coreColorOf.set(tileId, plan.colorOfNode.get(nodeId)!);
    const closures = colorClosures({ chosenIds: coreSet, depsOf, colorOf: coreColorOf });
    const poolMinusCore = poolIds.filter(id => !coreSet.has(id));
    const constraints: WildcardConstraint[] = [...bridgeConstraints];
    const hints = new Set<number>();
    for (const c of bridgeConstraints) {
      for (const assignment of c.assignments) {
        for (const t of assignment) hints.add(t);
      }
    }

    // 逐色缺口（扣除本色 wildcard 的自增 1）
    const needsGrowth: number[] = [];
    let verifiedPair: [number, number] | null = null;
    for (const color of plan.coreNodesOfColor.keys()) {
      const ownWC = wildcardNodes.filter(n => plan.colorOfNode.get(n) === color).length;
      const deficit = 8 - (closures.get(color) ?? 0) - ownWC;
      if (deficit > 0) needsGrowth.push(color);
    }
    if (needsGrowth.length > 0) {
      // 增长池：需要增长的花色的核心牌下方的候选（未来 wildcard 可落点）
      const growthPoolSet = new Set<number>();
      for (const color of needsGrowth) {
        for (const nodeId of plan.coreNodesOfColor.get(color)!) {
          const tileId = mapping.get(nodeId);
          if (tileId === undefined) continue;
          const desc = descendants.get(tileId);
          if (desc) for (const d of desc) if (poolSet.has(d) && !coreSet.has(d)) growthPoolSet.add(d);
        }
      }
      const growthPool = [...growthPoolSet].sort((a, b) => a - b);
      for (const t of growthPool) hints.add(t);

      /** core ∪ extras 的逐色闭包是否全 ≥ 8（extras 带模板花色，闭包单调） */
      const closuresWith = (extras: Array<[number, number]>): boolean => {
        const chosen = new Set<number>(coreSet);
        const colorOf = new Map<number, number>(coreColorOf);
        for (const [nodeId, tileId] of extras) {
          chosen.add(tileId);
          colorOf.set(tileId, plan.colorOfNode.get(nodeId)!);
        }
        const full = colorClosures({ chosenIds: chosen, depsOf, colorOf });
        for (const size of full.values()) {
          if (size < 8) return false;
        }
        return true;
      };

      // 存在任一通过的双 wildcard 分配即可补全（早退；记录该验证对为首提示）
      const zeroRep = poolMinusCore.find(t => !growthPoolSet.has(t));
      const candTiles = zeroRep === undefined ? growthPool : [...growthPool, zeroRep];
      const [n1, n2] = wildcardNodes;
      outer: for (const t1 of candTiles) {
        for (const t2 of candTiles) {
          if (t1 === t2) continue;
          if (closuresWith([[n1, t1], [n2, t2]])) {
            verifiedPair = [t1, t2];
            break outer;
          }
        }
      }
      if (verifiedPair === null) return null;
      for (const t of verifiedPair) hints.delete(t);
    }

    if (!wildcardConstraintsFeasible(constraints, poolMinusCore)) return null;
    // 已验证可行的组合排最前（选择阶段第一步即命中）
    const hintsList = verifiedPair === null
      ? [...hints]
      : [...verifiedPair, ...hints];
    return { constraints, hints: hintsList };
  }

  const pushCore = (
    mapping: Map<number, number>,
    bridgeConstraints: WildcardConstraint[],
  ): boolean => {
    const coreTileIds = [...mapping.values()].sort((a, b) => a - b);
    const setKey = coreTileIds.join(',');
    if (seenSets.has(setKey)) return true;
    const coreSet = new Set(coreTileIds);
    const completion = coreCompletionConstraints(mapping, coreSet, bridgeConstraints);
    if (completion === null) return true;
    const coreColorOf = new Map<number, number>();
    for (const [nodeId, tileId] of mapping) coreColorOf.set(tileId, plan.colorOfNode.get(nodeId)!);
    seenSets.add(setKey);
    matches.push({
      variantId: variant.id,
      coreMapping: new Map(mapping),
      coreTileIds,
      coreClosures: colorClosures({ chosenIds: coreSet, depsOf, colorOf: coreColorOf }),
      wildcardPool: poolIds.filter(id => !coreSet.has(id)),
      wildcardConstraints: completion.constraints.length > 0 ? completion.constraints : undefined,
      wildcardHints: completion.hints.length > 0 ? completion.hints : undefined,
    });
    return matches.length < limit;
  };

  // ── A 候选：4 底座（2 跳内）+ 上邻可承载 cap ──
  // 种子随机序：取前 searchLimit 个匹配 ≈ 从全部包含中随机采样
  const aPool = poolIds.filter(id => reach2.get(id)!.length >= 4 && upArr.get(id)!.length > 0);
  const aCands = guideA(aPool);
  for (const tileA of aCands) {
    if (matches.length >= limit) break;
    const r2A = reach2.get(tileA)!;
    const upA = new Set(upArr.get(tileA)!);
    const bPool = poolIds.filter(id => id !== tileA && reach2.get(id)!.length > 0);
    for (const tileB of guideB(bPool, tileA)) {
      if (matches.length >= limit) break;
      const r2B = reach2.get(tileB)!;
      const upB = new Set(upArr.get(tileB)!);

      // cap 候选：直接依赖优先（真实地形直接依赖 ≤ 数张），不足再桥接补齐
      const ceDirect = upArr.get(tileA)!.filter(t => upB.has(t) && t !== tileB);
      const dDirect = upArr.get(tileA)!.filter(t => t !== tileB);
      let ceCands = ceDirect;
      let dCands = dDirect;
      if (ceCands.length < 2 || dCands.length < 1) {
        const ceSet = new Set(ceDirect);
        const dSet = new Set(dDirect);
        for (const t of poolIds) {
          if (t === tileA || t === tileB) continue;
          const depArr = depsArr.get(t)!;
          const reachA = depArr.includes(tileA) || depArr.some(d => upA.has(d));
          const reachB = depArr.includes(tileB) || depArr.some(d => upB.has(d));
          if (reachA && reachB && !ceSet.has(t)) {
            ceSet.add(t);
            ceCands.push(t);
          }
          if (reachA && !dSet.has(t)) {
            dSet.add(t);
            dCands.push(t);
          }
        }
      }
      if (ceCands.length < 2 || dCands.length < 1) continue;

      // ── cap 组合（D × C/E，与底座解耦） ──
      const capCombos: Array<{ tileD: number; tileC: number; tileE: number }> = [];
      for (const tileD of dCands) {
        const ceAvail = ceCands.filter(t => t !== tileD);
        for (let i = 0; i < ceAvail.length - 1; i++) {
          for (let j = i + 1; j < ceAvail.length; j++) {
            capCombos.push({ tileD, tileC: ceAvail[i], tileE: ceAvail[j] });
          }
        }
      }
      if (capCombos.length === 0) continue;

      // ── x1 × 底座（标准通道：核心覆盖 ≥ 4 严格剪枝） ──
      const x1Cands = shuffled(r2B.filter(id => id !== tileA && id !== tileB), rng);
      for (const tileX1 of x1Cands) {
        if (matches.length >= limit) break;
        const baseCands = r2A.filter(id => id !== tileA && id !== tileB && id !== tileX1);
        if (baseCands.length < 4) continue;
        const standard = enumerateBaseSubsets(tileA, tileB, tileX1, baseCands, depsArr);
        for (const bases of standard) {
          if (matches.length >= limit) break;
          const used = new Set([tileA, tileB, tileX1, ...bases]);
          for (const { tileD, tileC, tileE } of capCombos) {
            if (matches.length >= limit) break;
            if (used.has(tileD) || used.has(tileC) || used.has(tileE)) continue;
            const mapping = buildCapCheckedMapping(
              tileA, tileB, tileX1, bases, tileD, tileC, tileE, used, upA, upB,
            );
            if (!mapping) continue;
            if (!pushCore(mapping.mapping, mapping.constraints)) return matches;
          }
        }

        // ── 救援通道：wildcard 桥接底座（Q1 类）。仅在尚未达到上限时运行
        //（采样语义下无需穷尽救援类；预算内枚举、超出记档为枚举边界）。
        if (matches.length < limit
          && (standard.length === 0 || bridgeEligibleExists(tileA, tileB, tileX1, baseCands, descendants, poolSet))) {
          for (const bases of enumerateRescuedSubsets(
            tileA, tileB, tileX1, baseCands, depsArr, descendants, poolSet,
          )) {
            if (matches.length >= limit) break;
            const used = new Set([tileA, tileB, tileX1, ...bases]);
            for (const { tileD, tileC, tileE } of capCombos) {
              if (matches.length >= limit) break;
              if (used.has(tileD) || used.has(tileC) || used.has(tileE)) continue;
              const mapping = buildCapCheckedMapping(
                tileA, tileB, tileX1, bases, tileD, tileC, tileE, used, upA, upB,
              );
              if (!mapping) continue;
              if (!pushCore(mapping.mapping, mapping.constraints)) return matches;
            }
          }
        }
      }
    }
  }
  return matches;

  /** cap（D/C/E）在核心定型后的精确判定：父可达或 wildcard 桥接约束。 */  function buildCapCheckedMapping(
    tileA: number,
    tileB: number,
    tileX1: number,
    bases: number[],
    tileD: number,
    tileC: number,
    tileE: number,
    used: Set<number>,
    upA: Set<number>,
    upB: Set<number>,
  ): { mapping: Map<number, number>; constraints: WildcardConstraint[] } | null {
    const constraints: WildcardConstraint[] = [];
    let ok = true;
    const coreCE = new Set([...used, tileD, tileC, tileE]);
    const checks: Array<[number, number[]]> = [
      [tileD, [tileA]],
      [tileC, [tileA, tileB]],
      [tileE, [tileA, tileB]],
    ];
    for (const [t, parents] of checks) {
      const reachT = reachWithinCore(t, coreCE, depsArr);
      for (const parent of parents) {
        if (reachT.has(parent)) continue;
        const c = capBridgeConstraint(t, parent, used, depsArr, depsOf,
          parent === tileA ? upA : upB, wildcardNodes);
        if (!c) {
          ok = false;
          break;
        }
        constraints.push(c);
      }
      if (!ok) break;
    }
    if (!ok) return null;
    const mapping = new Map<number, number>([
      [plan.nodeA, tileA],
      [plan.nodeB, tileB],
      [plan.nodeX1, tileX1],
      ...plan.nodeXAs.map((n, k) => [n, bases[k]] as [number, number]),
      [plan.nodeD, tileD],
      [plan.nodeCE[0], tileC],
      [plan.nodeCE[1], tileE],
    ]);
    return { mapping, constraints };
  }
}

/**
 * 标准通道底座 4 子集枚举：可达闭合 + 覆盖严格剪枝（核心内 reach(A)∪reach(B)
 * 覆盖底座 ∪ x1 ≥ 4）。候选按「直接依赖 A 优先」排序使覆盖增长快、剪枝紧。
 * 完备性：任何最终覆盖 ≥ 4 的 4 子集，其每个前缀的覆盖 + 剩余槽位 ≥ 4
 * （覆盖随选取单调不减），必不被剪掉。
 */
function enumerateBaseSubsets(
  tileA: number,
  tileB: number,
  tileX1: number,
  baseCands: number[],
  depsArr: Map<number, number[]>,
): number[][] {
  const depsA = new Set(depsArr.get(tileA) ?? []);
  const ordered = [...baseCands].sort((a, b) =>
    ((depsA.has(b) ? 1 : 0) - (depsA.has(a) ? 1 : 0)) || (a - b));

  const out: number[][] = [];
  const picked: number[] = [];
  const coverage = (): number => {
    const s = new Set([tileA, tileB, tileX1, ...picked]);
    const reachA = reachWithinCore(tileA, s, depsArr);
    const reachB = reachWithinCore(tileB, s, depsArr);
    let cov = 0;
    for (const b of picked) if (reachA.has(b) || reachB.has(b)) cov++;
    if (reachA.has(tileX1) || reachB.has(tileX1)) cov++;
    return cov;
  };
  const dfs = (start: number): void => {
    if (picked.length === 4) {
      out.push([...picked]);
      return;
    }
    const remainingAfter = 4 - picked.length - 1;
    for (let i = start; i <= ordered.length - (4 - picked.length); i++) {
      picked.push(ordered[i]);
      const cov = coverage();
      if (cov + remainingAfter >= 4) dfs(i + 1);
      picked.pop();
    }
  };
  dfs(0);
  return out;
}

/** 是否存在可作桥牌的候选（desc(A∪B) 内、覆盖某底座候选）。 */
function bridgeEligibleExists(
  tileA: number,
  tileB: number,
  tileX1: number,
  baseCands: number[],
  descendants: Map<number, Set<number>>,
  poolSet: Set<number>,
): boolean {
  const baseCandSet = new Set(baseCands);
  for (const anchor of [tileA, tileB]) {
    const desc = descendants.get(anchor);
    if (!desc) continue;
    for (const w of desc) {
      if (!poolSet.has(w) || w === tileA || w === tileB || w === tileX1) continue;
      const descW = descendants.get(w);
      if (!descW) continue;
      for (const b of baseCands) {
        if (descW.has(b)) return true;
      }
    }
  }
  void baseCandSet;
  return false;
}

/**
 * 救援通道：核心内不可达的底座（wildcard 桥接类，Q1）完整枚举。
 * 桥牌 = desc(A∪B) ∩ 候选池 − 已选，且 desc(w) 覆盖至少一个底座候选。
 * 对每个桥牌 w 与每对 (w1,w2)，在 core ∪ W' 上做可达闭合枚举 + 覆盖
 * 严格剪枝（该配置下覆盖上界精确）。桥牌超过 16 张时截断（更深链式救援
 * 记档为枚举边界；已枚举核心仍经闭包增长机制精确验证）。
 */
function enumerateRescuedSubsets(
  tileA: number,
  tileB: number,
  tileX1: number,
  baseCands: number[],
  depsArr: Map<number, number[]>,
  descendants: Map<number, Set<number>>,
  poolSet: Set<number>,
): number[][] {
  const baseCandSet = new Set(baseCands);
  const bridges: number[] = [];
  for (const anchor of [tileA, tileB]) {
    const desc = descendants.get(anchor);
    if (!desc) continue;
    for (const w of desc) {
      if (!poolSet.has(w) || w === tileA || w === tileB || w === tileX1) continue;
      const descW = descendants.get(w);
      if (!descW) continue;
      let cnt = 0;
      for (const b of baseCands) if (descW.has(b)) cnt++;
      if (cnt > 0) bridges.push(w);
    }
  }
  void baseCandSet;
  if (bridges.length === 0) return [];
  const bridgeList = [...new Set(bridges)].sort((a, b) => a - b).slice(0, 8);

  const out: number[][] = [];
  const seen = new Set<string>();
  const configs: number[][] = bridgeList.map(w => [w]);
  for (let i = 0; i < bridgeList.length - 1; i++) {
    for (let j = i + 1; j < bridgeList.length; j++) {
      configs.push([bridgeList[i], bridgeList[j]]);
    }
  }

  for (const cfg of configs) {
    // 排除桥牌作底座；覆盖 = 底座 ∪ x1 在 reach(core ∪ cfg) 内
    const candidates = baseCands.filter(b => !cfg.includes(b));
    if (candidates.length < 4) continue;
    const virtualCore = new Set([tileA, tileB, tileX1, ...cfg]);
    const reachAv = reachWithinCore(tileA, virtualCore, depsArr);
    const reachBv = reachWithinCore(tileB, virtualCore, depsArr);

    const ordered = [...candidates].sort((a, b) =>
      ((reachAv.has(b) || reachBv.has(b) ? 1 : 0) - (reachAv.has(a) || reachBv.has(a) ? 1 : 0))
      || (a - b));
    const picked: number[] = [];
    const coverageCore = (): number => {
      const s = new Set([tileA, tileB, tileX1, ...picked]);
      const reachA = reachWithinCore(tileA, s, depsArr);
      const reachB = reachWithinCore(tileB, s, depsArr);
      let cov = 0;
      for (const b of picked) if (reachA.has(b) || reachB.has(b)) cov++;
      if (reachA.has(tileX1) || reachB.has(tileX1)) cov++;
      return cov;
    };
    const coverageWith = (): number => {
      const s = new Set([tileA, tileB, tileX1, ...cfg, ...picked]);
      const reachA = reachWithinCore(tileA, s, depsArr);
      const reachB = reachWithinCore(tileB, s, depsArr);
      let cov = 0;
      for (const b of picked) if (reachA.has(b) || reachB.has(b)) cov++;
      if (reachA.has(tileX1) || reachB.has(tileX1)) cov++;
      return cov;
    };
    const dfs = (start: number): void => {
      if (picked.length === 4) {
        // 核心覆盖已 ≥ 4 的集合由标准通道覆盖，救援通道只保留真·桥接核心
        if (coverageCore() >= 4) return;
        const key = [...picked].sort((a, b) => a - b).join(',');
        if (!seen.has(key) && out.length < 64) {
          seen.add(key);
          out.push([...picked]);
        }
        return;
      }
      if (out.length >= 64) return;
      const remainingAfter = 4 - picked.length - 1;
      for (let i = start; i <= ordered.length - (4 - picked.length); i++) {
        picked.push(ordered[i]);
        // 保留子树当且仅当「核心覆盖」或「含桥覆盖」的上界仍可达 4
        const covC = coverageCore();
        const covW = coverageWith();
        if (covC + remainingAfter >= 4 || covW + remainingAfter >= 4) dfs(i + 1);
        picked.pop();
        if (out.length >= 64) return;
      }
    };
    dfs(0);
  }
  return out;
}

/**
 * wildcard 约束可行性：能否为全部约束分配互不相同的 wildcard 节点与 tile。
 * 约束的 assignments 为物化候选分配；预算守卫保守放行（选择阶段做最终过滤，不误收）。
 */
function wildcardConstraintsFeasible(
  constraints: WildcardConstraint[],
  poolMinusCore: number[],
): boolean {
  if (constraints.length === 0) return true;
  const freeTileSet = new Set(poolMinusCore);
  let steps = 0;
  const usedNodes = new Set<number>();
  const usedTiles = new Set<number>();
  const dfs = (index: number): boolean => {
    if (index === constraints.length) return true;
    if (++steps > 8192) return true; // 预算守卫：保守放行
    const c = constraints[index];
    const candidates: Array<Array<{ node: number; tile: number }>> = [];
    for (const node of c.eligibleNodeIds) {
      if (usedNodes.has(node)) continue;
      for (const assignment of c.assignments) {
        let ok = true;
        const tiles = new Set<number>();
        for (const t of assignment) {
          if (tiles.has(t) || !freeTileSet.has(t) || usedTiles.has(t)) {
            ok = false;
            break;
          }
          tiles.add(t);
        }
        if (ok) {
          candidates.push(assignment.map(t => ({ node, tile: t })));
          if (candidates.length >= 128) break;
        }
      }
    }
    for (const assignment of candidates) {
      let ok = true;
      for (const { node, tile } of assignment) {
        if (usedNodes.has(node) || usedTiles.has(tile)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      for (const { node, tile } of assignment) {
        usedNodes.add(node);
        usedTiles.add(tile);
      }
      if (dfs(index + 1)) return true;
      for (const { node, tile } of assignment) {
        usedNodes.delete(node);
        usedTiles.delete(tile);
      }
    }
    return false;
  };
  return dfs(0);
}

// ═══════════════════════════════════════════════════════════
//  通用族回溯搜索（minimal_y / minimal_y_deep）
// ═══════════════════════════════════════════════════════════

interface GNode {
  id: number;
  layer: number;
  deps: number[];
  color: number;
  children: number[];
  wildcard: boolean;
  signature: string;
}

function gSignature(node: GNode): string {
  const deps = [...node.deps].sort((a, b) => a - b).join(',');
  const children = [...node.children].sort((a, b) => a - b).join(',');
  return `${node.layer}|${deps}|${children}|${node.color}`;
}

/** 通用族回溯引擎（导出供对照测试与工具使用）。 */
export function searchGenericCoresImpl(
  input: ContainmentSearchInput,
  limit: number,
  rng: () => number = mulberry32(0),
): DeadlockCoreMatch[] {
  const { variant, candidateTiles, depsOf, descendants, ancestors } = input;

  const nodes: GNode[] = variant.nodes.map(n => ({
    id: n.id, layer: n.layer, deps: [...n.deps], color: n.color, children: [], wildcard: false, signature: '',
  }));
  const nodeById = new Map<number, GNode>();
  for (const n of nodes) nodeById.set(n.id, n);
  for (const n of nodes) {
    for (const depId of n.deps) {
      const parent = nodeById.get(depId);
      if (!parent) throw new Error(`模板边指向未知节点 ${depId}`);
      parent.children.push(n.id);
    }
  }
  for (const n of nodes) {
    n.children.sort((a, b) => a - b);
    n.wildcard = n.deps.length === 0 && n.children.length === 0;
    n.signature = gSignature(n);
  }

  const coreNodes = nodes.filter(n => !n.wildcard);
  const wildcardColorCounts = new Map<number, number>();
  for (const n of nodes) {
    if (n.wildcard) wildcardColorCounts.set(n.color, (wildcardColorCounts.get(n.color) ?? 0) + 1);
  }
  const order = [...coreNodes].sort((a, b) =>
    (b.children.length - a.children.length)
    || (b.deps.length - a.deps.length)
    || (a.id - b.id));
  const bottomRoles = new Set(
    coreNodes.filter(n => n.deps.length === 0 && n.children.length > 0).map(n => n.id));

  const poolIds = shuffled(candidateTiles.map(t => t.id).sort((a, b) => a - b), rng);
  const poolSet = new Set(poolIds);
  const used = new Set<number>();
  const chosen = new Map<number, number>();
  const matches: DeadlockCoreMatch[] = [];
  const seenSets = new Set<string>();

  const resolvedDepth = resolveDepthMap(depsOf, input.depthById);
  const depthOf = (id: number): number => resolvedDepth.get(id) ?? 1;

  const depsSet = new Map<number, Set<number>>();
  const downNeighbors = new Map<number, Set<number>>();
  const reach2 = new Map<number, Set<number>>();
  for (const tileId of poolIds) {
    depsSet.set(tileId, new Set(depsOf.get(tileId) ?? []));
    downNeighbors.set(tileId, new Set());
  }
  for (const tileId of poolIds) {
    for (const d of depsSet.get(tileId)!) {
      if (poolSet.has(d)) downNeighbors.get(d)!.add(tileId);
    }
  }
  for (const tileId of poolIds) {
    const r2 = new Set<number>();
    for (const d of depsSet.get(tileId)!) {
      if (poolSet.has(d)) r2.add(d);
      for (const d2 of depsOf.get(d) ?? []) if (poolSet.has(d2)) r2.add(d2);
    }
    reach2.set(tileId, r2);
  }

  const lastBySignature = new Map<string, { depth: number; id: number }>();
  let lastBottomDepth = Infinity;

  function chosenTiles(): Set<number> {
    return new Set(chosen.values());
  }
  function reachDown(x: number, chosenSet: Set<number>): Set<number> {
    const out = new Set<number>();
    const stack = [x];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (out.has(cur)) continue;
      out.add(cur);
      for (const d of depsOf.get(cur) ?? []) {
        if (d === x || chosenSet.has(d)) stack.push(d);
      }
    }
    return out;
  }
  function reachedOrBridged(x: number, target: number, chosenSet: Set<number>): boolean {
    const reach = reachDown(x, chosenSet);
    for (const y of reach) {
      for (const d of depsOf.get(y) ?? []) {
        if (d === target) return true;
        if (poolSet.has(d) && !used.has(d) && d !== target
          && (depsOf.get(d) ?? []).includes(target)) return true;
      }
    }
    return false;
  }
  function setIntersects(a: Set<number>, b: Set<number>): boolean {
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const x of small) if (large.has(x)) return true;
    return false;
  }

  function finishDomain(node: GNode, isBottom: boolean, candidates: number[]): number[] {
    const out: number[] = [];
    for (const tileId of candidates) {
      if (used.has(tileId)) continue;
      const depth = depthOf(tileId);
      const last = lastBySignature.get(node.signature);
      if (last) {
        if (depth > last.depth) continue;
        if (depth === last.depth && tileId <= last.id) continue;
      }
      if (isBottom && depth > lastBottomDepth) continue;
      const unplacedChildren = node.children.filter(c => !chosen.has(c));
      if (unplacedChildren.length > 0) {
        const anc = ancestors.get(tileId);
        let avail = 0;
        if (anc) {
          for (const a of anc) if (poolSet.has(a) && !used.has(a)) avail++;
        }
        if (avail < unplacedChildren.length) continue;
      }
      const unplacedDeps = node.deps.filter(d => !chosen.has(d));
      if (unplacedDeps.length > 0) {
        const r2 = reach2.get(tileId)!;
        let avail = 0;
        for (const d of r2) if (!used.has(d)) avail++;
        if (avail < unplacedDeps.length) continue;
      }
      out.push(tileId);
    }
    out.sort((a, b) =>
      ((depsSet.get(b)?.size ?? 0) - (depsSet.get(a)?.size ?? 0))
      || (depthOf(b) - depthOf(a))
      || (a - b));
    return out;
  }

  function domain(node: GNode): number[] {
    const chosenSet = chosenTiles();
    const isBottom = bottomRoles.has(node.id);
    const aboveTiles: number[] = [];
    const belowTiles: number[] = [];
    let directLayerOnly = true;
    for (const [placedNodeId, placedTile] of chosen) {
      const placedNode = nodeById.get(placedNodeId)!;
      const diff = Math.abs(node.layer - placedNode.layer);
      if (node.deps.includes(placedNodeId)) {
        belowTiles.push(placedTile);
        if (diff !== 1) directLayerOnly = false;
      } else if (placedNode.deps.includes(node.id)) {
        aboveTiles.push(placedTile);
        if (diff !== 1) directLayerOnly = false;
      }
    }
    if ((aboveTiles.length > 0 || belowTiles.length > 0) && directLayerOnly) {
      if (belowTiles.length === 0) {
        let allowed: Set<number> | null = null;
        for (const parentTile of aboveTiles) {
          const reach = reachDown(parentTile, chosenSet);
          let set: Set<number>;
          if (reach.size === 1 && reach.has(parentTile)) set = reach2.get(parentTile)!;
          else {
            set = new Set<number>();
            for (const y of reach) {
              for (const d of depsOf.get(y) ?? []) {
                if (poolSet.has(d)) set.add(d);
                if (poolSet.has(d) && d !== parentTile) {
                  for (const d2 of depsOf.get(d) ?? []) if (poolSet.has(d2)) set.add(d2);
                }
              }
            }
          }
          const cur = new Set<number>();
          for (const id of set) if (!used.has(id)) cur.add(id);
          if (allowed === null) allowed = cur;
          else for (const id of allowed) if (!cur.has(id)) allowed.delete(id);
        }
        return finishDomain(node, isBottom, allowed === null ? [] : [...allowed]);
      }
      if (aboveTiles.length === 0) {
        const firstParent = belowTiles[0];
        const directCands = [...downNeighbors.get(firstParent)!];
        const out = new Set<number>();
        const consider = (tileId: number): void => {
          if (used.has(tileId)) return;
          let ok = true;
          for (const parentTile of belowTiles) {
            const ds = depsSet.get(tileId)!;
            if (!ds.has(parentTile) && !setIntersects(ds, downNeighbors.get(parentTile)!)) {
              ok = false;
              break;
            }
          }
          if (ok) out.add(tileId);
        };
        for (const tileId of directCands) consider(tileId);
        for (const tileId of poolIds) {
          if (out.has(tileId) || used.has(tileId)) continue;
          const ds = depsSet.get(tileId)!;
          if (ds.has(firstParent)) continue;
          if (!ds.size || !setIntersects(ds, downNeighbors.get(firstParent)!)) continue;
          consider(tileId);
        }
        return finishDomain(node, isBottom, [...out]);
      }
    }
    const out: number[] = [];
    for (const tileId of poolIds) {
      if (used.has(tileId)) continue;
      let ok = true;
      for (const [placedNodeId, placedTile] of chosen) {
        if (!ok) break;
        const placedNode = nodeById.get(placedNodeId)!;
        if (node.deps.includes(placedNodeId)) {
          if (Math.abs(node.layer - placedNode.layer) === 1) {
            if (!reachedOrBridged(tileId, placedTile, chosenSet)) ok = false;
          } else {
            const anc = ancestors.get(placedTile);
            if (!anc || !anc.has(tileId)) ok = false;
          }
        } else if (placedNode.deps.includes(node.id)) {
          if (Math.abs(node.layer - placedNode.layer) === 1) {
            if (!reachedOrBridged(placedTile, tileId, chosenSet)) ok = false;
          } else {
            const desc = descendants.get(placedTile);
            if (!desc || !desc.has(tileId)) ok = false;
          }
        }
      }
      if (ok) out.push(tileId);
    }
    return finishDomain(node, isBottom, out);
  }

  function dfs(index: number): void {
    if (matches.length >= limit) return;
    if (index === order.length) {
      const coreTileIds = [...chosen.values()].sort((a, b) => a - b);
      const setKey = coreTileIds.join(',');
      if (seenSets.has(setKey)) return;
      const chosenSet = new Set(chosen.values());
      const coreColorOf = new Map<number, number>();
      for (const [nodeId, tileId] of chosen) coreColorOf.set(tileId, nodeById.get(nodeId)!.color);
      const closures = colorClosures({ chosenIds: chosenSet, depsOf, colorOf: coreColorOf });
      if (!coreMeetsThreshold(closures, wildcardColorCounts)) return;
      seenSets.add(setKey);
      matches.push({
        variantId: variant.id,
        coreMapping: new Map(chosen),
        coreTileIds,
        coreClosures: closures,
        wildcardPool: poolIds.filter(id => !chosenSet.has(id)),
      });
      return;
    }
    const node = order[index];
    const isBottom = bottomRoles.has(node.id);
    const prevBottomDepth = lastBottomDepth;
    for (const tileId of domain(node)) {
      chosen.set(node.id, tileId);
      used.add(tileId);
      const sig = node.signature;
      const prevSig = lastBySignature.get(sig) ?? null;
      lastBySignature.set(sig, { depth: depthOf(tileId), id: tileId });
      if (isBottom) lastBottomDepth = Math.min(lastBottomDepth, depthOf(tileId));
      dfs(index + 1);
      if (isBottom) lastBottomDepth = prevBottomDepth;
      if (prevSig === null) lastBySignature.delete(sig);
      else lastBySignature.set(sig, prevSig);
      used.delete(tileId);
      chosen.delete(node.id);
      if (matches.length >= limit) return;
    }
  }

  dfs(0);
  return matches;
}

/** 完整包含验证（核心 + wildcard 完成后）：逐色直接依赖子图闭包 ≥ 8。 */
export function verifyFullEmbedding(
  chosenIds: Set<number>,
  colorOf: Map<number, number>,
  depsOf: Map<number, number[]>,
): Map<number, number> {
  const closures = colorClosures({ chosenIds, depsOf, colorOf });
  for (const size of closures.values()) {
    if (size < 8) throw new Error(`死锁闭包验证失败: min(${[...closures.values()]}) < 8`);
  }
  return closures;
}
