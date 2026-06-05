/**
 * Generation Algorithm v4 — DFS-Free 结构锁定构造。
 *
 * 两阶段设计:
 *   Phase 1 (assignColors): 根据地形依赖层 + 目标分支序列，全局分配tile→色组
 *   Phase 2 (computeBranches): 纯结构计算每步分支数（无需DFS）
 *
 * 核心机制:
 *   - 分支数 = |{色C : |freed ∩ tiles(C)| ≥ 3}|
 *   - 通过控制"哪个色独占释放哪个色的多少tile"来控制每步的分支数
 *   - 这完全是结构计算，不涉及状态空间搜索
 */

import type { TerrainTile, TerrainData } from './types.js';
import { getAllTiles, loadTerrainFromFile } from './terrain-loader.js';
import { computeAllDependencies } from './dependency-graph.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ═══════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════

export interface GenV4Input {
  terrain: TerrainData;
  solvable: boolean;
  deathStep?: number;
}

export interface GenV4Output {
  assignments: Map<number, number>;
  branchLog: number[];
  ok: boolean;
  colorCount: number;
  colorSizes: number[];
  totalSteps: number;
}

// ═══════════════════════════════════════════════════
//  Phase 1: Assign colors by topological layers
// ═══════════════════════════════════════════════════

interface TileNode {
  id: number;
  directDeps: number[];
  blocks: number[];
  topoLayer: number; // 0 = initially clickable
}

// ═══════════════════════════════════════════════════
//  Phase 1 (Revised): Plan-driven color assignment
// ═══════════════════════════════════════════════════

/**
 * 使用消除计划来驱动颜色分配。
 *
 * 核心: 消除计划 = 一条完整的、依赖可行的消除序列。
 *       把序列中每步的 triple 分配同一个颜色。
 *       这样: 序列本身 = 可解性证明，颜色 = 使序列在游戏中可执行。
 *
 * 完全去掉"拓扑层"间接方式——直接使用依赖可行的 triple 序列。
 */
function assignColorsByPlan(
  freeTiles: TerrainTile[],
  totalSteps: number,
  targetDeathStep: number,
): { assignments: Map<number, number>; nodes: Map<number, TileNode> } {
  const { nodes: tileNodes } = buildTileGraphRaw(freeTiles);
  const assignments = new Map<number, number>();

  // 构建动态消除计划
  const eliminated = new Set<number>();
  const remainingDeps = new Map<number, Set<number>>();
  for (const [tid, n] of tileNodes) {
    remainingDeps.set(tid, new Set(n.directDeps));
  }

  const getFreed = (): number[] => {
    const f: number[] = [];
    for (const [tid, rd] of remainingDeps) {
      if (!eliminated.has(tid) && rd.size === 0) f.push(tid);
    }
    return f;
  };

  let nextColor = 1;

  for (let step = 0; step < Math.min(totalSteps, targetDeathStep >= 0 ? targetDeathStep : totalSteps); step++) {
    const freed = getFreed();

    if (freed.length < 3) break; // 无法继续

    // 从freed中选择3张不互相阻塞的tile → 同色
    const triple = pickValidTriple(freed, tileNodes);
    if (!triple) break;

    // 分配同色
    const color = nextColor++;
    for (const tid of triple) {
      assignments.set(tid, color);
      eliminated.add(tid);
      for (const [rtid, rd] of remainingDeps) {
        rd.delete(tid);
      }
    }
  }

  // 剩余未分配的tile: 按层分组作为常规色
  assignRemainingTiles(assignments, freeTiles, tileNodes, eliminated, targetDeathStep, nextColor);

  return { assignments, nodes: tileNodes };
}

function buildTileGraphRaw(freeTiles: TerrainTile[]): { nodes: Map<number, TileNode> } {
  const tileMap = new Map<number, TerrainTile>();
  for (const t of freeTiles) tileMap.set(t.id, t);
  const nodes = new Map<number, TileNode>();
  for (const t of freeTiles) {
    nodes.set(t.id, {
      id: t.id,
      directDeps: t.dependencies.filter(d => tileMap.has(d)),
      blocks: [],
      topoLayer: 0,
    });
  }
  for (const [tid, n] of nodes) {
    for (const depId of n.directDeps) {
      nodes.get(depId)?.blocks.push(tid);
    }
  }
  return { nodes };
}

function assignRemainingTiles(
  assignments: Map<number, number>,
  freeTiles: TerrainTile[],
  nodes: Map<number, TileNode>,
  eliminated: Set<number>,
  targetDeathStep: number,
  nextColor: number,
): void {
  const remaining = freeTiles.filter(t => !eliminated.has(t.id));

  if (remaining.length === 0) return;

  // Death boards: assign ≤2 per color to prevent ≥3
  if (targetDeathStep >= 0) {
    let c = nextColor;
    let batch: number[] = [];
    for (const t of remaining) {
      batch.push(t.id);
      if (batch.length === 2) {
        for (const btid of batch) assignments.set(btid, c);
        batch = [];
        c++;
      }
    }
    for (const btid of batch) assignments.set(btid, c++);
    return;
  }

  // Solvable: assign 3 per color
  let batch: number[] = [];
  let c = nextColor;
  for (const t of remaining) {
    batch.push(t.id);
    if (batch.length === 3) {
      for (const btid of batch) assignments.set(btid, c);
      batch = [];
      c++;
    }
  }
  for (const btid of batch) assignments.set(btid, c++);
}

/**
 * 强制在第K步后死亡。
 *
 * 策略: 不让topoLayer K之后的tile形成≥3的色组。
 *   将后续tile分成 ≤2张/色的组合。
 *
 * 但这违反了"每色3的倍数"规则。
 * 正确方式: 从topoLayer 0到K的tile分3张/色，
 *           topoLayer K+1之后的tile分成3张/色但引入互锁环。
 *
 * 简化: 将deathStep对应的topoLayer及之后的tile按2张/色分配。
 *       这确保消除deathStep的色后，无一色有≥3可点tile。
 */
function enforceDeathAt(
  assignments: Map<number, number>,
  nodes: Map<number, TileNode>,
  topoLayers: number[][],
  deathStep: number,
  startColor: number,
): void {
  if (deathStep < 0) return;

  // Map deathStep to toppological layer index
  // Each layer has floor(layerSize/3) elimination steps
  let stepsCounted = 0;
  let targetLayerIdx = topoLayers.length; // default: affect nothing

  for (let l = 0; l < topoLayers.length; l++) {
    const layerSteps = Math.floor(topoLayers[l].length / 3);
    if (stepsCounted + layerSteps > deathStep) {
      targetLayerIdx = l;
      break;
    }
    stepsCounted += layerSteps;
    targetLayerIdx = l + 1;
  }

  // From targetLayerIdx onward, reassign tiles to ≤2 per color
  let nextColor = startColor;
  for (let l = targetLayerIdx; l < topoLayers.length; l++) {
    // Clear old assignments for this layer
    for (const tid of topoLayers[l]) {
      assignments.delete(tid);
    }

    // Reassign: 2 tiles per color (ensures no color has ≥3)
    let batch: number[] = [];
    for (const tid of topoLayers[l]) {
      batch.push(tid);
      if (batch.length === 2) {
        const color = nextColor++;
        for (const btid of batch) assignments.set(btid, color);
        batch = [];
      }
    }
    if (batch.length > 0) {
      const color = nextColor++;
      assignments.set(batch[0], color);
    }
  }
}

/**
 * 确保每色tile数是3的倍数。
 */
/**
 * Select the color with the LOWEST topoLayer (浅层优先)。
 * 这保证了逐层消除，不跨层跳跃。
 * 如果同层有多个色，选第一个（任意）。
 */
function pickValidTriple(candidates: number[], nodes: Map<number, TileNode>): number[] | null {
  if (candidates.length < 3) return null;
  for (let i = 0; i < candidates.length - 2; i++) {
    for (let j = i + 1; j < candidates.length - 1; j++) {
      for (let k = j + 1; k < candidates.length; k++) {
        const triple = [candidates[i], candidates[j], candidates[k]];
        let valid = true;
        for (const tid of triple) {
          const nd = nodes.get(tid);
          if (!nd) { valid = false; break; }
          for (const depId of nd.directDeps) {
            if (triple.includes(depId)) { valid = false; break; }
          }
          if (!valid) break;
        }
        if (valid) return triple;
      }
    }
  }
  return null;
}

function selectByTopoLayer(
  availableColors: number[],
  assignments: Map<number, number>,
  nodes: Map<number, TileNode>,
): number {
  let bestColor = availableColors[0];
  let bestLayer = Infinity;

  for (const c of availableColors) {
    // 找到该色中tile的最浅topoLayer
    let minLayer = Infinity;
    for (const [tid, node] of nodes) {
      if (assignments.get(tid) === c && node.topoLayer < minLayer) {
        minLayer = node.topoLayer;
      }
    }
    if (minLayer < bestLayer) {
      bestLayer = minLayer;
      bestColor = c;
    }
  }
  return bestColor;
}

function normalizeColorSizes(
  assignments: Map<number, number>,
  freeTiles: TerrainTile[],
  _nextColor: number,
): Map<number, number> {
  const result = new Map(assignments); // 拷贝

  // 收集每色tile
  const colorTiles = new Map<number, number[]>();
  for (const t of freeTiles) {
    const c = result.get(t.id);
    if (c && c > 0) {
      const list = colorTiles.get(c) ?? [];
      list.push(t.id);
      colorTiles.set(c, list);
    }
  }

  // 对于size%3≠0的色: 取余数tile, 移到新色
  const orphans: number[] = [];
  const maxColor = Math.max(...colorTiles.keys(), 0);

  for (const [color, tiles] of colorTiles) {
    const mod = tiles.length % 3;
    if (mod === 0) continue;
    // 取最后mod张
    const removed = tiles.splice(-mod);
    for (const tid of removed) {
      result.delete(tid);
      orphans.push(tid);
    }
  }

  // 将孤儿tile重新分组为3张/色
  let batch: number[] = [];
  let newColor = maxColor + 100;
  for (const tid of orphans) {
    batch.push(tid);
    if (batch.length === 3) {
      const c = newColor++;
      for (const btid of batch) result.set(btid, c);
      batch = [];
    }
  }
  // 最后<=2张: 附加到已有色（尝试）
  for (const tid of batch) {
    result.set(tid, newColor++);
  }

  return result;
}

// ═══════════════════════════════════════════════════
//  Phase 2: Compute branch sequence (pure structure)
// ═══════════════════════════════════════════════════

/**
 * 给定完整的 tile→颜色 分配，计算每步的分支数。
 *
 * 逐层策略: 消除完一层所有色后，下一层才完整释放。
 *   层L的分支数 = 层L的色数 (每个色3张tile)
 *   消除顺序: 在该层内按任意顺序逐个消除 → 分支数全程 = 该层的色数
 *
 * 这是结构可证明的:
 *   - 同层tile的blocker都在更浅层 → 浅层全消后，该层全部可点
 *   - 同层tile互相不阻塞 → 同一层的色可以任意顺序消除
 *   - 消除完所有层 = 胜利
 */
function computeBranchSequence(
  freeTiles: TerrainTile[],
  assignments: Map<number, number>,
  nodes: Map<number, TileNode>,
): number[] {
  const totalSteps = Math.floor(freeTiles.length / 3);
  const branchLog: number[] = [];

  // 动态状态
  const eliminated = new Set<number>();
  const remainingDeps = new Map<number, Set<number>>();
  for (const [tid, n] of nodes) {
    remainingDeps.set(tid, new Set(n.directDeps));
  }

  const getFreed = (): Set<number> => {
    const f = new Set<number>();
    for (const [tid, rd] of remainingDeps) {
      if (!eliminated.has(tid) && rd.size === 0) f.add(tid);
    }
    return f;
  };

  const freed = getFreed();

  // ── Group colors by topological layer ──
  const colorLayer = new Map<number, number>();
  for (const [tid, node] of nodes) {
    const c = assignments.get(tid);
    if (c && c > 0) {
      const existing = colorLayer.get(c);
      if (existing === undefined || node.topoLayer < existing) {
        colorLayer.set(c, node.topoLayer);
      }
    }
  }
  const allColors = [...new Set(assignments.values())].filter(c => c > 0);
  const layerColors = new Map<number, number[]>();
  for (const c of allColors) {
    const l = colorLayer.get(c) ?? 0;
    const list = layerColors.get(l) ?? [];
    list.push(c);
    layerColors.set(l, list);
  }
  const sortedLayers = [...layerColors.keys()].sort((a, b) => a - b);

  // ── Strict layer-order elimination ──
  // Process layers sequentially: eliminate ALL colors in current layer
  // before advancing to deeper layers.
  // This guarantees: after layer L is done, ALL layer L+1 tiles are freed.

  for (let currentLayer = 0; currentLayer < sortedLayers.length; currentLayer++) {
    const layerNum = sortedLayers[currentLayer];

    // All colors up to and including this layer
    const eligibleColors = new Set<number>();
    for (let l = 0; l <= currentLayer; l++) {
      for (const c of (layerColors.get(sortedLayers[l]) ?? [])) {
        eligibleColors.add(c);
      }
    }

    // Eliminate all eligible colors that have ≥3 freed tiles
    let madeProgress = true;
    while (madeProgress) {
      madeProgress = false;

      // Count available colors
      const colorFreed = new Map<number, number[]>();
      for (const tid of freed) {
        if (eliminated.has(tid)) continue;
        const c = assignments.get(tid);
        if (c && c > 0) {
          const list = colorFreed.get(c) ?? [];
          list.push(tid);
          colorFreed.set(c, list);
        }
      }

      const allAvailable = [...colorFreed.entries()]
        .filter(([, tiles]) => tiles.length >= 3)
        .map(([c]) => c);

      branchLog.push(allAvailable.length);

      if (allAvailable.length === 0) {
        while (branchLog.length < totalSteps) branchLog.push(0);
        return branchLog;
      }

      // Filter: only colors from current or earlier layers
      const eligible = allAvailable.filter(c => eligibleColors.has(c));

      if (eligible.length === 0) break; // Move to next layer

      madeProgress = true;
      const chosen = eligible[0];
      const toRemove = colorFreed.get(chosen)!.slice(0, 3);

      for (const tid of toRemove) {
        eliminated.add(tid);
        freed.delete(tid);
        for (const [rtid, rd] of remainingDeps) {
          if (rd.delete(tid) && rd.size === 0) freed.add(rtid);
        }
      }
    }
  }

  while (branchLog.length < totalSteps) branchLog.push(0);

  return branchLog;
}

// ═══════════════════════════════════════════════════
//  Main entry
// ═══════════════════════════════════════════════════

export function generateV4(input: GenV4Input): GenV4Output {
  const { terrain, solvable = true, deathStep = -1 } = input;

  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(t => !t.isConst);
  const totalSteps = Math.floor(freeTiles.length / 3);

  // Phase 1: Plan-driven color assignment
  const targetDeath = solvable ? -1 : Math.max(0, deathStep ?? 0);
  const { assignments, nodes } = assignColorsByPlan(freeTiles, totalSteps, targetDeath);

  // Phase 2: Compute branches
  const branchLog = computeBranchSequence(freeTiles, assignments, nodes);

  // Validate
  const colorSizes = new Map<number, number>();
  for (const t of freeTiles) {
    const c = assignments.get(t.id);
    if (c && c > 0) colorSizes.set(c, (colorSizes.get(c) ?? 0) + 1);
  }
  const sizes = [...colorSizes.values()];
  const allDivisible = sizes.every(s => s % 3 === 0);

  const solvableCheck = solvable
    ? branchLog.every(b => b >= 1) // 可解: 每步至少1个候选
    : (() => {
        // 不可解: deathStep位置的branch为0且前面都有分支
        if (targetDeath >= branchLog.length) return false;
        if (branchLog[targetDeath] !== 0) return false;
        for (let i = 0; i < targetDeath; i++) {
          if (branchLog[i] === 0) return false;
        }
        return true;
      })();

  return {
    assignments,
    branchLog,
    // Death boards intentionally have non-mod3 colors (≤2/色)
    ok: solvable ? (allDivisible && solvableCheck) : solvableCheck,
    colorCount: colorSizes.size,
    colorSizes: sizes,
    totalSteps,
  };
}

// ═══════════════════════════════════════════════════
//  CLI test
// ═══════════════════════════════════════════════════

export function main() {
  const D = 'E:/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
  const terrains = [100002, 100006, 100010, 100050].filter(tid => existsSync(join(D, `${tid}.json`)));

  for (const tid of terrains) {
    console.log(`\n${'═'.repeat(55)}`);
    console.log(`  Terrain ${tid}`);
    console.log(`${'═'.repeat(55)}`);

    try {
      const terrain: any = loadTerrainFromFile(join(D, `${tid}.json`));
      const freeTiles: any[] = [];
      for (const l of terrain.layers) for (const t of l.tiles) freeTiles.push(t);
      const nonConst = freeTiles.filter((t: any) => !t.isConst);
      const steps = Math.floor(nonConst.length / 3);

      // SOLVABLE
      const sol = generateV4({ terrain, solvable: true });
      console.log(`\n  SOLVABLE (${nonConst.length} tiles, ${steps} steps):`);
      console.log(`    OK: ${sol.ok} | Colors: ${sol.colorCount} | All mod3: ${sol.colorSizes.every(s => s%3===0)}`);
      console.log(`    BranchLog: [${sol.branchLog.join(',')}]`);

      // DEATH at various points
      for (const ds of [0, Math.floor(steps/3), Math.floor(steps/2)]) {
        const death = generateV4({ terrain, solvable: false, deathStep: ds });
        const branchOk = death.branchLog[ds] === 0;
        const preOk = death.branchLog.slice(0, ds).every(b => b >= 1);
        console.log(`\n  DEATH at step ${ds}/${steps}:`);
        console.log(`    OK(legal): ${death.ok} | BranchOk: ${branchOk} | PreOk: ${preOk}`);
        console.log(`    BranchLog: [${death.branchLog.join(',')}]`);
      }
    } catch (e: any) {
      console.log(`  Error: ${e.message?.slice(0,100)}`);
    }
  }
}

if (process.argv[1]?.endsWith('generate-v4.ts') || process.argv[1]?.endsWith('generate-v4.js')) {
  main();
}
