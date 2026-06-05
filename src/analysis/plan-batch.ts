/**
 * Elimination Plan Batch Runner — 对全部 2507 个线上牌局做消除计划分析。
 *
 * 分析维度:
 *   1. 为每个牌局构建完整的消除计划
 *   2. 提取每步的分支数（精确的候选 triple 数）
 *   3. 检测死亡步（候选集归零的位置）
 *   4. 对比 DFS 验证结果
 *   5. 输出分支分布、死亡模式统计
 *
 * 这是之前 DAG 分析无法做到的——每一步的分支数是精确计算的，不是估计的。
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TerrainData, TerrainTile } from '../types.js';
import { TileState } from '../types.js';
import { loadTerrainFromFile } from '../terrain-loader.js';
import { decodeFromString, getCanonicalTileOrder } from '../replay-serializer.js';
import { computeAllDependencies } from '../dependency-graph.js';
import { setLogLevel, LogLevel } from '../logger.js';
import {
  analyzeTripleLogic,
  buildEliminationPlan,
  validatePlan,
  type TripleLogic,
  type EliminationPlan,
  type EliminationStep,
} from './elimination-plan.js';

setLogLevel(LogLevel.Error);

// ═══════════════════════════════════════════════════
//  Paths
// ═══════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════

interface CachedBoard {
  board: { levelResId: number; replayKey: string; grade: string };
  dfs: { win: boolean; statesVisited: number; stepCount: number } | null;
  greedy: { win: boolean } | null;
  features: Record<string, number | number[] | boolean>;
}

interface PlanAnalysisResult {
  board: { levelResId: number; replayKey: string };
  terrain: {
    freeTiles: number;
    totalTriples: number;
  };
  tripleStats: {
    totalEnumerated: number;
    valid: number;
    invalidSelfBlocking: number;
  };
  plan: {
    complete: boolean;
    steps: number;
    coveredTiles: number;
    totalCandidates: number;
    diedAt: number;
    deathReason: string;
    validated: boolean;
  };
  /** 每步信息 */
  steps: {
    step: number;
    tiles: [number, number, number];
    candidates: number;
    released: number;
    /** 该步在总体中的位置（0..1, 越靠近0越前期） */
    progress: number;
  }[];
  /** 分支序列: 每步的候选triple数 */
  branchLog: number[];
  /** 分支统计 */
  branchStats: {
    min: number;
    max: number;
    avg: number;
    median: number;
    /** 只有1个候选的步骤数 */
    singleChoiceSteps: number;
    /** 候选>100的步骤数（高自由度） */
    highFreedomSteps: number;
    /** 候选=0的步骤数（僵死） */
    deadSteps: number;
  };
  dfs: {
    solved: boolean;
    statesVisited: number;
    stepCount: number;
  };
  /** 消除计划预测 vs DFS 验证 */
  agreement: {
    /** 计划完成 ↔ DFS可解 */
    planSolvable: boolean;
    dfsSolved: boolean;
    match: boolean;
  };
}

// ═══════════════════════════════════════════════════
//  Load board data
// ═══════════════════════════════════════════════════

function loadBoardData(levelResId: number, replayKey: string): {
  freeTiles: TerrainTile[];
  suitMap: Map<number, number>;
  allTiles: TerrainTile[];
} {
  const terrainPath = join(LEVELS_DIR, `${levelResId}.json`);
  const terrain: TerrainData = loadTerrainFromFile(terrainPath);
  const allTiles: TerrainTile[] = [];
  for (const l of terrain.layers) for (const t of l.tiles) allTiles.push(t);
  const freeTiles = allTiles.filter(t => !t.isConst);
  const co = getCanonicalTileOrder(allTiles);

  const replayPath = join(REPLAYS_DIR, `${levelResId}.json`);
  const rj = JSON.parse(readFileSync(replayPath, 'utf-8'));
  let entry: any = null;
  for (const [, entries] of Object.entries(rj.replayInfoDict || {})) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries as any[]) {
      if (e.ReplayKey === replayKey) { entry = e; break; }
    }
    if (entry) break;
  }
  if (!entry) throw new Error(`ReplayKey not found`);

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

// ═══════════════════════════════════════════════════
//  Analyze one board
// ═══════════════════════════════════════════════════

function analyzeOneBoard(
  b: CachedBoard,
  freeTiles: TerrainTile[],
): PlanAnalysisResult {
  const allDeps = computeAllDependencies(freeTiles);
  const triples = analyzeTripleLogic(freeTiles, allDeps);
  const validTriples = triples.filter(t => t.isValid);

  const plan = buildEliminationPlan(freeTiles, allDeps, { strategy: 'max-release' });
  const validation = validatePlan(freeTiles, plan);

  const branchLog = plan.branchLog;
  const sortedBranches = [...branchLog].sort((a, b) => a - b);

  const branchStats = {
    min: branchLog.length > 0 ? Math.min(...branchLog) : 0,
    max: branchLog.length > 0 ? Math.max(...branchLog) : 0,
    avg: branchLog.length > 0 ? branchLog.reduce((s, v) => s + v, 0) / branchLog.length : 0,
    median: sortedBranches.length > 0
      ? sortedBranches[Math.floor(sortedBranches.length / 2)]
      : 0,
    singleChoiceSteps: branchLog.filter(v => v === 1).length,
    highFreedomSteps: branchLog.filter(v => v > 100).length,
    deadSteps: branchLog.filter(v => v === 0).length,
  };

  const totalTriples = Math.floor(freeTiles.length / 3);

  return {
    board: b.board,
    terrain: {
      freeTiles: freeTiles.length,
      totalTriples,
    },
    tripleStats: {
      totalEnumerated: triples.length,
      valid: validTriples.length,
      invalidSelfBlocking: triples.length - validTriples.length,
    },
    plan: {
      complete: plan.complete,
      steps: plan.steps.length,
      coveredTiles: plan.coveredTiles,
      totalCandidates: validTriples.length,
      diedAt: plan.diedAt,
      deathReason: plan.deathReason,
      validated: validation.valid,
    },
    steps: plan.steps.map(s => ({
      step: s.step,
      tiles: s.triple.tileIds,
      candidates: s.branchCount,
      released: s.released,
      progress: plan.steps.length > 0 ? s.step / plan.steps.length : 1,
    })),
    branchLog,
    branchStats,
    dfs: {
      solved: b.dfs?.win ?? false,
      statesVisited: b.dfs?.statesVisited ?? 0,
      stepCount: b.dfs?.stepCount ?? 0,
    },
    agreement: {
      planSolvable: plan.complete,
      dfsSolved: b.dfs?.win ?? false,
      match: plan.complete === (b.dfs?.win ?? false),
    },
  };
}

// ═══════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════

function main() {
  console.log('═'.repeat(70));
  console.log('  Elimination Plan — Full Batch Analysis (2507 boards)');
  console.log('═'.repeat(70));

  const files = readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
  const boards: CachedBoard[] = [];

  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(join(CACHE_DIR, f), 'utf-8'));
      if (!d.error && d.dfs) boards.push(d);
    } catch {}
  }

  console.log(`\nLoaded ${boards.length} cached boards`);
  console.log(`  DFS solved:   ${boards.filter(b => b.dfs?.win).length}`);
  console.log(`  DFS unsolved: ${boards.filter(b => !b.dfs?.win).length}`);
  console.log(`  Greedy solved: ${boards.filter(b => b.greedy?.win).length}`);

  // ── Run elimination plan on all boards ──
  const results: PlanAnalysisResult[] = [];
  let done = 0;
  let skipped = 0;

  // 预加载 terrain（同level共享）
  const terrainCache = new Map<number, TerrainTile[]>();

  console.log(`\nAnalyzing...`);
  const startTime = Date.now();

  for (const b of boards) {
    try {
      // 缓存terrain
      let freeTiles: TerrainTile[];
      if (terrainCache.has(b.board.levelResId)) {
        freeTiles = terrainCache.get(b.board.levelResId)!;
      } else {
        const data = loadBoardData(b.board.levelResId, b.board.replayKey);
        freeTiles = data.freeTiles;
        terrainCache.set(b.board.levelResId, freeTiles);
      }

      const result = analyzeOneBoard(b, freeTiles);
      results.push(result);

      done++;
      if (done % 200 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`  Progress: ${done}/${boards.length} (${elapsed}s) | skipped: ${skipped}`);
      }
    } catch (e: any) {
      skipped++;
      if (skipped <= 5) {
        console.warn(`  Skip ${b.board.levelResId}: ${e.message?.slice(0, 80)}`);
      }
      done++;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s. ${results.length} results, ${skipped} skipped.`);

  // ═══════════════════════════════════════════════════
  //  Analysis
  // ═══════════════════════════════════════════════════

  const completePlans = results.filter(r => r.plan.complete);
  const incompletePlans = results.filter(r => !r.plan.complete);
  const matching = results.filter(r => r.agreement.match);
  const falsePositive = results.filter(r => r.plan.complete && !r.dfs.solved);  // 计划完成但DFS说不
  const falseNegative = results.filter(r => !r.plan.complete && r.dfs.solved);  // 计划不完成但DFS说可解

  const reportLines: string[] = [];

  reportLines.push('═'.repeat(70));
  reportLines.push('  ELIMINATION PLAN — FULL ANALYSIS REPORT');
  reportLines.push('═'.repeat(70));
  reportLines.push('');

  // ── Section 1: Overall ──
  reportLines.push('## 1. 总体统计');
  reportLines.push('');
  reportLines.push(`  总牌局数:              ${results.length}`);
  reportLines.push(`  消除计划完成:           ${completePlans.length} (${(completePlans.length*100/results.length).toFixed(1)}%)`);
  reportLines.push(`  消除计划未完成(死亡):   ${incompletePlans.length} (${(incompletePlans.length*100/results.length).toFixed(1)}%)`);
  reportLines.push(`  DFS 可解:              ${results.filter(r => r.dfs.solved).length}`);
  reportLines.push(`  DFS 不可解:            ${results.filter(r => !r.dfs.solved).length}`);
  reportLines.push('');

  // ── Section 2: Agreement ──
  reportLines.push('## 2. 消除计划 vs DFS 一致性');
  reportLines.push('');
  reportLines.push(`  完全一致:      ${matching.length} (${(matching.length*100/results.length).toFixed(1)}%)`);
  reportLines.push(`  假阳性(计划可解, DFS不可解): ${falsePositive.length}`);
  reportLines.push(`  假阴性(计划不可解, DFS可解): ${falseNegative.length}`);
  reportLines.push('');

  // ── Section 3: Branch distribution ──
  reportLines.push('## 3. 分支数统计（消除计划的精确候选数）');
  reportLines.push('');

  const allBranches = results.flatMap(r => r.branchLog);
  const sortedBranches = [...allBranches].sort((a, b) => a - b);
  const branchDistribution: Record<string, number> = {};
  for (const b of allBranches) {
    let bucket: string;
    if (b === 0) bucket = '0';
    else if (b === 1) bucket = '1';
    else if (b <= 5) bucket = '2-5';
    else if (b <= 20) bucket = '6-20';
    else if (b <= 100) bucket = '21-100';
    else if (b <= 500) bucket = '101-500';
    else bucket = '500+';
    branchDistribution[bucket] = (branchDistribution[bucket] ?? 0) + 1;
  }
  const totalSteps = allBranches.length;
  for (const [bucket, count] of Object.entries(branchDistribution).sort()) {
    reportLines.push(`  分支数 [${bucket}]: ${count} steps (${(count*100/totalSteps).toFixed(1)}%)`);
  }
  reportLines.push('');

  // ── Section 4: Per-board branch pattern ──
  reportLines.push('## 4. 牌局分支模式分类');
  reportLines.push('');

  // 分类每局的整体分支模式
  const pureLinear = results.filter(r =>
    r.branchStats.singleChoiceSteps >= r.branchLog.length * 0.8
  ); // 80%+步骤只有1个候选
  const highlyBranching = results.filter(r =>
    r.branchStats.highFreedomSteps > 0
  ); // 有步骤>100候选
  const mixed = results.filter(r =>
    !pureLinear.includes(r) && !highlyBranching.includes(r)
  );

  reportLines.push(`  纯线性牌局 (≥80%步只有1候选):  ${pureLinear.length} (DFS可解: ${pureLinear.filter(r=>r.dfs.solved).length})`);
  reportLines.push(`  高自由度牌局 (某步>100候选):    ${highlyBranching.length} (DFS可解: ${highlyBranching.filter(r=>r.dfs.solved).length})`);
  reportLines.push(`  混合牌局:                       ${mixed.length} (DFS可解: ${mixed.filter(r=>r.dfs.solved).length})`);
  reportLines.push('');

  // ── Section 5: Death point analysis ──
  reportLines.push('## 5. 死亡点分析（消除计划未完成的牌局）');
  reportLines.push('');

  if (incompletePlans.length > 0) {
    const deathDepthDist: Record<number, number> = {};
    for (const r of incompletePlans) {
      const depth = r.plan.diedAt;
      deathDepthDist[depth] = (deathDepthDist[depth] ?? 0) + 1;
    }
    reportLines.push(`  死亡步分布:`);
    for (const [depth, count] of Object.entries(deathDepthDist).sort(([a],[b]) => Number(a)-Number(b))) {
      reportLines.push(`    step ${depth}: ${count} 牌局`);
    }
    reportLines.push('');

    // 死亡原因分类
    reportLines.push(`  死亡原因:`);
    const reasons = new Map<string, number>();
    for (const r of incompletePlans) {
      const reason = r.plan.deathReason.split('.')[0]; // 简化
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    for (const [reason, count] of [...reasons.entries()].sort(([,a], [,b]) => b-a)) {
      reportLines.push(`    ${reason}: ${count}`);
    }
  }
  reportLines.push('');

  // ── Section 6: Branch vs solvability ──
  reportLines.push('## 6. 分支模式 vs DFS 可解性的关系');
  reportLines.push('');

  // 按平均分支分桶
  const avgBranchUnsolved = results.filter(r => !r.dfs.solved).map(r => r.branchStats.avg);
  const avgBranchSolved = results.filter(r => r.dfs.solved).map(r => r.branchStats.avg);
  const avgU = avgBranchUnsolved.length > 0 ? avgBranchUnsolved.reduce((a,b)=>a+b,0)/avgBranchUnsolved.length : 0;
  const avgS = avgBranchSolved.length > 0 ? avgBranchSolved.reduce((a,b)=>a+b,0)/avgBranchSolved.length : 0;
  reportLines.push(`  不可解牌局平均分支数: ${avgU.toFixed(1)}`);
  reportLines.push(`  可解牌局平均分支数:   ${avgS.toFixed(1)}`);
  reportLines.push(`  倍率: ${(avgU/Math.max(avgS, 0.01)).toFixed(2)}`);
  reportLines.push('');

  // 按最大分支
  const maxBranchUnsolved = results.filter(r => !r.dfs.solved).map(r => r.branchStats.max);
  const maxBranchSolved = results.filter(r => r.dfs.solved).map(r => r.branchStats.max);
  const maxU = maxBranchUnsolved.length > 0 ? Math.max(...maxBranchUnsolved) : 0;
  const maxS = maxBranchSolved.length > 0 ? Math.max(...maxBranchSolved) : 0;
  reportLines.push(`  不可解牌局最大分支数: ${maxU}`);
  reportLines.push(`  可解牌局最大分支数:   ${maxS}`);
  reportLines.push('');

  // 按单候选步比例
  const scUnsolved = results.filter(r => !r.dfs.solved).map(r =>
    r.branchLog.length > 0 ? r.branchStats.singleChoiceSteps / r.branchLog.length : 0
  );
  const scSolved = results.filter(r => r.dfs.solved).map(r =>
    r.branchLog.length > 0 ? r.branchStats.singleChoiceSteps / r.branchLog.length : 0
  );
  const scU = scUnsolved.length > 0 ? scUnsolved.reduce((a,b)=>a+b,0)/scUnsolved.length : 0;
  const scS = scSolved.length > 0 ? scSolved.reduce((a,b)=>a+b,0)/scSolved.length : 0;
  reportLines.push(`  不可解牌局单候选步比例: ${(scU*100).toFixed(1)}%`);
  reportLines.push(`  可解牌局单候选步比例:   ${(scS*100).toFixed(1)}%`);
  reportLines.push('');

  // ── Section 7: False negatives detail ──
  reportLines.push('## 7. 假阴性详解（计划不可解但DFS可解）');
  reportLines.push('');
  if (falseNegative.length === 0) {
    reportLines.push(`  无假阴性 — 消除计划未发现可解但计划说不的情况`);
  } else {
    for (const r of falseNegative.slice(0, 20)) {
      reportLines.push(`  ${r.board.levelResId} | DFS states:${r.dfs.statesVisited} | ` +
        `plan died at step ${r.plan.diedAt}: ${r.plan.deathReason.slice(0, 80)}`);
      reportLines.push(`    Branch log: [${r.branchLog.slice(0, 5).join(',')}${r.branchLog.length > 5 ? ',...' : ''}]`);
    }
  }
  reportLines.push('');

  // ── Section 8: Key insight ──
  reportLines.push('## 8. 核心洞察');
  reportLines.push('');

  if (falseNegative.length === 0) {
    reportLines.push(`  ★ 消除计划的"max-release"策略在全部${results.length}个牌局中未产生假阴性。`);
    reportLines.push(`    这意味着：对于这些地形，选择"释放最多tile"的triple总是能找到解（如果解存在的话）。`);
    reportLines.push(`    但注意：这是经验验证，不是数学证明。`);
  }

  if (falsePositive.length > 0) {
    reportLines.push(`  ★ 有${falsePositive.length}个假阳性（计划可解但DFS不可解）。`);
    reportLines.push(`    原因：消除计划不考虑dock容量限制（7格）。一个计划可能逻辑上可行，`);
    reportLines.push(`    但在真实游戏中dock会溢出。`);
    reportLines.push(`    需要：在计划验证中加入dock压力追踪。`);
  }

  reportLines.push('');

  // ── Section 9: Branch pattern clustering ──
  reportLines.push('## 9. 分支模式聚类');
  reportLines.push('');

  // 将分支序列压缩为"形状"
  interface BranchShape {
    start: 'linear' | 'branching' | 'explosive';
    middle: 'linear' | 'branching' | 'narrowing';
    end: 'linear' | 'branching' | 'dead';
  }

  function classifyShape(r: PlanAnalysisResult): BranchShape {
    const log = r.branchLog;
    if (log.length === 0) return { start: 'linear', middle: 'linear', end: 'dead' };

    const third = Math.floor(log.length / 3);
    const firstThird = log.slice(0, third);
    const midThird = log.slice(third, third * 2);
    const lastThird = log.slice(third * 2);

    const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;

    return {
      start: avg(firstThird) <= 3 ? 'linear' : avg(firstThird) <= 100 ? 'branching' : 'explosive',
      middle: avg(midThird) <= 3 ? 'linear' : avg(midThird) <= Math.max(avg(firstThird)*0.7, 10) ? 'narrowing' : 'branching',
      end: r.plan.complete ? (avg(lastThird) <= 3 ? 'linear' : 'branching') : 'dead',
    };
  }

  const shapeCounts = new Map<string, { count: number; solved: number; unsolved: number }>();
  for (const r of results) {
    const shape = classifyShape(r);
    const key = `${shape.start}→${shape.middle}→${shape.end}`;
    const entry = shapeCounts.get(key) ?? { count: 0, solved: 0, unsolved: 0 };
    entry.count++;
    if (r.dfs.solved) entry.solved++;
    else entry.unsolved++;
    shapeCounts.set(key, entry);
  }

  reportLines.push(`  分支序列形状分布:`);
  reportLines.push(`  ${'形状'.padEnd(30)} | ${'数量'.padStart(5)} | ${'可解%'.padStart(6)}`);
  reportLines.push(`  ${'-'.repeat(30)} | ${'-'.repeat(5)} | ${'-'.repeat(6)}`);
  for (const [shape, stats] of [...shapeCounts.entries()].sort(([,a], [,b]) => b.count - a.count)) {
    const pct = (stats.solved * 100 / stats.count).toFixed(1);
    reportLines.push(`  ${shape.padEnd(30)} | ${String(stats.count).padStart(5)} | ${pct.padStart(5)}%`);
  }
  reportLines.push('');

  // ── Write outputs ──
  const report = reportLines.join('\n');
  console.log('\n' + report);

  const reportPath = join(OUTPUT_DIR, 'elimination-plan-report.md');
  writeFileSync(reportPath, report);

  const jsonPath = join(OUTPUT_DIR, 'elimination-plan-results.json');
  // 压缩版JSON（只保留关键字段）
  const compactResults = results.map(r => ({
    board: r.board,
    terrain: r.terrain,
    plan: r.plan,
    branchStats: r.branchStats,
    branchLog: r.branchLog.slice(0, 20), // 只保留前20步
    branchLogLen: r.branchLog.length,
    dfs: r.dfs,
    agreement: r.agreement,
  }));
  writeFileSync(jsonPath, JSON.stringify(compactResults, null, 2));

  console.log(`\nReport: ${reportPath}`);
  console.log(`JSON:   ${jsonPath}`);
}

main();
