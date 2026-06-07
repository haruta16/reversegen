/**
 * Enhanced DAG Analysis — 完整牌局结构编码。
 *
 * 现有 color-group DAG 的信息丢失:
 *   1. 色内可点/阻塞区分: 只知道"色A有N张tile"，不知道多少可点、多少被谁阻塞
 *   2. 独占/共享阻塞: 只知道"A阻塞B"，不知道是独立唯一阻塞还是共享阻塞
 *   3. 阻塞基数: "A阻塞B"但没说A的几张tile阻塞B的几张tile
 *   4. 色内依赖结构: 同色tile是否互相阻塞（内部分层）
 *   5. 多色独占链条: A唯一阻塞B, B唯一阻塞C → 完美顺序链
 *   6. 死锁环特征: 不是"A↔B"，而是消除A后B有多少tile变为可点
 *
 * 本模块构建增强DAG，编码上述所有信息。
 *
 * 核心概念:
 *   - Exclusive Blocker: B的某tile的唯一剩余blocker是A的tile
 *   - Shared Blocker: B的某tile有多个blocker，A只是其中之一
 *   - Partial Availability: 一个色组中可点tile的数量和身份
 *   - Gate: 消除A的K张tile后，B恰好获得≥3张新可点tile
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TerrainData, TerrainTile } from '../../src/types.js';
import { TileState } from '../../src/types.js';
import { loadTerrainFromFile } from '../../src/terrain-loader.js';
import { decodeFromString, getCanonicalTileOrder } from '../../src/replay-serializer.js';
import { computeAllDependencies } from '../../src/dependency-graph.js';
import { buildColorGroupDAG } from './board-dag.js';
import { createGame, OfflineGame } from '../../src/solver/offline-game.js';
import { setLogLevel, LogLevel } from '../../src/logger.js';

// 静默日志
setLogLevel(LogLevel.Error);

// ═══════════════════════════════════════════════════
//  Enhanced Types
// ═══════════════════════════════════════════════════

/** 单个tile在色组内的状态 */
export interface TileStatus {
  tileId: number;
  layer: number;
  /** 全部传递依赖 */
  depClosure: Set<number>;
  /** 直接依赖 */
  directDeps: number[];
  /** 是否初始可点（无自由牌依赖） */
  initiallyClickable: boolean;
  /** 被哪些自由牌阻塞（直接） */
  blockedBy: number[];
  /** 被哪些色组阻塞 */
  blockedByColors: number[];
  /** 该tile阻塞了哪些其他自由牌 */
  blocks: number[];
}

/** 增强色组节点 */
export interface EnhancedColorNode {
  color: number;
  tileCount: number;
  tiles: TileStatus[];

  // ── 可点状态 ──
  /** 初始可点tile数 */
  initiallyClickable: number;
  /** 可点tile ID列表 */
  clickableTileIds: number[];
  /** 不可点tile数（被阻塞） */
  initiallyBlocked: number;

  // ── 阻塞关系 ──
  /** 每个阻塞者的详细信息: color → {exclusiveCount, sharedCount, totalBlockedTiles} */
  blockerDetails: Map<number, BlockingDetail>;

  // ── 被阻塞关系 ──
  /** 该色组的tile阻塞了哪些其他色组的tile: color → {exclusiveCount, sharedCount} */
  blocksDetails: Map<number, BlockingDetail>;

  // ── 色内结构 ──
  /** 色内是否分层（部分tile被同色tile阻塞） */
  hasInternalBlocking: boolean;
  /** 同色内互相阻塞的对 */
  internalBlockPairs: [number, number][];

  // ── 纯结构属性 ──
  /** 消除该色后，释放的"独占阻塞"tile数（按目标色分组） */
  exclusiveRelease: Map<number, number>;
}

export interface BlockingDetail {
  /** 独占阻塞: B的某tile的唯一blocker是A */
  exclusiveCount: number;
  /** 共享阻塞: B的某tile有多个blocker，A是其中之一 */
  sharedCount: number;
  /** 被A阻塞的B的tile总数 */
  totalBlockedTiles: number;
  /** 当A被完全消除后，B的tile中变为可点的数量（= exclusiveCount，因为共享阻塞仍需等其他blocker） */
  releasableOnElimination: number;
}

/** 增强色组DAG */
export interface EnhancedColorDAG {
  /** 色组节点 */
  nodes: EnhancedColorNode[];
  /** 颜色 → 节点索引 */
  colorToIdx: Map<number, number>;

  // ── 全局结构 ──
  /** 入口色（所有tile初始可点的色） */
  entryColors: number[];
  /** 出口色（不阻塞任何其他色的tile） */
  exitColors: number[];

  // ── 图边: 增强版 ──
  /** 独占边: from→to 表示 from是to的某个tile的唯一blocker */
  exclusiveEdges: [number, number][];
  /** 共享边: from→to 表示 from只是to的共享blocker之一 */
  sharedEdges: [number, number][];

  // ── 环分析 ──
  /** 死锁环列表（环上颜色ID列表） */
  deadlockRings: number[][];
  /** 独占环: 环上每条边都是独占阻塞 */
  exclusiveRings: number[][];
  /** 混合环: 环上部分边是独占、部分是共享 */
  mixedRings: number[][];

  // ── 链分析 ──
  /** 完美序链: 每个色是下一个色的独占阻塞者 */
  perfectChains: number[][];
  /** 最大独占链长 */
  maxExclusiveChainLength: number;

  // ── 并行度分析 ──
  /** 每层实际并行度: 消除前一层后，有多少色同时获得≥3可点tile */
  layerParallelism: number[];
}

/** 死锁机制分类 */
export enum DeathMechanism {
  /** 立死: 不存在任何色有≥3可点tile */
  IMMEDIATE = 'IMMEDIATE',
  /** 死锁环: 色组互锁形成环，无一色能完全消除 */
  DEADLOCK_RING = 'DEADLOCK_RING',
  /** 独占断链: 消除K步后，下一步释放的独占tile散开到多个色，无一色达到≥3 */
  EXCLUSIVE_DISPERSION = 'EXCLUSIVE_DISPERSION',
  /** 共享稀释: 所有剩余tile的阻塞都是共享的，消除任何色都无法释放足够tile */
  SHARED_DILUTION = 'SHARED_DILUTION',
  /** 入口溢出: 唯一入口的depSet过大，dock在形成第一个triple前溢出 */
  ENTRY_OVERFLOW = 'ENTRY_OVERFLOW',
  /** 同色内部分层: 色内tile互相阻塞，无法一次性获取所有tile */
  INTERNAL_LAYERING = 'INTERNAL_LAYERING',
  /** 未分类 */
  UNKNOWN = 'UNKNOWN',
}

/** 死亡机制分析结果 */
export interface DeathAnalysis {
  mechanism: DeathMechanism;
  /** 死亡发生在消除几步之后（0=立死） */
  deathDepth: number;
  /** 涉及的色 */
  involvedColors: number[];
  /** 死亡步的释放分布: 该步释放的独占tile在各个色中的分布 */
  releaseDistribution: Map<number, number>;
  /** 人类可读描述 */
  description: string;
  /** 确定性评分 (0-100, 越高越确定) */
  confidence: number;
}

// ═══════════════════════════════════════════════════
//  增强DAG构建
// ═══════════════════════════════════════════════════

/**
 * 构建增强色组DAG。
 * 输入: 地形 + 花色分配
 * 输出: 完整编码了色内状态、独占/共享阻塞、可点条件的DAG
 */
export function buildEnhancedDAG(
  freeTiles: TerrainTile[],
  suitMap: Map<number, number>,
): EnhancedColorDAG {
  const allDeps = computeAllDependencies(freeTiles);
  const tileMap = new Map<number, TerrainTile>();
  for (const t of freeTiles) tileMap.set(t.id, t);

  // ── 1. 构建TileStatus ──
  const tileStatuses = new Map<number, TileStatus>();
  for (const tile of freeTiles) {
    const depClosure = allDeps.get(tile.id) ?? new Set();
    const depsOnFreeTiles = tile.dependencies.filter(d => tileMap.has(d));
    const initiallyClickable = depsOnFreeTiles.length === 0;

    // 找出被哪些自由牌阻塞
    const blockedBy = depsOnFreeTiles;

    // 该tile阻塞了哪些自由牌
    const blocks: number[] = [];
    for (const other of freeTiles) {
      if (other.id === tile.id) continue;
      if (other.dependencies.includes(tile.id)) blocks.push(other.id);
    }

    tileStatuses.set(tile.id, {
      tileId: tile.id,
      layer: tile.layer,
      depClosure,
      directDeps: depsOnFreeTiles,
      initiallyClickable,
      blockedBy,
      blockedByColors: [], // 稍后填充
      blocks,
    });
  }

  // ── 2. 构建色组 ──
  const colorGroups = new Map<number, number[]>();
  for (const tile of freeTiles) {
    const color = suitMap.get(tile.id) ?? 0;
    if (color <= 0) continue;
    const list = colorGroups.get(color) ?? [];
    list.push(tile.id);
    colorGroups.set(color, list);
  }

  const nodes: EnhancedColorNode[] = [];
  const colorToIdx = new Map<number, number>();

  for (const [color, tileIds] of colorGroups) {
    colorToIdx.set(color, nodes.length);
    const tiles: TileStatus[] = [];
    for (const tid of tileIds) {
      const ts = tileStatuses.get(tid)!;
      // 填充 blockedByColors
      ts.blockedByColors = [...new Set(
        ts.blockedBy.map(bid => suitMap.get(bid) ?? 0).filter(c => c > 0 && c !== color)
      )];
      tiles.push(ts);
    }

    // 色内阻塞检测
    const internalBlockPairs: [number, number][] = [];
    for (const ts of tiles) {
      for (const blockerId of ts.blockedBy) {
        if (tileIds.includes(blockerId)) {
          internalBlockPairs.push([blockerId, ts.tileId]);
        }
      }
    }

    const clickableTileIds = tiles.filter(t => t.initiallyClickable).map(t => t.tileId);

    nodes.push({
      color,
      tileCount: tileIds.length,
      tiles,
      initiallyClickable: clickableTileIds.length,
      clickableTileIds,
      initiallyBlocked: tileIds.length - clickableTileIds.length,
      blockerDetails: new Map(),
      blocksDetails: new Map(),
      hasInternalBlocking: internalBlockPairs.length > 0,
      internalBlockPairs,
      exclusiveRelease: new Map(),
    });
  }

  // ── 3. 分析阻塞关系 ──
  for (let i = 0; i < nodes.length; i++) {
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const a = nodes[i];
      const b = nodes[j];

      let exclusive = 0;
      let shared = 0;
      let totalBlocked = 0;

      for (const bTile of b.tiles) {
        const aBlockers = bTile.blockedBy.filter(bid => a.tiles.some(at => at.tileId === bid));
        if (aBlockers.length === 0) continue;
        totalBlocked++;

        // 判断: A是否是此tile的独占blocker
        // A独占阻塞此tile ⟺ 此tile的所有blocker都在A中
        const allBlockers = bTile.blockedBy;
        const nonABlockers = allBlockers.filter(bid => !a.tiles.some(at => at.tileId === bid));
        if (nonABlockers.length === 0) {
          exclusive++;
        } else {
          shared++;
        }
      }

      if (totalBlocked > 0) {
        a.blocksDetails.set(b.color, {
          exclusiveCount: exclusive,
          sharedCount: shared,
          totalBlockedTiles: totalBlocked,
          releasableOnElimination: exclusive,
        });
        b.blockerDetails.set(a.color, {
          exclusiveCount: exclusive,
          sharedCount: shared,
          totalBlockedTiles: totalBlocked,
          releasableOnElimination: exclusive,
        });

        // exclusiveRelease: 消除A后，B有多少tile变为可点
        if (exclusive > 0) {
          a.exclusiveRelease.set(b.color, (a.exclusiveRelease.get(b.color) ?? 0) + exclusive);
        }
      }
    }
  }

  // ── 4. 边分类 ──
  const exclusiveEdges: [number, number][] = [];
  const sharedEdges: [number, number][] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const detail = nodes[i].blocksDetails.get(nodes[j].color);
      if (!detail) continue;
      if (detail.exclusiveCount > 0) exclusiveEdges.push([i, j]);
      if (detail.sharedCount > 0) sharedEdges.push([i, j]);
    }
  }

  // ── 5. 入口/出口色 ──
  const entryColors: number[] = [];
  const exitColors: number[] = [];
  for (const node of nodes) {
    if (node.initiallyBlocked === 0 && node.tileCount >= 3) {
      // 入口色：所有tile初始可点 且 至少3张
      entryColors.push(node.color);
    }
    if (node.blocksDetails.size === 0) {
      // 出口色: 不阻塞任何其他色
      exitColors.push(node.color);
    }
  }

  // ── 6. 环检测 ──
  const deadlockRings: number[][] = [];
  const exclusiveRings: number[][] = [];
  const mixedRings: number[][] = [];

  detectAllRings(nodes, exclusiveEdges, sharedEdges, deadlockRings, exclusiveRings, mixedRings);

  // ── 7. 完美链检测 ──
  const perfectChains = findPerfectChains(nodes, exclusiveEdges);
  const maxExclusiveChainLength = perfectChains.length > 0
    ? Math.max(...perfectChains.map(c => c.length))
    : 0;

  // ── 8. 层并行度 ──
  const layerParallelism = computeLayerParallelism(nodes, exclusiveEdges, sharedEdges, entryColors);

  return {
    nodes,
    colorToIdx,
    entryColors,
    exitColors,
    exclusiveEdges,
    sharedEdges,
    deadlockRings,
    exclusiveRings,
    mixedRings,
    perfectChains,
    maxExclusiveChainLength,
    layerParallelism,
  };
}

// ═══════════════════════════════════════════════════
//  环检测 —— 精确枚举所有环
// ═══════════════════════════════════════════════════

function detectAllRings(
  nodes: EnhancedColorNode[],
  exclusiveEdges: [number, number][],
  sharedEdges: [number, number][],
  allRings: number[][],
  exclusiveRings: number[][],
  mixedRings: number[][],
): void {
  // 构建邻接表 (有向)
  const adj = new Map<number, number[]>();
  const exclusiveAdj = new Map<number, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    adj.set(i, []);
    exclusiveAdj.set(i, []);
  }
  for (const [a, b] of sharedEdges) {
    const list = adj.get(a)!;
    if (!list.includes(b)) list.push(b);
  }
  for (const [a, b] of exclusiveEdges) {
    // 独占边也是边
    const list = adj.get(a)!;
    if (!list.includes(b)) list.push(b);
    const elist = exclusiveAdj.get(a)!;
    if (!elist.includes(b)) elist.push(b);
  }

  // DFS每个起点，找长度≥2的环 (带硬限制防止组合爆炸)
  const visited = new Set<string>(); // "a|b|c" 排序后的环签名
  const MAX_RING_LENGTH = Math.min(nodes.length, 10);
  const MAX_RINGS = 200; // 硬上限
  const MAX_DFS_STATES = 50000; // DFS状态上限
  let dfsStateCount = 0;
  let stopped = false;

  for (let start = 0; start < nodes.length && !stopped; start++) {
    const path: number[] = [start];
    const inPath = new Set([start]);

    function dfs(node: number, depth: number): void {
      if (stopped) return;
      if (depth > MAX_RING_LENGTH) return;
      dfsStateCount++;
      if (dfsStateCount > MAX_DFS_STATES) { stopped = true; return; }
      if (visited.size >= MAX_RINGS) { stopped = true; return; }

      const neighbors = adj.get(node) ?? [];
      for (const next of neighbors) {
        if (stopped) return;
        if (next === start && depth >= 2) {
          // 找到环
          const ring = [...path];
          ring.sort((a, b) => a - b);
          const sig = ring.join(',');
          if (!visited.has(sig)) {
            visited.add(sig);
            let allExclusive = true;
            for (let p = 0; p < path.length; p++) {
              const from = path[p];
              const to = p < path.length - 1 ? path[p + 1] : start;
              const elist = exclusiveAdj.get(from) ?? [];
              if (!elist.includes(to)) { allExclusive = false; break; }
            }
            const colorRing = ring.map(i => nodes[i].color);
            allRings.push(colorRing);
            if (allExclusive) { exclusiveRings.push(colorRing); }
            else { mixedRings.push(colorRing); }
            if (visited.size >= MAX_RINGS) { stopped = true; }
          }
          continue;
        }
        if (!inPath.has(next)) {
          inPath.add(next);
          path.push(next);
          dfs(next, depth + 1);
          path.pop();
          inPath.delete(next);
        }
      }
    }
    dfs(start, 1);
  }
}

// ═══════════════════════════════════════════════════
//  完美链检测
// ═══════════════════════════════════════════════════

function findPerfectChains(
  nodes: EnhancedColorNode[],
  exclusiveEdges: [number, number][],
): number[][] {
  // 完美链: 节点之间仅有独占边连接，无分支
  // 即: 每个节点的出度≤1，入度≤1，且边都是独占的
  const outDegree = new Array(nodes.length).fill(0);
  const inDegree = new Array(nodes.length).fill(0);
  const nextOf = new Array<number>(nodes.length).fill(-1);

  for (const [a, b] of exclusiveEdges) {
    if (outDegree[a] === 0 && inDegree[b] === 0) {
      outDegree[a]++;
      inDegree[b]++;
      nextOf[a] = b;
    }
  }

  // 从入度=0的节点开始走最长路径
  const chains: number[][] = [];
  const visited = new Set<number>();

  for (let i = 0; i < nodes.length; i++) {
    if (inDegree[i] === 0 && outDegree[i] > 0 && !visited.has(i)) {
      const chain: number[] = [];
      let cur = i;
      while (cur !== -1 && !visited.has(cur)) {
        visited.add(cur);
        chain.push(nodes[cur].color);
        cur = nextOf[cur];
      }
      if (chain.length >= 2) chains.push(chain);
    }
  }

  return chains;
}

// ═══════════════════════════════════════════════════
//  层并行度
// ═══════════════════════════════════════════════════

function computeLayerParallelism(
  nodes: EnhancedColorNode[],
  exclusiveEdges: [number, number][],
  _sharedEdges: [number, number][],
  entryColors: number[],
): number[] {
  // 模拟消除过程：从入口色开始，计算每步后有多少色获得≥3可点tile
  const colorToIdx = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) colorToIdx.set(nodes[i].color, i);

  const eliminated = new Set<number>(); // 已消除的色
  const result: number[] = [];

  // 起始可消的色：所有入口色
  let currentLayer = entryColors.filter(c => {
    const idx = colorToIdx.get(c);
    if (idx === undefined) return false;
    return nodes[idx].initiallyClickable >= 3;
  });

  while (currentLayer.length > 0) {
    result.push(currentLayer.length);

    // 消除当前层的所有色
    for (const color of currentLayer) {
      const idx = colorToIdx.get(color);
      if (idx === undefined) continue;
      eliminated.add(idx);
    }

    // 计算下一层：所有未被消除的色中，那些所有blocker都已被消除的
    const nextLayer: number[] = [];
    for (const node of nodes) {
      if (eliminated.has(colorToIdx.get(node.color)!)) continue;

      // 该色的所有独占blocker是否都已消除
      let allBlockersGone = true;
      let newClickable = 0;
      for (const [blockerColor, detail] of node.blockerDetails) {
        const bidx = colorToIdx.get(blockerColor);
        if (bidx === undefined) continue;
        if (!eliminated.has(bidx)) {
          allBlockersGone = false;
        } else {
          newClickable += detail.releasableOnElimination;
        }
      }

      // 该色变为"可消"的条件: 可点tile≥3
      const totalClickable = node.initiallyClickable + newClickable;
      if (totalClickable >= 3) {
        nextLayer.push(node.color);
      }
    }

    currentLayer = nextLayer;
  }

  return result;
}

// ═══════════════════════════════════════════════════
//  死亡机制分析
// ═══════════════════════════════════════════════════

export function analyzeDeathMechanism(dag: EnhancedColorDAG): DeathAnalysis {
  const { nodes, entryColors, exclusiveRings, mixedRings, exclusiveEdges, layerParallelism } = dag;

  // ── Check: IMMEDIATE (立死) ──
  const hasEntry = entryColors.some(c => {
    const node = nodes.find(n => n.color === c);
    return node && node.initiallyClickable >= 3;
  });

  if (!hasEntry) {
    // 进一步检查: 有无任何色有≥3可点
    const anyPlayable = nodes.some(n => n.initiallyClickable >= 3);
    if (!anyPlayable) {
      // 检查: 有没有任何色可以通过消除其他色的共享阻塞来获得≥3可点
      // 立死的充要条件: 没有任何合理的第一步
      const releaseMap = computeReleaseMap(dag);
      const canStart = nodes.some(n => {
        const afterRelease = n.initiallyClickable + (releaseMap.get(n.color) ?? 0);
        return afterRelease >= 3;
      });

      if (!canStart) {
        return {
          mechanism: DeathMechanism.IMMEDIATE,
          deathDepth: 0,
          involvedColors: nodes.filter(n => n.initiallyClickable > 0).map(n => n.color),
          releaseDistribution: new Map(),
          description: `立死: 开局没有任何色有≥3可点tile。` +
            `${nodes.filter(n => n.initiallyClickable > 0).length}个色有可点tile，` +
            `最多一个色有${Math.max(...nodes.map(n => n.initiallyClickable))}张可点。`,
          confidence: 100,
        };
      }
    }
  }

  // ── Check: DEADLOCK_RING ──
  if (exclusiveRings.length > 0) {
    const ring = exclusiveRings[0];
    // 验证: 环上的色是否无一色能独立开始（无入口）
    const ringHasEntry = ring.some(c => entryColors.includes(c));
    if (!ringHasEntry) {
      return {
        mechanism: DeathMechanism.DEADLOCK_RING,
        deathDepth: layerParallelism.length,
        involvedColors: ring,
        releaseDistribution: analyzeReleaseOnRing(dag, ring),
        description: `独占死锁环 [${ring.join(',')}]: ` +
          `${ring.length}个色形成独占阻塞环，无一色能独立开始。` +
          `前${layerParallelism.length}层并行度=[${layerParallelism.join(',')}]可正常消除，` +
          `之后陷入死锁。`,
        confidence: 95,
      };
    }

    if (mixedRings.length > 0 && exclusiveRings.length === 0) {
      const mring = mixedRings[0];
      return {
        mechanism: DeathMechanism.DEADLOCK_RING,
        deathDepth: layerParallelism.length,
        involvedColors: mring,
        releaseDistribution: analyzeReleaseOnRing(dag, mring),
        description: `混合死锁环 [${mring.join(',')}]: ` +
          `环上存在共享边，部分阻塞可能通过其他路径解除。`,
        confidence: 70,
      };
    }
  }

  // ── Check: EXCLUSIVE_DISPERSION ──
  // 核心: 在死亡步，消除当前色释放的独占tile散开到多个色，无一色达到≥3
  const availableForNext = computeAvailableAfterLayer(dag, layerParallelism.length);
  if (availableForNext.size > 0) {
    const maxPerColor = Math.max(...availableForNext.values(), 0);
    if (maxPerColor < 3) {
      const dispersion = [...availableForNext.entries()]
        .filter(([, cnt]) => cnt > 0)
        .sort(([, a], [, b]) => b - a);

      return {
        mechanism: DeathMechanism.EXCLUSIVE_DISPERSION,
        deathDepth: layerParallelism.length,
        involvedColors: dispersion.map(([c]) => c),
        releaseDistribution: availableForNext,
        description: `独占释放分散: 在step ${layerParallelism.length}后，` +
          `消除释放的新可点tile分散到${dispersion.length}个色，` +
          `每色最多${maxPerColor}张（<3）。` +
          `分布: [${dispersion.map(([c, n]) => `${c}:${n}`).join(', ')}]`,
        confidence: 85,
      };
    }
  }

  // ── Check: SHARED_DILUTION ──
  const sharedOnlyColors = nodes.filter(n => {
    if (n.initiallyClickable >= 3) return false;
    // 检查: 所有不可点tile的blocker是否都是共享的
    const blockedTiles = n.tiles.filter(t => !t.initiallyClickable);
    return blockedTiles.length > 0 && blockedTiles.every(t =>
      t.blockedByColors.length > 1
    );
  });

  if (sharedOnlyColors.length >= nodes.length * 0.7) {
    return {
      mechanism: DeathMechanism.SHARED_DILUTION,
      deathDepth: layerParallelism.length,
      involvedColors: sharedOnlyColors.map(n => n.color),
      releaseDistribution: new Map(),
      description: `共享稀释: ${sharedOnlyColors.length}/${nodes.length}个色的阻塞依赖是共享的，` +
        `消除单一色无法释放足够tile。每色可点tile停留在<3。`,
      confidence: 70,
    };
  }

  // ── Check: ENTRY_OVERFLOW ──
  if (entryColors.length === 1) {
    const entryNode = nodes.find(n => n.color === entryColors[0])!;
    const totalDepSize = entryNode.tiles.reduce(
      (sum, t) => sum + t.depClosure.size, 0
    );
    if (totalDepSize > 7 + entryNode.tileCount * 3) {
      return {
        mechanism: DeathMechanism.ENTRY_OVERFLOW,
        deathDepth: 0,
        involvedColors: entryColors,
        releaseDistribution: new Map(),
        description: `入口溢出: 唯一入口色${entryColors[0]}的depSet过大(${totalDepSize})，` +
          `dock在消除前溢出。`,
        confidence: 80,
      };
    }
  }

  // ── Fallback: UNKNOWN ──
  return {
    mechanism: DeathMechanism.UNKNOWN,
    deathDepth: layerParallelism.length,
    involvedColors: [],
    releaseDistribution: new Map(),
    description: `未匹配已知死锁模式。layer并行度=[${layerParallelism.join(',')}]`,
    confidence: 30,
  };
}

// ═══════════════════════════════════════════════════
//  辅助: 释放图
// ═══════════════════════════════════════════════════

function computeReleaseMap(dag: EnhancedColorDAG): Map<number, number> {
  // 对每个色，计算如果消除它，能为其他色释放多少独占可点tile
  const map = new Map<number, number>();
  for (const node of dag.nodes) {
    let release = 0;
    for (const [, cnt] of node.exclusiveRelease) {
      release += cnt;
    }
    if (release > 0) map.set(node.color, release);
  }
  return map;
}

function analyzeReleaseOnRing(dag: EnhancedColorDAG, ring: number[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const color of ring) {
    const node = dag.nodes.find(n => n.color === color);
    if (!node) continue;
    let total = node.initiallyClickable;
    for (const [blockerColor, detail] of node.blockerDetails) {
      if (!ring.includes(blockerColor)) {
        total += detail.releasableOnElimination;
      }
    }
    map.set(color, total);
  }
  return map;
}

function computeAvailableAfterLayer(dag: EnhancedColorDAG, layerCount: number): Map<number, number> {
  // 模拟推进layerCount层后，剩余的每个色有多少可点tile
  const eliminated = new Set<number>();
  const colorToIdx = new Map(dag.colorToIdx);

  // 简单模拟: 消除前layerCount个并行层的色
  // 实际模拟 消除每个并行层的所有色
  let currentLayer = dag.entryColors.filter(c => {
    const n = dag.nodes.find(x => x.color === c);
    return n && n.initiallyClickable >= 3;
  });

  for (let l = 0; l < layerCount && currentLayer.length > 0; l++) {
    for (const color of currentLayer) {
      eliminated.add(color);
    }

    const nextLayer: number[] = [];
    for (const node of dag.nodes) {
      if (eliminated.has(node.color)) continue;
      let newClickable = 0;
      for (const [blocker, detail] of node.blockerDetails) {
        if (eliminated.has(blocker)) {
          newClickable += detail.releasableOnElimination;
        }
      }
      const total = node.initiallyClickable + newClickable;
      if (total >= 3) nextLayer.push(node.color);
    }
    currentLayer = nextLayer;
  }

  // 计算剩余色的可点tile数
  const result = new Map<number, number>();
  for (const node of dag.nodes) {
    if (eliminated.has(node.color)) continue;
    let newClickable = 0;
    for (const [blocker, detail] of node.blockerDetails) {
      if (eliminated.has(blocker)) {
        newClickable += detail.releasableOnElimination;
      }
    }
    result.set(node.color, node.initiallyClickable + newClickable);
  }

  return result;
}

// ═══════════════════════════════════════════════════
//  DAG 完整性验证
// ═══════════════════════════════════════════════════

/**
 * 验证增强DAG是否精确编码了牌局结构。
 * 通过将DAG的"可解性预测"与DFS实际结果对比来验证。
 */
export interface DAGValidationResult {
  /** DAG预测: 可解/不可解 */
  predictedSolvable: boolean;
  /** DAG预测的死亡深度 */
  predictedDeathDepth: number;
  /** 死亡机制 */
  mechanism: DeathMechanism;
  /** DFS验证: 实际可解 */
  dfsSolved: boolean;
  /** DFS验证: 状态数 */
  dfsStates: number;
  /** 预测与实际是否一致 */
  consistent: boolean;
}

export function validateDAGPrediction(
  dag: EnhancedColorDAG,
  dfsSolved: boolean,
  dfsStates: number,
): DAGValidationResult {
  const death = analyzeDeathMechanism(dag);

  // DAG预测: 如果没有致命死锁模式、入口存在、无环 → 可解
  const fatalMechanisms = [
    DeathMechanism.IMMEDIATE,
    DeathMechanism.DEADLOCK_RING,
    DeathMechanism.ENTRY_OVERFLOW,
  ];

  const predictedSolvable = !fatalMechanisms.includes(death.mechanism);

  return {
    predictedSolvable,
    predictedDeathDepth: death.deathDepth,
    mechanism: death.mechanism,
    dfsSolved,
    dfsStates,
    consistent: predictedSolvable === dfsSolved,
  };
}

// ═══════════════════════════════════════════════════
//  Batch runner
// ═══════════════════════════════════════════════════

export interface EnhancedDAGResult {
  board: { levelResId: number; replayKey: string; };
  dag: EnhancedColorDAG;
  death: DeathAnalysis;
  validation: DAGValidationResult;
  /** 旧DAG特征 (用于对比) */
  oldFeatures: {
    cgNodeCount: number;
    cgEdgeCount: number;
    cgParallelSources: number;
    cgSinkCount: number;
    exclusiveEdgeCount: number;
    sharedEdgeCount: number;
    entryColorCount: number;
    maxExclusiveChainLength: number;
    deadlockRingCount: number;
    exclusiveRingCount: number;
    internalBlockingColors: number;
    layerParallelism: number[];
    perfectChainCount: number;
  };
}

// ═══════════════════════════════════════════════════
//  Main runner
// ═══════════════════════════════════════════════════

// Auto-detect data paths
function findDataDir(...candidates: string[]): string {
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`No data directory found. Tried: ${candidates.join(', ')}`);
}

const DATASET_ROOT = findDataDir(
  'E:/workspace/tilematch/TileMatchShell/Tools/Config/Json',
  '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json',
  join(process.cwd(), '..', 'TileMatchShell', 'Tools', 'Config', 'Json'),
);
const LEVELS_DIR = join(DATASET_ROOT, 'Levels');
const REPLAYS_DIR = join(DATASET_ROOT, 'Replays');
const CACHE_DIR = join(process.cwd(), '.reversegen-cache', 'board-results-v2');
const OUTPUT_DIR = join(process.cwd(), '.reversegen-cache');

interface CachedBoard {
  board: { levelResId: number; replayKey: string; };
  dfs: { win: boolean; statesVisited: number; } | null;
  features: Record<string, number | number[] | boolean>;
}

function loadBoardData(levelResId: number, replayKey: string): {
  freeTiles: TerrainTile[];
  suitMap: Map<number, number>;
  allTiles: TerrainTile[];
} {
  const terrainPath = join(LEVELS_DIR, `${levelResId}.json`);
  if (!existsSync(terrainPath)) throw new Error(`Terrain not found: ${levelResId}`);

  const terrain: TerrainData = loadTerrainFromFile(terrainPath);
  const allTiles: TerrainTile[] = [];
  for (const l of terrain.layers) for (const t of l.tiles) allTiles.push(t);
  const freeTiles = allTiles.filter(t => !t.isConst);
  const co = getCanonicalTileOrder(allTiles);

  const replayPath = join(REPLAYS_DIR, `${levelResId}.json`);
  if (!existsSync(replayPath)) throw new Error(`Replay not found: ${levelResId}`);

  const rj = JSON.parse(readFileSync(replayPath, 'utf-8'));
  let entry: any = null;
  for (const [, entries] of Object.entries(rj.replayInfoDict || {})) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries as any[]) {
      if (e.ReplayKey === replayKey) { entry = e; break; }
    }
    if (entry) break;
  }
  if (!entry) throw new Error(`ReplayKey ${replayKey} not found in ${levelResId}`);

  const rd = decodeFromString(entry.ReplayCode);
  if (!rd) throw new Error('Decode failed');

  const c2t = new Map<number, number>();
  for (let i = 0; i < co.length; i++) c2t.set(i, co[i].id);

  const suitMap = new Map<number, number>();
  for (let i = 0; i < rd.instanceArray.length; i++) {
    const tid = c2t.get(i);
    if (tid !== undefined) suitMap.set(tid, (rd.instanceArray[i] & 0x3F) + 1);
  }
  for (const de of rd.dockEntries) {
    const tid = c2t.get(de.tileId);
    if (tid !== undefined) suitMap.set(tid, de.element);
  }

  return { freeTiles, suitMap, allTiles };
}

export function runEnhancedDAGAnalysis(sampleSize?: number): EnhancedDAGResult[] {
  const files = readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
  const boards: CachedBoard[] = [];

  // 加载所有缓存board
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(join(CACHE_DIR, f), 'utf-8'));
      if (!d.error && d.dfs) boards.push(d);
    } catch {}
  }

  // 选择样本：包含所有unsolved + 对solved做分层采样
  const unsolved = boards.filter(b => !b.dfs?.win);
  const solved = boards.filter(b => b.dfs?.win);

  // 分层采样 solved: 按cgEdgeCount分bin，每层取一定数量
  const bins: [number, number][] = [
    [0, 30], [30, 70], [70, 120], [120, 180], [180, 500],
  ];
  const sampledSolved: CachedBoard[] = [];
  const perBin = sampleSize ? Math.ceil(sampleSize / bins.length) : 10;

  for (const [lo, hi] of bins) {
    const inBin = solved.filter(b => {
      const e = (b.features.cgEdgeCount as number) ?? 0;
      return e >= lo && e < hi;
    });
    sampledSolved.push(...inBin.slice(0, perBin));
  }

  const sample = [...unsolved, ...sampledSolved];
  console.log(`Analyzing ${sample.length} boards (${unsolved.length} unsolved + ${sampledSolved.length} solved samples)...`);

  const results: EnhancedDAGResult[] = [];
  let done = 0;
  let skipped = 0;

  // 预加载terrain数据缓存 (同一levelResId只需加载一次)
  const terrainCache = new Map<number, TerrainTile[]>();

  for (const b of sample) {
    try {
      // 缓存terrain
      let freeTiles: TerrainTile[];
      let suitMap: Map<number, number>;

      const cacheKey = b.board.levelResId;
      const prev = terrainCache.get(cacheKey);
      // 每次都需重新解码 replay (不同 replayKey)
      const data = loadBoardData(b.board.levelResId, b.board.replayKey);
      freeTiles = data.freeTiles;
      suitMap = data.suitMap;

      const dag = buildEnhancedDAG(freeTiles, suitMap);
      const death = analyzeDeathMechanism(dag);
      const validation = validateDAGPrediction(dag, b.dfs?.win ?? false, b.dfs?.statesVisited ?? 0);

      const oldCgDAG = buildColorGroupDAG(freeTiles, suitMap);

      results.push({
        board: b.board,
        dag,
        death,
        validation,
        oldFeatures: {
          cgNodeCount: oldCgDAG.nodes.length,
          cgEdgeCount: oldCgDAG.edges.length,
          cgParallelSources: oldCgDAG.parallelGroups,
          cgSinkCount: dag.exitColors.length,
          exclusiveEdgeCount: dag.exclusiveEdges.length,
          sharedEdgeCount: dag.sharedEdges.length,
          entryColorCount: dag.entryColors.length,
          maxExclusiveChainLength: dag.maxExclusiveChainLength,
          deadlockRingCount: dag.deadlockRings.length,
          exclusiveRingCount: dag.exclusiveRings.length,
          internalBlockingColors: dag.nodes.filter(n => n.hasInternalBlocking).length,
          layerParallelism: dag.layerParallelism,
          perfectChainCount: dag.perfectChains.length,
        },
      });

      done++;
      if (done % 10 === 0) {
        console.log(`  Progress: ${done}/${sample.length} (skipped: ${skipped})`);
      }
    } catch (e: any) {
      skipped++;
      if (skipped <= 5) {
        console.warn(`  Skip ${b.board.levelResId}/${b.board.replayKey}: ${e.message?.slice(0, 80)}`);
      }
      done++;
      if (done % 10 === 0) {
        console.log(`  Progress: ${done}/${sample.length} (skipped: ${skipped})`);
      }
    }
  }

  console.log(`Done. ${results.length} results, ${skipped} skipped.`);
  return results;
}

// ═══════════════════════════════════════════════════
//  报告生成
// ═══════════════════════════════════════════════════

export function generateEnhancedReport(results: EnhancedDAGResult[]): string {
  const lines: string[] = [];

  lines.push('═'.repeat(80));
  lines.push('  增强DAG 分析报告');
  lines.push('═'.repeat(80));
  lines.push('');

  // ── 1. 验证精度 ──
  const correct = results.filter(r => r.validation.consistent);
  const incorrect = results.filter(r => !r.validation.consistent);
  const falsePositive = incorrect.filter(r => r.validation.predictedSolvable === false && r.validation.dfsSolved === true);
  const falseNegative = incorrect.filter(r => r.validation.predictedSolvable === true && r.validation.dfsSolved === false);

  lines.push(`## 1. 预测准确性`);
  lines.push('');
  lines.push(`  总样本: ${results.length}`);
  lines.push(`  正确预测: ${correct.length} (${(correct.length * 100 / results.length).toFixed(1)}%)`);
  lines.push(`  错误预测: ${incorrect.length} (${(incorrect.length * 100 / results.length).toFixed(1)}%)`);
  lines.push(`    - 假阳性(DAG判死不实际可解): ${falsePositive.length}`);
  lines.push(`    - 假阴性(DAG判可解实际不): ${falseNegative.length}`);
  lines.push('');

  // ── 2. 死亡机制分布 ──
  lines.push(`## 2. 死亡机制分布`);
  lines.push('');
  const mechCounts = new Map<string, { total: number; unsolved: number; correct: number }>();
  for (const r of results) {
    const m = r.death.mechanism;
    if (!mechCounts.has(m)) mechCounts.set(m, { total: 0, unsolved: 0, correct: 0 });
    const c = mechCounts.get(m)!;
    c.total++;
    if (!r.validation.dfsSolved) c.unsolved++;
    if (r.validation.consistent) c.correct++;
  }

  for (const [mech, stats] of [...mechCounts.entries()].sort(([, a], [, b]) => b.total - a.total)) {
    const pct = (stats.unsolved * 100 / stats.total).toFixed(1);
    const acc = (stats.correct * 100 / stats.total).toFixed(1);
    lines.push(`  ${mech.padEnd(25)} | 总数:${String(stats.total).padStart(4)} | 不可解:${String(stats.unsolved).padStart(3)}(${pct}%) | 预测正确:${acc}%`);
  }
  lines.push('');

  // ── 3. 新特征 vs 旧特征的区分力 ──
  lines.push(`## 3. 增强特征 vs 旧特征的区分力`);
  lines.push('');

  const unsolvedResults = results.filter(r => !r.validation.dfsSolved);
  const solvedResults = results.filter(r => r.validation.dfsSolved);

  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  const featurePairs: { name: string; getter: (r: EnhancedDAGResult) => number }[] = [
    { name: '独占边数', getter: r => r.oldFeatures.exclusiveEdgeCount },
    { name: '共享边数', getter: r => r.oldFeatures.sharedEdgeCount },
    { name: '独占环数', getter: r => r.oldFeatures.exclusiveRingCount },
    { name: '死锁环数', getter: r => r.oldFeatures.deadlockRingCount },
    { name: '最大独占链长', getter: r => r.oldFeatures.maxExclusiveChainLength },
    { name: '完美链数', getter: r => r.oldFeatures.perfectChainCount },
    { name: '入口色数', getter: r => r.oldFeatures.entryColorCount },
    { name: '色内阻塞色数', getter: r => r.oldFeatures.internalBlockingColors },
    { name: '(旧)cgEdgeCount', getter: r => r.oldFeatures.cgEdgeCount },
    { name: '(旧)cgNodeCount', getter: r => r.oldFeatures.cgNodeCount },
    { name: '(旧)parallelSources', getter: r => r.oldFeatures.cgParallelSources },
  ];

  lines.push(`  ${'特征'.padEnd(22)} | ${'不可解均值'.padStart(10)} | ${'可解均值'.padStart(10)} | 倍率`);
  lines.push(`  ${'-'.repeat(22)} | ${'-'.repeat(10)} | ${'-'.repeat(10)} | ----`);

  for (const { name, getter } of featurePairs) {
    const uAvg = avg(unsolvedResults.map(getter));
    const sAvg = avg(solvedResults.map(getter));
    const ratio = sAvg > 0 ? (uAvg / sAvg) : (uAvg > 0 ? Infinity : 1);
    const ratioStr = ratio === Infinity ? '∞' : ratio.toFixed(2);
    const marker = ratio >= 2 ? ' ★' : ratio >= 1.5 ? ' ↑' : '';
    lines.push(`  ${name.padEnd(22)} | ${uAvg.toFixed(1).padStart(10)} | ${sAvg.toFixed(1).padStart(10)} | ${ratioStr}${marker}`);
  }
  lines.push('');

  // ── 4. 死锁环详细 ──
  const ringResults = results.filter(r => r.dag.exclusiveRings.length > 0 || r.dag.mixedRings.length > 0);
  lines.push(`## 4. 死锁环牌局 (${ringResults.length}个)`);
  lines.push('');

  for (const r of ringResults.slice(0, 30)) {
    const dfsStatus = r.validation.dfsSolved ? '✓可解' : '✗不可解';
    const rings = [
      ...r.dag.exclusiveRings.map(c => `独占[${c.join('→')}]`),
      ...r.dag.mixedRings.map(c => `混合[${c.join('→')}]`),
    ].join('; ');
    lines.push(`  ${r.board.levelResId} ${dfsStatus} | 机制:${r.death.mechanism} | 环:${rings}`);
  }
  lines.push('');

  // ── 5. 完美链牌局 ──
  const chainResults = results.filter(r => r.dag.perfectChains.length > 0);
  lines.push(`## 5. 完美独占链牌局 (${chainResults.length}个)`);
  lines.push('');

  for (const r of chainResults.slice(0, 20)) {
    const chains = r.dag.perfectChains.map(c => `[${c.join('→')}](长${c.length})`).join(', ');
    const dfsStatus = r.validation.dfsSolved ? '✓可解' : '✗不可解';
    lines.push(`  ${r.board.levelResId} ${dfsStatus} | 链:${chains}`);
  }
  lines.push('');

  // ── 6. DAG 完整性诊断 ──
  lines.push(`## 6. DAG 完整性诊断`);
  lines.push('');

  // 信息丢失检查: 比较新旧DAG的特征
  const oldEdgeDensity = results.map(r => r.oldFeatures.cgEdgeCount / Math.max(r.oldFeatures.cgNodeCount * (r.oldFeatures.cgNodeCount - 1), 1));
  const newEdgeDensity = results.map(r =>
    (r.oldFeatures.exclusiveEdgeCount + r.oldFeatures.sharedEdgeCount) /
    Math.max(r.oldFeatures.cgNodeCount * (r.oldFeatures.cgNodeCount - 1), 1)
  );

  // 检查: 旧DAG有边但增强DAG无边 (信息丢失)
  let infoLossCount = 0;
  for (const r of results) {
    if (r.oldFeatures.cgEdgeCount > 0 &&
      r.oldFeatures.exclusiveEdgeCount === 0 &&
      r.oldFeatures.sharedEdgeCount === 0) {
      infoLossCount++;
    }
  }
  lines.push(`  旧DAG有边但增强DAG无边的牌局: ${infoLossCount}/${results.length} (信息丢失)`);

  // 增强多出的信息
  const hasInternalBlocking = results.filter(r => r.oldFeatures.internalBlockingColors > 0).length;
  const hasExclusiveRings = results.filter(r => r.oldFeatures.exclusiveRingCount > 0).length;
  const hasPerfectChains = results.filter(r => r.oldFeatures.perfectChainCount > 0).length;

  lines.push(`  增强DAG新增信息:`);
  lines.push(`    - 色内阻塞: ${hasInternalBlocking} 牌局 (${(hasInternalBlocking * 100 / results.length).toFixed(1)}%)`);
  lines.push(`    - 独占环:   ${hasExclusiveRings} 牌局 (${(hasExclusiveRings * 100 / results.length).toFixed(1)}%)`);
  lines.push(`    - 完美链:   ${hasPerfectChains} 牌局 (${(hasPerfectChains * 100 / results.length).toFixed(1)}%)`);
  lines.push('');

  // ── 7. 确定性规则 ──
  lines.push(`## 7. 确定性规则 (基于增强DAG)`);
  lines.push('');

  const rules: { name: string; pred: (r: EnhancedDAGResult) => boolean }[] = [
    {
      name: 'EXCLUSIVE_RING ≥ 1 → UNSOLVABLE',
      pred: r => r.dag.exclusiveRings.length >= 1,
    },
    {
      name: 'DEADLOCK_RING ≥ 1 ∧ ENTRY_COLORS=0 → UNSOLVABLE',
      pred: r => r.dag.deadlockRings.length >= 1 && r.dag.entryColors.length === 0,
    },
    {
      name: 'EXCLUSIVE_RING=0 ∧ ENTRY_COLORS≥1 → SOLVABLE',
      pred: r => r.dag.exclusiveRings.length === 0 && r.dag.entryColors.length >= 1,
    },
    {
      name: 'EXCLUSIVE_CHAIN ≤ 0 ∧ ALL_BLOCK_SHARED → UNSOLVABLE',
      pred: r => r.oldFeatures.maxExclusiveChainLength === 0
        && r.oldFeatures.sharedEdgeCount > r.oldFeatures.exclusiveEdgeCount * 3,
    },
    {
      name: 'INTERNAL_BLOCKING > 0 → COMPLEX',
      pred: r => r.oldFeatures.internalBlockingColors > 0,
    },
    {
      name: 'NO_ENTRY ∧ INITIAL_CLICKABLE=0 → IMMEDIATE_DEATH',
      pred: r => r.dag.entryColors.length === 0
        && r.dag.nodes.every(n => n.initiallyClickable < 3),
    },
  ];

  for (const { name, pred } of rules) {
    const hits = results.filter(pred);
    const unsolvableInHits = hits.filter(r => !r.validation.dfsSolved);
    const solvableInHits = hits.filter(r => r.validation.dfsSolved);
    const accuracy = hits.length > 0 ? (unsolvableInHits.length * 100 / hits.length) : 0;

    let verdict: string;
    if (hits.length === 0) {
      verdict = '(无匹配)';
    } else if (unsolvableInHits.length === hits.length) {
      verdict = `★ 确定性: ${hits.length}/${hits.length} 全部不可解`;
    } else if (solvableInHits.length === hits.length) {
      verdict = `★ 确定性: ${hits.length}/${hits.length} 全部可解`;
    } else {
      verdict = `⚠ 部分匹配: ${unsolvableInHits.length}/${hits.length} 不可解 (${accuracy.toFixed(1)}%)`;
    }

    lines.push(`  ${name}`);
    lines.push(`    命中: ${hits.length} 牌局 | ${verdict}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════
//  CLI entry
// ═══════════════════════════════════════════════════

export function main() {
  console.log('Enhanced DAG Analysis');
  console.log('='.repeat(60));

  // 全部 unsolved (74) + 每bin 10个 solved = ~124
  const results = runEnhancedDAGAnalysis(10);

  const report = generateEnhancedReport(results);

  // 写入报告
  const reportPath = join(OUTPUT_DIR, 'enhanced-dag-report.md');
  writeFileSync(reportPath, report);

  // 写入JSON数据
  const jsonPath = join(OUTPUT_DIR, 'enhanced-dag-results.json');
  writeFileSync(jsonPath, JSON.stringify(results.map(r => ({
    board: r.board,
    death: {
      mechanism: r.death.mechanism,
      deathDepth: r.death.deathDepth,
      involvedColors: r.death.involvedColors,
      description: r.death.description,
      confidence: r.death.confidence,
    },
    validation: r.validation,
    oldFeatures: r.oldFeatures,
    dagSummary: {
      nodes: r.dag.nodes.length,
      entryColors: r.dag.entryColors,
      exitColors: r.dag.exitColors,
      exclusiveEdges: r.dag.exclusiveEdges.length,
      sharedEdges: r.dag.sharedEdges.length,
      deadlockRings: r.dag.deadlockRings.length,
      exclusiveRings: r.dag.exclusiveRings.length,
      perfectChains: r.dag.perfectChains.length,
      layerParallelism: r.dag.layerParallelism,
    },
  })), null, 2));

  console.log(report);
  console.log(`\nReport saved to: ${reportPath}`);
  console.log(`JSON data saved to: ${jsonPath}`);
}

// 直接运行时执行
if (process.argv[1]?.endsWith('enhanced-dag.ts') || process.argv[1]?.endsWith('enhanced-dag.js')) {
  main();
}
