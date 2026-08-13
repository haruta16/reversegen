/**
 * GUI 批量生产与候选牌局收集 API。
 *
 * /api/batch-generate/* 的网页批量任务由 strategy v2 执行器（fork 子进程）
 * 驱动，这里只保留 UI 轮询所需的进程信息与投影。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import type { StrategyDefinition, StrategyRunRecord } from '../../src/strategy/types.js';
import {
  strategyRecordToBatchRow,
  webBatchConfigToStrategyV2,
  type WebBatchConfig,
} from '../../src/strategy/web-adapter.js';
import { serializeBatchCsv, type BatchProgress, type BatchRow } from '../../src/batch-generator.js';
import {
  appendReplaySelection,
  buildReplaySelections,
  defaultReplaySelectionPaths,
} from '../../src/replay-selection.js';
import { decodeFromString } from '../../src/index.js';
import {
  GENERATION_RUNS_DIR,
  PROJECT_ROOT,
  json,
  parseBody,
  writeJsonAtomic,
} from './runtime.js';
import { readJsonFile } from './strategy-admin.js';

interface WebBatchJob {
  jobId: string;
  definition: StrategyDefinition;
  terrainPaths: string[];
  outputDir: string;
  strategyPath: string;
  child: ChildProcess;
  startedAt: number;
  state: 'running' | 'done' | 'error' | 'aborted';
  error?: string;
}

/** 网页批量任务也由 strategy v2 执行，这里只保留 UI 轮询所需的进程信息。 */
const batchJobs = new Map<string, WebBatchJob>();

function readStrategyRecords(path: string): StrategyRunRecord[] {
  if (!existsSync(path)) return [];
  const records: StrategyRunRecord[] = [];
  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line) as StrategyRunRecord); }
    catch { /* the writer may currently be appending the final line */ }
  }
  return records;
}

function webBatchRows(job: WebBatchJob): BatchRow[] {
  const terrainIndexes = new Map(job.terrainPaths.map((path, index) => [basename(path, '.json'), index]));
  return readStrategyRecords(join(job.outputDir, 'accepted.jsonl')).map(record =>
    strategyRecordToBatchRow(record, terrainIndexes.get(record.candidate.terrain_id) ?? 0));
}

function webBatchProgress(job: WebBatchJob): BatchProgress {
  const statusPath = join(job.outputDir, 'status.json');
  const status = existsSync(statusPath) ? readJsonFile<any>(statusPath) : { jobs: {} };
  const rows = webBatchRows(job);
  const rowsByLevel = new Map<string, BatchRow[]>();
  for (const row of rows) {
    const levelRows = rowsByLevel.get(row.levelResId) ?? [];
    levelRows.push(row);
    rowsByLevel.set(row.levelResId, levelRows);
  }
  const maxGrade = Math.max(...job.definition.target.grades);
  return {
    jobId: job.jobId,
    status: job.state,
    terrains: job.terrainPaths.map((terrainPath, terrainIndex) => {
      const level = basename(terrainPath, '.json');
      const state = status.jobs?.[level] ?? {};
      return {
        terrainIndex,
        terrainPath,
        phase: state.status === 'running'
          ? 'collecting'
          : state.status === 'complete' || state.status === 'partial' || state.status === 'error'
            ? 'done'
            : 'idle',
        maxGrade,
        collected: state.accepted ?? {},
        attempts: Number(state.attempts_completed ?? 0),
        rows: rowsByLevel.get(level) ?? [],
      };
    }),
    totalRows: rows.length,
    startedAt: job.startedAt,
    error: job.error,
  };
}

// route-handlers placeholder
export async function handleBatchStart(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/batch-generate/start' || req.method !== 'POST') return false;
    const body = await parseBody(req);
    try {
      const raw = body as unknown as Partial<WebBatchConfig>;
      const terrainPaths = Array.isArray(raw.terrainPaths) ? raw.terrainPaths.map(String) : [];
      const config: WebBatchConfig = {
        terrainPaths,
        closeRates: raw.closeRates === 'random' ? 'random' : String(raw.closeRates ?? '0.3,0.6,0.8'),
        colorCount: raw.colorCount === 'random' ? 'random' : Number(raw.colorCount ?? 8),
        colorCountRatio: Number(raw.colorCountRatio ?? 0.6),
        spreadParam: raw.spreadParam === 'random' ? 'random' : Number(raw.spreadParam ?? 0),
        debtPersistenceWeight: raw.debtPersistenceWeight === 'random' ? 'random' : Number(raw.debtPersistenceWeight ?? 0),
        simRuns: Number(raw.simRuns ?? 200),
        targetPerTier: Number(raw.targetPerTier ?? 10),
        maxAttempts: Number(raw.maxAttempts ?? 500),
        concurrency: Math.max(1, Math.min(terrainPaths.length, Math.floor(Number(raw.concurrency ?? 1)))),
        seed: Number(raw.seed ?? 20260630),
        targetGrades: raw.targetGrades,
      };
      const jobId = `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const outputDir = join(GENERATION_RUNS_DIR, jobId, jobId);
      const strategyPath = join(outputDir, 'strategy.request.v2.json');
      const definition = webBatchConfigToStrategyV2(config, jobId);
      writeJsonAtomic(strategyPath, definition);
      const script = join(PROJECT_ROOT, 'tools', 'run-strategy.ts');
      const child = fork(script, ['--strategy', strategyPath, '--output-dir', outputDir, '--run'], {
        cwd: PROJECT_ROOT,
        execArgv: process.execArgv.filter(arg => !['--eval', '-e', '--print', '-p'].includes(arg)),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      const job: WebBatchJob = {
        jobId,
        definition,
        terrainPaths,
        outputDir,
        strategyPath,
        child,
        startedAt: Date.now(),
        state: 'running',
      };
      batchJobs.set(jobId, job);
      let stderr = '';
      child.stderr?.on('data', chunk => { stderr += String(chunk); });
      child.stdout?.on('data', chunk => console.log(`[batch:${jobId}] ${String(chunk).trim()}`));
      child.on('error', error => {
        job.state = 'error';
        job.error = error.message;
      });
      child.on('exit', code => {
        if (job.state === 'running') {
          job.state = code === 0 ? 'done' : 'error';
          if (code !== 0) job.error = stderr.trim() || `strategy runner exited with code ${code}`;
        }
        setTimeout(() => {
          batchJobs.delete(jobId);
        }, 30 * 60 * 1000);
      });
      json(res, { ok: true, jobId, schemaVersion: 2, seed: definition.runtime.seed });
    } catch (err) { json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 400); }
    return true;
  }

export async function handleBatchStop(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/batch-generate/stop' || req.method !== 'POST') return false;
    const body = await parseBody(req);
    const jobId = (body as { jobId?: string }).jobId;
    if (!jobId) { json(res, { ok: false, error: 'Missing jobId' }, 400); return true; }
    const job = batchJobs.get(jobId);
    if (!job) { json(res, { ok: false, error: 'Job not found' }, 404); return true; }
    job.state = 'aborted';
    job.child.kill('SIGTERM');
    json(res, { ok: true });
    return true;
  }

export async function handleBatchStatus(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/batch-generate/status' || req.method !== 'GET') return false;
    const jobId = url.searchParams.get('jobId');
    if (!jobId) { json(res, { ok: false, error: 'Missing jobId' }, 400); return true; }
    const job = batchJobs.get(jobId);
    if (!job) { json(res, { ok: false, error: 'Job not found' }, 404); return true; }
    json(res, { ok: true, ...webBatchProgress(job), schemaVersion: 2, seed: job.definition.runtime.seed });
    return true;
  }

export async function handleBatchCsv(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/batch-generate/csv' || req.method !== 'GET') return false;
    const jobId = url.searchParams.get('jobId');
    if (!jobId) { json(res, { ok: false, error: 'Missing jobId' }, 400); return true; }
    const job = batchJobs.get(jobId);
    if (!job) { json(res, { ok: false, error: 'Job not found' }, 404); return true; }
    try {
      const csv = serializeBatchCsv(webBatchRows(job));
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="batch_result_${jobId}.csv"`,
      });
      res.end(csv);
    } catch { json(res, { ok: false, error: 'CSV file not available' }, 500); }
    return true;
  }

export async function handleReplaySelectionAppend(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/replay-selection/append' || req.method !== 'POST') return false;
    const body = await parseBody(req);
    try {
      const { levelResId, replayCode, grade, elementCount, passrate } = body as {
        levelResId?: number | string;
        replayCode?: string;
        grade?: number | string | null;
        passrate?: number | string | null;
        elementCount?: number | string;
      };
      if (levelResId == null || levelResId === '') throw new Error('缺少 levelResId');
      if (!replayCode) throw new Error('缺少 ReplayCode');
      if (elementCount == null || elementCount === '') throw new Error('缺少花色数');
      const replayData = decodeFromString(replayCode);
      if (!replayData) throw new Error('ReplayCode 解码失败');
      if (Number(elementCount) !== replayData.elementCount) {
        throw new Error(`花色数与 ReplayCode 不一致：提交 ${elementCount}，实际 ${replayData.elementCount}`);
      }

      const paths = defaultReplaySelectionPaths();
      const result = appendReplaySelection({
        levelResId,
        ReplayCode: replayCode,
        grade,
        passrate,
        ElementCount: elementCount,
      }, paths.csvPath);
      json(res, {
        ok: true,
        duplicate: result.duplicate,
        totalRows: result.totalRows,
        replayKey: result.row.ReplayKey,
        csvPath: paths.csvPath,
        message: result.duplicate ? '该牌局已在 CSV 中，未重复写入' : '已保存到候选 CSV',
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return true;
  }

export async function handleReplaySelectionBuild(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/replay-selection/build' || req.method !== 'POST') return false;
    try {
      const paths = defaultReplaySelectionPaths();
      const result = buildReplaySelections(paths.csvPath, paths.generatedDir);
      json(res, {
        ok: true,
        rowsRead: result.rowsRead,
        validRows: result.validRows,
        skippedBlankGrade: result.skippedBlankGrade,
        skippedLines: result.skippedLines,
        levelCount: result.levelCount,
        fileCount: result.files.length,
        files: result.files.map(file => basename(file)),
        generatedDir: paths.generatedDir,
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return true;
  }
