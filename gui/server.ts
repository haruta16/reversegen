/**
 * HTTP server for ReverseGen web GUI.
 *
 * Usage:
 *   npx tsx gui/server.ts [--host 0.0.0.0] [--port 3000] [--open]
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync, readdirSync, writeFileSync, appendFileSync, unlinkSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join, dirname, basename, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, execFile, fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import {
  appendReplaySelection,
  buildReplaySelections,
  defaultReplaySelectionPaths,
} from '../src/replay-selection.js';

import {
  generateBoard,
  generateBoardLayerClosure,
  generateBoardTileExplorer,
  loadTerrainFromFile,
  getAllTiles,
  getCanonicalTileOrder,
  decodeFromString,
  formatHash,
  setLogLevel,
  LogLevel,
  computeDependencyDepth,
  gradeStandard,
  gradeRefined,
  gradeStrategy1,
  gradeStrategy2,
  gradeFull,
  validateGrade,
  computeStability,
  computeAllDependencies,
  runPureGreedySimulation,
  computeMetrics,
  computeTileDepSets,
  computeCloseRatesFromAssignments,
} from '../src/index.js';
import type { TerrainTile, GradeConfig, GradeStrategy1Config, GradeResult, GradeValidation, GradeVerdict, GradeStrategy2Result } from '../src/index.js';
import {
  analyzeTriples,
  filterGraphData,
  getTripleDetail,
} from '../tools/dag/triple-analyzer.js';
import { buildEliminationPlan } from '../tools/planning/elimination-plan.js';
import {
  OfflineGame,
  solveDFS,
  solveDeathCheckpoint,
  solvePlayerBatch,
  solvePlayerRiskyBatch,
  solvePlayerCostCapBatch,
  solvePlayerMistakeBatch,
  solvePlayerShortestBatch,
  OfflineTile,
  PileType,
} from '../src/solver/index.js';
import {
  serializeBatchCsv,
  type BatchProgress,
  type BatchRow,
} from '../src/batch-generator.js';
import { validateStrategyDefinition } from '../src/strategy/definition.js';
import type { StrategyDefinition, StrategyRunRecord } from '../src/strategy/types.js';
import {
  compileEditorStrategyV2,
  strategyRecordToBatchRow,
  strategyV2ToEditor,
  webBatchConfigToStrategyV2,
  type StrategyEditorMeta,
  type WebBatchConfig,
} from '../src/strategy/web-adapter.js';
import { generateReplayFromExternalInput } from '../src/external-generation.js';

/** 内存中的分析结果缓存 (keyed by terrainHash)，最多保留 50 条，LRU 淘汰 */
const ANALYSIS_CACHE_MAX = 50;
const analysisCache = new Map<string, ReturnType<typeof analyzeTriples>>();

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

function cacheGet(key: string): ReturnType<typeof analyzeTriples> | undefined {
  // LRU: delete + re-insert to move to end
  const val = analysisCache.get(key);
  if (val !== undefined) {
    analysisCache.delete(key);
    analysisCache.set(key, val);
  }
  return val;
}

function cacheSet(key: string, value: ReturnType<typeof analyzeTriples>): void {
  // Evict oldest if at capacity (Map iterates in insertion order)
  if (analysisCache.size >= ANALYSIS_CACHE_MAX && !analysisCache.has(key)) {
    const oldest = analysisCache.keys().next().value;
    if (oldest !== undefined) analysisCache.delete(oldest);
  }
  analysisCache.set(key, value);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUI_DIR = __dirname;
const PROJECT_ROOT = join(__dirname, '..');
const GENERATION_STRATEGIES_DIR = join(PROJECT_ROOT, 'strategies');
const GENERATION_RUNS_DIR = join(PROJECT_ROOT, 'output', 'runs');
const GENERATION_SCHEMA_PATH = join(PROJECT_ROOT, 'config', 'strategy-v2.schema.json');
const GENERATION_CATALOG_PATH = join(PROJECT_ROOT, 'config', 'generation-feature-catalog.json');
const UPLOADED_TERRAINS_DIR = join(PROJECT_ROOT, '.reversegen-cache', 'uploaded-terrains');
const GENERATION_STRATEGY_ID = /^[a-z0-9][a-z0-9_-]{2,79}$/;
const APP_NAME = 'reversegen';
const APP_VERSION = (() => {
  try { return String(JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8')).version || '0.0.0'); }
  catch { return '0.0.0'; }
})();

function normalizeBasePath(value: string | undefined): string {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed === '/') return '/';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}/`;
}

const appBasePath = normalizeBasePath(process.env.APP_BASE_PATH);
const frameAncestors = String(process.env.FRAME_ANCESTORS || '').trim();
const appSurface = String(process.env.APP_SURFACE || 'full').trim().toLowerCase() || 'full';

type GenerationStrategy = Record<string, any>;

// ── CLI Args ──
const args = process.argv.slice(2);
let port = Number.parseInt(process.env.PORT || '', 10) || 3000;
let host = String(process.env.HOST || '0.0.0.0').trim() || '0.0.0.0';
let autoOpen = false;
let openPath = '/';
// Default: look for levels in the original TileMatchShell project
let defaultLevelsDir = String(process.env.LEVELS_DIR || '').trim()
  || join(__dirname, '..', '..', 'TileMatchShell', 'Tools', 'Config', 'Json', 'Levels');

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = parseInt(args[i + 1], 10); i++;
  } else if (args[i] === '--host' && args[i + 1]) {
    host = args[i + 1]; i++;
  } else if (args[i] === '--open') {
    autoOpen = true;
  } else if (args[i] === '--open-challenge') {
    autoOpen = true;
    openPath = '/challenge-expectation';
  } else if (args[i] === '--levels-dir' && args[i + 1]) {
    defaultLevelsDir = args[i + 1]; i++;
  }
}

// ── Helpers ──
setLogLevel(LogLevel.Silent);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
};

function serveStatic(res: ServerResponse, path: string): void {
  try {
    const resolvedPath = resolve(path);
    const relativePath = relative(resolve(GUI_DIR), resolvedPath);
    if (!existsSync(resolvedPath) || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const content = readFileSync(resolvedPath);
    res.writeHead(200, { 'Content-Type': MIME[resolvedPath.substring(resolvedPath.lastIndexOf('.'))] || 'application/octet-stream' });
    res.end(content);
  } catch { res.writeHead(500); res.end('Internal error'); }
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = '';
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > 25 * 1024 * 1024) {
        tooLarge = true;
        body = '';
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) { resolve({ bodyError: '请求内容不能超过 25 MB' }); return; }
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

function generationStrategyPath(strategyId: string): string {
  if (!GENERATION_STRATEGY_ID.test(strategyId)) throw new Error('策略 ID 仅允许小写字母、数字、下划线和连字符');
  return join(GENERATION_STRATEGIES_DIR, strategyId, 'strategy.v2.json');
}

function generationStrategyUiPath(strategyId: string): string {
  generationStrategyPath(strategyId);
  return join(GENERATION_STRATEGIES_DIR, strategyId, 'ui.json');
}

function readStrategyUiMeta(strategyId: string): StrategyEditorMeta {
  const path = generationStrategyUiPath(strategyId);
  return existsSync(path) ? readJsonFile<StrategyEditorMeta>(path) : {};
}

function editorMeta(strategy: GenerationStrategy): StrategyEditorMeta {
  return {
    name: String(strategy.meta?.name || strategy.meta?.strategy_id || ''),
    status: String(strategy.meta?.status || 'active'),
    notes: String(strategy.meta?.notes || ''),
  };
}

function readJsonFile<T = any>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function readGenerationCatalog(): any {
  const catalog = readJsonFile<any>(GENERATION_CATALOG_PATH);
  const groups = catalog.fieldGroups || {};
  const generators = catalog.generators || {};
  const modes = catalog.policyModes || {};
  const policyFields = new Set(['value', 'ratio', 'jitter', 'min', 'max', 'points']);
  const reachableFields = new Map<string, Set<string>>(
    Object.keys(groups).map(group => [group, new Set<string>()]),
  );
  const reachableModes = new Set<string>();
  if (!catalog.workflows || !Object.keys(catalog.workflows).length) throw new Error('页面能力目录缺少 workflows');
  for (const [group, fieldIds] of Object.entries<any>(catalog.commonFields || {})) {
    if (!groups[group]) throw new Error(`通用配置引用了未知字段组 ${group}`);
    for (const fieldId of fieldIds || []) {
      if (!groups[group].includes(fieldId)) throw new Error(`通用配置引用了未知字段 ${group}.${fieldId}`);
      reachableFields.get(group)?.add(fieldId);
    }
  }
  for (const [workflowId, workflow] of Object.entries<any>(catalog.workflows)) {
    for (const section of workflow.sections || []) {
      if (section !== 'generation' && !groups[section]) throw new Error(`工作流 ${workflowId} 引用了未知模块 ${section}`);
    }
    for (const [group, fieldIds] of Object.entries<any>(workflow.fields || {})) {
      if (!groups[group]) throw new Error(`工作流 ${workflowId} 引用了未知字段组 ${group}`);
      for (const fieldId of fieldIds || []) {
        if (!groups[group].includes(fieldId)) throw new Error(`工作流 ${workflowId} 引用了未知字段 ${group}.${fieldId}`);
        reachableFields.get(group)?.add(fieldId);
      }
    }
    for (const generatorId of workflow.supportedGenerators || []) {
      if (!generators[generatorId]) throw new Error(`工作流 ${workflowId} 引用了未知生成器 ${generatorId}`);
    }
  }
  for (const [generatorId, generator] of Object.entries<any>(generators)) {
    for (const policy of generator.policies || []) {
      if (!generator.policyModes?.[policy]) throw new Error(`生成器 ${generatorId} 缺少 ${policy} 的 mode 列表`);
      for (const mode of generator.policyModes[policy]) {
        if (!modes[mode]) throw new Error(`生成器 ${generatorId}.${policy} 引用了未知 mode ${mode}`);
        reachableModes.add(mode);
      }
    }
  }
  for (const [group, fieldIds] of Object.entries<any>(groups)) {
    for (const fieldId of fieldIds || []) {
      if (!reachableFields.get(group)?.has(fieldId)) throw new Error(`配置项 ${group}.${fieldId} 没有可选择的工作流入口`);
    }
  }
  for (const [mode, definition] of Object.entries<any>(modes)) {
    if (!reachableModes.has(mode)) throw new Error(`参数 mode ${mode} 没有可选择的生成器入口`);
    for (const field of definition.fields || []) {
      if (!policyFields.has(field)) throw new Error(`参数 mode ${mode} 引用了未知输入字段 ${field}`);
    }
  }
  const batchWorkflow = catalog.workflows['run-batch-generation'];
  batchWorkflow.supportedGenerators = ['layer-closure'];
  batchWorkflow.fields.evaluation = ['gradeStrategy', 'simRuns', 'simulationEngine', 'thresholdProfile', 'collectTrace', 'traceSampleRate', 'optimalRuns', 'optimalEnabled', 'optimalWrap'];
  batchWorkflow.fields.search = ['attemptsPerLevel', 'concurrency', 'strategySeed'];
  batchWorkflow.fields.outputs = ['outputDirectory', 'writeConfig'];
  catalog.workflows = { 'run-batch-generation': batchWorkflow };
  catalog.generators = { 'layer-closure': catalog.generators['layer-closure'] };
  catalog.generators['layer-closure'].policyModes.closure = ['random', 'random_range', 'per_layer_list'];
  return catalog;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  renameSync(temp, path);
}

function strategySummary(strategy: StrategyDefinition, path: string, ui: StrategyEditorMeta = {}) {
  const target = strategy.target || {};
  return {
    strategyId: strategy.id || basename(path, '.v2.json'),
    name: String(ui.name || strategy.id),
    version: strategy.version,
    purpose: String(strategy.description || ''),
    status: String(ui.status || 'active'),
    executor: 'run-batch-generation',
    grades: Array.isArray(target.grades) ? target.grades : [],
    targetCount: Number(target.count_per_grade || 0),
    sourceCsv: '',
    updatedAt: statSync(path).mtime.toISOString(),
  };
}

function listGenerationStrategies() {
  mkdirSync(GENERATION_STRATEGIES_DIR, { recursive: true });
  return readdirSync(GENERATION_STRATEGIES_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && GENERATION_STRATEGY_ID.test(entry.name))
    .map(entry => {
      const path = generationStrategyPath(entry.name);
      if (!existsSync(path)) return null;
      try {
        const strategy = validateStrategyDefinition(readJsonFile(path));
        return strategySummary(strategy, path, readStrategyUiMeta(strategy.id));
      }
      catch (error) {
        return {
          strategyId: entry.name, name: entry.name, version: 0,
          purpose: String(error), status: 'invalid', executor: '', grades: [], targetCount: 0,
          sourceCsv: '', updatedAt: statSync(path).mtime.toISOString(),
        };
      }
    })
    .filter((item): item is Exclude<typeof item, null> => item !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function historyStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').replace('Z', '').replace('.', '_');
}

function writeGenerationStrategySnapshot(
  strategy: StrategyDefinition,
  ui: StrategyEditorMeta,
  reason: string,
  stableName = false,
): void {
  const id = strategy.id;
  const version = strategy.version;
  const dir = join(GENERATION_STRATEGIES_DIR, id, 'versions');
  mkdirSync(dir, { recursive: true });
  const suffix = stableName ? 'baseline' : historyStamp();
  const path = join(dir, `v${version}_${suffix}.json`);
  if (stableName && existsSync(path)) return;
  writeJsonAtomic(path, { recordedAt: new Date().toISOString(), reason, strategy, ui });
}

function listGenerationStrategyHistory(strategyId: string) {
  generationStrategyPath(strategyId);
  const dir = join(GENERATION_STRATEGIES_DIR, strategyId, 'versions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      const value = readJsonFile<any>(join(dir, name));
      const strategy = validateStrategyDefinition(value.strategy || value);
      const ui = value.ui ?? readStrategyUiMeta(strategy.id);
      const editor = strategyV2ToEditor(strategy, ui);
      return {
        file: name,
        recordedAt: value.recordedAt || statSync(join(dir, name)).mtime.toISOString(),
        reason: value.reason || 'history',
        version: strategy.version,
        name: String(ui.name || strategy.id),
        status: String(ui.status || 'active'),
        strategy: editor,
      };
    })
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

async function validateGenerationStrategy(strategy: GenerationStrategy): Promise<{ ok: boolean; errors: string[]; warnings: string[] }> {
  try {
    compileEditorStrategyV2(strategy);
    return { ok: true, errors: [], warnings: [] };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)], warnings: [] };
  }
}

async function planGenerationStrategy(strategyPath: string, strategyId: string): Promise<any> {
  const strategy = validateStrategyDefinition(readJsonFile(strategyPath));
  return {
    schema_version: 2,
    strategy: { id: strategy.id, version: strategy.version, file: strategyPath },
    output_root: join(GENERATION_RUNS_DIR, strategy.id),
    command: `npm run strategy:run -- --strategy ${strategyPath}`,
    levels: strategy.scope.levels.length,
    max_attempts_per_level: strategy.target.max_attempts_per_level,
    strategyId,
  };
}

function refreshGenerationStrategyIndex(): void {
  // strategy v2 files in /strategies are the index; no generated legacy index is needed.
}

function listGenerationRuns() {
  if (!existsSync(GENERATION_RUNS_DIR)) return [];
  const summaries = new Map(listGenerationStrategies().map(item => [item.strategyId, item]));
  return readdirSync(GENERATION_RUNS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(strategyEntry => readdirSync(join(GENERATION_RUNS_DIR, strategyEntry.name), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(runEntry => {
        try {
          const outputDir = join(GENERATION_RUNS_DIR, strategyEntry.name, runEntry.name);
          const manifestPath = join(outputDir, 'manifest.json');
          if (!existsSync(manifestPath)) return null;
          const manifest = readJsonFile<any>(manifestPath);
          const artifacts = manifest.artifacts ?? {};
          const snapshotPath = join(outputDir, artifacts.strategy_snapshot ?? 'strategy.snapshot.json');
          return {
            runId: String(manifest.run_id ?? runEntry.name),
            strategyId: String(manifest.strategy?.id ?? strategyEntry.name),
            strategyName: summaries.get(strategyEntry.name)?.name ?? strategyEntry.name,
            strategyVersion: Number(manifest.strategy?.version ?? 0),
            status: manifest.status === 'complete' ? 'done' : String(manifest.status ?? 'planned'),
            createdAt: String(manifest.created_at ?? statSync(manifestPath).birthtime.toISOString()),
            updatedAt: String(manifest.updated_at ?? statSync(manifestPath).mtime.toISOString()),
            artifacts: {
              directory: outputDir,
              records: join(outputDir, artifacts.records ?? 'records.jsonl'),
              accepted: join(outputDir, artifacts.accepted ?? 'accepted.jsonl'),
              status: join(outputDir, artifacts.status ?? 'status.json'),
            },
            strategySnapshot: existsSync(snapshotPath) ? readJsonFile(snapshotPath) : undefined,
          };
        } catch { return null; }
      }))
    .filter(Boolean)
    .sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** Resolve terrain: an explicitly selected file takes priority; levelId is the legacy fallback. */
function resolveTerrainPath(levelId: string | undefined, levelsDir: string | undefined, terrainPath: string | undefined): string | null {
  if (terrainPath) {
    if (existsSync(terrainPath)) return terrainPath;
    throw new Error(`文件不存在: ${terrainPath}`);
  }
  if (levelId) {
    const dir = levelsDir || defaultLevelsDir;
    const p = join(dir, `${levelId}.json`);
    if (existsSync(p)) return p;
    throw new Error(`关卡 ${levelId} 不存在: ${p}`);
  }
  return null;
}

/** Persist a browser-selected terrain so all existing generation/analysis APIs can reuse it by path. */
function storeUploadedTerrain(fileName: string, terrainJson: string): string {
  if (!fileName.toLowerCase().endsWith('.json')) throw new Error('请选择 JSON 地形文件');
  const byteLength = Buffer.byteLength(terrainJson, 'utf-8');
  if (byteLength === 0) throw new Error('地形文件为空');
  if (byteLength > 20 * 1024 * 1024) throw new Error('地形文件不能超过 20 MB');

  mkdirSync(UPLOADED_TERRAINS_DIR, { recursive: true });
  const safeStem = basename(fileName).replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'terrain';
  const contentHash = createHash('sha256').update(terrainJson).digest('hex').slice(0, 16);
  const finalPath = join(UPLOADED_TERRAINS_DIR, `${safeStem}-${contentHash}.json`);
  if (existsSync(finalPath)) return finalPath;

  const tempPath = join(UPLOADED_TERRAINS_DIR, `.${safeStem}-${contentHash}-${randomUUID()}.tmp`);
  writeFileSync(tempPath, terrainJson, 'utf-8');
  try {
    const terrain = loadTerrainFromFile(tempPath);
    const tileCount = getAllTiles(terrain).length;
    if (!terrain.layers.length || !tileCount) throw new Error('文件中没有有效的地形层或牌数据');
    if (existsSync(finalPath)) unlinkSync(tempPath);
    else renameSync(tempPath, finalPath);
    if (terrain.levelHash) hashToPath.set(terrain.levelHash, finalPath);
    return finalPath;
  } catch (error) {
    try { unlinkSync(tempPath); } catch {}
    throw error;
  }
}

/** levelHash → 文件路径 的内存缓存（避免重复扫描） */
const hashToPath = new Map<string, string>();

/** 按 levelHash 在 levels 目录中查找匹配的地形文件。
 *  加载完整地形以获取计算后的 levelHash（兼容无 levelHash 字段的旧关卡文件）。 */
function findTerrainByLevelHash(levelHash: string, levelsDir?: string): string | null {
  if (!levelHash) return null;
  // 命中缓存
  const cached = hashToPath.get(levelHash);
  if (cached && existsSync(cached)) return cached;

  const directories = [...new Set([UPLOADED_TERRAINS_DIR, levelsDir || defaultLevelsDir])];
  for (const dir of directories) {
    if (!existsSync(dir)) continue;
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const p = join(dir, f);
        try {
          const terrain = loadTerrainFromFile(p);
          const h = terrain.levelHash;
          if (h) hashToPath.set(h, p);
          if (h === levelHash) {
            console.log(`[auto-resolve] ReplayCode levelHash=${levelHash} → ${basename(p)}`);
            return p;
          }
        } catch { /* 跳过损坏的 JSON */ }
      }
    } catch { /* 跳过不可读目录 */ }
  }
  return null;
}

/** List level IDs from a directory */
function listLevels(dir: string): Array<{ id: number; name: string; tiles: number }> {
  if (!existsSync(dir)) return [];
  const results: Array<{ id: number; name: string; tiles: number }> = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const id = parseInt(basename(f, '.json'), 10);
      if (isNaN(id)) continue;
      try {
        const raw = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
        let total = 0;
        if (raw.layers) for (const l of raw.layers) total += (l.tiles?.length || 0);
        results.push({ id, name: String(raw.levelResId || id), tiles: total });
      } catch { results.push({ id, name: String(id), tiles: 0 }); }
    }
  } catch { /* ignore */ }
  results.sort((a, b) => a.id - b.id);
  return results;
}

/** 从 ReplayCode + 关卡信息构建 OfflineGame 实例（玩家模拟类求解器共用）。 */
function buildGameFromReplay(
  replayCode: string,
  levelId?: string,
  levelsDir?: string,
  terrainPath?: string,
): { game: OfflineGame; totalTiles: number } {
  const replayData = decodeFromString(replayCode);
  if (!replayData) throw new Error('ReplayCode 解码失败');

  // 加载地形
  let path: string | null = null;
  if (replayData.levelHash !== 0n) {
    const hashStr = replayData.levelHash.toString(16).padStart(16, '0');
    path = findTerrainByLevelHash(hashStr, levelsDir || defaultLevelsDir);
  }
  if (!path && (terrainPath || levelId)) {
    path = resolveTerrainPath(levelId, levelsDir, terrainPath);
  }
  if (!path) throw new Error('无法解析地形（需要 levelId 或有效的 ReplayCode）');

  const terrain = loadTerrainFromFile(path);
  const allTiles = getAllTiles(terrain);
  const ordered = getCanonicalTileOrder(allTiles);

  // 构建 OfflineTile 列表
  const offlineTiles: OfflineTile[] = [];
  for (let i = 0; i < ordered.length && i < replayData.instanceArray.length; i++) {
    const tile = ordered[i];
    const b = replayData.instanceArray[i];
    const elemValue = (b & 0x3F) + 1;
    const ot = new OfflineTile({
      id: tile.id,
      layer: tile.layer,
      dependencies: tile.dependencies,
      isConst: tile.isConst,
      constElementValue: tile.constElementValue,
      posX: tile.posX,
      posY: tile.posY,
    }, elemValue);
    offlineTiles.push(ot);
  }

  return { game: new OfflineGame(offlineTiles), totalTiles: offlineTiles.length };
}

// ── Grade Config ──

/** 分档阈值配置的内存缓存，启动时加载。可通过 /api/grade/config-reload 热更新。 */
let gradeConfig: GradeConfig | null = null;
let gradeStrategy1Config: GradeStrategy1Config | null = null;
const gradeStrategy2Info = {
  name: '评估策略2',
  description: '基于 sim1/sim5/sim15 的 passrate 估计六档。',
  formula: 'clamp(0.30*sim1 + 0.10*sim5 + 0.60*sim15 + 0.08, 0, 1)',
  simRates: { ceiling: 0.01, baseline: 0.05, floor: 0.15 },
  defaultRuns: 100,
};

function loadGradeConfig(): GradeConfig {
  const configPath = join(__dirname, '..', 'config', 'grade-thresholds.json');
  if (!existsSync(configPath)) {
    throw new Error(`分档配置文件不存在: ${configPath}`);
  }
  const raw = readFileSync(configPath, 'utf-8');
  const cfg = JSON.parse(raw) as GradeConfig;
  if (!cfg.version || !cfg.standard || !cfg.refined || !cfg.simRates) {
    throw new Error('分档配置文件格式无效（缺少 version/standard/refined/simRates）');
  }
  gradeConfig = cfg;
  console.log(`[grade-config] 加载成功 (v${cfg.version}), ${cfg.standard.length} 个档位`);
  return cfg;
}

function getGradeConfig(): GradeConfig {
  return gradeConfig ?? loadGradeConfig();
}

function loadGradeStrategy1Config(): GradeStrategy1Config {
  const configPath = join(__dirname, '..', 'config', 'grade-strategy-1.json');
  if (!existsSync(configPath)) throw new Error(`分档策略1配置不存在: ${configPath}`);
  const cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as GradeStrategy1Config;
  if (!cfg.version || !cfg.name || !cfg.priority || !cfg.tiers || !cfg.simRates) {
    throw new Error('分档策略1配置格式无效');
  }
  gradeStrategy1Config = cfg;
  console.log(`[grade-config] 加载成功: ${cfg.name} (v${cfg.version}), ${cfg.tiers.length} 个档位`);
  return cfg;
}

function getGradeStrategy1Config(): GradeStrategy1Config {
  return gradeStrategy1Config ?? loadGradeStrategy1Config();
}

// ── Server ──
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  const originalPath = url.pathname;
  const baseWithoutTrailingSlash = appBasePath === '/' ? '/' : appBasePath.slice(0, -1);

  if (frameAncestors) res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (appBasePath !== '/' && originalPath === baseWithoutTrailingSlash) {
    res.writeHead(302, { Location: appBasePath });
    res.end();
    return;
  }

  if (originalPath === '/health') {
    url.pathname = '/health';
  } else if (appBasePath !== '/') {
    if (!originalPath.startsWith(appBasePath)) {
      json(res, { ok: false, error: 'Not found' }, 404);
      return;
    }
    url.pathname = `/${originalPath.slice(appBasePath.length)}`;
  }

  if (url.pathname === '/health' && req.method === 'GET') {
    json(res, {
      status: 'ok',
      app: APP_NAME,
      version: APP_VERSION,
      surface: appSurface,
      basePath: appBasePath,
      platformApiConfigured: Boolean(process.env.PLATFORM_API_URL),
    });
    return;
  }

  if (url.pathname === '/api/runtime-config' && req.method === 'GET') {
    json(res, {
      ok: true,
      surface: appSurface,
      basePath: appBasePath,
    });
    return;
  }

  // ── Stable external API: copied parameter string + level JSON → ReplayCode ──
  if (url.pathname === '/api/v1/generate-replay' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const {
        parameterString,
        terrain,
        terrainJson,
        bodyError,
      } = body as {
        parameterString?: string;
        terrain?: unknown;
        terrainJson?: string;
        bodyError?: string;
      };
      if (bodyError) throw new Error(bodyError);
      if (typeof parameterString !== 'string' || !parameterString.trim()) {
        throw new Error('parameterString 不能为空');
      }
      const result = generateReplayFromExternalInput({
        parameterString,
        terrain: terrain ?? terrainJson,
      });
      json(res, { ok: true, ...result });
    } catch (error) {
      json(res, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }, 400);
    }
    return;
  }

  // ── API: generation strategy metadata ──
  if (url.pathname === '/api/generation-strategies/meta' && req.method === 'GET') {
    try {
      const catalog = readGenerationCatalog();
      const layerClosure = catalog.generators?.['layer-closure'] || {};
      json(res, {
        ok: true,
        schema: readJsonFile(GENERATION_SCHEMA_PATH),
        catalog,
        options: {
          executors: Object.entries(catalog.workflows || {}).map(([value, item]: [string, any]) => [value, item.label]),
          closureModes: layerClosure.policyModes?.closure || [],
          colorModes: layerClosure.policyModes?.color || [],
          colorAllocationModes: layerClosure.policyModes?.color_allocation || [],
          scalarModes: layerClosure.policyModes?.spread || [],
          statuses: ['draft', 'active', 'deprecated', 'archived'],
          fillPolicies: ['all'],
          fallbackPolicies: ['none'],
        },
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 500); }
    return;
  }

  // ── API: list/create/validate generation strategies ──
  if (url.pathname === '/api/generation-strategies' && req.method === 'GET') {
    try { json(res, { ok: true, strategies: listGenerationStrategies() }); }
    catch (err) { json(res, { ok: false, error: String(err) }, 500); }
    return;
  }
  if (url.pathname === '/api/generation-strategies/validate' && req.method === 'POST') {
    const body = await parseBody(req);
    const strategy = body.strategy as GenerationStrategy;
    if (!strategy || typeof strategy !== 'object') { json(res, { ok: false, errors: ['缺少 strategy 对象'], warnings: [] }, 400); return; }
    json(res, await validateGenerationStrategy(strategy));
    return;
  }
  if (url.pathname === '/api/generation-strategies' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const editor = JSON.parse(JSON.stringify(body.strategy || {})) as GenerationStrategy;
      const strategyId = String(editor.meta?.strategy_id || '');
      const path = generationStrategyPath(strategyId);
      if (existsSync(path)) { json(res, { ok: false, error: `策略 ${strategyId} 已存在，请使用复制后的新 ID` }, 409); return; }
      editor.meta.version = 1;
      const validation = await validateGenerationStrategy(editor);
      if (!validation.ok) { json(res, validation, 422); return; }
      const strategy = compileEditorStrategyV2(editor);
      const ui = editorMeta(editor);
      writeJsonAtomic(path, strategy);
      writeJsonAtomic(generationStrategyUiPath(strategyId), ui);
      writeGenerationStrategySnapshot(strategy, ui, 'created');
      const plan = await planGenerationStrategy(path, strategyId);
      refreshGenerationStrategyIndex();
      const response = strategyV2ToEditor(strategy, ui);
      json(res, { ok: true, strategy: response, validation, plan, summary: strategySummary(strategy, path, ui) }, 201);
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return;
  }

  if (url.pathname === '/api/generation-runs' && req.method === 'GET') {
    try { json(res, { ok: true, runs: listGenerationRuns() }); }
    catch (err) { json(res, { ok: false, error: String(err) }, 500); }
    return;
  }

  const strategyHistoryMatch = url.pathname.match(/^\/api\/generation-strategies\/([^/]+)\/history$/);
  if (strategyHistoryMatch && req.method === 'GET') {
    try {
      const strategyId = decodeURIComponent(strategyHistoryMatch[1]);
      json(res, { ok: true, history: listGenerationStrategyHistory(strategyId) });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return;
  }

  const strategyItemMatch = url.pathname.match(/^\/api\/generation-strategies\/([^/]+)$/);
  if (strategyItemMatch && req.method === 'GET') {
    try {
      const strategyId = decodeURIComponent(strategyItemMatch[1]);
      const path = generationStrategyPath(strategyId);
      if (!existsSync(path)) { json(res, { ok: false, error: '策略不存在' }, 404); return; }
      const strategy = validateStrategyDefinition(readJsonFile(path));
      const ui = readStrategyUiMeta(strategyId);
      json(res, { ok: true, strategy: strategyV2ToEditor(strategy, ui), summary: strategySummary(strategy, path, ui) });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return;
  }
  if (strategyItemMatch && req.method === 'PUT') {
    const body = await parseBody(req);
    try {
      const strategyId = decodeURIComponent(strategyItemMatch[1]);
      const path = generationStrategyPath(strategyId);
      if (!existsSync(path)) { json(res, { ok: false, error: '策略不存在' }, 404); return; }
      const previous = validateStrategyDefinition(readJsonFile(path));
      const previousUi = readStrategyUiMeta(strategyId);
      const editor = JSON.parse(JSON.stringify(body.strategy || {})) as GenerationStrategy;
      if (String(editor.meta?.strategy_id || '') !== strategyId) throw new Error('更新时不能修改策略 ID，请使用复制策略');
      writeGenerationStrategySnapshot(previous, previousUi, 'baseline before first visual edit', true);
      editor.meta.version = previous.version + 1;
      const validation = await validateGenerationStrategy(editor);
      if (!validation.ok) { json(res, validation, 422); return; }
      const strategy = compileEditorStrategyV2(editor);
      const ui = editorMeta(editor);
      writeJsonAtomic(path, strategy);
      writeJsonAtomic(generationStrategyUiPath(strategyId), ui);
      writeGenerationStrategySnapshot(strategy, ui, 'updated');
      const plan = await planGenerationStrategy(path, strategyId);
      refreshGenerationStrategyIndex();
      const response = strategyV2ToEditor(strategy, ui);
      json(res, { ok: true, strategy: response, validation, plan, summary: strategySummary(strategy, path, ui) });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return;
  }

  // ── API: list levels ──
  if (url.pathname === '/api/levels' && req.method === 'GET') {
    const dir = url.searchParams.get('dir') || defaultLevelsDir;
    json(res, { ok: true, dir, levels: listLevels(dir) });
    return;
  }

  // ── API: browser-selected terrain upload ──
  if (url.pathname === '/api/terrain-upload' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const { fileName, terrainJson, bodyError } = body as { fileName?: string; terrainJson?: string; bodyError?: string };
      if (bodyError) throw new Error(bodyError);
      if (!fileName || typeof terrainJson !== 'string') throw new Error('缺少地形文件名或内容');
      const resolvedPath = storeUploadedTerrain(fileName, terrainJson);
      json(res, { ok: true, fileName: basename(fileName), resolvedPath });
    } catch (err) { json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 400); }
    return;
  }

  // ── API: terrain info (by levelId or terrainPath) ──
  if (url.pathname === '/api/terrain-info' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const { levelId, levelsDir, terrainPath, replayCode } = body as {
        levelId?: string; levelsDir?: string; terrainPath?: string; replayCode?: string;
      };
      // replayCode 决定地形，否则用 levelId/terrainPath
      let path: string | null = null;
      if (replayCode) {
        const replayData = decodeFromString(replayCode);
        if (replayData && replayData.levelHash !== 0n) {
          const hashStr = replayData.levelHash.toString(16).padStart(16, '0');
          path = findTerrainByLevelHash(hashStr, levelsDir);
        }
      }
      if (!path) path = resolveTerrainPath(levelId, levelsDir, terrainPath);
      if (!path) throw new Error('请提供关卡ID、文件路径或有效的 ReplayCode');

      const terrain = loadTerrainFromFile(path);
      const allTiles = getAllTiles(terrain);
      const freeTiles = allTiles.filter(t => !t.isConst);
      const constTiles = allTiles.filter(t => t.isConst);

      // 如果提供了 ReplayCode，解码返回花色分布
      let suitPreview: { suitCount: number; tilesPerSuit: { suit: number; count: number }[] } | undefined;
      if (replayCode) {
        const replayData = decodeFromString(replayCode);
        if (replayData) {
          const ordered = getCanonicalTileOrder(allTiles);
          const sc = new Map<number, number>();
          for (let i = 0; i < ordered.length && i < replayData.instanceArray.length; i++) {
            const tile = ordered[i];
            if (!tile.isConst) {
              const s = replayData.instanceArray[i] & 0x3F;
              sc.set(s, (sc.get(s) ?? 0) + 1);
            }
          }
          suitPreview = {
            suitCount: sc.size,
            tilesPerSuit: [...sc.entries()].sort((a, b) => a[0] - b[0]).map(([suit, count]) => ({ suit, count })),
          };
        }
      }

      // 计算依赖深度（供 LayerClosure 算法预填闭合率）
      const freeOnly = allTiles.filter(t => !t.isConst);
      const tileMap = new Map(freeOnly.map(t => [t.id, t]));
      const depthMap = computeDependencyDepth(freeOnly, tileMap);
      const maxDepth = freeOnly.length > 0 ? Math.max(...depthMap.values()) : 0;
      const tilesPerDepth: number[] = [];
      for (let d = 1; d <= maxDepth; d++) {
        tilesPerDepth.push(freeOnly.filter(t => depthMap.get(t.id) === d).length);
      }

      json(res, {
        ok: true,
        levelResId: terrain.levelResId,
        levelHash: terrain.levelHash || '',
        layers: terrain.layers.length,
        totalTiles: allTiles.length,
        freeTiles: freeTiles.length,
        steps: Math.floor(freeTiles.length / 3),
        constTiles: constTiles.length,
        width: terrain.LevelWidth,
        height: terrain.LevelHeight,
        resolvedPath: path,
        suitPreview: suitPreview ?? null,
        // LayerClosure 深度信息
        depthCount: maxDepth,
        tilesPerDepth,
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return;
  }

  // ── API: generate board ──
  if (url.pathname === '/api/generate' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const {
        algorithm,
        costArray, colorCount, // CostLadder params
        closeRates, dock, spreadParam, debtPersistenceWeight, // LayerClosure params
        colorAllocationMode, colorAllocationMaxRatio,        // LayerClosure
        teStrategy, difficulty, sequenceSeed, placementSeed, placementRandomState, typeCycle, typeWeights,
        easyLayerCount, hardTag, limitFullFirst, lowerCoefficient, topCoefficient,
        fallbackExtraLayers, solvabilityRandomMode, colorGradientTypeGroups,
        levelId, levelsDir, terrainPath, levelHash,
      } = body as {
        algorithm?: string;
        costArray?: string; colorCount?: string;           // CostLadder
        closeRates?: string; dock?: string; spreadParam?: string; // LayerClosure
        debtPersistenceWeight?: string;                    // LayerClosure
        colorAllocationMode?: string;                      // LayerClosure
        colorAllocationMaxRatio?: string;                  // LayerClosure
        teStrategy?: string; difficulty?: string; sequenceSeed?: string; placementSeed?: string;
        placementRandomState?: string | import('../src/index.js').DotNetRandomState;
        typeCycle?: string; typeWeights?: string; easyLayerCount?: string; hardTag?: string;
        limitFullFirst?: string | boolean; lowerCoefficient?: string; topCoefficient?: string;
        fallbackExtraLayers?: string; solvabilityRandomMode?: string | boolean; colorGradientTypeGroups?: string;
        levelId?: string; levelsDir?: string; terrainPath?: string; levelHash?: string;
      };

      const path = resolveTerrainPath(levelId, levelsDir, terrainPath);
      if (!path) {
        json(res, { ok: false, error: '请提供关卡ID或文件路径' }, 400);
        return;
      }
      const terrain = loadTerrainFromFile(path);
      const allTiles = getAllTiles(terrain);

      if (algorithm === 'tile-explorer') {
        const k = parseInt(colorCount || '5', 10);
        const parseIntegerList = (raw: string | undefined, name: string): number[] | undefined => {
          if (!raw?.trim()) return undefined;
          const values = raw.split(',').map(value => Number(value.trim()));
          if (values.some(value => !Number.isInteger(value))) throw new Error(`${name} 必须是整数 CSV`);
          return values;
        };
        const numeric = (raw: string | undefined): number | undefined => {
          if (raw == null || raw.trim() === '') return undefined;
          const value = Number(raw);
          if (!Number.isFinite(value)) throw new Error(`无效数字: ${raw}`);
          return value;
        };
        const optionalBoolean = (raw: string | boolean | undefined): boolean | undefined => {
          if (raw === '' || raw == null) return undefined;
          if (raw === true || raw === 'true') return true;
          if (raw === false || raw === 'false') return false;
          throw new Error(`无效布尔值: ${String(raw)}`);
        };
        const gradientGroups = colorGradientTypeGroups?.trim()
          ? JSON.parse(colorGradientTypeGroups) as number[][]
          : undefined;
        const strategy = (teStrategy || 'default') as import('../src/index.js').TileExplorerStrategy;
        const isSolvability = strategy.startsWith('solvability_coefficient');
        const isLimit = strategy === 'limit_layer_random';
        const isGradient = strategy === 'color_gradient';
        const randomState = typeof placementRandomState === 'string'
          ? (placementRandomState.trim()
              ? JSON.parse(placementRandomState) as import('../src/index.js').DotNetRandomState
              : undefined)
          : placementRandomState;
        const result = generateBoardTileExplorer({
          terrain,
          strategy,
          difficulty: parseInt(difficulty || '1', 10),
          colorCount: k,
          tileTypesCanUse: k,
          sequenceSeed: parseInt(sequenceSeed || '0', 10),
          placementSeed: parseInt(placementSeed || '0', 10),
          placementRandomState: randomState,
          typeCycle: isGradient ? undefined : parseIntegerList(typeCycle, 'typeCycle'),
          tileTypeWeights: isGradient || typeCycle?.trim() ? undefined : parseIntegerList(typeWeights, 'typeWeights'),
          easyLayerCount: strategy === 'default' ? parseInt(easyLayerCount || '0', 10) : undefined,
          levelHardTag: isLimit || isSolvability ? parseInt(hardTag || '1', 10) : undefined,
          limitFullFirst: isLimit ? optionalBoolean(limitFullFirst) : undefined,
          solvabilityLowerCoefficient: isSolvability ? numeric(lowerCoefficient) : undefined,
          solvabilityTopCoefficient: isSolvability ? numeric(topCoefficient) : undefined,
          fallbackExtraLayers: isSolvability ? numeric(fallbackExtraLayers) : undefined,
          solvabilityRandomMode: isSolvability ? optionalBoolean(solvabilityRandomMode) : undefined,
          colorGradientTypeGroups: isGradient ? gradientGroups : undefined,
          levelHash,
        });
        const ordered = getCanonicalTileOrder(allTiles);
        const tileSummary = ordered.map((tile, index) => ({
          index, id: tile.id, layer: tile.layer, isConst: tile.isConst,
          element: result.assignments.get(tile.id) ?? tile.constElementValue ?? 0,
        }));
        json(res, {
          ok: true,
          algorithm: 'tile-explorer',
          levelResId: terrain.levelResId,
          replayCode: result.replayCode,
          elementCount: decodeFromString(result.replayCode)?.elementCount ?? k,
          levelHash: result.levelHash,
          assignments: Object.fromEntries(result.assignments),
          groups: Object.fromEntries(result.groups),
          strategy: result.strategy,
          viewLayers: result.viewLayers,
          typeCycle: result.typeCycle,
          generatedGroupCount: result.generatedGroupCount,
          sequenceSeed: result.sequenceSeed,
          placementSeed: result.placementSeed,
          placementRandomStateAfter: result.placementRandomStateAfter,
          metrics: {
            depthCount: result.viewLayers.length,
            colorCount: new Set(result.assignments.values()).size,
            generatedGroupCount: result.generatedGroupCount,
          },
          colorCount: k,
          terrainSummary: {
            layers: terrain.layers.length,
            totalTiles: allTiles.length,
            freeTiles: allTiles.filter(tile => !tile.isConst).length,
            constTiles: allTiles.filter(tile => tile.isConst).length,
            source: basename(path),
          },
          tiles: tileSummary,
        });
      } else if (algorithm === 'closure') {
        // ═══ LayerClosure 算法 ═══
        const k = parseInt(colorCount || '8', 10);

        if (!closeRates || !closeRates.trim()) {
          json(res, { ok: false, error: '请提供闭合率数组 (closeRates)' }, 400);
          return;
        }
        const rates = closeRates.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
        if (rates.length === 0 || rates.some(r => r < 0 || r > 1)) {
          json(res, { ok: false, error: '闭合率格式无效，需为 0-1 之间的数字' }, 400);
          return;
        }

                const dk = parseInt(dock || '7', 10) || 7;
        const sp = parseFloat(spreadParam || '0.5');
        const spread = isNaN(sp) ? 0.5 : Math.max(0, Math.min(1, sp));
        const dpRaw = parseFloat(debtPersistenceWeight || '0');
        const dp = isNaN(dpRaw) ? 0 : Math.max(0, Math.min(1, dpRaw));

        const allocMode = (colorAllocationMode === 'single-heavy' ? 'single-heavy' : 'balanced') as import('../src/types.js').ColorAllocationMode;
        const allocRatioRaw = parseFloat(colorAllocationMaxRatio || '1');
        const allocRatio = isNaN(allocRatioRaw) ? 1 : Math.max(0.01, Math.min(1, allocRatioRaw));
        const result = generateBoardLayerClosure({
          terrain, closeRates: rates, colorCount: k,
          dock: dk, levelHash, spreadParam: spread,
          debtPersistenceWeight: dp,
          colorAllocationMode: allocMode,
          colorAllocationMaxRatio: allocRatio,
        });

        const ordered = getCanonicalTileOrder(allTiles);
        const tileSummary = ordered.map((t, i) => ({
          index: i, id: t.id, layer: t.layer, isConst: t.isConst,
          element: result.assignments.get(t.id) ?? t.constElementValue ?? 0,
        }));

        const assignmentsObj: Record<string, number> = {};
        for (const [k, v] of result.assignments) assignmentsObj[String(k)] = v;

        json(res, {
          ok: true,
          algorithm: 'closure',
          levelResId: terrain.levelResId,
          replayCode: result.replayCode,
          elementCount: decodeFromString(result.replayCode)?.elementCount ?? k,
          levelHash: result.levelHash,
          assignments: assignmentsObj,
          tripletCount: result.triplets.length,
          metrics: result.metrics,
          colorCount: k,
          terrainSummary: {
            layers: terrain.layers.length,
            totalTiles: allTiles.length,
            freeTiles: allTiles.filter(t => !t.isConst).length,
            constTiles: allTiles.filter(t => t.isConst).length,
            source: basename(path),
          },
          tiles: tileSummary,
        });
      } else {
        // ═══ CostLadder 算法 (默认) ═══
        const k = parseInt(colorCount || '99', 10);

        if (!costArray || !costArray.trim()) {
          json(res, { ok: false, error: '请提供 Cost 数组' }, 400);
          return;
        }

        const costs = costArray.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
        if (costs.length === 0 || costs.some(c => c < 1)) {
          json(res, { ok: false, error: 'Cost 数组格式无效' }, 400);
          return;
        }

        const result = generateBoard({ terrain, costArray: costs, colorCount: k, levelHash });

        const ordered = getCanonicalTileOrder(allTiles);
        const tileSummary = ordered.map((t, i) => ({
          index: i, id: t.id, layer: t.layer, isConst: t.isConst,
          element: result.assignments.get(t.id) ?? t.constElementValue ?? 0,
        }));

        const assignmentsObj: Record<string, number> = {};
        for (const [k, v] of result.assignments) assignmentsObj[String(k)] = v;

        json(res, {
          ok: true,
          algorithm: 'cost-ladder',
          levelResId: terrain.levelResId,
          replayCode: result.replayCode,
          elementCount: decodeFromString(result.replayCode)?.elementCount ?? k,
          levelHash: result.levelHash,
          completed: result.completed,
          totalSteps: result.totalSteps,
          costLog: result.costLog,
          branchLog: result.branchLog,
          stepLog: result.stepLog,
          assignments: assignmentsObj,
          stats: result.stats,
          banSetSize: result.banSetSize,
          deviationCount: result.deviationCount,
          matchRate: result.matchRate,
          costTargets: costs,
          colorCount: k,
          terrainSummary: {
            layers: terrain.layers.length,
            totalTiles: allTiles.length,
            freeTiles: allTiles.filter(t => !t.isConst).length,
            constTiles: allTiles.filter(t => t.isConst).length,
            source: basename(path),
          },
          tiles: tileSummary,
        });
      }
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return;
  }

  // ── API: decode ──
  if (url.pathname === '/api/decode' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const { replayCode } = body as { replayCode?: string };
      if (!replayCode) throw new Error('Missing replayCode');
      const data = decodeFromString(replayCode);
      if (!data) throw new Error('Failed to decode');

      const tiles = Array.from(data.instanceArray, (b, i) => ({
        index: i, state: (b >> 6) & 0x3, elemIdx: b & 0x3F, elemValue: (b & 0x3F) + 1,
      }));

      json(res, {
        ok: true, version: data.version, tileCount: data.instanceArray.length,
        elementCount: data.elementCount, levelHash: formatHash(data.levelHash),
        dockEntries: data.dockEntries.map(e => ({ tileId: e.tileId, element: e.element })),
        tiles,
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return;
  }

  // ── API: replay closure rates ──
  if (url.pathname === '/api/replay-closure' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const { replayCode, levelsDir, terrainPath } = body as {
        replayCode?: string; levelsDir?: string; terrainPath?: string;
      };
      if (!replayCode) throw new Error('Missing replayCode');

      // 解析 ReplayCode
      const replayData = decodeFromString(replayCode);
      if (!replayData) throw new Error('ReplayCode 解码失败');

      // 解析地形
      let path: string | null = null;
      if (replayData.levelHash !== 0n) {
        const hashStr = replayData.levelHash.toString(16).padStart(16, '0');
        path = findTerrainByLevelHash(hashStr, levelsDir || defaultLevelsDir);
      }
      if (!path && terrainPath) path = resolveTerrainPath(undefined, undefined, terrainPath);
      if (!path) throw new Error('无法解析地形（ReplayCode 中无 levelHash 或无匹配关卡文件）');

      const terrain = loadTerrainFromFile(path);
      const allTiles = getAllTiles(terrain);
      const freeTiles = allTiles.filter(t => !t.isConst);
      const ordered = getCanonicalTileOrder(allTiles);

      // 构建 tileId → element 映射（仅自由牌，与生成路径的 assignments 一致）
      const elemMap = new Map<number, number>();
      for (let i = 0; i < ordered.length && i < replayData.instanceArray.length; i++) {
        const tile = ordered[i];
        if (!tile.isConst) {
          elemMap.set(tile.id, (replayData.instanceArray[i] & 0x3F) + 1);
        }
      }

      // 计算依赖深度 — tileMap 必须包含全部牌（含固定牌），否则依赖链被截断
      const freeOnly = freeTiles;
      const allTileMap = new Map(allTiles.map(t => [t.id, t]));
      const depthMap = computeDependencyDepth(freeOnly, allTileMap);
      const maxDepth = freeOnly.length > 0 ? Math.max(...depthMap.values()) : 0;

      // 按深度分层
      const depthLayers: TerrainTile[][] = [];
      for (let d = 1; d <= maxDepth; d++) {
        depthLayers.push(freeOnly.filter(t => depthMap.get(t.id) === d));
      }

      // 收集花色数
      const allColors = new Set<number>();
      for (const [, color] of elemMap) { if (color > 0) allColors.add(color); }
      const colorCount = allColors.size;

      // 闭合率：与生成路径共用 computeCloseRatesFromAssignments，基于真实落色结果
      const layerClosureRates = computeCloseRatesFromAssignments(elemMap, depthLayers);

      // 组装 computeMetrics 所需参数（复用上面的 allTileMap）
      const tileDepSets = computeTileDepSets(freeOnly, allTileMap);
      const dock = 7; // 默认 dock 容量

      const metrics = computeMetrics(
        elemMap,
        freeOnly,        // 与生成路径一致：传自由牌，不含固定牌
        depthLayers,
        depthMap,
        allTileMap,
        tileDepSets,
        dock,
        colorCount,
        layerClosureRates,
        0,   // debtPersistenceWeight: 导入路径无配置，回显 0
        [],  // retainedOldDebtTilesByLayer: 由 computeLayerProgressMetrics 事后统计
      );

      json(res, {
        ok: true,
        levelHash: terrain.levelHash || '',
        metrics,
        totalFreeTiles: freeOnly.length,
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return;
  }

  // ── API: 从 ReplayCode 提取参数（用于导入到生成输入区）──
  if (url.pathname === '/api/replay-params' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const { replayCode, levelsDir, terrainPath } = body as {
        replayCode?: string; levelsDir?: string; terrainPath?: string;
      };
      if (!replayCode) throw new Error('Missing replayCode');

      const replayData = decodeFromString(replayCode);
      if (!replayData) throw new Error('ReplayCode 解码失败');

      // 解析地形
      let path: string | null = null;
      let levelId: string | null = null;
      if (replayData.levelHash !== 0n) {
        const hashStr = replayData.levelHash.toString(16).padStart(16, '0');
        path = findTerrainByLevelHash(hashStr, levelsDir || defaultLevelsDir);
      }
      if (!path && terrainPath) path = resolveTerrainPath(undefined, undefined, terrainPath);
      if (path) {
        // 从文件路径提取 levelId（文件名不含扩展名）
        levelId = basename(path, '.json');
      }

      // 加载地形以获取深度分层
      if (!path) throw new Error('无法解析地形（ReplayCode 中无 levelHash 或无匹配关卡文件）');
      const terrain = loadTerrainFromFile(path);
      const allTiles = getAllTiles(terrain);
      const freeTiles = allTiles.filter(t => !t.isConst);
      const ordered = getCanonicalTileOrder(allTiles);

      // 构建 tileId → element 映射
      const elemMap = new Map<number, number>();
      for (let i = 0; i < ordered.length && i < replayData.instanceArray.length; i++) {
        const tile = ordered[i];
        if (!tile.isConst) {
          elemMap.set(tile.id, (replayData.instanceArray[i] & 0x3F) + 1);
        }
      }

      // 依赖深度分层
      const allTileMap = new Map(allTiles.map(t => [t.id, t]));
      const depthMap = computeDependencyDepth(freeTiles, allTileMap);
      const maxDepth = freeTiles.length > 0 ? Math.max(...depthMap.values()) : 0;
      const depthLayers: TerrainTile[][] = [];
      for (let d = 1; d <= maxDepth; d++) {
        depthLayers.push(freeTiles.filter(t => depthMap.get(t.id) === d));
      }

      // 花色数
      const allColors = new Set<number>();
      for (const [, color] of elemMap) { if (color > 0) allColors.add(color); }
      const colorCount = allColors.size;

      // 逐层闭合率（triplet 口径）
      const closeRates = computeCloseRatesFromAssignments(elemMap, depthLayers);

      // Dock 容量：取 dockEntries 数量（至少为常见默认值 7）
      const dockFromReplay = replayData.dockEntries.length;
      const dock = Math.max(dockFromReplay, 7);

      const tilesPerDepth = depthLayers.map(l => l.length);

      json(res, {
        ok: true,
        levelId,
        levelResId: terrain.levelResId,
        levelHash: terrain.levelHash || '',
        colorCount,
        dock,
        closeRates,
        depthCount: maxDepth,
        tilesPerDepth,
        totalFreeTiles: freeTiles.length,
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return;
  }

  // ── API: replay cost log ──
  if (url.pathname === '/api/replay-costlog' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const { replayCode, levelId, levelsDir, terrainPath } = body as {
        replayCode?: string; levelId?: string; levelsDir?: string; terrainPath?: string;
      };
      if (!replayCode) throw new Error('缺少 replayCode');

      const replayData = decodeFromString(replayCode);
      if (!replayData) throw new Error('ReplayCode 解码失败');

      // 解析地形
      let path: string | null = null;
      if (replayData.levelHash !== 0n) {
        const hashStr = replayData.levelHash.toString(16).padStart(16, '0');
        path = findTerrainByLevelHash(hashStr, levelsDir || defaultLevelsDir);
      }
      if (!path && (terrainPath || levelId)) {
        path = resolveTerrainPath(levelId, levelsDir, terrainPath);
      }
      if (!path) throw new Error('无法解析地形');

      const terrain = loadTerrainFromFile(path);
      const allTiles = getAllTiles(terrain);
      const freeTiles = allTiles.filter(t => !t.isConst);
      const ordered = getCanonicalTileOrder(allTiles);
      const steps = Math.floor(freeTiles.length / 3);

      // 构建 tileId → color 映射
      const assignments = new Map<number, number>();
      for (let i = 0; i < ordered.length && i < replayData.instanceArray.length; i++) {
        const tile = ordered[i];
        const elemValue = (replayData.instanceArray[i] & 0x3F) + 1;
        assignments.set(tile.id, elemValue);
      }

      // 计算依赖闭包 + 运行贪心模拟
      const allDeps = computeAllDependencies(allTiles);
      const { costLog, branchLog } = runPureGreedySimulation(freeTiles, assignments, allDeps, steps);

      const stats = costLog.length > 0 ? {
        min: Math.min(...costLog),
        max: Math.max(...costLog),
        avg: costLog.reduce((a, b) => a + b, 0) / costLog.length,
      } : { min: 0, max: 0, avg: 0 };

      json(res, {
        ok: true,
        costLog,
        branchLog,
        stats,
        totalSteps: steps,
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return;
  }

  // ── API: analyze triples ──
  if (url.pathname === '/api/analyze-triples' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const { levelId, levelsDir, terrainPath, terrainJson, forceRefresh, replayCode } = body as {
        levelId?: string; levelsDir?: string; terrainPath?: string;
        terrainJson?: string; forceRefresh?: boolean; replayCode?: string;
      };
      const { topN, minSuccessors, maxEdgesPerNode, layerMin, layerMax, stratify, perLayer, layerMode, edgeMode, partialThreshold } = body as {
        topN?: number; minSuccessors?: number; maxEdgesPerNode?: number;
        layerMin?: number; layerMax?: number; stratify?: boolean; perLayer?: number;
        layerMode?: string; edgeMode?: string; partialThreshold?: number;
      };

      let terrain;
      if (terrainJson && typeof terrainJson === 'string') {
        // 写入临时文件再加载 (利用 terrain-loader 的 normalize 逻辑)
        const tmpDir = join(GUI_DIR, '..', '.reversegen-cache');
        const tmpPath = join(tmpDir, '_tmp_terrain.json');
        if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
        writeFileSync(tmpPath, terrainJson, 'utf-8');
        try {
          terrain = loadTerrainFromFile(tmpPath);
        } finally {
          try { unlinkSync(tmpPath); } catch {}
        }
      } else {
        // replayCode 决定地形，否则用 levelId/terrainPath
        let path: string | null = null;
        if (replayCode) {
          const replayData = decodeFromString(replayCode);
          if (replayData && replayData.levelHash !== 0n) {
            const hashStr = replayData.levelHash.toString(16).padStart(16, '0');
            path = findTerrainByLevelHash(hashStr, levelsDir);
          }
        }
        if (!path) path = resolveTerrainPath(levelId, levelsDir, terrainPath);
        if (!path) throw new Error('请提供关卡ID、文件路径、地形JSON或有效的 ReplayCode');
        terrain = loadTerrainFromFile(path);
      }

      // ── 解码 ReplayCode，构建 suitMap ──
      let suitMap: Map<number, number> | undefined;
      if (replayCode) {
        const replayData = decodeFromString(replayCode);
        if (!replayData) throw new Error('ReplayCode 解码失败');
        const ordered = getCanonicalTileOrder(getAllTiles(terrain));
        suitMap = new Map<number, number>();
        for (let i = 0; i < ordered.length && i < replayData.instanceArray.length; i++) {
          suitMap.set(ordered[i].id, (replayData.instanceArray[i] & 0x3F) + 1);
        }
      }

      // 计算或从缓存获取分析结果
      const freeCount = getAllTiles(terrain).filter(t => !t.isConst).length;
      let mcKey = `${terrain.levelHash || 'no-hash'}-${freeCount}`;
      if (suitMap) {
        const suitHash = createHash('md5')
          .update([...suitMap.entries()].sort((a, b) => a[0] - b[0]).map(([id, s]) => `${id}:${s}`).join(','))
          .digest('hex').substring(0, 8);
        mcKey += `-replay-${suitHash}`;
      }
      let analysisResult = cacheGet(mcKey);
      if (!analysisResult || forceRefresh) {
        analysisResult = analyzeTriples(terrain, {
          force: !!forceRefresh,
          edgeTopN: 6000,
          maxEdgesPerNode: 20,
          suitMap,
        });
        cacheSet(mcKey, analysisResult);
      }

      // 过滤图数据
      const graphData = filterGraphData(analysisResult, {
        stratify: stratify ?? true,
        perLayer: perLayer ?? 80,
        topN: topN ?? 1000,
        minSuccessors: minSuccessors ?? 0,
        maxEdgesPerNode: maxEdgesPerNode ?? 15,
        layerMin,
        layerMax,
        layerMode: layerMode ?? 'depSetQuantile',
        edgeMode: (edgeMode === 'partial' ? 'partial' : 'full') as 'full' | 'partial',
        partialThreshold,
      });

      // 构建响应: 用 triple key 标识边（filterGraphData 已返回完整边集，直接转换索引→key）
      const allTriples = analysisResult.triples;
      const graphTriples = graphData.nodeIndices.map(i => allTriples[i]);

      const allEdges: { from: string; to: string; overlap: number }[] =
        graphData.prerequisiteEdges.map(e => ({
          from: allTriples[e.from].key,
          to: allTriples[e.to].key,
          overlap: e.overlap,
        }));

      json(res, {
        ok: true,
        cacheKey: mcKey,
        mode: analysisResult.mode ?? 'terrain',
        terrainInfo: analysisResult.terrainInfo,
        suitStats: analysisResult.suitStats ?? null,
        statistics: analysisResult.statistics,
        bottleneckTiles: analysisResult.bottleneckTiles,
        graph: {
          triples: graphTriples,
          prerequisiteEdges: allEdges,
        },
        // 全部 triple 元数据 (紧凑格式，供前端过滤器和检查器使用)
        allTriples: allTriples.map(t => ({
          k: t.key,
          t: t.tileIds,
          d: t.depSetSize,
          l: t.topologicalLayer,
          dp: t.dependencyDepth,
          s: t.successorCount,
          p: t.predecessorCount,
          poS: t.partialOrderSuccessorCount,
          poP: t.partialOrderPredecessorCount,
          b: t.bottleneckScore,
          ly: [t.layerMin, t.layerMax],
        })),
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return;
  }

  // ── API: triple detail ──
  if (url.pathname === '/api/triple-detail' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const { tripleKey: tk, cacheKey } = body as {
        tripleKey?: string; cacheKey?: string;
      };
      if (!tk) throw new Error('Missing tripleKey');

      // 用分析时返回的精确 cacheKey 查找（确保不同花色分布的缓存不串）
      const mcKey = cacheKey || '';
      const analysisResult = cacheGet(mcKey);
      if (!analysisResult) throw new Error('请先运行分析 (/api/analyze-triples)');

      const detail = getTripleDetail(analysisResult, tk);
      if (!detail) throw new Error(`Triple ${tk} 不存在`);

      json(res, {
        ok: true,
        detail: {
          node: detail.node,
          predecessors: detail.predecessors,
          successors: detail.successors,
          topOverlaps: detail.topOverlaps,
        },
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return;
  }
  // ── API: tile DAG (地形版: 无 replayCode 显示灰色, 牌局版: 有 replayCode 显示花色) ──
  if (url.pathname === '/api/tile-dag' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const { levelId, levelsDir, terrainPath, replayCode } = body as {
        levelId?: string; levelsDir?: string; terrainPath?: string; replayCode?: string;
      };
      // replayCode 决定地形
      let path: string | null = null;
      if (replayCode) {
        const rd = decodeFromString(replayCode);
        if (rd && rd.levelHash !== 0n) {
          path = findTerrainByLevelHash(rd.levelHash.toString(16).padStart(16, '0'), levelsDir || defaultLevelsDir);
        }
      }
      if (!path) path = resolveTerrainPath(levelId, levelsDir, terrainPath);
      if (!path) throw new Error('请提供关卡ID、文件路径或有效的 ReplayCode');
      const terrain = loadTerrainFromFile(path);
      const allTiles = getAllTiles(terrain);
      const freeTiles = allTiles.filter(t => !t.isConst);

      // 构建花色映射（如果有 replayCode）
      const colorMap: Record<number, number> = {};
      if (replayCode) {
        const rd = decodeFromString(replayCode);
        if (rd) {
          const ordered = getCanonicalTileOrder(allTiles);
          for (let i = 0; i < ordered.length && i < rd.instanceArray.length; i++) {
            colorMap[ordered[i].id] = (rd.instanceArray[i] & 0x3F) + 1;
          }
        }
      }
      const hasColors = Object.keys(colorMap).length > 0;

      // 构建传递依赖
      const allDeps = new Map<number, number[]>();
      for (const t of freeTiles) {
        const deps = new Set<number>();
        const q = [...t.dependencies];
        for (let h = 0; h < q.length; h++) {
          const depId = q[h];
          if (!deps.has(depId)) {
            deps.add(depId);
            const depTile = allTiles.find(x => x.id === depId);
            if (depTile) q.push(...depTile.dependencies);
          }
        }
        allDeps.set(t.id, [...deps]);
      }
      // blocks: 反向 — 这张牌阻塞了哪些牌
      const blocksBy = new Map<number, number[]>();
      for (const t of freeTiles) blocksBy.set(t.id, []);
      for (const [tid, deps] of allDeps) {
        for (const depId of deps) {
          blocksBy.get(depId)?.push(tid);
        }
      }

      // 计算依赖链深度（根牌=1，每多一层依赖+1）
      const depthCache = new Map<number, number>();
      function getDepth(tileId: number): number {
        if (depthCache.has(tileId)) return depthCache.get(tileId)!;
        const t = allTiles.find(x => x.id === tileId);
        if (!t || !t.dependencies.length) { depthCache.set(tileId, 1); return 1; }
        let maxD = 0;
        for (const depId of t.dependencies) { const d = getDepth(depId); if (d > maxD) maxD = d; }
        depthCache.set(tileId, maxD + 1);
        return maxD + 1;
      }
      for (const t of allTiles) getDepth(t.id);

      const tiles = freeTiles.map(t => ({
        id: t.id,
        layer: t.layer,
        depth: depthCache.get(t.id) ?? 1,
        deps: allDeps.get(t.id) ?? [],
        blocks: blocksBy.get(t.id) ?? [],
        color: colorMap[t.id] ?? 0,
      }));

      // 按 layer 和 depth 分别分组
      const layerGroups: Record<number, number[]> = {};
      const depthGroups: Record<number, number[]> = {};
      for (const t of tiles) {
        (layerGroups[t.layer] ??= []).push(t.id);
        (depthGroups[t.depth] ??= []).push(t.id);
      }

      json(res, {
        ok: true,
        tiles,
        layers: Object.entries(layerGroups).map(([l, ids]) => ({ layer: Number(l), tileIds: ids })),
        depthLayers: Object.entries(depthGroups).map(([d, ids]) => ({ depth: Number(d), tileIds: ids })),
        maxLayer: Math.max(...tiles.map(t => t.layer), 0),
        maxDepth: Math.max(...tiles.map(t => t.depth), 0),
        summary: { totalTiles: allTiles.length, freeTiles: freeTiles.length, hasColors },
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return;
  }


  // ── API: elimination plan ──
  if (url.pathname === '/api/elimination-plan' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const { levelId, levelsDir, terrainPath } = body as {
        levelId?: string; levelsDir?: string; terrainPath?: string;
      };
      const path = resolveTerrainPath(levelId, levelsDir, terrainPath);
      if (!path) throw new Error('请提供关卡ID或文件路径');
      const terrain = loadTerrainFromFile(path);
      const allTiles = getAllTiles(terrain);
      const freeTiles = allTiles.filter(t => !t.isConst);

      const allDeps = computeAllDependencies(freeTiles);
      const plan = buildEliminationPlan(freeTiles, allDeps);
      json(res, {
        ok: true,
        steps: plan.steps.map(s => ({ tileIds: s.triple.tileIds, layer: s.step })),
        totalSteps: plan.steps.length,
        complete: plan.steps.length * 3 >= freeTiles.length,
        terrainInfo: { totalTiles: allTiles.length, freeTiles: freeTiles.length, layers: terrain.layers.length },
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return;
  }

  // ── API: DFS verify & revive ──
  if (url.pathname === '/api/dfs-verify' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const { replayCode, levelId, levelsDir, terrainPath, timeout, mode, maxReviveSearch: _maxReviveSearch } = body as {
        replayCode?: string; levelId?: string; levelsDir?: string; terrainPath?: string;
        timeout?: number; mode?: string; maxReviveSearch?: number;
      };
      if (!replayCode) throw new Error('缺少 replayCode');

      // 解析 ReplayCode → 获取花色分配
      const replayData = decodeFromString(replayCode);
      if (!replayData) throw new Error('ReplayCode 解码失败');

      // 加载地形
      let path: string | null = null;
      if (replayData.levelHash !== 0n) {
        const hashStr = replayData.levelHash.toString(16).padStart(16, '0');
        path = findTerrainByLevelHash(hashStr, levelsDir || defaultLevelsDir);
      }
      if (!path && (terrainPath || levelId)) {
        path = resolveTerrainPath(levelId, levelsDir, terrainPath);
      }
      if (!path) throw new Error('无法解析地形（需要 levelId 或有效的 ReplayCode）');

      const terrain = loadTerrainFromFile(path);
      const allTiles = getAllTiles(terrain);
      const ordered = getCanonicalTileOrder(allTiles);

      // 构建 OfflineTile 列表
      const offlineTiles: OfflineTile[] = [];
      for (let i = 0; i < ordered.length && i < replayData.instanceArray.length; i++) {
        const tile = ordered[i];
        const b = replayData.instanceArray[i];
        const elemValue = (b & 0x3F) + 1;
        const ot = new OfflineTile({
          id: tile.id,
          layer: tile.layer,
          dependencies: tile.dependencies,
          isConst: tile.isConst,
          constElementValue: tile.constElementValue,
          posX: tile.posX,
          posY: tile.posY,
        }, elemValue);
        offlineTiles.push(ot);
      }

      const game = new OfflineGame(offlineTiles);
      const tMs = (timeout || 10) * 1000;

      if (mode === 'revive') {
        // ── 死亡卡点模式：BFS-by-death-depth ──
        // maxReviveSearch 是预留参数（限制复活动作数量），并非 maxStates。
        // 此处传 timeoutMs 即可，maxStates 使用求解器默认值（10M）。
        const reviveResult = solveDeathCheckpoint(game, {
          timeoutMs: tMs,
        });

        json(res, {
          ok: true,
          mode: 'revive',
          solvable: reviveResult.win,
          failReason: reviveResult.failReason,
          minRevives: reviveResult.minRevives,
          reviveSteps: reviveResult.reviveSteps,
          stepCount: reviveResult.stepCount,
          statesVisited: reviveResult.statesVisited,
          elapsedMs: Math.round(reviveResult.elapsedMs),
        });
      } else {
        // ── 普通 DFS 模式 ──
        const result = solveDFS(game, { timeoutMs: tMs });

        json(res, {
          ok: true,
          mode: 'normal',
          solvable: result.win,
          failReason: result.failReason,
          statesVisited: result.statesVisited,
          elapsedMs: Math.round(result.elapsedMs),
          stepCount: result.stepCount,
        });
      }
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return;
  }

  // ── API: player simulation ──
  if (url.pathname === '/api/player-sim' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const { replayCode, levelId, levelsDir, terrainPath, runs } = body as {
        replayCode?: string; levelId?: string; levelsDir?: string; terrainPath?: string;
        runs?: number;
      };
      if (!replayCode) throw new Error('缺少 replayCode');

      const { game } = buildGameFromReplay(replayCode, levelId, levelsDir, terrainPath);
      const simRuns = runs ?? 100;
      const baseSeed = Date.now() & 0x7fffffff;

      const result = solvePlayerBatch(game, simRuns, baseSeed);

      json(res, {
        ok: true,
        runs: simRuns,
        wins: result.wins,
        losses: result.losses,
        winRate: result.winRate,
        avgStepsOnWin: result.avgStepsOnWin,
        avgStepsOnLoss: result.avgStepsOnLoss,
        elapsedMs: Math.round(result.elapsedMs),
        // 只返回前 10 个详细结果（避免数据太大）
        sampleResults: (result.results ?? []).slice(0, 10).map(r => ({
          win: r.win,
          failReason: r.failReason,
          stepCount: r.stepCount,
          seed: r.seed,
        })),
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return;
  }

  // ── API: player simulation (short-sighted optimal) ──
  if (url.pathname === '/api/player-sim-shortest' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const { replayCode, levelId, levelsDir, terrainPath, runs } = body as {
        replayCode?: string; levelId?: string; levelsDir?: string; terrainPath?: string;
        runs?: number;
      };
      if (!replayCode) throw new Error('缺少 replayCode');

      const { game, totalTiles } = buildGameFromReplay(replayCode, levelId, levelsDir, terrainPath);
      const simRuns = runs ?? 100;
      const baseSeed = Date.now() & 0x7fffffff;
      const result = solvePlayerShortestBatch(game, simRuns, baseSeed);
      const remainingTilesOnLoss = result.losses > 0
        ? Math.max(0, totalTiles - result.stepsOnLoss)
        : null;
      const remainingRatioOnLoss = remainingTilesOnLoss == null || totalTiles <= 0
        ? null
        : remainingTilesOnLoss / totalTiles;
      const optimalMetrics = {
        runs: simRuns,
        wins: result.wins,
        losses: result.losses,
        winRate: result.winRate,
        avgStepsOnWin: result.avgStepsOnWin,
        forcedPickOnWin: result.forcedPickOnWin,
        starvationOnWin: result.starvationOnWin,
        starvationPerTileOnWin: totalTiles > 0 ? result.starvationOnWin / totalTiles : 0,
        avgStepsOnLoss: result.stepsOnLoss,
        forcedPickOnLoss: result.forcedPickOnLoss,
        starvationOnLoss: result.starvationOnLoss,
        remainingTilesOnLoss,
        remainingRatioOnLoss,
        totalTiles,
      };

      json(res, {
        ok: true,
        mode: 'shortest',
        runs: simRuns,
        wins: result.wins,
        losses: result.losses,
        winRate: result.winRate,
        avgStepsOnWin: result.avgStepsOnWin,
        avgStepsOnLoss: result.avgStepsOnLoss,
        elapsedMs: Math.round(result.elapsedMs),
        forcedPickOnWin: result.forcedPickOnWin,
        starvationOnWin: result.starvationOnWin,
        stepsOnLoss: result.stepsOnLoss,
        forcedPickOnLoss: result.forcedPickOnLoss,
        starvationOnLoss: result.starvationOnLoss,
        totalTiles: totalTiles,
        remainingTilesOnLoss,
        remainingRatioOnLoss,
        optimalMetrics,
        sampleResults: (result.results ?? []).slice(0, 10).map(r => ({
          win: r.win,
          failReason: r.failReason,
          stepCount: r.stepCount,
          seed: r.seed,
        })),
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return;
  }

  // ── API: player simulation (risky) ──
  if (url.pathname === '/api/player-sim-risky' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const { replayCode, levelId, levelsDir, terrainPath, runs, riskThreshold } = body as {
        replayCode?: string; levelId?: string; levelsDir?: string; terrainPath?: string;
        runs?: number; riskThreshold?: number;
      };
      if (!replayCode) throw new Error('缺少 replayCode');

      const { game } = buildGameFromReplay(replayCode, levelId, levelsDir, terrainPath);
      const simRuns = runs ?? 100;
      const baseSeed = Date.now() & 0x7fffffff;

      const result = solvePlayerRiskyBatch(game, simRuns, baseSeed, { riskThreshold });

      json(res, {
        ok: true,
        mode: 'risky',
        riskThreshold: riskThreshold ?? 3,
        runs: simRuns,
        wins: result.wins,
        losses: result.losses,
        winRate: result.winRate,
        avgStepsOnWin: result.avgStepsOnWin,
        avgStepsOnLoss: result.avgStepsOnLoss,
        elapsedMs: Math.round(result.elapsedMs),
        sampleResults: (result.results ?? []).slice(0, 10).map(r => ({
          win: r.win,
          failReason: r.failReason,
          stepCount: r.stepCount,
          seed: r.seed,
        })),
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return;
  }

  // ── API: player simulation (cost cap) ──
  if (url.pathname === '/api/player-sim-costcap' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const { replayCode, levelId, levelsDir, terrainPath, runs, maxCost } = body as {
        replayCode?: string; levelId?: string; levelsDir?: string; terrainPath?: string;
        runs?: number; maxCost?: number;
      };
      if (!replayCode) throw new Error('缺少 replayCode');
      if (maxCost == null || maxCost < 1) throw new Error('请提供有效的成本上限 (maxCost ≥ 1)');

      const { game } = buildGameFromReplay(replayCode, levelId, levelsDir, terrainPath);
      const simRuns = runs ?? 100;
      const baseSeed = Date.now() & 0x7fffffff;

      const result = solvePlayerCostCapBatch(game, simRuns, baseSeed, { maxCost });

      json(res, {
        ok: true,
        mode: 'costcap',
        maxCost,
        runs: simRuns,
        wins: result.wins,
        losses: result.losses,
        winRate: result.winRate,
        avgStepsOnWin: result.avgStepsOnWin,
        avgStepsOnLoss: result.avgStepsOnLoss,
        elapsedMs: Math.round(result.elapsedMs),
        sampleResults: (result.results ?? []).slice(0, 10).map(r => ({
          win: r.win,
          failReason: r.failReason,
          stepCount: r.stepCount,
          seed: r.seed,
        })),
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return;
  }

  // ── API: player simulation (mistake) ──
  if (url.pathname === '/api/player-sim-mistake' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const { replayCode, levelId, levelsDir, terrainPath, runs, mistakeRate } = body as {
        replayCode?: string; levelId?: string; levelsDir?: string; terrainPath?: string;
        runs?: number; mistakeRate?: number;
      };
      if (!replayCode) throw new Error('缺少 replayCode');
      if (mistakeRate == null || mistakeRate < 0 || mistakeRate > 1) {
        throw new Error('失误率需在 0.0 ~ 1.0 之间');
      }

      const { game } = buildGameFromReplay(replayCode, levelId, levelsDir, terrainPath);
      const simRuns = runs ?? 100;
      const baseSeed = Date.now() & 0x7fffffff;

      const result = solvePlayerMistakeBatch(game, simRuns, baseSeed, { mistakeRate });

      json(res, {
        ok: true,
        mode: 'mistake',
        mistakeRate,
        runs: simRuns,
        wins: result.wins,
        losses: result.losses,
        winRate: result.winRate,
        avgStepsOnWin: result.avgStepsOnWin,
        avgStepsOnLoss: result.avgStepsOnLoss,
        elapsedMs: Math.round(result.elapsedMs),
        sampleResults: (result.results ?? []).slice(0, 10).map(r => ({
          win: r.win,
          failReason: r.failReason,
          stepCount: r.stepCount,
          seed: r.seed,
        })),
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return;
  }

  // ── API: grade config ──
  if (url.pathname === '/api/grade/config' && req.method === 'GET') {
    try {
      const cfg = getGradeConfig();
      const strategy1 = getGradeStrategy1Config();
      json(res, { ok: true, config: cfg, strategy1, strategy2: gradeStrategy2Info });
    } catch (err) { json(res, { ok: false, error: String(err) }, 500); }
    return;
  }

  // ── API: grade config reload ──
  if (url.pathname === '/api/grade/config-reload' && req.method === 'POST') {
    try {
      gradeConfig = null; // 清除缓存
      gradeStrategy1Config = null;
      const cfg = loadGradeConfig();
      const strategy1 = loadGradeStrategy1Config();
      json(res, { ok: true, message: `已重新加载旧版、${strategy1.name}与${gradeStrategy2Info.name}`, config: cfg, strategy1, strategy2: gradeStrategy2Info });
    } catch (err) { json(res, { ok: false, error: String(err) }, 500); }
    return;
  }

  // ── API: grade calculate ──
  if (url.pathname === '/api/grade/calculate' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const { replayCode, levelId, levelsDir, terrainPath, runs, strategy } = body as {
        replayCode?: string; levelId?: string; levelsDir?: string; terrainPath?: string; runs?: number; strategy?: string;
      };
      if (!replayCode) throw new Error('缺少 replayCode');

      const { game: gam } = buildGameFromReplay(replayCode, levelId, levelsDir, terrainPath);
      const useStrategy1 = strategy === 'strategy1';
      const useStrategy2 = strategy === 'strategy2';
      const cfg = (useStrategy1 || useStrategy2) ? getGradeStrategy1Config() : getGradeConfig();
      const simRuns = runs ?? cfg.defaultRuns;

      // 串行跑三个失误率
      const simResults: Array<{ rate: number; label: string }> = [
        { rate: cfg.simRates.ceiling, label: 'sim1' },
        { rate: cfg.simRates.baseline, label: 'sim5' },
        { rate: cfg.simRates.floor, label: 'sim15' },
      ];

      const rawResults: Record<string, { winRate: number; wins: number; losses: number; elapsedMs: number }> = {};
      for (const sr of simResults) {
        const baseSeed = (Date.now() + Math.floor(Math.random() * 65536)) & 0x7fffffff;
        const r = solvePlayerMistakeBatch(gam, simRuns, baseSeed, { mistakeRate: sr.rate });
        rawResults[sr.label] = {
          winRate: r.winRate,
          wins: r.wins,
          losses: r.losses,
          elapsedMs: Math.round(r.elapsedMs),
        };
      }

      const snap = {
        sim1: { ...rawResults.sim1, runs: simRuns },
        sim5: { ...rawResults.sim5, runs: simRuns },
        sim15: { ...rawResults.sim15, runs: simRuns },
      };

      const strategyResult: GradeVerdict | null = useStrategy1
        ? gradeStrategy1(snap, cfg as GradeStrategy1Config)
        : null;
      const strategy2Result: GradeStrategy2Result | null = useStrategy2
        ? gradeStrategy2(snap)
        : null;
      const legacyResult: GradeResult | null = (useStrategy1 || useStrategy2)
        ? null
        : gradeFull(snap, cfg as GradeConfig);

      // 计算稳定性（兼容旧版本可能没有的字段，这里用 gradeFull 内部的结果）
      const stability = computeStability(snap.sim1.winRate, snap.sim15.winRate);

      json(res, {
        ok: true,
        strategy: useStrategy1 ? 'strategy1' : useStrategy2 ? 'strategy2' : 'legacy',
        runs: simRuns,
        simResults: {
          sim1: { winRate: snap.sim1.winRate, wins: snap.sim1.wins, losses: snap.sim1.losses, elapsedMs: snap.sim1.elapsedMs },
          sim5: { winRate: snap.sim5.winRate, wins: snap.sim5.wins, losses: snap.sim5.losses, elapsedMs: snap.sim5.elapsedMs },
          sim15: { winRate: snap.sim15.winRate, wins: snap.sim15.wins, losses: snap.sim15.losses, elapsedMs: snap.sim15.elapsedMs },
        },
        stability,
        grade: useStrategy1
          ? { strategy1: strategyResult }
          : useStrategy2
            ? { strategy2: strategy2Result }
            : { standard: legacyResult!.standard, refined: legacyResult!.refined },
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return;
  }

  // ── API: grade validate ──
  if (url.pathname === '/api/grade/validate' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const { replayCode, levelId, levelsDir, terrainPath, runs, targetGrade, strategy } = body as {
        replayCode?: string; levelId?: string; levelsDir?: string; terrainPath?: string; runs?: number; targetGrade?: number; strategy?: string;
      };
      if (!replayCode) throw new Error('缺少 replayCode');
      const useStrategy1 = strategy === 'strategy1';
      const useStrategy2 = strategy === 'strategy2';
      const maxGrade = (useStrategy1 || useStrategy2) ? 5 : 7;
      if (targetGrade == null || targetGrade < 0 || targetGrade > maxGrade) {
        throw new Error(`targetGrade 需为 0-${maxGrade} 的整数`);
      }

      const { game: gam } = buildGameFromReplay(replayCode, levelId, levelsDir, terrainPath);
      const cfg = (useStrategy1 || useStrategy2) ? getGradeStrategy1Config() : getGradeConfig();
      const simRuns = runs ?? cfg.defaultRuns;

      const simResults: Array<{ rate: number; label: string }> = [
        { rate: cfg.simRates.ceiling, label: 'sim1' },
        { rate: cfg.simRates.baseline, label: 'sim5' },
        { rate: cfg.simRates.floor, label: 'sim15' },
      ];

      const rawResults: Record<string, { winRate: number; wins: number; losses: number; elapsedMs: number }> = {};
      for (const sr of simResults) {
        const baseSeed = (Date.now() + Math.floor(Math.random() * 65536)) & 0x7fffffff;
        const r = solvePlayerMistakeBatch(gam, simRuns, baseSeed, { mistakeRate: sr.rate });
        rawResults[sr.label] = {
          winRate: r.winRate,
          wins: r.wins,
          losses: r.losses,
          elapsedMs: Math.round(r.elapsedMs),
        };
      }

      const snap = {
        sim1: { ...rawResults.sim1, runs: simRuns },
        sim5: { ...rawResults.sim5, runs: simRuns },
        sim15: { ...rawResults.sim15, runs: simRuns },
      };

      const strategyResult: GradeVerdict | null = useStrategy1
        ? gradeStrategy1(snap, cfg as GradeStrategy1Config)
        : null;
      const strategy2Result: GradeStrategy2Result | null = useStrategy2
        ? gradeStrategy2(snap)
        : null;
      const legacyResult: GradeResult | null = (useStrategy1 || useStrategy2)
        ? null
        : gradeFull(snap, cfg as GradeConfig);
      const strategy1Match = strategyResult != null
        && strategyResult.passed
        && strategyResult.grade === targetGrade;
      const strategy2Match = strategy2Result != null
        && strategy2Result.passed
        && strategy2Result.grade === targetGrade;
      const validation = useStrategy1
        ? {
            targetGrade,
            strategy1Match,
            reasons: strategy1Match ? [] : [strategyResult!.passed
              ? `分档策略1: 实际档${strategyResult!.grade}(${strategyResult!.label})，目标档${targetGrade}`
              : `分档策略1: ${strategyResult!.reason}`],
          }
        : useStrategy2
          ? {
              targetGrade,
              strategy2Match,
              reasons: strategy2Match ? [] : [
                `评估策略2: 实际档${strategy2Result!.grade}(${strategy2Result!.label})，目标档${targetGrade}，passrate=${(strategy2Result!.passrate * 100).toFixed(1)}%`,
              ],
            }
        : validateGrade(snap, targetGrade, cfg as GradeConfig);
      const stability = computeStability(snap.sim1.winRate, snap.sim15.winRate);

      json(res, {
        ok: true,
        strategy: useStrategy1 ? 'strategy1' : useStrategy2 ? 'strategy2' : 'legacy',
        runs: simRuns,
        targetGrade,
        allMatch: useStrategy1
          ? strategy1Match
          : useStrategy2
            ? strategy2Match
          : (validation as GradeValidation).standardMatch && (validation as GradeValidation).refinedMatch,
        simResults: {
          sim1: { winRate: snap.sim1.winRate, wins: snap.sim1.wins, losses: snap.sim1.losses, elapsedMs: snap.sim1.elapsedMs },
          sim5: { winRate: snap.sim5.winRate, wins: snap.sim5.wins, losses: snap.sim5.losses, elapsedMs: snap.sim5.elapsedMs },
          sim15: { winRate: snap.sim15.winRate, wins: snap.sim15.wins, losses: snap.sim15.losses, elapsedMs: snap.sim15.elapsedMs },
        },
        stability,
        grade: useStrategy1
          ? { strategy1: strategyResult }
          : useStrategy2
            ? { strategy2: strategy2Result }
            : { standard: legacyResult!.standard, refined: legacyResult!.refined },
        validation,
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return;
  }

  // ── API: Batch Generate — Start ──
  if (url.pathname === '/api/batch-generate/start' && req.method === 'POST') {
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
    return;
  }

  // ── API: Batch Generate — Stop ──
  if (url.pathname === '/api/batch-generate/stop' && req.method === 'POST') {
    const body = await parseBody(req);
    const jobId = (body as { jobId?: string }).jobId;
    if (!jobId) { json(res, { ok: false, error: 'Missing jobId' }, 400); return; }
    const job = batchJobs.get(jobId);
    if (!job) { json(res, { ok: false, error: 'Job not found' }, 404); return; }
    job.state = 'aborted';
    job.child.kill('SIGTERM');
    json(res, { ok: true });
    return;
  }

  // ── API: Batch Generate — Status ──
  if (url.pathname === '/api/batch-generate/status' && req.method === 'GET') {
    const jobId = url.searchParams.get('jobId');
    if (!jobId) { json(res, { ok: false, error: 'Missing jobId' }, 400); return; }
    const job = batchJobs.get(jobId);
    if (!job) { json(res, { ok: false, error: 'Job not found' }, 404); return; }
    json(res, { ok: true, ...webBatchProgress(job), schemaVersion: 2, seed: job.definition.runtime.seed });
    return;
  }

  // ── API: Batch Generate — Download CSV ──
  if (url.pathname === '/api/batch-generate/csv' && req.method === 'GET') {
    const jobId = url.searchParams.get('jobId');
    if (!jobId) { json(res, { ok: false, error: 'Missing jobId' }, 400); return; }
    const job = batchJobs.get(jobId);
    if (!job) { json(res, { ok: false, error: 'Job not found' }, 404); return; }
    try {
      const csv = serializeBatchCsv(webBatchRows(job));
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="batch_result_${jobId}.csv"`,
      });
      res.end(csv);
    } catch { json(res, { ok: false, error: 'CSV file not available' }, 500); }
    return;
  }

  // ── API: append replay candidate to CSV ──
  if (url.pathname === '/api/replay-selection/append' && req.method === 'POST') {
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
    return;
  }

  // ── API: validate CSV and rebuild replay JSON files ──
  if (url.pathname === '/api/replay-selection/build' && req.method === 'POST') {
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
    return;
  }

  // ── Static files ──
  if (url.pathname === '/' || url.pathname === '/index.html') {
    serveStatic(res, join(GUI_DIR, 'index.html'));
    return;
  }
  if (appSurface === 'generator') {
    if (url.pathname === '/reversegen-theme.js' || url.pathname === '/reversegen-theme.css') {
      serveStatic(res, join(GUI_DIR, url.pathname));
      return;
    }
    json(res, { ok: false, error: 'Not found' }, 404);
    return;
  }
  if (url.pathname === '/challenge-expectation' || url.pathname === '/challenge-expectation/') {
    serveStatic(res, join(GUI_DIR, 'challenge-expectation', 'index.html'));
    return;
  }
  if (url.pathname === '/batch-generate.html' || url.pathname === '/batch-generate') {
    serveStatic(res, join(GUI_DIR, 'batch-generate.html'));
    return;
  }
  if (url.pathname === '/generation-strategies.html' || url.pathname === '/generation-strategies') {
    serveStatic(res, join(GUI_DIR, 'generation-strategies.html'));
    return;
  }
  serveStatic(res, join(GUI_DIR, url.pathname));
});

server.listen(port, host, () => {
  // 启动时加载分档配置
  try { loadGradeConfig(); } catch (e) { console.warn(`⚠️  分档配置加载失败: ${e}`); }
  try { loadGradeStrategy1Config(); } catch (e) { console.warn(`⚠️  分档策略1配置加载失败: ${e}`); }

  console.log(`\n🔧 ReverseGen GUI → http://localhost:${port}${appBasePath}`);
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    const virtualInterfacePattern = /(?:vEthernet|WSL|Hyper-V|VMware|VirtualBox|VMnet|Docker|TAP|VPN|Loopback|Bluetooth|蓝牙)/i;
    const addresses = Object.entries(networkInterfaces())
      .flatMap(([interfaceName, entries]) => (entries ?? [])
        .filter(entry => entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.'))
        .map(entry => ({
          interfaceName,
          address: entry.address,
          virtual: virtualInterfacePattern.test(interfaceName),
        })))
      .filter((item, index, all) => all.findIndex(other => other.address === item.address) === index);
    const physicalAddresses = addresses.filter(item => !item.virtual);
    const virtualAddresses = addresses.filter(item => item.virtual);

    if (physicalAddresses.length) {
      console.log('🌐 局域网访问（请选择与访问设备处于同一网络的地址）:');
      for (const item of physicalAddresses) {
        console.log(`   http://${item.address}:${port}  [${item.interfaceName}]`);
      }
    } else {
      console.log('⚠️  未检测到可用的物理局域网地址');
    }
    if (virtualAddresses.length) {
      console.log('🧩 虚拟网卡地址（通常仅供 WSL、虚拟机或 VPN 内部访问）:');
      for (const item of virtualAddresses) {
        console.log(`   http://${item.address}:${port}  [${item.interfaceName}]`);
      }
    }
  }
  if (existsSync(defaultLevelsDir)) {
    const n = listLevels(defaultLevelsDir).length;
    console.log(`📁 ReplayCode 自动匹配目录（兼容功能）: ${defaultLevelsDir} (${n} 个关卡)`);
  } else {
    console.log('ℹ️  未配置 ReplayCode 自动匹配目录；手动选择地形文件不受影响');
  }
  console.log('');
  if (autoOpen) {
    const platform = process.platform;
    const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
    const baseUrl = `http://localhost:${port}${appBasePath}`;
    const target = openPath === '/' ? baseUrl : `${baseUrl}${openPath.replace(/^\//, '')}`;
    exec(`${cmd} ${target}`);
  }
});
