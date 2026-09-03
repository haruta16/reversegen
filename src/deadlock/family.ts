/**
 * dagT 模板族 —— 参考实现 dag_geometry.py 的 TypeScript 移植。
 *
 * 三个构造器（全部由闭包判据保证必死，测试用 golden 复核）：
 *  - minimal12tVariants()        12t3l 最小边（E=10）24 个变体（hub × avoid × pick 对称性）
 *  - minimalYVariant(y)          l=3 任意 y≥4（统一放大器优化 v2，定理 4.5c 最优）
 *  - minimalYDeepVariant(y, l)   l≥4 塔式/中继放大器（选项族 DP，族内最优）
 *
 * 约定：
 *  - 模板节点 id 1 起，与参考实现一致；
 *  - 模板逻辑层 1 起（python 的 0 → 1）；
 *  - 模板花色归一化为 0..y-1：cap 色 p → p-1，hub 色（100+i）→ c+i。
 *
 * 搜索只用结构；染色依据变体表的 col。canonicalVariant 为生成用的规范变体。
 */

import type { DagTVariant, DagTNode } from './types.js';

interface RawVariant {
  id: string;
  tileCount: number;
  layerLimit: number;
  layers: Map<number, number>;
  deps: Map<number, Set<number>>;
  col: Map<number, number>;
}

function toVariant(raw: RawVariant): DagTVariant {
  const nodes: DagTNode[] = [];
  for (const id of [...raw.layers.keys()].sort((a, b) => a - b)) {
    nodes.push({
      id,
      layer: raw.layers.get(id)!,
      deps: [...(raw.deps.get(id) ?? [])].sort((a, b) => a - b),
      color: raw.col.get(id)!,
    });
  }
  let edges = 0;
  for (const [, deps] of raw.deps) edges += deps.size;
  return {
    id: raw.id,
    tileCount: raw.tileCount,
    layerLimit: raw.layerLimit,
    edges,
    nodes,
  };
}

function assertDeadlockShape(tileCount: number, layerLimit: number): number {
  if (!Number.isInteger(tileCount) || tileCount % 3 !== 0) {
    throw new Error(`deadlock tileCount ${tileCount} 必须是 3 的倍数`);
  }
  const n = tileCount / 3;
  if (n < 4) throw new Error(`deadlock 花色数 ${n} < 4：必死局至少 4 色（tile ≥ 12）`);
  if (layerLimit < 3) throw new Error(`deadlock layerLimit ${layerLimit} < 3：1 层必可解、2 层不可能`);
  return n;
}

// ═══════════════════════════════════════════════════════════
//  12t3l：E=10 抽象最小族（24 变体）
// ═══════════════════════════════════════════════════════════

/**
 * 全部 24 个 12tile/3层/4色 最小边（E=10）必死 DAG 变体。
 * 参数空间：hub 色(4) × hub 避开的 cap 对(3) × 被避开对中 B 的依赖(2)。
 * 每个变体四色闭包全 = 8 ⇒ 必死（golden 测试复核）。
 */
export function minimal12tVariants(): DagTVariant[] {
  const out: DagTVariant[] = [];
  for (let hub = 0; hub < 4; hub++) {
    const caps = [0, 1, 2, 3].filter(c => c !== hub);
    const pairIds: Array<[number, number]> = [[1, 2], [3, 4], [5, 6]];
    for (let avoid = 0; avoid < 3; avoid++) {
      for (let pick = 0; pick < 2; pick++) {
        const layers = new Map<number, number>();
        for (let i = 1; i <= 6; i++) layers.set(i, 1);
        for (let i = 7; i <= 9; i++) layers.set(i, 2);
        for (let i = 10; i <= 12; i++) layers.set(i, 3);

        const deps = new Map<number, Set<number>>();
        for (let i = 1; i <= 12; i++) deps.set(i, new Set());

        const col = new Map<number, number>();
        for (let k = 0; k < 3; k++) {
          col.set(pairIds[k][0], caps[k]);
          col.set(pairIds[k][1], caps[k]);
        }
        col.set(7, hub);
        col.set(8, hub);
        col.set(9, hub);

        for (let k = 0; k < 3; k++) {
          if (k !== avoid) {
            deps.get(7)!.add(pairIds[k][0]);
            deps.get(7)!.add(pairIds[k][1]);
          }
        }
        deps.get(8)!.add(pairIds[avoid][pick]);

        const capOf: Record<number, number> = { 2: 10, 0: 11, 1: 12 };
        for (let k = 0; k < 3; k++) {
          if (k === avoid) deps.get(capOf[k])!.add(7);
          else {
            deps.get(capOf[k])!.add(7);
            deps.get(capOf[k])!.add(8);
          }
        }
        col.set(10, caps[2]);
        col.set(11, caps[0]);
        col.set(12, caps[1]);

        out.push(toVariant({
          id: `12t3l-h${hub}-a${avoid}-p${pick}`,
          tileCount: 12,
          layerLimit: 3,
          layers,
          deps,
          col,
        }));
      }
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
//  l=3 通用：minimal_y（定理 4.5c 最优）
// ═══════════════════════════════════════════════════════════

function fillerCost(A: number, h: number): number {
  if (A >= 2 * h) return 0;
  const f2 = Math.floor(A / 2);
  const f1 = A % 2;
  const f0 = h - f2 - f1;
  return f1 + 5 * f0;
}

/** l=3 最小边（理论最优值，供 golden 对照）。 */
export function minimalEdgeCount3L(y: number): number {
  assertDeadlockShape(3 * y, 3);
  let best = Infinity;
  for (let h = 1; h < y; h++) {
    const c = y - h;
    const A = Math.ceil(c / 4);
    if (A > 3 * h) continue;
    const E = c + 4 * A + fillerCost(A, h) + (A === 1 ? 2 : 0);
    if (E < best) best = E;
  }
  return best;
}

/**
 * 3y tile / 3层 / y色 的最小边必死 DAG（抽象层），任意 y≥4。
 * 统一放大器系统优化（hub 色数 h 为自由变量）：
 *   E = min_h [(y−h) + 4A + F(A,h) + 2·[A==1]]，A = ⌈(y−h)/4⌉
 */
export function minimalYVariant(y: number): DagTVariant {
  assertDeadlockShape(3 * y, 3);

  let best: { E: number; h: number; c: number; A: number } | null = null;
  for (let h = 1; h < y; h++) {
    const c = y - h;
    const A = Math.ceil(c / 4);
    if (A > 3 * h) continue;
    const E = c + 4 * A + fillerCost(A, h) + (A === 1 ? 2 : 0);
    if (!best || E < best.E) best = { E, h, c, A };
  }
  const { h, c, A } = best!;

  const layers = new Map<number, number>();
  const deps = new Map<number, Set<number>>();
  const col = new Map<number, number>();

  // cap 色底座：每色 2 颗 L0（色 p-1）
  for (let p = 1; p <= c; p++) {
    layers.set(2 * p - 1, 1);
    layers.set(2 * p, 1);
    deps.set(2 * p - 1, new Set());
    deps.set(2 * p, new Set());
    col.set(2 * p - 1, p - 1);
    col.set(2 * p, p - 1);
  }

  // hub 色放大器数量分布
  const q: number[] = [];
  if (A >= 2 * h) {
    for (let i = 0; i < h; i++) q.push(2 + (i < A - 2 * h ? 1 : 0));
  } else {
    for (let i = 0; i < h; i++) q.push(i < Math.floor(A / 2) ? 2 : (i === Math.floor(A / 2) && A % 2 ? 1 : 0));
  }

  const amps: Array<{ tid: number; pairs: [number, number] }> = [];
  let k = 0;
  const fillers = new Map<number, number>(); // hubIndex → filler tileId
  for (let i = 0; i < h; i++) {
    for (let j = 0; j < q[i]; j++) {
      k++;
      let p1 = ((2 * k - 2) % c) + 1;
      let p2 = ((2 * k - 1) % c) + 1;
      if (p1 === p2) p2 = (p2 % c) + 1;
      const tid = 2 * c + 1 + 3 * i + j;
      deps.set(tid, new Set([2 * p1 - 1, 2 * p1, 2 * p2 - 1, 2 * p2]));
      amps.push({ tid, pairs: [p1, p2] });
    }
    const hid0 = 2 * c + 1 + 3 * i;
    if (q[i] === 1) {
      const used = deps.get(hid0)!;
      for (let t = 1; t <= 2 * c; t++) {
        if (!used.has(t)) {
          deps.set(hid0 + 1, new Set([t]));
          fillers.set(i, hid0 + 1);
          break;
        }
      }
    } else if (q[i] === 0) {
      deps.set(hid0, new Set([1, 2, 3, 4]));
      deps.set(hid0 + 1, new Set([5]));
    }
    for (let j = 0; j < 3; j++) {
      const tid = hid0 + j;
      layers.set(tid, 2);
      col.set(tid, c + i);
      if (!deps.has(tid)) deps.set(tid, new Set());
    }
  }

  // cap 色 L2 顶 tile
  const pressed = new Map<number, number>();
  for (const { tid } of amps) pressed.set(tid, 0);
  for (let p = 1; p <= c; p++) {
    const tid = 2 * c + 3 * h + p;
    layers.set(tid, 3);
    col.set(tid, p - 1);
    deps.set(tid, new Set());
    if (A === 1) {
      const touched = amps[0].pairs.includes(p);
      deps.get(tid)!.add(amps[0].tid);
      if (touched) deps.get(tid)!.add(fillers.get(0)!);
      else pressed.set(amps[0].tid, (pressed.get(amps[0].tid) ?? 0) + 1);
    } else {
      const cands = amps.filter(a => !a.pairs.includes(p));
      if (cands.length === 0) throw new Error(`放大器覆盖不足：pair ${p} 无避开放大器`);
      cands.sort((a, b) => (pressed.get(a.tid)! - pressed.get(b.tid)!) || (a.tid - b.tid));
      const chosen = cands[0];
      deps.get(tid)!.add(chosen.tid);
      pressed.set(chosen.tid, (pressed.get(chosen.tid) ?? 0) + 1);
    }
  }

  return toVariant({
    id: `3y${y}-3l-v2`,
    tileCount: 3 * y,
    layerLimit: 3,
    layers,
    deps,
    col,
  });
}

// ═══════════════════════════════════════════════════════════
//  l≥4：minimal_y_deep（塔式/中继放大器，选项族 DP）
// ═══════════════════════════════════════════════════════════

interface TowerOption {
  cost: number;
  capacity: number;
  kind: string;
  nAmp: number;
  nRelay: number;
}

function towerOptions(layers: number): TowerOption[] {
  if (layers === 4) {
    return [
      { cost: 5, capacity: 4, kind: 'q1', nAmp: 1, nRelay: 0 },
      { cost: 6, capacity: 7, kind: 'relay1', nAmp: 1, nRelay: 1 },
      { cost: 8, capacity: 10, kind: 'relay2a', nAmp: 1, nRelay: 2 },
      { cost: 8, capacity: 8, kind: 'a2', nAmp: 2, nRelay: 0 },
      { cost: 12, capacity: 12, kind: 'a3', nAmp: 3, nRelay: 0 },
      { cost: 5, capacity: 0, kind: 'q0', nAmp: 0, nRelay: 0 },
    ];
  }
  return [
    { cost: 5, capacity: 4, kind: 'q1', nAmp: 1, nRelay: 0 },
    { cost: 6, capacity: 7, kind: 'relay1', nAmp: 1, nRelay: 1 },
    { cost: 7, capacity: 10, kind: 'relay2b', nAmp: 1, nRelay: 2 },
    { cost: 8, capacity: 8, kind: 'a2', nAmp: 2, nRelay: 0 },
    { cost: 12, capacity: 12, kind: 'a3', nAmp: 3, nRelay: 0 },
    { cost: 5, capacity: 0, kind: 'q0', nAmp: 0, nRelay: 0 },
  ];
}

/**
 * l≥4 的 3y tile / y色 必死 DAG（塔式/中继放大器族，族内最小）。
 * 注：跨色「中继农场」可进一步压缩（全局最小开放中），此处忠实移植参考实现。
 */
export function minimalYDeepVariant(y: number, layers: number): DagTVariant {
  assertDeadlockShape(3 * y, layers);
  if (layers < 4) throw new Error(`minimal_y_deep 需 layers ≥ 4，收到 ${layers}`);

  const ops = towerOptions(layers);
  let best: { total: number; h: number; c: number; kinds: string[] } | null = null;
  for (let h = 1; h < y; h++) {
    const c = y - h;
    const memo = new Map<string, { v: number; kinds: string[] }>();
    const f = (i: number, cap: number, amps: number, relays: number): { v: number; kinds: string[] } => {
      const key = `${i}|${cap}|${amps}|${relays}`;
      const hit = memo.get(key);
      if (hit) return hit;
      let result: { v: number; kinds: string[] };
      if (i === h) {
        const pen = cap <= 0 && amps === 1 && relays === 0 ? 2 : 0;
        result = { v: (cap <= 0 ? 0 : Infinity) + pen, kinds: [] };
      } else {
        let bestv = { v: Infinity, kinds: [] as string[] };
        for (const op of ops) {
          const rest = f(i + 1, cap - op.capacity, amps + op.nAmp, relays + op.nRelay);
          if (op.cost + rest.v < bestv.v) bestv = { v: op.cost + rest.v, kinds: [op.kind, ...rest.kinds] };
        }
        result = bestv;
      }
      memo.set(key, result);
      return result;
    };
    const { v, kinds } = f(0, c, 0, 0);
    if (!best || c + v < best.total) best = { total: c + v, h, c, kinds };
  }
  const { h, c, kinds } = best!;

  const layersMap = new Map<number, number>();
  const deps = new Map<number, Set<number>>();
  const col = new Map<number, number>();

  for (let p = 1; p <= c; p++) {
    layersMap.set(2 * p - 1, 1);
    layersMap.set(2 * p, 1);
    deps.set(2 * p - 1, new Set());
    deps.set(2 * p, new Set());
    col.set(2 * p - 1, p - 1);
    col.set(2 * p, p - 1);
  }

  let hid = 2 * c + 1;
  const targets: Array<{ tid: number; avoidPairs: [number, number] | null; capacity: number }> = [];
  let k = 0; // 全局放大器计数器（q1/relay/a2/a3 共用）
  for (let hubIndex = 0; hubIndex < kinds.length; hubIndex++) {
    const kind = kinds[hubIndex];
    for (let j = 0; j < 3; j++) {
      layersMap.set(hid + j, 2);
      col.set(hid + j, c + hubIndex);
      deps.set(hid + j, new Set());
    }
    const nextAmpPairs = (): [number, number] => {
      k++;
      let p1 = ((2 * k - 2) % c) + 1;
      let p2 = ((2 * k - 1) % c) + 1;
      if (p1 === p2) p2 = (p2 % c) + 1;
      return [p1, p2];
    };
    const firstFreeBase = (exclude: Set<number>, extra: number | null = null): number => {
      for (let t = 1; t <= 2 * c; t++) {
        if (!exclude.has(t) && t !== extra) return t;
      }
      throw new Error('底座候选耗尽');
    };

    switch (kind) {
      case 'q0':
        deps.set(hid, new Set([1, 2, 3, 4]));
        deps.set(hid + 1, new Set([5]));
        hid += 3;
        continue;
      case 'q1': {
        const [p1, p2] = nextAmpPairs();
        deps.set(hid, new Set([2 * p1 - 1, 2 * p1, 2 * p2 - 1, 2 * p2]));
        targets.push({ tid: hid, avoidPairs: [p1, p2], capacity: 4 });
        deps.set(hid + 1, new Set([firstFreeBase(deps.get(hid)!)]));
        hid += 3;
        continue;
      }
      case 'relay1': {
        const [p1, p2] = nextAmpPairs();
        deps.set(hid, new Set([2 * p1 - 1, 2 * p1, 2 * p2 - 1, 2 * p2]));
        targets.push({ tid: hid, avoidPairs: [p1, p2], capacity: 3 });
        const x = firstFreeBase(deps.get(hid)!);
        layersMap.set(hid + 1, 3);
        deps.set(hid + 1, new Set([hid, x]));
        targets.push({ tid: hid + 1, avoidPairs: null, capacity: 4 });
        hid += 3;
        continue;
      }
      case 'relay2a': {
        const [p1, p2] = nextAmpPairs();
        deps.set(hid, new Set([2 * p1 - 1, 2 * p1, 2 * p2 - 1, 2 * p2]));
        targets.push({ tid: hid, avoidPairs: [p1, p2], capacity: 2 });
        const x1 = firstFreeBase(deps.get(hid)!);
        layersMap.set(hid + 1, 3);
        deps.set(hid + 1, new Set([hid, x1]));
        const x2 = firstFreeBase(deps.get(hid)!, x1);
        layersMap.set(hid + 2, 3);
        deps.set(hid + 2, new Set([hid, x2]));
        targets.push({ tid: hid + 1, avoidPairs: null, capacity: 4 });
        targets.push({ tid: hid + 2, avoidPairs: null, capacity: 4 });
        hid += 3;
        continue;
      }
      case 'relay2b': {
        const [p1, p2] = nextAmpPairs();
        deps.set(hid, new Set([2 * p1 - 1, 2 * p1, 2 * p2 - 1, 2 * p2]));
        targets.push({ tid: hid, avoidPairs: [p1, p2], capacity: 3 });
        const x1 = firstFreeBase(deps.get(hid)!);
        layersMap.set(hid + 1, 3);
        deps.set(hid + 1, new Set([hid, x1]));
        layersMap.set(hid + 2, 4);
        deps.set(hid + 2, new Set([hid + 1]));
        targets.push({ tid: hid + 1, avoidPairs: null, capacity: 3 });
        targets.push({ tid: hid + 2, avoidPairs: null, capacity: 4 });
        hid += 3;
        continue;
      }
      case 'a2':
      case 'a3': {
        const nAmp = kind === 'a2' ? 2 : 3;
        for (let a = 0; a < nAmp; a++) {
          const [p1, p2] = nextAmpPairs();
          deps.set(hid + a, new Set([2 * p1 - 1, 2 * p1, 2 * p2 - 1, 2 * p2]));
          targets.push({ tid: hid + a, avoidPairs: [p1, p2], capacity: 4 });
        }
        hid += 3;
        continue;
      }
      default:
        throw new Error(`未知塔式选项 ${kind}`);
    }
  }

  // cap 顶 tile（层 4 或 5）
  const topLayer = layers >= 5 ? 5 : 4;
  for (let p = 1; p <= c; p++) {
    const tid = hid + p;
    layersMap.set(tid, topLayer);
    col.set(tid, p - 1);
    deps.set(tid, new Set());
    const cands = targets.filter(t => t.capacity > 0 && (t.avoidPairs === null || !t.avoidPairs.includes(p)));
    if (cands.length === 0) throw new Error(`塔式构造覆盖不足：pair ${p} 无候选`);
    cands.sort((a, b) => (a.capacity - b.capacity) || (a.tid - b.tid));
    const chosen = cands[0];
    deps.get(tid)!.add(chosen.tid);
    chosen.capacity -= 1;
  }

  return toVariant({
    id: `3y${y}-${layers}l-tower`,
    tileCount: 3 * y,
    layerLimit: layers,
    layers: layersMap,
    deps,
    col,
  });
}

// ═══════════════════════════════════════════════════════════
//  统一入口
// ═══════════════════════════════════════════════════════════

/**
 * 给定 t（=3n）与 l，返回 dagT 变体族。
 *  (12, 3) → 24 个 E=10 变体（染色变体表）；
 *  其余    → 单变体（l=3 定理最优 / l≥4 塔式族）。
 */
export function buildDagTVariants(tileCount: number, layerLimit: number): DagTVariant[] {
  assertDeadlockShape(tileCount, layerLimit);
  if (tileCount === 12 && layerLimit === 3) return minimal12tVariants();
  if (layerLimit === 3) return [minimalYVariant(tileCount / 3)];
  return [minimalYDeepVariant(tileCount / 3, layerLimit)];
}

/** 生成用规范变体（(12,3) → hub=0/avoid=0/pick=0）。 */
export function canonicalVariant(tileCount: number, layerLimit: number): DagTVariant {
  assertDeadlockShape(tileCount, layerLimit);
  if (tileCount === 12 && layerLimit === 3) {
    const found = minimal12tVariants().find(v => v.id === '12t3l-h0-a0-p0');
    if (!found) throw new Error('规范变体 12t3l-h0-a0-p0 缺失');
    return found;
  }
  const variants = buildDagTVariants(tileCount, layerLimit);
  return variants[0];
}
