/**
 * Elimination Plan — 消除计划器。
 *
 * 核心理念:
 *   牌局的可解性证明 = 一条完整的消除序列。
 *   消除序列是一个逻辑结构，每步都有明确的前提条件和释放结果。
 *   前提条件和释放结果都可以从地形依赖图中纯逻辑地推导。
 *
 * 本模块:
 *   1. 分析地形，枚举所有可能的 triple 及其前提/释放条件
 *   2. 构建 triple 之间的逻辑依赖图（"消除A后才能消B"的充要条件）
 *   3. 在依赖图上找到完整的消除序列
 *   4. 序列本身就是可解性证明
 *
 * 与 ReverseGen 的区别:
 *   ReverseGen: 贪心选triple → 反向分配花色 → 模拟验证
 *   本模块: 逻辑推导triple序列 → 序列即证明 → 分配花色是实现细节
 *
 * 与 generate-v3 的区别:
 *   generate-v3: 正向构造triple（启发式评分）
 *   本模块: 枚举所有可能的triple序列（逻辑穷举 + 剪枝）
 */

import type { TerrainTile, TerrainData } from '../../src/types.js';
import { getAllTiles, loadTerrainFromFile } from '../../src/terrain-loader.js';
import { computeAllDependencies } from '../../src/dependency-graph.js';
import { sortTriple } from '../../src/types.js';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

// ═══════════════════════════════════════════════════
//  Triple 前提/释放 分析
// ═══════════════════════════════════════════════════

/**
 * 一个 triple 的逻辑信息:
 *   - 哪3张tile
 *   - 消除前提: 这3张tile必须在消除时都可点
 *   - 释放结果: 消除后哪些tile变为可点（通过"独占阻塞"）
 */
export interface TripleLogic {
  /** 三张tile ID (排序) */
  tileIds: [number, number, number];
  /** depSet: 传递依赖闭包 ∪ 三张tile自身 */
  depSet: Set<number>;
  /** 消除前提: 消除这3张tile之前，哪些tile必须先被消除 */
  prerequisites: Set<number>;
  /** 独占释放: 消除这3张后，哪些tile的"唯一剩余blocker"被移除 */
  exclusiveRelease: Set<number>;
  /** 共享释放: 消除后，哪些tile的blocker减少但不是归零 */
  sharedRelease: Set<number>;
  /** 该triple是否合法（三张tile不会互相阻塞） */
  isValid: boolean;
}

/**
 * 对给定tile集合，分析每个C(k,3)组合的逻辑属性。
 */
export function analyzeTripleLogic(
  tiles: TerrainTile[],
  allDeps: Map<number, Set<number>>,
): TripleLogic[] {
  const tileMap = new Map<number, TerrainTile>();
  for (const t of tiles) tileMap.set(t.id, t);

  // 构建反向阻塞图: tileId → 被它直接阻塞的tile集合
  const blocksMap = new Map<number, Set<number>>();
  for (const t of tiles) blocksMap.set(t.id, new Set());
  for (const t of tiles) {
    for (const depId of t.dependencies) {
      if (tileMap.has(depId)) {
        blocksMap.get(depId)?.add(t.id);
      }
    }
  }

  // 计算每张tile的"前提集"（消除前必须先被消除的tile）
  function getPrerequisites(tileId: number): Set<number> {
    const prereqs = new Set<number>();
    // 该tile的直接依赖中的自由牌 → 必须先消除
    const tile = tileMap.get(tileId);
    if (!tile) return prereqs;
    for (const depId of tile.dependencies) {
      if (tileMap.has(depId)) prereqs.add(depId);
    }
    return prereqs;
  }

  const result: TripleLogic[] = [];
  const n = tiles.length;

  // 完整枚举 C(n,3)
  for (let i = 0; i < n - 2; i++) {
    for (let j = i + 1; j < n - 1; j++) {
      for (let k = j + 1; k < n; k++) {
        const a = tiles[i], b = tiles[j], c = tiles[k];

        // depSet: 三张tile的传递依赖闭包 + 自身
        const depSet = new Set<number>();
        for (const tid of [a.id, b.id, c.id]) {
          depSet.add(tid);
          const deps = allDeps.get(tid);
          if (deps) for (const d of deps) depSet.add(d);
        }

        // 前提集: 三张tile各自的直接依赖（自由牌）的并集
        const prerequisites = new Set<number>();
        for (const tid of [a.id, b.id, c.id]) {
          for (const p of getPrerequisites(tid)) {
            if (!depSet.has(p)) prerequisites.add(p); // 不在depSet中 = 不是自身的依赖传递
          }
        }

        // 合法性检查: triple内部的3张tile不能互相阻塞
        const tripleSet = new Set([a.id, b.id, c.id]);
        let isValid = true;
        for (const tid of [a.id, b.id, c.id]) {
          const prereqs = getPrerequisites(tid);
          for (const p of prereqs) {
            if (tripleSet.has(p)) { isValid = false; break; }
          }
          if (!isValid) break;
        }

        // 独占释放: 消除这3张后，哪些其他tile的"所有blocker都不在desk上了"
        const exclusiveRelease = new Set<number>();
        const sharedRelease = new Set<number>();

        // 被这3张阻塞的所有tile
        const blockedByUs = new Set<number>();
        for (const tid of [a.id, b.id, c.id]) {
          const blocked = blocksMap.get(tid);
          if (blocked) for (const btid of blocked) blockedByUs.add(btid);
        }

        for (const btid of blockedByUs) {
          const bt = tileMap.get(btid);
          if (!bt) continue;
          // 该tile的所有blocker
          const allBlockers = bt.dependencies.filter(d => tileMap.has(d));
          // 如果所有blocker都在 (depSet ∪ prerequisites) 中 → 释放
          // 实际上"独占释放"意味着所有blocker都在本triple的depSet中
          const allBlockedByTriple = allBlockers.every(bid => depSet.has(bid));
          if (allBlockedByTriple) {
            exclusiveRelease.add(btid);
          } else if (allBlockers.some(bid => depSet.has(bid))) {
            sharedRelease.add(btid);
          }
        }

        result.push({
          tileIds: sortTriple(a.id, b.id, c.id),
          depSet,
          prerequisites,
          exclusiveRelease,
          sharedRelease,
          isValid,
        });
      }
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════
//  消除计划: 逻辑推导完整序列
// ═══════════════════════════════════════════════════

/**
 * 一个消除步骤。
 */
export interface EliminationStep {
  /** 步骤序号 (0-based) */
  step: number;
  /** 选中的 triple */
  triple: TripleLogic;
  /** 这一步有多少个可选 triple（分支数） */
  branchCount: number;
  /** 消除后释放的独占 tile 数 */
  released: number;
}

/**
 * 完整的消除计划。
 * 如果 complete=true，序列覆盖所有free tile → 可解性证明。
 * 如果 complete=false，在某步无法继续 → diedAt 指示死亡步。
 */
export interface EliminationPlan {
  /** 消除步骤序列 */
  steps: EliminationStep[];
  /** 序列是否覆盖全部 free tile */
  complete: boolean;
  /** 如果不完整，在哪一步死亡 */
  diedAt: number;
  /** 如果死亡，死亡原因 */
  deathReason: string;
  /** 总共有多少合法 triple */
  totalTriples: number;
  /** 覆盖了多少 tile */
  coveredTiles: number;
  /** 每步的分支数日志 */
  branchLog: number[];
}

/**
 * 从地形构建完整的消除计划。
 *
 * 算法:
 *   1. 枚举所有合法 triple
 *   2. 每一步: 找到所有"前提已满足"的 triple
 *   3. 选择"释放最多独占tile"的 triple（确定性策略）
 *   4. 标记被选 triple 的 tile 为"已消除"
 *   5. 标记释放 tile 为"前提已满足"
 *   6. 重复直到无可用 triple 或所有 tile 已消除
 *
 * 这不是"贪心启发式"——它是在搜索空间中使用确定性策略。
 * 改变第3步的选择策略可以得到不同的序列（分支点）。
 */
export function buildEliminationPlan(
  tiles: TerrainTile[],
  allDeps: Map<number, Set<number>>,
  options?: {
    /** 分支选择策略 */
    strategy?: 'max-release' | 'min-release' | 'first-valid';
    /** 每步最大候选数（用于控制分支展示） */
    maxCandidates?: number;
  },
): EliminationPlan {
  const { strategy = 'max-release', maxCandidates = 50 } = options ?? {};

  const allTriples = analyzeTripleLogic(tiles, allDeps);
  const validTriples = allTriples.filter(t => t.isValid);

  const tileMap = new Map<number, TerrainTile>();
  for (const t of tiles) tileMap.set(t.id, t);

  const eliminated = new Set<number>(); // 已消除的tile

  // ── 动态依赖追踪 ──
  // remainingDeps[tileId] = 该tile的直接依赖中仍在desk上的自由牌集合
  const remainingDeps = new Map<number, Set<number>>();
  for (const tile of tiles) {
    const rd = new Set<number>();
    for (const depId of tile.dependencies) {
      if (tileMap.has(depId)) rd.add(depId);
    }
    remainingDeps.set(tile.id, rd);
  }

  // freed: remainingDeps为空的tile（可消除）
  const getFreed = (): Set<number> => {
    const f = new Set<number>();
    for (const tile of tiles) {
      if (!eliminated.has(tile.id)) {
        const rd = remainingDeps.get(tile.id);
        if (rd && rd.size === 0) f.add(tile.id);
      }
    }
    return f;
  };

  const steps: EliminationStep[] = [];
  const branchLog: number[] = [];
  let coveredTiles = 0;

  // 用于高效查找（避免每步重建整个freed集合）
  const freedSet = getFreed();

  for (let stepNum = 0; ; stepNum++) {
    // 找到所有当前可用的 triple: 三张tile都在freed中且未被消除
    const freed = freedSet;
    const candidates = validTriples.filter(t => {
      return t.tileIds.every(id => freed.has(id) && !eliminated.has(id));
    });

    if (candidates.length === 0) {
      // 无法继续
      const remainingTiles = tiles.filter(t => !eliminated.has(t.id)).length;
      return {
        steps,
        complete: remainingTiles === 0,
        diedAt: stepNum,
        deathReason: remainingTiles > 0
          ? `${remainingTiles} tiles remain, no valid triple available`
          : 'All tiles eliminated (should not reach here)',
        totalTriples: validTriples.length,
        coveredTiles,
        branchLog,
      };
    }

    // 记录分支数
    branchLog.push(candidates.length);

    // 选择策略
    let chosen: TripleLogic;
    switch (strategy) {
      case 'max-release':
        chosen = candidates.reduce((best, c) =>
          c.exclusiveRelease.size > best.exclusiveRelease.size ? c : best
        );
        break;
      case 'min-release':
        chosen = candidates.reduce((best, c) =>
          c.exclusiveRelease.size < best.exclusiveRelease.size ? c : best
        );
        break;
      case 'first-valid':
        chosen = candidates[0];
        break;
    }

    // 消除: 从remainingDeps中移除选中tile的阻塞
    let releasedThisStep = 0;
    for (const id of chosen.tileIds) {
      eliminated.add(id);
      freedSet.delete(id);
      coveredTiles++;
      // 从阻塞图中移除该tile → 被它阻塞的tile的remainingDeps减1
      for (const [tid, rd] of remainingDeps) {
        if (eliminated.has(tid)) continue;
        if (rd.delete(id) && rd.size === 0) {
          freedSet.add(tid);
          releasedThisStep++;
        }
      }
    }

    steps.push({
      step: stepNum,
      triple: chosen,
      branchCount: candidates.length,
      released: releasedThisStep,
    });

    if (eliminated.size >= tiles.length) break;
    if (stepNum > tiles.length) break; // 安全上限
  }

  return {
    steps,
    complete: eliminated.size >= tiles.length,
    diedAt: -1,
    deathReason: '',
    totalTriples: validTriples.length,
    coveredTiles,
    branchLog,
  };
}

// ═══════════════════════════════════════════════════
//  多分支枚举: 找到所有可能的消除序列
// ═══════════════════════════════════════════════════

export interface SequenceNode {
  triple: TripleLogic;
  children: SequenceNode[];
  depth: number;
  terminal: boolean; // 是否通向胜利
  leafCount: number; // 该分支下的叶节点数
}

/**
 * 构建序列树。
 * 用 BFS + memoization 枚举所有可能的消除序列。
 * 可以回答: "有多少条不同的消除路径？" "每一步有多少实际分支？"
 */
export function buildSequenceTree(
  tiles: TerrainTile[],
  allDeps: Map<number, Set<number>>,
  maxNodes: number = 100000,
): { root: SequenceNode | null; totalNodes: number; exhausted: boolean } {
  const validTriples = analyzeTripleLogic(tiles, allDeps).filter(t => t.isValid);

  // 初始可消除的tile
  const initialFreed = new Set<number>();
  for (const tile of tiles) {
    const hasFreeDep = tile.dependencies.some(d => tiles.some(ft => ft.id === d));
    if (!hasFreeDep) initialFreed.add(tile.id);
  }

  // State = sorted eliminated IDs → memoized result
  const memo = new Map<string, SequenceNode | null>();
  let totalNodes = 0;
  let exhausted = true;

  function buildNode(eliminated: Set<number>, freed: Set<number>): SequenceNode | null {
    totalNodes++;
    if (totalNodes > maxNodes) { exhausted = false; return null; }

    const stateKey = [...eliminated].sort((a, b) => a - b).join(',');
    const cached = memo.get(stateKey);
    if (cached !== undefined) return cached;

    // 找到所有候选
    const candidates = validTriples.filter(t =>
      t.tileIds.every(id => freed.has(id) && !eliminated.has(id))
    );

    if (candidates.length === 0) {
      const remaining = tiles.filter(t => !eliminated.has(t.id));
      memo.set(stateKey, null);
      return null;
    }

    // 如果一个候选能消除所有剩余tile → 叶节点
    if (eliminated.size + 3 >= tiles.length && candidates.length > 0) {
      const leaf: SequenceNode = {
        triple: candidates[0],
        children: [],
        depth: -1, // 将由parent计算
        terminal: true,
        leafCount: 1,
      };
      memo.set(stateKey, leaf);
      return leaf;
    }

    // 构建子节点
    const children: SequenceNode[] = [];
    for (const cand of candidates) {
      const newElim = new Set(eliminated);
      const newFreed = new Set(freed);
      for (const id of cand.tileIds) {
        newElim.add(id);
        newFreed.delete(id);
      }
      for (const id of cand.exclusiveRelease) {
        newFreed.add(id);
      }
      const child = buildNode(newElim, newFreed);
      if (child) children.push(child);
      if (!exhausted) break;
    }

    if (children.length === 0) {
      memo.set(stateKey, null);
      return null;
    }

    const node: SequenceNode = {
      triple: candidates[0], // 代表候选之一
      children,
      depth: 0,
      terminal: children.length > 0,
      leafCount: children.reduce((s, c) => s + c.leafCount, 0),
    };

    memo.set(stateKey, node);
    return node;
  }

  const root = buildNode(new Set(), initialFreed);
  return { root, totalNodes, exhausted };
}

// ═══════════════════════════════════════════════════
//  消除计划的逻辑验证
// ═══════════════════════════════════════════════════

/**
 * 验证消除计划的逻辑正确性。
 * 不依赖任何启发式——纯逻辑检查。
 */
export interface PlanValidation {
  /** 计划是否逻辑有效 */
  valid: boolean;
  /** 如果无效，具体哪一步有问题 */
  errors: {
    step: number;
    tileIds: [number, number, number];
    issue: string;
  }[];
  /** 每步的前提条件是否满足 */
  prerequisiteChecks: {
    step: number;
    satisfied: boolean;
    missingPrerequisites: number[];
    tilesAvailable: boolean;
    tilesNotBlockingEachOther: boolean;
  }[];
}

export function validatePlan(
  tiles: TerrainTile[],
  plan: EliminationPlan,
): PlanValidation {
  const tileMap = new Map<number, TerrainTile>();
  for (const t of tiles) tileMap.set(t.id, t);

  const eliminated = new Set<number>();
  const errors: PlanValidation['errors'] = [];
  const prerequisiteChecks: PlanValidation['prerequisiteChecks'] = [];

  for (const step of plan.steps) {
    const { triple } = step;
    const missingPrereqs: number[] = [];
    let tilesAvailable = true;
    let tilesNotBlockingEachOther = true;

    // 检查1: 三张tile未被消除
    for (const id of triple.tileIds) {
      if (eliminated.has(id)) {
        tilesAvailable = false;
        errors.push({
          step: step.step,
          tileIds: triple.tileIds,
          issue: `Tile ${id} already eliminated`,
        });
      }
    }

    // 检查2: 三张tile的依赖都已满足
    for (const id of triple.tileIds) {
      const tile = tileMap.get(id);
      if (!tile) continue;
      for (const depId of tile.dependencies) {
        const isFreeTile = tileMap.has(depId);
        if (isFreeTile && !eliminated.has(depId)) {
          missingPrereqs.push(depId);
        }
      }
    }

    // 检查3: triple内部不互相阻塞
    const tripleSet = new Set(triple.tileIds);
    for (const id of triple.tileIds) {
      const tile = tileMap.get(id);
      if (!tile) continue;
      for (const depId of tile.dependencies) {
        if (tripleSet.has(depId)) {
          tilesNotBlockingEachOther = false;
          errors.push({
            step: step.step,
            tileIds: triple.tileIds,
            issue: `Tiles ${id} and ${depId} block each other in same triple`,
          });
        }
      }
    }

    prerequisiteChecks.push({
      step: step.step,
      satisfied: missingPrereqs.length === 0,
      missingPrerequisites: missingPrereqs,
      tilesAvailable,
      tilesNotBlockingEachOther,
    });

    if (missingPrereqs.length > 0) {
      errors.push({
        step: step.step,
        tileIds: triple.tileIds,
        issue: `Missing prerequisites: [${missingPrereqs.join(', ')}]`,
      });
      break; // 一旦前提不满足，后续检查无意义
    }

    // 更新状态
    for (const id of triple.tileIds) eliminated.add(id);
  }

  return {
    valid: errors.length === 0 && plan.complete,
    errors,
    prerequisiteChecks,
  };
}

// ═══════════════════════════════════════════════════
//  从计划导出花色分配
// ═══════════════════════════════════════════════════

/**
 * 消除计划 → 花色分配。
 * 默认: 每步一个独立色（3张一色）。
 * 可以合并相邻步骤到同一色（共享花色，色内多triple）。
 */
export function planToAssignment(
  plan: EliminationPlan,
  colorScheme?: {
    /** 每色的 triple 数: 1 = 独立色(3张/色), 2 = 6张/色, 3 = 9张/色 */
    triplesPerColor?: number;
    /** 显式指定: 哪些步骤共享颜色 */
    colorGroups?: number[][];
  },
): Map<number, number> {
  const assignments = new Map<number, number>();
  let nextColor = 1;

  if (colorScheme?.colorGroups) {
    // 显式分组
    for (const group of colorScheme.colorGroups) {
      const color = nextColor++;
      for (const stepIdx of group) {
        if (stepIdx < plan.steps.length) {
          for (const id of plan.steps[stepIdx].triple.tileIds) {
            assignments.set(id, color);
          }
        }
      }
    }
  } else {
    const tpc = colorScheme?.triplesPerColor ?? 1;
    let tripleCount = 0;
    let currentColor = nextColor++;

    for (const step of plan.steps) {
      for (const id of step.triple.tileIds) {
        assignments.set(id, currentColor);
      }
      tripleCount++;
      if (tripleCount >= tpc) {
        tripleCount = 0;
        currentColor = nextColor++;
      }
    }
  }

  return assignments;
}

// ═══════════════════════════════════════════════════
//  CLI: 快速测试
// ═══════════════════════════════════════════════════

export function main() {
  const TERRAIN_DIR = process.env.TERRAIN_DIR
    || 'E:/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';

  const terrainPath = join(TERRAIN_DIR, '100002.json');

  if (!existsSync(terrainPath)) {
    console.error(`Terrain not found: ${terrainPath}`);
    return;
  }

  const terrain: TerrainData = loadTerrainFromFile(terrainPath);
  const tiles: TerrainTile[] = [];
  for (const l of terrain.layers) for (const t of l.tiles) tiles.push(t);
  const freeTiles = tiles.filter(t => !t.isConst);

  console.log(`Terrain: 100002, free tiles: ${freeTiles.length}, triples: ${Math.floor(freeTiles.length / 3)}`);

  const allDeps = computeAllDependencies(freeTiles);
  const triples = analyzeTripleLogic(freeTiles, allDeps);
  const validTriples = triples.filter(t => t.isValid);

  console.log(`Total triples: ${triples.length}, Valid: ${validTriples.length}`);
  console.log(`Invalid (internal blocking): ${triples.length - validTriples.length}`);

  // 统计: 独占释放能力
  const releaseStats = validTriples.map(t => t.exclusiveRelease.size);
  console.log(`Exclusive release: min=${Math.min(...releaseStats)} max=${Math.max(...releaseStats)} avg=${(releaseStats.reduce((a,b)=>a+b,0)/releaseStats.length).toFixed(1)}`);

  // 构建消除计划
  const plan = buildEliminationPlan(freeTiles, allDeps, { strategy: 'max-release' });
  console.log(`\nElimination Plan:`);
  console.log(`  Complete: ${plan.complete}`);
  console.log(`  Steps: ${plan.steps.length}`);
  console.log(`  Covered tiles: ${plan.coveredTiles}/${freeTiles.length}`);
  console.log(`  Branch log: [${plan.branchLog.join(', ')}]`);

  if (!plan.complete) {
    console.log(`  Died at step: ${plan.diedAt}`);
    console.log(`  Death reason: ${plan.deathReason}`);
  }

  // 验证
  const validation = validatePlan(freeTiles, plan);
  console.log(`\nValidation: ${validation.valid ? '✅ VALID' : '❌ INVALID'}`);
  if (validation.errors.length > 0) {
    for (const err of validation.errors.slice(0, 5)) {
      console.log(`  Step ${err.step}: ${err.issue}`);
    }
  }

  // 打印前几步
  console.log(`\nFirst 5 steps:`);
  for (const step of plan.steps.slice(0, 5)) {
    console.log(`  Step ${step.step}: tiles=[${step.triple.tileIds.join(',')}] ` +
      `branches=${step.branchCount} release=${step.released} ` +
      `prereqs=[${[...step.triple.prerequisites].slice(0, 5).join(',')}${step.triple.prerequisites.size > 5 ? '...' : ''}]`);
  }

  // 分配花色
  const assignments = planToAssignment(plan, { triplesPerColor: 1 });
  const colorCount = new Set(assignments.values()).size;
  console.log(`\nColor assignment: ${colorCount} colors for ${assignments.size} tiles`);

  // 色组大小分布
  const colorSizes = new Map<number, number>();
  for (const [, c] of assignments) colorSizes.set(c, (colorSizes.get(c) ?? 0) + 1);
  const sizes = [...colorSizes.values()];
  console.log(`Color sizes: ${sizes.filter(s => s === 3).length}x3, ${sizes.filter(s => s === 6).length}x6, ${sizes.filter(s => s === 9).length}x9`);
  console.log(`All divisible by 3: ${sizes.every(s => s % 3 === 0) ? '✅' : '❌'}`);
}

// 直接运行
if (process.argv[1]?.endsWith('elimination-plan.ts') || process.argv[1]?.endsWith('elimination-plan.js')) {
  main();
}
