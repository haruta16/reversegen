/**
 * 批量跑关核心逻辑。
 *
 * 流程：
 *   1. Phase 1 — 每个地形用极限困难参数探测最高档位（maxGrade）
 *   2. Phase 2 — 用统一参数（各参数随机/固定按开关），收集各档位各 targetPerTier 条
 *   3. 输出 CSV
 *
 * 参数统一：所有地形共享同一套生成参数配置。
 */

import { fork } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  loadTerrainFromFile,
  getAllTiles,
  generateBoardLayerClosure,
  computeDependencyDepth,
} from './index.js';
import { solvePlayerMistakeBatch } from './solver/index.js';
import { OfflineTile } from './solver/types.js';
import { OfflineGame } from './solver/offline-game.js';
import { gradeStrategy2 } from './grader.js';
import type { TerrainData, TerrainTile } from './types.js';
import type { SimSnapshot } from './grader.js';
import { mulberry32 } from './random-utils.js';

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export type ParamMode = 'random' | number;
export type ParamModeStr = 'random' | string;

export interface UnifiedParams {
  closeRates: ParamModeStr;
  colorCount: ParamMode;
  colorCountRatio: number;       // [0,1]，colorCount='random' 时使用
  spreadParam: ParamMode;
  debtPersistenceWeight: ParamMode;
}

export interface BatchConfig {
  terrainPaths: string[];
  closeRates: ParamModeStr;
  colorCount: ParamMode;
  colorCountRatio: number;
  spreadParam: ParamMode;
  debtPersistenceWeight: ParamMode;
  simRuns: number;
  targetPerTier: number;
  maxAttempts: number;
  concurrency?: number;
}

export interface GenerationParams {
  closeRates: number[];
  colorCount: number;
  spreadParam: number;
  debtPersistenceWeight: number;
}

export interface BatchRow {
  terrainIndex: number; terrainPath: string; levelResId: string;
  attemptIndex: number; isMaxGradeProbe: boolean;
  colorCount: number; closeRates: number[]; spreadParam: number; debtPersistenceWeight: number;
  freeTiles: number; totalTiles: number; depthCount: number;
  peakDebt: number; peakExpDebt: number; oi: number; consecutiveOI: number;
  suitSpreadNorm: number; isDoomed: boolean;
  actualCloseRates: number[]; weightedDebtRetentionRate: number;
  replayCode: string; grade: number; passrate: number; label: string;
  levelTags?: string;
  simRuns: number; sim1WinRate: number; sim1Wins: number;
  sim5WinRate: number; sim5Wins: number; sim15WinRate: number; sim15Wins: number;
  optimalRuns?: number; optimalWins?: number; optimalLosses?: number; optimalWinRate?: number;
  optimalForcedPickOnWin?: number; optimalStarvationOnWin?: number;
  optimalStepsOnLoss?: number; optimalForcedPickOnLoss?: number; optimalStarvationOnLoss?: number;
  optimalRemainingTilesOnLoss?: number; optimalRemainingRatioOnLoss?: number;
  elapsedMs: number; success: boolean; error?: string;
}

export interface TerrainProgress {
  terrainIndex: number; terrainPath: string;
  phase: 'idle' | 'maxgrade' | 'collecting' | 'done';
  maxGrade: number; collected: Record<number, number>; attempts: number;
  rows: BatchRow[];
}

export interface BatchProgress {
  jobId: string; status: 'running' | 'done' | 'error' | 'aborted';
  terrains: TerrainProgress[]; totalRows: number; startedAt: number; error?: string;
}

export type ProgressCallback = (progress: BatchProgress) => void;

interface WorkerProgressMessage {
  type: 'progress';
  terrainIndex: number;
  terrain: TerrainProgress;
  rowsAdded: number;
}

interface WorkerDoneMessage {
  type: 'done';
  terrainIndex: number;
  terrain: TerrainProgress;
}

interface WorkerErrorMessage {
  type: 'error';
  terrainIndex: number;
  error: string;
}

type WorkerMessage = WorkerProgressMessage | WorkerDoneMessage | WorkerErrorMessage;

// ═══════════════════════════════════════════════════════════
// 花色数：ratio × N → 向下取整
// ═══════════════════════════════════════════════════════════

export function colorCountFromRatio(ratio: number, freeTiles: number): number {
  return Math.floor(ratio * Math.floor(freeTiles / 3));
}

// ═══════════════════════════════════════════════════════════
// 闭合率随机化（整数 target → 反算百分比）
// ═══════════════════════════════════════════════════════════

/**
 * 按层累积牌数推导每层可能的 triplet 数 P[d]。
 * 每层 target = randomInt(prevTarget, P[d])，rate = target / P[d]。
 * 前两层在物理可行时至少闭合 1 组，避免随机到过空的开局层。
 * 跳过百分比中间层，直接在可行的整数 target 区间内随机。
 */
export function randomizeCloseRatesFromTiles(
  allTiles: TerrainTile[],
  rng: () => number,
): number[] {
  const freeTiles = allTiles.filter(t => !t.isConst);
  const tileMap = new Map(allTiles.map(t => [t.id, t]));
  const depthMap = computeDependencyDepth(freeTiles, tileMap);
  const maxDepth = depthMap.size > 0 ? Math.max(...depthMap.values()) : 1;

  const rates: number[] = [];
  let cumTiles = 0;
  let prevTarget = 0;

  for (let d = 1; d < maxDepth; d++) {
    const layerTiles = allTiles.filter(t => depthMap.get(t.id) === d).length;
    cumTiles += layerTiles;
    const P = Math.floor(cumTiles / 3);
    const earlyLayerFloor = d <= 2 ? 1 : 0;
    const lo = Math.max(prevTarget, Math.min(earlyLayerFloor, P));
    const hi = P;
    const target = lo + Math.floor(rng() * (hi - lo + 1));
    rates.push(P > 0 ? target / P : 0);
    prevTarget = target;
  }
  return rates;
}

// ═══════════════════════════════════════════════════════════
// 参数随机化
// ═══════════════════════════════════════════════════════════

export function randomizeParams(
  params: UnifiedParams,
  terrain: TerrainData,
  rng: () => number,
): GenerationParams {
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(t => !t.isConst).length;

  return {
    closeRates: params.closeRates === 'random'
      ? randomizeCloseRatesFromTiles(allTiles, rng)
      : params.closeRates.split(',').map(s => Math.max(0, Math.min(1, parseFloat(s.trim()) || 0))),
    colorCount: params.colorCount === 'random'
      ? colorCountFromRatio(params.colorCountRatio, freeTiles)
      : params.colorCount,
    spreadParam: params.spreadParam === 'random' ? rng() : params.spreadParam,
    debtPersistenceWeight: params.debtPersistenceWeight === 'random'
      ? rng() : params.debtPersistenceWeight,
  };
}

// ═══════════════════════════════════════════════════════════
// 极限困难参数
// ═══════════════════════════════════════════════════════════

/** 探顶用：在统一参数配置的合法范围内取最困难的极端值 */
export function buildHardestParams(
  unified: UnifiedParams, terrain: TerrainData, depthCount: number,
): GenerationParams {
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(t => !t.isConst).length;

  // 随机模式下：每层 target = prevTarget（一个 triplet 都不新闭），rate = prevTarget / P
  let minCloseRates: number[];
  if (unified.closeRates === 'random') {
    const tileMap = new Map(allTiles.map(t => [t.id, t]));
    const freeOnly = allTiles.filter(t => !t.isConst);
    const depthMap = computeDependencyDepth(freeOnly, tileMap);
    const maxDepth = depthMap.size > 0 ? Math.max(...depthMap.values()) : 1;
    minCloseRates = [];
    let cum = 0, prev = 0;
    for (let d = 1; d < maxDepth; d++) {
      cum += allTiles.filter(t => depthMap.get(t.id) === d).length;
      const P = Math.floor(cum / 3);
      minCloseRates.push(P > 0 ? prev / P : 0);
    }
  } else {
    minCloseRates = unified.closeRates.split(',').map(s => Math.max(0, Math.min(1, parseFloat(s.trim()) || 0)));
  }

  return {
    closeRates: minCloseRates,
    colorCount: unified.colorCount === 'random'
      ? colorCountFromRatio(1.0, freeTiles)
      : unified.colorCount,
    spreadParam: unified.spreadParam === 'random' ? 1.0 : unified.spreadParam,
    debtPersistenceWeight: unified.debtPersistenceWeight === 'random' ? 1.0 : unified.debtPersistenceWeight,
  };
}

// ═══════════════════════════════════════════════════════════
// 帮助函数
// ═══════════════════════════════════════════════════════════

function computeDepthCount(tiles: ReturnType<typeof getAllTiles>): number {
  const tileMap = new Map(tiles.map(t => [t.id, t]));
  const depthMap = new Map<number, number>();
  function walk(id: number): number {
    const c = depthMap.get(id); if (c !== undefined) return c;
    const t = tileMap.get(id);
    if (!t || t.dependencies.length === 0) { depthMap.set(id, 1); return 1; }
    let maxD = 0;
    for (const depId of t.dependencies) { const d = walk(depId); if (d > maxD) maxD = d; }
    depthMap.set(id, maxD + 1); return maxD + 1;
  }
  for (const t of tiles) walk(t.id);
  return depthMap.size > 0 ? Math.max(...depthMap.values()) : 1;
}

function buildOfflineTiles(terrain: TerrainData, assignments: Map<number, number>): OfflineTile[] {
  const allTiles = getAllTiles(terrain);
  const evMap = new Map<number, number>();
  for (const t of allTiles) {
    if (t.isConst && t.constElementValue > 0) evMap.set(t.id, t.constElementValue);
  }
  for (const [tid, sv] of assignments) evMap.set(tid, sv);
  return allTiles.map(t => new OfflineTile({
    id: t.id, layer: t.layer, dependencies: t.dependencies,
    isConst: t.isConst, constElementValue: t.constElementValue,
    posX: t.posX, posY: t.posY,
  }, evMap.get(t.id) ?? 0));
}

function mkEmptyRow(idx: number, path: string, p: GenerationParams, attempt: number,
  isProbe: boolean, ok: boolean, err?: string): BatchRow {
  return {
    terrainIndex: idx, terrainPath: path, levelResId: '', attemptIndex: attempt,
    isMaxGradeProbe: isProbe,
    colorCount: p.colorCount, closeRates: p.closeRates,
    spreadParam: p.spreadParam, debtPersistenceWeight: p.debtPersistenceWeight,
    freeTiles: 0, totalTiles: 0, depthCount: 0,
    peakDebt: 0, peakExpDebt: 0, oi: 0, consecutiveOI: 0,
    suitSpreadNorm: 0, isDoomed: false, actualCloseRates: [], weightedDebtRetentionRate: 0,
    replayCode: '', grade: -1, passrate: 0, label: ok ? '' : '失败',
    simRuns: 0, sim1WinRate: 0, sim1Wins: 0, sim5WinRate: 0, sim5Wins: 0,
    sim15WinRate: 0, sim15Wins: 0, elapsedMs: 0, success: ok, error: err,
  };
}

// ═══════════════════════════════════════════════════════════
// 单次：生成 + 模拟 + 评估
// ═══════════════════════════════════════════════════════════

export function generateAndEvaluateOne(
  terrain: TerrainData, params: GenerationParams,
  terrainIndex: number, terrainPath: string,
  attemptIndex: number, isMaxGradeProbe: boolean,
  simRuns: number, seed: number,
): BatchRow {
  const t0 = performance.now();
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(t => !t.isConst).length;

  try {
    const result = generateBoardLayerClosure({
      terrain, closeRates: params.closeRates, colorCount: params.colorCount,
      dock: 7, spreadParam: params.spreadParam, debtPersistenceWeight: params.debtPersistenceWeight,
    });
    const m = result.metrics;
    const offlineTiles = buildOfflineTiles(terrain, result.assignments);

    // 三次模拟（串行，保持简单）
    function sim(rate: number, s: number) {
      const g = new OfflineGame(offlineTiles);
      const r = solvePlayerMistakeBatch(g, simRuns, seed + s, { mistakeRate: rate });
      return { winRate: r.winRate, wins: r.wins, losses: r.losses, elapsedMs: Math.round(r.elapsedMs) };
    }
    const s1 = sim(0.01, 1), s5 = sim(0.05, 2), s15 = sim(0.15, 3);

    const snap: SimSnapshot = {
      sim1: { ...s1, runs: simRuns }, sim5: { ...s5, runs: simRuns }, sim15: { ...s15, runs: simRuns },
    };
    const gd = gradeStrategy2(snap);

    return {
      terrainIndex, terrainPath, levelResId: String(terrain.levelResId ?? ''),
      attemptIndex, isMaxGradeProbe,
      colorCount: params.colorCount, closeRates: params.closeRates,
      spreadParam: params.spreadParam, debtPersistenceWeight: params.debtPersistenceWeight,
      freeTiles, totalTiles: allTiles.length, depthCount: m.depthCount,
      peakDebt: m.peakDebt, peakExpDebt: m.peakExpDebt, oi: m.oi, consecutiveOI: m.consecutiveOI,
      suitSpreadNorm: m.suitSpreadNorm, isDoomed: m.isDoomed,
      actualCloseRates: m.actualCloseRates, weightedDebtRetentionRate: m.weightedDebtRetentionRate,
      replayCode: result.replayCode,
      grade: gd.grade, passrate: gd.passrate, label: gd.label,
      simRuns, sim1WinRate: s1.winRate, sim1Wins: s1.wins,
      sim5WinRate: s5.winRate, sim5Wins: s5.wins,
      sim15WinRate: s15.winRate, sim15Wins: s15.wins,
      elapsedMs: Math.round(performance.now() - t0), success: true,
    };
  } catch (err) {
    return {
      ...mkEmptyRow(terrainIndex, terrainPath, params, attemptIndex, isMaxGradeProbe, false,
        err instanceof Error ? err.message : String(err)),
      freeTiles, totalTiles: allTiles.length,
      elapsedMs: Math.round(performance.now() - t0),
    };
  }
}

// ═══════════════════════════════════════════════════════════
// Phase 1: 探顶
// ═══════════════════════════════════════════════════════════

export function determineMaxGrade(
  terrain: TerrainData, unified: UnifiedParams,
  terrainIndex: number, terrainPath: string,
  simRuns: number, seed: number,
): { maxGrade: number; row: BatchRow } {
  const allTiles = getAllTiles(terrain);
  const d = computeDepthCount(allTiles);
  const params = buildHardestParams(unified, terrain, d);
  const row = generateAndEvaluateOne(terrain, params, terrainIndex, terrainPath, 0, true, simRuns, seed);
  return { maxGrade: row.success ? row.grade : 0, row };
}

// ═══════════════════════════════════════════════════════════
// Phase 2: 收样
// ═══════════════════════════════════════════════════════════

const yieldTick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export async function collectGradesForTerrain(
  terrain: TerrainData, unifiedParams: UnifiedParams,
  terrainIndex: number, terrainPath: string,
  maxGrade: number, targetPerTier: number, maxAttempts: number,
  simRuns: number, baseSeed: number,
  isAborted?: () => boolean,
  onProgress?: (collected: Record<number, number>, attempts: number, latestRow: BatchRow | null) => void,
): Promise<{ rows: BatchRow[]; collected: Record<number, number>; attempts: number }> {
  // 桶: 0..maxGrade 有 targetPerTier 要求; 超出也收但不强制
  const buckets: Record<number, BatchRow[]> = {};
  for (let g = 0; g <= Math.max(maxGrade, 5); g++) buckets[g] = [];

  const allRows: BatchRow[] = [];
  let attempts = 0;

  while (attempts < maxAttempts) {
    if (isAborted?.()) break;
    // 仅检查 0..maxGrade 是否收满
    let allFull = true;
    for (let g = 0; g <= maxGrade; g++) {
      if (buckets[g].length < targetPerTier) { allFull = false; break; }
    }
    if (allFull) break;

    const seed = baseSeed + 1000 + attempts * 10;
    const rng = mulberry32(seed + 999);
    const params = randomizeParams(unifiedParams, terrain, rng);

    const row = generateAndEvaluateOne(terrain, params, terrainIndex, terrainPath,
      attempts + 1, false, simRuns, seed);
    allRows.push(row);
    attempts++;

    if (row.success && row.grade >= 0) {
      if (row.grade <= maxGrade) {
        // 0..maxGrade: 有 targetPerTier 要求
        if (buckets[row.grade].length < targetPerTier) buckets[row.grade].push(row);
      } else {
        // 超出 maxGrade: 照收不误，但不设目标
        buckets[row.grade].push(row);
      }
    }

    if (onProgress) {
      const cts: Record<number, number> = {};
      for (let g = 0; g <= Math.max(maxGrade, 5); g++) cts[g] = buckets[g].length;
      onProgress(cts, attempts, row);
    }
    // 让出事件循环，允许轮询请求得到处理
    await yieldTick();
    if (isAborted?.()) break;
  }

  const collected: Record<number, number> = {};
  for (let g = 0; g <= Math.max(maxGrade, 5); g++) collected[g] = buckets[g].length;
  return { rows: allRows, collected, attempts };
}

// ═══════════════════════════════════════════════════════════
// CSV 序列化
// ═══════════════════════════════════════════════════════════

export const BATCH_CSV_HEADERS = [
  // 前 13 列：兼容现有 replay-selection 格式
  'levelResId', 'ReplayKey', 'ReplayCode', 'grade', 'passrate', 'ElementCount',
  'DifficultyScore', 'CompletionStatus', 'ExpectConsume', 'LevelTags', 'ReplayTags',
  'highWinRate', 'MiddleWinRate', 'LowWinRate',
  // 后 12 列：生成参数 + sim 详情 + 实际闭合率 + 元信息
  'colorCount', 'closeRates', 'spreadParam', 'debtPersistenceWeight',
  'simRuns', 'sim1Wins', 'sim5Wins', 'sim15Wins', 'totalTiles',
  'optimalRuns', 'optimalWins', 'optimalLosses', 'optimalWinRate',
  'optimalForcedPickOnWin', 'optimalStarvationOnWin',
  'optimalStepsOnLoss', 'optimalForcedPickOnLoss', 'optimalStarvationOnLoss',
  'optimalRemainingTilesOnLoss', 'optimalRemainingRatioOnLoss',
  'actualCloseRates',
  'attemptIndex', 'isMaxGradeProbe', 'terrainPath',
];

function csvEscape(val: unknown): string {
  const s = String(val);
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? `"${s.replace(/"/g, '""')}"` : s;
}

export function serializeBatchRow(row: BatchRow): string {
  const levelResId = row.levelResId || row.terrainPath.replace(/^.*[\\/]/, '').replace('.json', '');
  const replayKey = `batch-${row.colorCount}-${row.attemptIndex}`;
  const grade = row.success ? row.grade : '';
  const passrate = row.success ? row.passrate : 0;
  const status = row.success ? 'Success' : `Failed: ${row.error || 'unknown'}`;
  const tags = row.levelTags ?? `cr=${row.closeRates.map(r => r.toFixed(2)).join('|')}|sp=${row.spreadParam.toFixed(2)}|dp=${row.debtPersistenceWeight.toFixed(2)}|cc=${row.colorCount}`;

  return [
    // 前 13
    levelResId, replayKey, row.replayCode, grade, passrate, row.colorCount,
    0, status, 0, tags, '',
    row.sim1WinRate, row.sim5WinRate, row.sim15WinRate,
    // 后 12
    row.colorCount, row.closeRates.join(','), row.spreadParam, row.debtPersistenceWeight,
    row.simRuns, row.sim1Wins, row.sim5Wins, row.sim15Wins, row.totalTiles,
    row.optimalRuns ?? '', row.optimalWins ?? '', row.optimalLosses ?? '', row.optimalWinRate ?? '',
    row.optimalForcedPickOnWin ?? '', row.optimalStarvationOnWin ?? '',
    row.optimalStepsOnLoss ?? '', row.optimalForcedPickOnLoss ?? '', row.optimalStarvationOnLoss ?? '',
    row.optimalRemainingTilesOnLoss ?? '', row.optimalRemainingRatioOnLoss ?? '',
    row.actualCloseRates.join(','),
    row.attemptIndex, row.isMaxGradeProbe ? 1 : 0, row.terrainPath,
  ].map(csvEscape).join(',');
}

export function serializeBatchCsv(rows: BatchRow[]): string {
  return `﻿${BATCH_CSV_HEADERS.join(',')}\n${rows.map(serializeBatchRow).join('\n')}\n`;
}

export async function runTerrainGeneration(
  config: BatchConfig,
  unified: UnifiedParams,
  terrainIndex: number,
  terrainPath: string,
  isAborted?: () => boolean,
  onProgress?: (terrain: TerrainProgress, rowsAdded: number) => void,
): Promise<TerrainProgress> {
  const tp: TerrainProgress = {
    terrainIndex, terrainPath, phase: 'idle',
    maxGrade: 0, collected: {}, attempts: 0, rows: [],
  };

  let terrain: TerrainData;
  try { terrain = loadTerrainFromFile(terrainPath); } catch (err) {
    tp.phase = 'done';
    const ep: GenerationParams = { closeRates: [], colorCount: 0, spreadParam: 0, debtPersistenceWeight: 0 };
    tp.rows.push(mkEmptyRow(terrainIndex, terrainPath, ep, 0, false, false, err instanceof Error ? err.message : String(err)));
    if (onProgress) onProgress(tp, 1);
    return tp;
  }

  // Phase 1
  tp.phase = 'maxgrade';
  if (onProgress) onProgress(tp, 0);
  const seed = (Date.now() + terrainIndex * 10000) & 0x7fffffff;
  const { maxGrade, row: probe } = determineMaxGrade(terrain, unified, terrainIndex, terrainPath, config.simRuns, seed);
  tp.maxGrade = maxGrade;
  tp.rows.push(probe);
  for (let g = 0; g <= Math.max(maxGrade, 5); g++) tp.collected[g] = 0;
  if (probe.success && probe.grade >= 0) tp.collected[probe.grade] = 1;
  if (onProgress) onProgress(tp, 1);
  await yieldTick();

  // Phase 2
  tp.phase = 'collecting';
  const { collected, attempts } = await collectGradesForTerrain(
    terrain, unified, terrainIndex, terrainPath, maxGrade,
    config.targetPerTier, config.maxAttempts, config.simRuns, seed,
    isAborted,
    (cts, att, latestRow) => {
      tp.collected = { ...cts };
      if (probe.success && probe.grade >= 0) {
        tp.collected[probe.grade] = Math.max(tp.collected[probe.grade], 1);
      }
      tp.attempts = att;
      if (latestRow) tp.rows.push(latestRow);
      if (onProgress) onProgress(tp, latestRow ? 1 : 0);
    },
  );
  tp.attempts = attempts; tp.collected = collected;
  if (probe.success && probe.grade >= 0) {
    tp.collected[probe.grade] = Math.max(tp.collected[probe.grade], 1);
  }
  tp.phase = 'done';
  if (onProgress) onProgress(tp, 0);
  return tp;
}

function cloneTerrainWithoutRows(tp: TerrainProgress): TerrainProgress {
  return { ...tp, rows: [] };
}

function normalizeConcurrency(config: BatchConfig): number {
  const requested = Math.floor(Number(config.concurrency ?? 1));
  const maxByTerrain = Math.max(1, config.terrainPaths.length);
  const maxByCpu = Math.max(1, availableParallelism() - 1);
  return Math.max(1, Math.min(maxByTerrain, maxByCpu, requested || 1));
}

function getWorkerExecArgv(): string[] {
  const args: string[] = [];
  for (let i = 0; i < process.execArgv.length; i++) {
    const arg = process.execArgv[i];
    if (arg === '--eval' || arg === '-e' || arg === '--print' || arg === '-p') {
      i++;
      continue;
    }
    args.push(arg);
  }
  return args;
}

function runTerrainWorker(
  config: BatchConfig,
  terrainIndex: number,
  terrainPath: string,
  isAborted?: () => boolean,
  onProgress?: (terrain: TerrainProgress, rowsAdded: number) => void,
): Promise<TerrainProgress> {
  return new Promise((resolve, reject) => {
    const worker = fork(fileURLToPath(new URL('./batch-worker.ts', import.meta.url)), [], {
      execArgv: getWorkerExecArgv(),
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    let finalTerrain: TerrainProgress | null = null;
    let settled = false;
    const abortTimer = setInterval(() => {
      if (isAborted?.() && worker.connected) worker.send({ type: 'abort' });
    }, 25);

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(abortTimer);
      reject(err);
    };

    worker.on('message', (msg: WorkerMessage) => {
      if (msg.type === 'progress') {
        if (onProgress) onProgress(msg.terrain, msg.rowsAdded);
      } else if (msg.type === 'done') {
        finalTerrain = msg.terrain;
      } else if (msg.type === 'error') {
        fail(new Error(msg.error));
      }
    });
    worker.on('error', fail);
    worker.on('exit', (code) => {
      if (settled) return;
      clearInterval(abortTimer);
      if (code !== 0) {
        fail(new Error(`Worker exited with code ${code}`));
      } else if (finalTerrain) {
        settled = true;
        resolve(finalTerrain);
      } else {
        fail(new Error('Worker exited without result'));
      }
    });
    worker.send({ config, terrainIndex, terrainPath });
  });
}

// ═══════════════════════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════════════════════

export async function runBatchGeneration(
  config: BatchConfig, onProgress?: ProgressCallback,
  isAborted?: () => boolean,
): Promise<BatchProgress> {
  const jobId = `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const progress: BatchProgress = {
    jobId, status: 'running',
    terrains: config.terrainPaths.map((p, i) => ({
      terrainIndex: i, terrainPath: p, phase: 'idle' as const,
      maxGrade: 0, collected: {}, attempts: 0, rows: [],
    })),
    totalRows: 0, startedAt: Date.now(),
  };

  const unified: UnifiedParams = {
    closeRates: config.closeRates, colorCount: config.colorCount,
    colorCountRatio: config.colorCountRatio,
    spreadParam: config.spreadParam, debtPersistenceWeight: config.debtPersistenceWeight,
  };

  const updateTerrain = (terrain: TerrainProgress, rowsAdded: number) => {
    progress.terrains[terrain.terrainIndex] = terrain;
    progress.totalRows += rowsAdded;
    if (onProgress) onProgress(progress);
    progress.terrains[terrain.terrainIndex] = cloneTerrainWithoutRows(terrain);
  };

  const concurrency = normalizeConcurrency(config);
  if (concurrency <= 1) {
    for (let i = 0; i < config.terrainPaths.length; i++) {
      if (isAborted?.()) break;
      const finalTerrain = await runTerrainGeneration(
        config, unified, i, config.terrainPaths[i], isAborted, updateTerrain,
      );
      progress.terrains[i] = cloneTerrainWithoutRows(finalTerrain);
      if (onProgress) onProgress(progress);
    }
  } else {
    let nextIndex = 0;
    const runNext = async (): Promise<void> => {
      if (isAborted?.()) return;
      const i = nextIndex++;
      if (i >= config.terrainPaths.length) return;
      const finalTerrain = await runTerrainWorker(
        config, i, config.terrainPaths[i], isAborted, updateTerrain,
      );
      progress.terrains[i] = cloneTerrainWithoutRows(finalTerrain);
      if (onProgress) onProgress(progress);
      await runNext();
    };
    const workers = Array.from({ length: concurrency }, () => runNext());
    await Promise.all(workers);
  }

  progress.status = isAborted?.() ? 'aborted' as const : 'done';
  if (onProgress) onProgress(progress);
  return progress;
}
