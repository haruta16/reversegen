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
  loadTerrainFromFile,
  getAllTiles,
  getCanonicalTileOrder,
  decodeFromString,
  formatHash,
  setLogLevel,
  LogLevel,
} from '../src/index.js';
import {
  analyzeTriples,
  filterGraphData,
  getTripleDetail,
} from '../src/triple-analyzer.js';
import { decodeFromString, getCanonicalTileOrder } from '../src/replay-serializer.js';

/** 内存中的分析结果缓存 (keyed by terrainHash) */
const analysisCache = new Map<string, ReturnType<typeof analyzeTriples>>();

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
      let path = resolveTerrainPath(levelId, levelsDir, terrainPath);

      // ReplayCode 自动解析地形：解码获取 levelHash → 在 levels 目录中匹配
      if (!path && replayCode) {
        const replayData = decodeFromString(replayCode);
        if (replayData && replayData.levelHash !== 0n) {
          const hashStr = replayData.levelHash.toString(16).padStart(16, '0');
          path = findTerrainByLevelHash(hashStr, levelsDir);
        }
      }
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
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return;
  }

  // ── API: generate board ──
  if (url.pathname === '/api/generate' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const { costArray, colorCount, levelId, levelsDir, terrainPath, levelHash } = body as {
        costArray?: string; colorCount?: string;
        levelId?: string; levelsDir?: string; terrainPath?: string; levelHash?: string;
      };

      const k = parseInt(colorCount || '99', 10);

      if (!costArray || !costArray.trim()) {
        json(res, { ok: false, error: '请提供 Cost 数组' }, 400);
        return;
      }

      const path = resolveTerrainPath(levelId, levelsDir, terrainPath);
      if (!path) {
        json(res, { ok: false, error: '请提供关卡ID或文件路径' }, 400);
        return;
      }
      const terrain = loadTerrainFromFile(path);

      const costs = costArray.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      if (costs.length === 0 || costs.some(c => c < 1)) {
        json(res, { ok: false, error: 'Cost 数组格式无效' }, 400);
        return;
      }

      const result = generateBoard({ terrain, costArray: costs, colorCount: k, levelHash });

      const allTiles = getAllTiles(terrain);
      const ordered = getCanonicalTileOrder(allTiles);
      const tileSummary = ordered.map((t, i) => ({
        index: i, id: t.id, layer: t.layer, isConst: t.isConst,
        element: result.assignments.get(t.id) ?? t.constElementValue ?? 0,
      }));

      const assignmentsObj: Record<string, number> = {};
      for (const [k, v] of result.assignments) assignmentsObj[String(k)] = v;

      json(res, {
        ok: true,
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
        let path = resolveTerrainPath(levelId, levelsDir, terrainPath);
        // ReplayCode 自动解析地形
        if (!path && replayCode) {
          const replayData = decodeFromString(replayCode);
          if (replayData && replayData.levelHash !== 0n) {
            const hashStr = replayData.levelHash.toString(16).padStart(16, '0');
            path = findTerrainByLevelHash(hashStr, levelsDir);
          }
        }
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
          suitMap.set(ordered[i].id, replayData.instanceArray[i] & 0x3F);
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
      let analysisResult = analysisCache.get(mcKey);
      if (!analysisResult || forceRefresh) {
        analysisResult = analyzeTriples(terrain, {
          force: !!forceRefresh,
          edgeTopN: 6000,
          maxEdgesPerNode: 20,
          suitMap,
        });
        analysisCache.set(mcKey, analysisResult);
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
      const analysisResult = analysisCache.get(mcKey);
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

  // ── Static files ──
  if (url.pathname === '/' || url.pathname === '/index.html') {
    serveStatic(res, join(GUI_DIR, 'index.html'));
    return;
  }
  serveStatic(res, join(GUI_DIR, url.pathname));
});

server.listen(port, () => {
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
