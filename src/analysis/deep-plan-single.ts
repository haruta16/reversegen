/**
 * Deep single-board analysis — 对选定牌局做逐步骤的消除计划诊断。
 *
 * 诊断维度:
 *   1. 每步: 候选triple数、最大/最小释放triple
 *   2. 死亡步: 如果存在，详细分析为什么候选集归零
 *   3. 与DFS验证的逐步对比
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TerrainData, TerrainTile } from '../types.js';
import { loadTerrainFromFile } from '../terrain-loader.js';
import { decodeFromString, getCanonicalTileOrder } from '../replay-serializer.js';
import { computeAllDependencies } from '../dependency-graph.js';
import {
  analyzeTripleLogic,
  buildEliminationPlan,
  validatePlan,
  type TripleLogic,
  type EliminationStep,
} from './elimination-plan.js';
import { setLogLevel, LogLevel } from '../logger.js';

setLogLevel(LogLevel.Error);

function findDataDir(...candidates: string[]): string {
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error('No data found');
}

const DATASET_ROOT = findDataDir(
  'E:/workspace/tilematch/TileMatchShell/Tools/Config/Json',
  '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json',
  join(process.cwd(), '..', 'TileMatchShell', 'Tools', 'Config', 'Json'),
);
const LEVELS_DIR = join(DATASET_ROOT, 'Levels');
const REPLAYS_DIR = join(DATASET_ROOT, 'Replays');
const CACHE_DIR = join(process.cwd(), '.reversegen-cache', 'board-results-v2');

function loadBoard(levelResId: number, replayKey: string) {
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
  if (!entry) throw new Error('ReplayKey not found');

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

function deepAnalyze(levelResId: number, replayKey: string, dfsResult: { win: boolean; statesVisited: number; stepCount: number }) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  Deep Analysis: ${levelResId} / ${replayKey}`);
  console.log(`  DFS: ${dfsResult.win ? '✓ SOLVABLE' : '✗ UNSOLVABLE'} | states: ${dfsResult.statesVisited} | steps: ${dfsResult.stepCount}`);
  console.log(`${'═'.repeat(70)}`);

  const { freeTiles } = loadBoard(levelResId, replayKey);
  const allDeps = computeAllDependencies(freeTiles);
  const totalTriples = Math.floor(freeTiles.length / 3);

  console.log(`\n  Terrain: ${freeTiles.length} free tiles, ${totalTriples} triples needed`);

  // 分析 triple 统计
  const triples = analyzeTripleLogic(freeTiles, allDeps);
  const valid = triples.filter(t => t.isValid);
  console.log(`  Triples: ${triples.length} total, ${valid.length} valid (${triples.length - valid.length} self-blocking)`);

  // 释放能力分布
  const releaseSizes = valid.map(t => t.exclusiveRelease.size);
  const releaseDist: Record<number, number> = {};
  for (const s of releaseSizes) releaseDist[s] = (releaseDist[s] ?? 0) + 1;
  console.log(`  Release capacity distribution:`);
  for (const [size, count] of Object.entries(releaseDist).sort(([a],[b])=>Number(a)-Number(b))) {
    console.log(`    release=${size}: ${count} triples (${(count*100/valid.length).toFixed(1)}%)`);
  }

  // 构建消除计划
  const plan = buildEliminationPlan(freeTiles, allDeps, { strategy: 'max-release' });
  const validation = validatePlan(freeTiles, plan);

  console.log(`\n  ── Elimination Plan ──`);
  console.log(`  Complete: ${plan.complete}`);
  console.log(`  Steps: ${plan.steps.length} / ${totalTriples}`);
  console.log(`  Covered: ${plan.coveredTiles} / ${freeTiles.length} tiles`);
  console.log(`  Validated: ${validation.valid ? '✅' : '❌'}`);

  if (!plan.complete) {
    console.log(`  Died at step ${plan.diedAt}: ${plan.deathReason}`);
  }

  // 逐步详情
  console.log(`\n  ── Step Details ──`);
  console.log(`  ${'Step'.padStart(4)} | ${'Tiles'.padEnd(15)} | ${'Cands'.padStart(6)} | ${'Release'.padStart(7)} | Prerequisites`);
  console.log(`  ${'-'.repeat(4)} | ${'-'.repeat(15)} | ${'-'.repeat(6)} | ${'-'.repeat(7)} | ${'-'.repeat(30)}`);

  for (const step of plan.steps.slice(0, 15)) {
    const tiles = `[${step.triple.tileIds.join(',')}]`;
    const prereqs = [...step.triple.prerequisites].slice(0, 5).join(',');
    const prereqStr = step.triple.prerequisites.size === 0
      ? '(none)'
      : `${prereqs}${step.triple.prerequisites.size > 5 ? '...' : ''}`;
    console.log(`  ${String(step.step).padStart(4)} | ${tiles.padEnd(15)} | ${String(step.branchCount).padStart(6)} | ${String(step.released).padStart(7)} | ${prereqStr}`);
  }

  if (plan.steps.length > 15) {
    console.log(`  ... (${plan.steps.length - 15} more steps)`);
  }

  // 分支序列
  console.log(`\n  Branch log (first 20): [${plan.branchLog.slice(0, 20).join(', ')}${plan.branchLog.length > 20 ? ', ...' : ''}]`);

  // 分支统计
  const sorted = [...plan.branchLog].sort((a, b) => a - b);
  const avgBranch = plan.branchLog.reduce((s, v) => s + v, 0) / Math.max(plan.branchLog.length, 1);
  console.log(`  Branch stats: min=${sorted[0] ?? 0}, max=${sorted[sorted.length-1] ?? 0}, avg=${avgBranch.toFixed(1)}, median=${sorted[Math.floor(sorted.length/2)] ?? 0}`);
  console.log(`  Single-choice steps: ${plan.branchLog.filter(v => v === 1).length}/${plan.branchLog.length}`);

  // 死亡分析（如果不完成）
  if (!plan.complete && plan.diedAt > 0) {
    console.log(`\n  ── Death Analysis at step ${plan.diedAt} ──`);
    // 检查: 还剩多少tile, 每tile的剩余阻塞情况
    // 重新模拟到死亡步
    const allValid = valid;
    const eliminated = new Set<number>();
    const remainingDeps = new Map<number, Set<number>>();

    // 重建remainingDeps
    const tileMap = new Map<number, TerrainTile>();
    for (const t of freeTiles) tileMap.set(t.id, t);
    for (const t of freeTiles) {
      const rd = new Set<number>();
      for (const d of t.dependencies) {
        if (tileMap.has(d)) rd.add(d);
      }
      remainingDeps.set(t.id, rd);
    }

    // 模拟前面步骤
    for (let s = 0; s < plan.steps.length && s < plan.diedAt; s++) {
      const step = plan.steps[s];
      for (const id of step.triple.tileIds) {
        eliminated.add(id);
        for (const [tid, rd] of remainingDeps) {
          if (!eliminated.has(tid)) rd.delete(id);
        }
      }
    }

    // 分析剩余tile
    const remaining = freeTiles.filter(t => !eliminated.has(t.id));
    console.log(`  Remaining tiles: ${remaining.length}`);
    console.log(`  Per-tile remaining blockers:`);
    for (const t of remaining) {
      const rd = remainingDeps.get(t.id) ?? new Set();
      const blockers = [...rd];
      console.log(`    tile ${t.id}: ${rd.size} blockers [${blockers.join(', ')}]`);
    }
  }

  return { plan, validation, totalTriples, freeTiles: freeTiles.length };
}

function main() {
  console.log('Deep Elimination Plan Analysis');
  console.log('='.repeat(70));

  // 选取代表性牌局:
  // 1. 一个简单可解的 (低cgEdge)
  // 2. 一个复杂可解的 (高cgEdge)
  // 3. 一个不可解的 (立死)
  // 4. 一个不可解的 (后死)

  const cases: { levelResId: number; replayKey: string; label: string }[] = [];

  // 从缓存中找
  const files = readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(join(CACHE_DIR, f), 'utf-8'));
      if (d.error || !d.dfs) continue;

      const cg = (d.features.cgEdgeCount as number) ?? 0;
      const dfsWin = d.dfs.win;

      // 低cgEdge + 可解
      if (cg < 30 && dfsWin && cases.length < 1) {
        cases.push({ levelResId: d.board.levelResId, replayKey: d.board.replayKey, label: 'Low-cgEdge, Solvable' });
      }
      // 高cgEdge + 可解
      if (cg > 150 && dfsWin && cases.length < 2) {
        cases.push({ levelResId: d.board.levelResId, replayKey: d.board.replayKey, label: 'High-cgEdge, Solvable' });
      }
      // 立死 (step=0 death)
      if (!dfsWin && d.dfs.stepCount === 0 && cases.length < 3) {
        cases.push({ levelResId: d.board.levelResId, replayKey: d.board.replayKey, label: 'Immediate Death' });
      }
      // 后死
      if (!dfsWin && (d.dfs.stepCount ?? 0) > 3 && cases.length < 4) {
        cases.push({ levelResId: d.board.levelResId, replayKey: d.board.replayKey, label: 'Delayed Death' });
      }
      if (cases.length >= 4) break;
    } catch {}
  }

  console.log(`\nSelected ${cases.length} representative boards:\n`);
  for (const c of cases) {
    console.log(`  ${c.levelResId}: ${c.label}`);
  }

  for (const c of cases) {
    const dfsResult = { win: true, statesVisited: 0, stepCount: 0 };
    // 重新读取DFS结果
    for (const f of files) {
      try {
        const d = JSON.parse(readFileSync(join(CACHE_DIR, f), 'utf-8'));
        if (d.board.levelResId === c.levelResId && d.board.replayKey === c.replayKey) {
          dfsResult.win = d.dfs?.win ?? false;
          dfsResult.statesVisited = d.dfs?.statesVisited ?? 0;
          dfsResult.stepCount = d.dfs?.stepCount ?? 0;
          break;
        }
      } catch {}
    }

    try {
      deepAnalyze(c.levelResId, c.replayKey, dfsResult);
    } catch (e: any) {
      console.log(`  Error: ${e.message}`);
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('Analysis complete.');
}

main();
