/**
 * GUI server shared runtime — 目录常量、地形解析、分析缓存、分档配置与
 * HTTP 辅助函数。所有路由模块从这里导入共享状态与工具。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync, readdirSync, writeFileSync, unlinkSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname, basename, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import {
  loadTerrainFromFile,
  getAllTiles,
  getCanonicalTileOrder,
  decodeFromString,
  buildReplayElementMap,
  mapReplayElementValue,
  parseMechanicCounts,
} from '../../src/index.js';
import type { GradeConfig, GradeStrategy1Config } from '../../src/index.js';
import { OfflineGame, createGame } from '../../src/solver/index.js';
import { analyzeTriples } from '../../tools/dag/triple-analyzer.js';

const ANALYSIS_CACHE_MAX = 50;
const analysisCache = new Map<string, ReturnType<typeof analyzeTriples>>();

export function cacheGet(key: string): ReturnType<typeof analyzeTriples> | undefined {
  // LRU: delete + re-insert to move to end
  const val = analysisCache.get(key);
  if (val !== undefined) {
    analysisCache.delete(key);
    analysisCache.set(key, val);
  }
  return val;
}

export function cacheSet(key: string, value: ReturnType<typeof analyzeTriples>): void {
  // Evict oldest if at capacity (Map iterates in insertion order)
  if (analysisCache.size >= ANALYSIS_CACHE_MAX && !analysisCache.has(key)) {
    const oldest = analysisCache.keys().next().value;
    if (oldest !== undefined) analysisCache.delete(oldest);
  }
  analysisCache.set(key, value);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// runtime.ts 位于 gui/lib/，因此 GUI_DIR 与仓库根目录都要多回退一层。
export const GUI_DIR = join(__dirname, '..');
export const PROJECT_ROOT = join(__dirname, '..', '..');
export const GENERATION_STRATEGIES_DIR = join(PROJECT_ROOT, 'strategies');
export const GENERATION_RUNS_DIR = join(PROJECT_ROOT, 'output', 'runs');
export const GENERATION_SCHEMA_PATH = join(PROJECT_ROOT, 'config', 'strategy-v2.schema.json');
export const GENERATION_CATALOG_PATH = join(PROJECT_ROOT, 'config', 'generation-feature-catalog.json');
export const UPLOADED_TERRAINS_DIR = join(PROJECT_ROOT, '.reversegen-cache', 'uploaded-terrains');
export const GENERATION_STRATEGY_ID = /^[a-z0-9][a-z0-9_-]{2,79}$/;
export const APP_NAME = 'reversegen';
export const APP_VERSION = (() => {
  try { return String(JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8')).version || '0.0.0'); }
  catch { return '0.0.0'; }
})();


const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
};

export function serveStatic(res: ServerResponse, path: string): void {
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

export function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
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


export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  renameSync(temp, path);
}


/** Resolve terrain: an explicitly selected file takes priority; levelId is the legacy fallback. */
export function resolveTerrainPath(levelId: string | undefined, levelsDir: string | undefined, terrainPath: string | undefined): string | null {
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
export function storeUploadedTerrain(fileName: string, terrainJson: string): string {
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
export function findTerrainByLevelHash(levelHash: string, levelsDir?: string): string | null {
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
export function listLevels(dir: string): Array<{ id: number; name: string; tiles: number }> {
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


/**
 * 从 ReplayCode + 关卡信息构建 OfflineGame 实例（玩家模拟类求解器共用）。
 * 即"结果"组装点：花色来自 code，挂件来自地形静态摆放 + 机制分配器
 * （extraConfig 分配请求 + mechanicSeed，对齐 Unity FixedReplayCode 装载顺序）。
 */
export function buildGameFromReplay(
  replayCode: string,
  levelId?: string,
  levelsDir?: string,
  terrainPath?: string,
  mechanicsText?: string,
  mechanicSeed?: number,
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

  // 花色来自 ReplayCode：归一化 → 真实花色（const 牌钉回固定值，对齐 Unity BuildReplayElementMap）
  const elementMap = buildReplayElementMap(ordered, replayData.instanceArray, replayData.elementCount);
  const elementValues = new Map<number, number>();
  for (let i = 0; i < ordered.length && i < replayData.instanceArray.length; i++) {
    const normValue = (replayData.instanceArray[i] & 0x3f) + 1;
    elementValues.set(ordered[i].id, mapReplayElementValue(normValue, elementMap));
  }
  const mechanics = mechanicsText && mechanicsText.trim()
    ? parseMechanicCounts(mechanicsText)
    : undefined;

  const game = createGame({
    terrainTiles: ordered,
    terrainStructures: terrain.terrainStructures,
    elementValues,
    levelResId: terrain.levelResId,
    replayCode,
    mechanicConfig: mechanics,
    mechanicSeed,
  });
  return { game, totalTiles: ordered.length };
}

// ── Grade Config ──

/** 分档阈值配置的内存缓存，启动时加载。可通过 /api/grade/config-reload 热更新。 */
let gradeConfig: GradeConfig | null = null;
let gradeStrategy1Config: GradeStrategy1Config | null = null;
export const gradeStrategy2Info = {
  name: '评估策略2',
  description: '基于 sim1/sim5/sim15 的 passrate 估计六档。',
  formula: 'clamp(0.30*sim1 + 0.10*sim5 + 0.60*sim15 + 0.08, 0, 1)',
  simRates: { ceiling: 0.01, baseline: 0.05, floor: 0.15 },
  defaultRuns: 100,
};

export function loadGradeConfig(): GradeConfig {
  const configPath = join(__dirname, '..', '..', 'config', 'grade-thresholds.json');
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

export function getGradeConfig(): GradeConfig {
  return gradeConfig ?? loadGradeConfig();
}

export function loadGradeStrategy1Config(): GradeStrategy1Config {
  const configPath = join(__dirname, '..', '..', 'config', 'grade-strategy-1.json');
  if (!existsSync(configPath)) throw new Error(`分档策略1配置不存在: ${configPath}`);
  const cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as GradeStrategy1Config;
  if (!cfg.version || !cfg.name || !cfg.priority || !cfg.tiers || !cfg.simRates) {
    throw new Error('分档策略1配置格式无效');
  }
  gradeStrategy1Config = cfg;
  console.log(`[grade-config] 加载成功: ${cfg.name} (v${cfg.version}), ${cfg.tiers.length} 个档位`);
  return cfg;
}

export function getGradeStrategy1Config(): GradeStrategy1Config {
  return gradeStrategy1Config ?? loadGradeStrategy1Config();
}

// ── 默认关卡目录（--levels-dir / LEVELS_DIR 可覆盖）──
export let defaultLevelsDir: string = String(process.env.LEVELS_DIR || '').trim()
  || join(__dirname, '..', '..', 'TileMatchShell', 'Tools', 'Config', 'Json', 'Levels');

export function setDefaultLevelsDir(value: string): void {
  defaultLevelsDir = value;
}

/** 清除分档配置缓存（config-reload 端点使用）。 */
export function resetGradeConfigs(): void {
  gradeConfig = null;
  gradeStrategy1Config = null;
}

