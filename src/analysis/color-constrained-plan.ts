/**
 * Color-Constrained Elimination Plan — 花色约束下的消除计划。
 *
 * 核心发现（来自 deep-plan-single.ts 分析）:
 *   地形级消除计划 100% 完成（对100006），但DFS判定不可解。
 *
 *   差距: 消除计划只验证依赖可行性（"这些tile可以组合成triple"），
 *        不验证花色一致性（"这三张tile是否同色"）。
 *
 *   真实的牌局 = 地形 + 花色分配。
 *   消除计划必须在花色约束下运行，才是对真实游戏的正确建模。
 *
 * 本模块:
 *   给定地形 + 花色分配，在每一步只考虑"候选triple中三张tile同色"的triple。
 *   这完全匹配真实游戏的规则。
 */

import type { TerrainTile } from '../types.js';
import { computeAllDependencies } from '../dependency-graph.js';
import { sortTriple } from '../types.js';
import { loadTerrainFromFile } from '../terrain-loader.js';
import { decodeFromString, getCanonicalTileOrder } from '../replay-serializer.js';
import { buildEliminationPlan } from './elimination-plan.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setLogLevel, LogLevel } from '../logger.js';

setLogLevel(LogLevel.Error);

// ═══════════════════════════════════════════════════
//  Color-constrained triple state
// ═══════════════════════════════════════════════════

/**
 * 花色约束下的消除步骤。
 * 与 EliminationStep 的区别: 候选triple只包括同色的。
 */
export interface ColorEliminationStep {
  step: number;
  /** 选中的 triple（三张同色tile） */
  tileIds: [number, number, number];
  /** 花色 */
  color: number;
  /** 这一步有多少个可选同色triple */
  branchCount: number;
  /** 消除后释放了多少tile（remainingDeps归零） */
  released: number;
}

export interface ColorConstrainedPlan {
  steps: ColorEliminationStep[];
  /** 是否覆盖全部 free tile */
  complete: boolean;
  /** 死亡步 */
  diedAt: number;
  deathReason: string;
  /** 每步同色候选数 */
  branchLog: number[];
  /** 花色使用统计 */
  colorUsage: Map<number, number>;
}

// ═══════════════════════════════════════════════════
//  Build color-constrained plan
// ═══════════════════════════════════════════════════

/**
 * 在花色约束下构建消除计划。
 *
 * 与 buildEliminationPlan 的核心区别:
 *   候选过滤: trip.tileIds.every(id => suitMap.get(id) === sameColor)
 *   即: 三张tile必须同色。
 *
 * 这是真实游戏规则的正确建模。
 */
export function buildColorConstrainedPlan(
  freeTiles: TerrainTile[],
  suitMap: Map<number, number>,
  options?: {
    strategy?: 'max-release' | 'min-release' | 'first-valid';
  },
): ColorConstrainedPlan {
  const { strategy = 'max-release' } = options ?? {};
  const allDeps = computeAllDependencies(freeTiles);

  const tileMap = new Map<number, TerrainTile>();
  for (const t of freeTiles) tileMap.set(t.id, t);

  // ── 构建按花色分组的同色triple枚举 ──
  // 不枚举所有C(n,3)，只按花色分组枚举C(k,3)
  const colorGroups = new Map<number, number[]>();
  for (const t of freeTiles) {
    const color = suitMap.get(t.id) ?? 0;
    if (color <= 0) continue;
    const list = colorGroups.get(color) ?? [];
    list.push(t.id);
    colorGroups.set(color, list);
  }

  // 每个花色的所有同色triple
  interface SameColorTriple {
    tileIds: [number, number, number];
    color: number;
    depSet: Set<number>;
    prerequisites: Set<number>;
  }

  const allSameColorTriples: SameColorTriple[] = [];

  for (const [color, tileIds] of colorGroups) {
    const k = tileIds.length;
    // C(k,3) 同色triple
    for (let i = 0; i < k - 2; i++) {
      for (let j = i + 1; j < k - 1; j++) {
        for (let m = j + 1; m < k; m++) {
          const a = tileIds[i], b = tileIds[j], c = tileIds[m];

          // 检查: triple内部不互相阻塞
          const tripleSet = new Set([a, b, c]);
          let validTriple = true;
          for (const tid of [a, b, c]) {
            const tile = tileMap.get(tid);
            if (!tile) { validTriple = false; break; }
            for (const depId of tile.dependencies) {
              if (tripleSet.has(depId)) { validTriple = false; break; }
            }
            if (!validTriple) break;
          }
          if (!validTriple) continue;

          // depSet
          const depSet = new Set<number>();
          for (const tid of [a, b, c]) {
            depSet.add(tid);
            const deps = allDeps.get(tid);
            if (deps) for (const d of deps) depSet.add(d);
          }

          // 前提集
          const prerequisites = new Set<number>();
          for (const tid of [a, b, c]) {
            const tile = tileMap.get(tid);
            if (!tile) continue;
            for (const depId of tile.dependencies) {
              if (tileMap.has(depId) && !depSet.has(depId)) {
                prerequisites.add(depId);
              }
            }
          }

          allSameColorTriples.push({
            tileIds: sortTriple(a, b, c),
            color,
            depSet,
            prerequisites,
          });
        }
      }
    }
  }

  // ── 动态状态 ──
  const eliminated = new Set<number>();
  const remainingDeps = new Map<number, Set<number>>();
  for (const t of freeTiles) {
    const rd = new Set<number>();
    for (const depId of t.dependencies) {
      if (tileMap.has(depId)) rd.add(depId);
    }
    remainingDeps.set(t.id, rd);
  }

  const getFreed = (): Set<number> => {
    const f = new Set<number>();
    for (const t of freeTiles) {
      if (!eliminated.has(t.id) && (remainingDeps.get(t.id)?.size ?? 0) === 0) {
        f.add(t.id);
      }
    }
    return f;
  };

  const freedSet = getFreed();
  const steps: ColorEliminationStep[] = [];
  const branchLog: number[] = [];
  let coveredTiles = 0;

  for (let stepNum = 0; ; stepNum++) {
    const freed = freedSet;

    // 过滤: 三张tile必须在freed中、未被消除、且同色
    const candidates = allSameColorTriples.filter(t =>
      t.tileIds.every(id => freed.has(id) && !eliminated.has(id))
    );

    if (candidates.length === 0) {
      const remainingTiles = freeTiles.filter(t => !eliminated.has(t.id)).length;
      return {
        steps,
        complete: remainingTiles === 0,
        diedAt: stepNum,
        deathReason: remainingTiles > 0
          ? `${remainingTiles} tiles remain, no same-color triple available. ` +
            `Available colors with ≥3 freed tiles: ${countAvailableColors(freed, suitMap, 3).join(', ')}`
          : 'All tiles eliminated',
        branchLog,
        colorUsage: computeColorUsage(steps),
      };
    }

    branchLog.push(candidates.length);

    // 选择策略: max-release（释放最多tile的同色triple）
    let chosen: SameColorTriple;
    switch (strategy) {
      case 'max-release': {
        // 计算每个候选的实际释放量
        let best = candidates[0];
        let bestRelease = -1;
        for (const cand of candidates) {
          let release = 0;
          for (const id of cand.tileIds) {
            // 消除该tile后，被它阻塞的tile的remainingDeps减1
            for (const [tid, rd] of remainingDeps) {
              if (!eliminated.has(tid) && rd.has(id) && rd.size === 1) {
                release++;
              }
            }
          }
          // 优先级: 释放多 → depSet大（消除更深入依赖）
          const score = release * 100 + cand.depSet.size;
          if (score > bestRelease) {
            bestRelease = score;
            best = cand;
          }
        }
        chosen = best;
        break;
      }
      case 'min-release':
        chosen = candidates.reduce((best, c) =>
          c.depSet.size < best.depSet.size ? c : best
        );
        break;
      default:
        chosen = candidates[0];
    }

    // 消除
    let releasedThisStep = 0;
    for (const id of chosen.tileIds) {
      eliminated.add(id);
      freedSet.delete(id);
      coveredTiles++;
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
      tileIds: chosen.tileIds,
      color: chosen.color,
      branchCount: candidates.length,
      released: releasedThisStep,
    });

    if (eliminated.size >= freeTiles.length) break;
    if (stepNum > freeTiles.length) break;
  }

  return {
    steps,
    complete: eliminated.size >= freeTiles.length,
    diedAt: -1,
    deathReason: '',
    branchLog,
    colorUsage: computeColorUsage(steps),
  };
}

// ═══════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════

function countAvailableColors(
  freed: Set<number>,
  suitMap: Map<number, number>,
  minTiles: number,
): number[] {
  const colorCount = new Map<number, number>();
  for (const id of freed) {
    const c = suitMap.get(id) ?? 0;
    if (c > 0) colorCount.set(c, (colorCount.get(c) ?? 0) + 1);
  }
  const result: number[] = [];
  for (const [color, count] of colorCount) {
    if (count >= minTiles) result.push(color);
  }
  return result.sort((a, b) => a - b);
}

function computeColorUsage(steps: ColorEliminationStep[]): Map<number, number> {
  const usage = new Map<number, number>();
  for (const s of steps) {
    usage.set(s.color, (usage.get(s.color) ?? 0) + 3);
  }
  return usage;
}

// ═══════════════════════════════════════════════════
//  CLI: 对比分析
// ═══════════════════════════════════════════════════

export function main() {
  const DATASET_ROOT = 'E:/workspace/tilematch/TileMatchShell/Tools/Config/Json';
  const LEVELS_DIR = join(DATASET_ROOT, 'Levels');
  const REPLAYS_DIR = join(DATASET_ROOT, 'Replays');

  const testCases = [
    { levelResId: 100006, replayKey: '2-2-3-12-1529188790', label: 'DFS unsolvable (100006)' },
    { levelResId: 100002, replayKey: '3-6-8-9-1535201331', label: 'DFS solvable (100002)' },
  ];

  for (const tc of testCases) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  ${tc.label}`);
    console.log(`${'═'.repeat(60)}`);

    try {
      const terrainPath = join(LEVELS_DIR, `${tc.levelResId}.json`);
      const replayPath = join(REPLAYS_DIR, `${tc.levelResId}.json`);

      if (!existsSync(terrainPath) || !existsSync(replayPath)) {
        console.log(`  Data not found`);
        continue;
      }

      const terrain = loadTerrainFromFile(terrainPath);
      const allTiles: any[] = [];
      for (const l of terrain.layers) for (const t of l.tiles) allTiles.push(t);
      const freeTiles = allTiles.filter((t: any) => !t.isConst);
      const co = getCanonicalTileOrder(allTiles);

      const rj = JSON.parse(readFileSync(replayPath, 'utf-8'));
      let entry: any = null;
      for (const [, entries] of Object.entries(rj.replayInfoDict || {})) {
        if (!Array.isArray(entries)) continue;
        for (const e of entries as any[]) {
          if (e.ReplayKey === tc.replayKey) { entry = e; break; }
        }
        if (entry) break;
      }
      if (!entry) { console.log('  ReplayKey not found'); continue; }

      const rd = decodeFromString(entry.ReplayCode);
      if (!rd) { console.log('  Decode failed'); continue; }

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

      // 构建花色约束消除计划
      const ccPlan = buildColorConstrainedPlan(freeTiles, suitMap, { strategy: 'max-release' });

      console.log(`  Free tiles: ${freeTiles.length}, Expected steps: ${Math.floor(freeTiles.length/3)}`);
      console.log(`  Color-constrained plan:`);
      console.log(`    Complete: ${ccPlan.complete}`);
      console.log(`    Steps: ${ccPlan.steps.length}`);
      console.log(`    Branch log: [${ccPlan.branchLog.slice(0, 10).join(', ')}${ccPlan.branchLog.length > 10 ? ', ...' : ''}]`);

      if (!ccPlan.complete) {
        console.log(`    Died at step ${ccPlan.diedAt}: ${ccPlan.deathReason}`);
      }

      // 对比: 无花色约束的消除计划
      const allDeps = computeAllDependencies(freeTiles);
      const noColorPlan = buildEliminationPlan(freeTiles, allDeps, { strategy: 'max-release' });

      console.log(`  Unconstrained plan (comparison):`);
      console.log(`    Complete: ${noColorPlan.complete}`);
      console.log(`    Steps: ${noColorPlan.steps.length}`);
      console.log(`    Branch log: [${noColorPlan.branchLog.slice(0, 10).join(', ')}${noColorPlan.branchLog.length > 10 ? ', ...' : ''}]`);

      // 关键对比
      console.log(`\n  ★ Gap analysis:`);
      if (noColorPlan.complete && !ccPlan.complete) {
        console.log(`    依赖可行: 可消 ✔`);
        console.log(`    花色约束: 不可消 ✗ (step ${ccPlan.diedAt})`);
        console.log(`    → 花色分配阻止了依赖可行的triple`);
      } else if (ccPlan.complete) {
        console.log(`    花色约束下可消 ✔`);
      }
    } catch (e: any) {
      console.log(`  Error: ${e.message}`);
    }
  }
}

if (process.argv[1]?.endsWith('color-constrained-plan.ts') || process.argv[1]?.endsWith('color-constrained-plan.js')) {
  main();
}
