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
  intersectSize,
} from '../src/triple-analyzer.js';
import { tripleKey, sortTriple } from '../src/types.js';

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
      const { levelId, levelsDir, terrainPath } = body as { levelId?: string; levelsDir?: string; terrainPath?: string };
      const path = resolveTerrainPath(levelId, levelsDir, terrainPath);
      if (!path) throw new Error('请提供关卡ID或文件路径');

      const terrain = loadTerrainFromFile(path);
      const allTiles = getAllTiles(terrain);
      const freeTiles = allTiles.filter(t => !t.isConst);
      const constTiles = allTiles.filter(t => t.isConst);

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
      const { levelId, levelsDir, terrainPath, terrainJson, forceRefresh } = body as {
        levelId?: string; levelsDir?: string; terrainPath?: string;
        terrainJson?: string; forceRefresh?: boolean;
      };
      const { topN, minSuccessors, maxEdgesPerNode, layerMin, layerMax, stratify, perLayer, layerMode } = body as {
        topN?: number; minSuccessors?: number; maxEdgesPerNode?: number;
        layerMin?: number; layerMax?: number; stratify?: boolean; perLayer?: number;
        layerMode?: string; // 'depSetQuantile' | 'dependencyDepth'
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
        const path = resolveTerrainPath(levelId, levelsDir, terrainPath);
        if (!path) throw new Error('请提供关卡ID、文件路径或地形JSON');
        terrain = loadTerrainFromFile(path);
      }

      // 计算或从缓存获取分析结果 (首次构建边用 generous 默认值)
      const cacheKey = `${terrain.levelHash || 'no-hash'}-${getAllTiles(terrain).filter(t => !t.isConst).length}`;
      let analysisResult = analysisCache.get(cacheKey);
      if (!analysisResult || forceRefresh) {
        analysisResult = analyzeTriples(terrain, {
          force: !!forceRefresh,
          edgeTopN: 6000,        // 预构建足够多的边，覆盖更多层
          maxEdgesPerNode: 20,
        });
        analysisCache.set(cacheKey, analysisResult);
      }

      // 过滤图数据
      const graphData = filterGraphData(analysisResult, {
        stratify: stratify ?? true,
        perLayer: perLayer ?? 80,
        topN: topN ?? 1000,
        minSuccessors: minSuccessors ?? 1,
        maxEdgesPerNode: maxEdgesPerNode ?? 15,
        layerMin,
        layerMax,
        layerMode: layerMode ?? 'depSetQuantile',
      });

      // 构建响应: 用 triple key 标识边（前端无需关心原始索引）
      const allTriples = analysisResult.triples;
      const graphTriples = graphData.nodeIndices.map(i => allTriples[i]);

      // 补充前驱边: 对每个显示节点，从它的 depSetTiles 枚举 C(n,3)，
      // 找到也在显示集合中的前驱 triple，补上存储边集中缺失的连线
      const displayedKeys = new Set(graphTriples.map(t => t.key));
      const edgeSet = new Set<string>(); // "fromKey|toKey"
      const allEdges: { from: string; to: string; overlap: number }[] = [];

      // 先加入存储的边
      for (const e of graphData.prerequisiteEdges) {
        const fk = allTriples[e.from].key, tk = allTriples[e.to].key;
        const sig = `${fk}|${tk}`;
        if (!edgeSet.has(sig)) {
          edgeSet.add(sig);
          allEdges.push({ from: fk, to: tk, overlap: e.overlap });
        }
      }

      // 对每个显示节点，从其 depSetTiles 枚举前驱
      for (const node of graphTriples) {
        const ds = node.depSetTiles; // 已排序
        const d = ds.length;
        if (d < 3) continue;
        const [at1, at2, at3] = node.tileIds;

        for (let a = 0; a < d - 2; a++) {
          const t1 = ds[a];
          if (t1 === at1 || t1 === at2 || t1 === at3) continue;
          for (let b = a + 1; b < d - 1; b++) {
            const t2 = ds[b];
            if (t2 === at1 || t2 === at2 || t2 === at3) continue;
            for (let c = b + 1; c < d; c++) {
              const t3 = ds[c];
              if (t3 === at1 || t3 === at2 || t3 === at3) continue;
              const predKey = tripleKey(sortTriple(t1, t2, t3));
              if (!displayedKeys.has(predKey)) continue;

              const sig = `${predKey}|${node.key}`;
              if (!edgeSet.has(sig)) {
                edgeSet.add(sig);
                // 找到前驱节点以计算 overlap
                const predNode = graphTriples.find(t => t.key === predKey);
                const overlap = predNode ? intersectSize(predNode.depSetTiles, ds) : 0;
                allEdges.push({ from: predKey, to: node.key, overlap });
              }
            }
          }
        }
      }

      json(res, {
        ok: true,
        terrainInfo: analysisResult.terrainInfo,
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
      const { tripleKey: tk, levelHash, freeTileCount } = body as {
        tripleKey?: string; levelHash?: string; freeTileCount?: number;
      };
      if (!tk) throw new Error('Missing tripleKey');

      // 从缓存中查找
      const cacheKey = `${levelHash || 'no-hash'}-${freeTileCount || 0}`;
      const analysisResult = analysisCache.get(cacheKey);
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
