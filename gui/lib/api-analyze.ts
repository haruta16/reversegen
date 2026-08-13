/**
 * GUI 分析类 API：triple 关系分析、triple 详情、tile DAG、
 * 消除计划与 DFS 可解性验证。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  loadTerrainFromFile,
  getAllTiles,
  getCanonicalTileOrder,
  decodeFromString,
  computeAllDependencies,
} from '../../src/index.js';
import { OfflineGame, solveDFS, solveDeathCheckpoint, OfflineTile } from '../../src/solver/index.js';
import { analyzeTriples, filterGraphData, getTripleDetail } from '../../tools/dag/triple-analyzer.js';
import { buildEliminationPlan } from '../../tools/planning/elimination-plan.js';
import {
  PROJECT_ROOT,
  cacheGet,
  cacheSet,
  defaultLevelsDir,
  findTerrainByLevelHash,
  resolveTerrainPath,
  json,
  parseBody,
} from './runtime.js';

export async function handleAnalyzeTriples(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/analyze-triples' || req.method !== 'POST') return false;
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
        const tmpDir = join(PROJECT_ROOT, '.reversegen-cache');
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
    return true;
  }

export async function handleTripleDetail(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/triple-detail' || req.method !== 'POST') return false;
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
    return true;
  }

export async function handleTileDag(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/tile-dag' || req.method !== 'POST') return false;
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
    return true;
  }

export async function handleEliminationPlan(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/elimination-plan' || req.method !== 'POST') return false;
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
    return true;
  }

export async function handleDfsVerify(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/dfs-verify' || req.method !== 'POST') return false;
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

      const game = new OfflineGame(offlineTiles, terrain.terrainStructures);
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
    return true;
  }
