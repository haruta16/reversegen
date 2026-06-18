/**
 * HTTP server for ReverseGen web GUI.
 *
 * Usage:
 *   npx tsx gui/server.ts [--port 3000] [--open] [--levels-dir /path/to/levels]
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync, readdirSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  generateBoard,
  generateBoardLayerClosure,
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
  gradeFull,
  validateGrade,
  computeStability,
  computeAllDependencies,
  runPureGreedySimulation,
  computeMetrics,
  computeTileDepSets,
  computeCloseRatesFromAssignments,
} from '../src/index.js';
import type { TerrainTile, GradeConfig, GradeResult, GradeValidation } from '../src/index.js';
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
  OfflineTile,
  PileType,
} from '../src/solver/index.js';

/** 内存中的分析结果缓存 (keyed by terrainHash)，最多保留 50 条，LRU 淘汰 */
const ANALYSIS_CACHE_MAX = 50;
const analysisCache = new Map<string, ReturnType<typeof analyzeTriples>>();

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

// ── CLI Args ──
const args = process.argv.slice(2);
let port = 3000;
let autoOpen = false;
// Default: look for levels in the original TileMatchShell project
let defaultLevelsDir = join(__dirname, '..', '..', 'TileMatchShell', 'Tools', 'Config', 'Json', 'Levels');

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = parseInt(args[i + 1], 10); i++;
  } else if (args[i] === '--open') {
    autoOpen = true;
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
    if (!existsSync(path) || path.includes('..')) { res.writeHead(404); res.end('Not found'); return; }
    const content = readFileSync(path);
    res.writeHead(200, { 'Content-Type': MIME[path.substring(path.lastIndexOf('.'))] || 'application/octet-stream' });
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
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

/** Resolve terrain: levelId takes priority; falls back to terrainPath. */
function resolveTerrainPath(levelId: string | undefined, levelsDir: string | undefined, terrainPath: string | undefined): string | null {
  if (levelId) {
    const dir = levelsDir || defaultLevelsDir;
    const p = join(dir, `${levelId}.json`);
    if (existsSync(p)) return p;
    throw new Error(`关卡 ${levelId} 不存在: ${p}`);
  }
  if (terrainPath) {
    if (existsSync(terrainPath)) return terrainPath;
    throw new Error(`文件不存在: ${terrainPath}`);
  }
  return null;
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

  const dir = levelsDir || defaultLevelsDir;
  if (!existsSync(dir)) return null;

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
  } catch { return null; }
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
): OfflineGame {
  const replayData = decodeFromString(replayCode);
  if (!replayData) throw new Error('ReplayCode 解码失败');

  // 加载地形
  let path: string | null = null;
  if (replayData.levelHash !== 0n) {
    const hashStr = replayData.levelHash.toString(16).padStart(16, '0');
    path = findTerrainByLevelHash(hashStr, levelsDir || defaultLevelsDir);
  }
  if (!path && levelId) {
    path = resolveTerrainPath(levelId, levelsDir, undefined);
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

  return new OfflineGame(offlineTiles);
}

// ── Grade Config ──

/** 分档阈值配置的内存缓存，启动时加载。可通过 /api/grade/config-reload 热更新。 */
let gradeConfig: GradeConfig | null = null;

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

// ── Server ──
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`);

  // ── API: list levels ──
  if (url.pathname === '/api/levels' && req.method === 'GET') {
    const dir = url.searchParams.get('dir') || defaultLevelsDir;
    json(res, { ok: true, dir, levels: listLevels(dir) });
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
        closeRates, dock, spreadParam, // LayerClosure params
        levelId, levelsDir, terrainPath, levelHash,
      } = body as {
        algorithm?: string;
        costArray?: string; colorCount?: string;           // CostLadder
        closeRates?: string; dock?: string; spreadParam?: string; // LayerClosure
        levelId?: string; levelsDir?: string; terrainPath?: string; levelHash?: string;
      };

      const path = resolveTerrainPath(levelId, levelsDir, terrainPath);
      if (!path) {
        json(res, { ok: false, error: '请提供关卡ID或文件路径' }, 400);
        return;
      }
      const terrain = loadTerrainFromFile(path);
      const allTiles = getAllTiles(terrain);

      if (algorithm === 'closure') {
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

        const result = generateBoardLayerClosure({
          terrain, closeRates: rates, colorCount: k,
          dock: dk, levelHash, spreadParam: spread,
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
          replayCode: result.replayCode,
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
          replayCode: result.replayCode,
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
      const { replayCode, levelsDir } = body as {
        replayCode?: string; levelsDir?: string;
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
      const tileDepSets = computeTileDepSets(allTiles, allTileMap);
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

  // ── API: replay cost log ──
  if (url.pathname === '/api/replay-costlog' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const { replayCode, levelId, levelsDir } = body as {
        replayCode?: string; levelId?: string; levelsDir?: string;
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
      if (!path && levelId) {
        path = resolveTerrainPath(levelId, levelsDir, undefined);
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

      const plan = buildEliminationPlan(freeTiles);
      json(res, {
        ok: true,
        steps: plan.steps.map(s => ({ tileIds: s.tileIds, layer: s.layer })),
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
      const { replayCode, levelId, levelsDir, timeout, mode, maxReviveSearch: _maxReviveSearch } = body as {
        replayCode?: string; levelId?: string; levelsDir?: string;
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
      if (!path && levelId) {
        path = resolveTerrainPath(levelId, levelsDir, undefined);
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
      const { replayCode, levelId, levelsDir, runs } = body as {
        replayCode?: string; levelId?: string; levelsDir?: string;
        runs?: number;
      };
      if (!replayCode) throw new Error('缺少 replayCode');

      const game = buildGameFromReplay(replayCode, levelId, levelsDir);
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
        sampleResults: result.results.slice(0, 10).map(r => ({
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
      const { replayCode, levelId, levelsDir, runs, riskThreshold } = body as {
        replayCode?: string; levelId?: string; levelsDir?: string;
        runs?: number; riskThreshold?: number;
      };
      if (!replayCode) throw new Error('缺少 replayCode');

      const game = buildGameFromReplay(replayCode, levelId, levelsDir);
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
        sampleResults: result.results.slice(0, 10).map(r => ({
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
      const { replayCode, levelId, levelsDir, runs, maxCost } = body as {
        replayCode?: string; levelId?: string; levelsDir?: string;
        runs?: number; maxCost?: number;
      };
      if (!replayCode) throw new Error('缺少 replayCode');
      if (maxCost == null || maxCost < 1) throw new Error('请提供有效的成本上限 (maxCost ≥ 1)');

      const game = buildGameFromReplay(replayCode, levelId, levelsDir);
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
        sampleResults: result.results.slice(0, 10).map(r => ({
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
      const { replayCode, levelId, levelsDir, runs, mistakeRate } = body as {
        replayCode?: string; levelId?: string; levelsDir?: string;
        runs?: number; mistakeRate?: number;
      };
      if (!replayCode) throw new Error('缺少 replayCode');
      if (mistakeRate == null || mistakeRate < 0 || mistakeRate > 1) {
        throw new Error('失误率需在 0.0 ~ 1.0 之间');
      }

      const game = buildGameFromReplay(replayCode, levelId, levelsDir);
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
        sampleResults: result.results.slice(0, 10).map(r => ({
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
      json(res, { ok: true, config: cfg });
    } catch (err) { json(res, { ok: false, error: String(err) }, 500); }
    return;
  }

  // ── API: grade config reload ──
  if (url.pathname === '/api/grade/config-reload' && req.method === 'POST') {
    try {
      gradeConfig = null; // 清除缓存
      const cfg = loadGradeConfig();
      json(res, { ok: true, message: `已重新加载 (v${cfg.version})`, config: cfg });
    } catch (err) { json(res, { ok: false, error: String(err) }, 500); }
    return;
  }

  // ── API: grade calculate ──
  if (url.pathname === '/api/grade/calculate' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const { replayCode, levelId, levelsDir, runs } = body as {
        replayCode?: string; levelId?: string; levelsDir?: string; runs?: number;
      };
      if (!replayCode) throw new Error('缺少 replayCode');

      const gam = buildGameFromReplay(replayCode, levelId, levelsDir);
      const cfg = getGradeConfig();
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

      const result = gradeFull(snap, cfg);

      // 计算稳定性（兼容旧版本可能没有的字段，这里用 gradeFull 内部的结果）
      const stability = computeStability(snap.sim1.winRate, snap.sim15.winRate);

      json(res, {
        ok: true,
        runs: simRuns,
        simResults: {
          sim1: { winRate: snap.sim1.winRate, wins: snap.sim1.wins, losses: snap.sim1.losses, elapsedMs: snap.sim1.elapsedMs },
          sim5: { winRate: snap.sim5.winRate, wins: snap.sim5.wins, losses: snap.sim5.losses, elapsedMs: snap.sim5.elapsedMs },
          sim15: { winRate: snap.sim15.winRate, wins: snap.sim15.wins, losses: snap.sim15.losses, elapsedMs: snap.sim15.elapsedMs },
        },
        stability,
        grade: {
          standard: result.standard,
          refined: result.refined,
        },
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return;
  }

  // ── API: grade validate ──
  if (url.pathname === '/api/grade/validate' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const { replayCode, levelId, levelsDir, runs, targetGrade } = body as {
        replayCode?: string; levelId?: string; levelsDir?: string; runs?: number; targetGrade?: number;
      };
      if (!replayCode) throw new Error('缺少 replayCode');
      if (targetGrade == null || targetGrade < 0 || targetGrade > 7) {
        throw new Error('targetGrade 需为 0-7 的整数');
      }

      const gam = buildGameFromReplay(replayCode, levelId, levelsDir);
      const cfg = getGradeConfig();
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

      const full = gradeFull(snap, cfg);
      const validation = validateGrade(snap, targetGrade, cfg);
      const stability = computeStability(snap.sim1.winRate, snap.sim15.winRate);

      json(res, {
        ok: true,
        runs: simRuns,
        targetGrade,
        allMatch: validation.standardMatch && validation.refinedMatch,
        simResults: {
          sim1: { winRate: snap.sim1.winRate, wins: snap.sim1.wins, losses: snap.sim1.losses, elapsedMs: snap.sim1.elapsedMs },
          sim5: { winRate: snap.sim5.winRate, wins: snap.sim5.wins, losses: snap.sim5.losses, elapsedMs: snap.sim5.elapsedMs },
          sim15: { winRate: snap.sim15.winRate, wins: snap.sim15.wins, losses: snap.sim15.losses, elapsedMs: snap.sim15.elapsedMs },
        },
        stability,
        grade: {
          standard: full.standard,
          refined: full.refined,
        },
        validation,
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return;
  }

  // ── Static files ──
  if (url.pathname === '/' || url.pathname === '/index.html') {
    serveStatic(res, join(GUI_DIR, 'index.html'));
    return;
  }
  serveStatic(res, join(GUI_DIR, url.pathname));
});

server.listen(port, () => {
  // 启动时加载分档配置
  try { loadGradeConfig(); } catch (e) { console.warn(`⚠️  分档配置加载失败: ${e}`); }

  console.log(`\n🔧 ReverseGen GUI → http://localhost:${port}`);
  if (existsSync(defaultLevelsDir)) {
    const n = listLevels(defaultLevelsDir).length;
    console.log(`📁 关卡目录: ${defaultLevelsDir} (${n} 个关卡)`);
  } else {
    console.log(`⚠️  关卡目录不存在: ${defaultLevelsDir}`);
    console.log(`   用 --levels-dir 指定路径`);
  }
  console.log('');
  if (autoOpen) {
    const platform = process.platform;
    const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${cmd} http://localhost:${port}`);
  }
});
