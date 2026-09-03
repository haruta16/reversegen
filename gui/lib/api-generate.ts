/**
 * GUI 生成类 API：外部生成接口、地形加载/上传、四算法生成、
 * ReplayCode 解码、闭合率/参数/costLog 回放分析。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename } from 'node:path';
import {
  generateBoard,
  generateBoardLayerClosure,
  generateBoardTileExplorer,
  generateBoardZenMatch,
  loadTerrainFromFile,
  getAllTiles,
  getCanonicalTileOrder,
  decodeFromString,
  formatHash,
  computeDependencyDepth,
  computeAllDependencies,
  runPureGreedySimulation,
  computeMetrics,
  computeTileDepSets,
  computeCloseRatesFromAssignments,
  buildGenerationLogicalLayers,
  parseMechanicCounts,
  countTerrainExtras,
  validateMechanicCounts,
  MECHANICS,
  MECHANIC_SEED_SALTS,
} from '../../src/index.js';
import type { TerrainTile } from '../../src/index.js';
import { generateReplayFromExternalInput } from '../../src/external-generation.js';
import { MAX_DOCK_SLOTS } from '../../src/constants.js';
import {
  defaultLevelsDir,
  findTerrainByLevelHash,
  listLevels,
  resolveTerrainPath,
  storeUploadedTerrain,
  json,
  parseBody,
} from './runtime.js';

/** 机制注册表（前端校验/帮助文案用）。 */
export async function handleMechanics(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/mechanics' || req.method !== 'GET') return false;
  json(res, {
    ok: true,
    mechanics: Object.values(MECHANICS),
    salts: MECHANIC_SEED_SALTS,
  });
  return true;
}

export async function handleExternalGenerateReplay(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/v1/generate-replay' || req.method !== 'POST') return false;
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
    return true;
  }

export async function handleLevels(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/levels' || req.method !== 'GET') return false;
    const dir = url.searchParams.get('dir') || defaultLevelsDir;
    json(res, { ok: true, dir, levels: listLevels(dir) });
    return true;
  }

export async function handleTerrainUpload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/terrain-upload' || req.method !== 'POST') return false;
    const body = await parseBody(req);
    try {
      const { fileName, terrainJson, bodyError } = body as { fileName?: string; terrainJson?: string; bodyError?: string };
      if (bodyError) throw new Error(bodyError);
      if (!fileName || typeof terrainJson !== 'string') throw new Error('缺少地形文件名或内容');
      const resolvedPath = storeUploadedTerrain(fileName, terrainJson);
      json(res, { ok: true, fileName: basename(fileName), resolvedPath });
    } catch (err) { json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 400); }
    return true;
  }

export async function handleTerrainInfo(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/terrain-info' || req.method !== 'POST') return false;
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
      const logicalTerrain = buildGenerationLogicalLayers(terrain);
      const freeOnly = allTiles.filter(t => !t.isConst);
      const maxDepth = logicalTerrain.layers.length;
      const tilesPerDepth = logicalTerrain.layers.map(
        layer => layer.filter(tile => !tile.isConst).length,
      );

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
        // 特殊机制：地形 tile 里写着的挂件（来源 1）
        extras: [...countTerrainExtras(allTiles).entries()].sort((a, b) => a[0] - b[0])
          .map(([extraEnum, count]) => ({ extraEnum, count })),
        // LayerClosure 深度信息
        depthCount: maxDepth,
        tilesPerDepth,
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return true;
  }

export async function handleGenerate(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/generate' || req.method !== 'POST') return false;
    const body = await parseBody(req);
    try {
      const {
        algorithm,
        costArray, colorCount, // CostLadder params
        closeRates, dock, spreadParam, debtPersistenceWeight, debtPersistenceLayers, // LayerClosure params
        colorAllocationMode, colorAllocationMaxRatio,        // LayerClosure
        teStrategy, difficulty, sequenceSeed, placementSeed, placementRandomState, typeCycle, typeWeights,
        easyLayerCount, hardTag, limitFullFirst, lowerCoefficient, topCoefficient,
        fallbackExtraLayers, solvabilityRandomMode, colorGradientTypeGroups,
        zenStrategy, seed,
        checkpointPosition, checkpointCount, minCheckpointSpan,
        levelId, levelsDir, terrainPath, levelHash,
        mechanics,
      } = body as {
        algorithm?: string;
        costArray?: string; colorCount?: string;           // CostLadder
        closeRates?: string; dock?: string; spreadParam?: string; // LayerClosure
        debtPersistenceWeight?: string;                    // LayerClosure 旧版兼容
        debtPersistenceLayers?: string;                    // LayerClosure 新版：最大跨层数
        colorAllocationMode?: string;                      // LayerClosure
        colorAllocationMaxRatio?: string;                  // LayerClosure
        teStrategy?: string; difficulty?: string; sequenceSeed?: string; placementSeed?: string;
        placementRandomState?: string | import('../../src/index.js').DotNetRandomState;
        typeCycle?: string; typeWeights?: string; easyLayerCount?: string; hardTag?: string;
        limitFullFirst?: string | boolean; lowerCoefficient?: string; topCoefficient?: string;
        fallbackExtraLayers?: string; solvabilityRandomMode?: string | boolean; colorGradientTypeGroups?: string;
        zenStrategy?: string; seed?: string;
        levelId?: string; levelsDir?: string; terrainPath?: string; levelHash?: string;
        /** 特殊机制（enum:count 文本，如 "31:3,39:2"），外部注入来源 */
        mechanics?: string;
      };

      const path = resolveTerrainPath(levelId, levelsDir, terrainPath);
      if (!path) {
        json(res, { ok: false, error: '请提供关卡ID或文件路径' }, 400);
        return true;
      }
      const terrain = loadTerrainFromFile(path);
      const allTiles = getAllTiles(terrain);

      // ── 特殊机制：外部注入（enum:count）与地形摆放（tile.extraEnum）两个来源 ──
      const mechanicsText = typeof mechanics === 'string' ? mechanics.trim() : '';
      const requestedMechanics = mechanicsText ? parseMechanicCounts(mechanicsText) : new Map<number, number>();
      const terrainExtras = countTerrainExtras(allTiles);
      const mechanicsErrors = validateMechanicCounts(requestedMechanics);
      if (mechanicsErrors.length > 0) {
        json(res, { ok: false, error: `机制配置无效: ${mechanicsErrors.map(e => e.message).join('; ')}` }, 400);
        return true;
      }
      const mechanicsSummary = {
        requested: mechanicsText || null,
        requestedCounts: Object.fromEntries(requestedMechanics),
        terrainExtras: Object.fromEntries(terrainExtras),
        errors: mechanicsErrors,
      };

      if (algorithm === 'zen-match') {
        const k = Number(colorCount || '5');
        const resolvedSeed = Number(seed || '0');
        const resolvedStrategy = Number(zenStrategy || '4');
        if (!Number.isInteger(k) || k < 1 || k > 64) {
          throw new Error('Zen Match 花色数必须是 1-64 的整数');
        }
        if (!Number.isInteger(resolvedSeed)) throw new Error('Zen Match Seed 必须是整数');
        if (resolvedStrategy !== 4 && resolvedStrategy !== 5) {
          throw new Error('Zen Match 策略必须是 4 或 5');
        }
        const result = generateBoardZenMatch({
          terrain,
          uniqueCount: k,
          seed: resolvedSeed,
          strategy: resolvedStrategy,
          levelHash,
        });
        const ordered = getCanonicalTileOrder(allTiles);
        const tileSummary = ordered.map((tile, index) => ({
          index,
          id: tile.id,
          layer: tile.layer,
          isConst: tile.isConst,
          element: result.assignments.get(tile.id) ?? tile.constElementValue ?? 0,
        }));
        json(res, {
          ok: true,
          algorithm: 'zen-match',
          levelResId: terrain.levelResId,
          replayCode: result.replayCode,
          elementCount: decodeFromString(result.replayCode)?.elementCount ?? result.actualColorCount,
          levelHash: result.levelHash,
          assignments: Object.fromEntries(result.assignments),
          abstractAssignments: Object.fromEntries(result.abstractAssignments),
          topMatchTileIds: result.topMatchTileIds,
          strategy: result.strategy,
          seed: result.seed,
          requestedUniqueCount: result.requestedUniqueCount,
          actualColorCount: result.actualColorCount,
          colorCount: k,
          metrics: {
            colorCount: result.actualColorCount,
            topMatchCount: result.topMatchTileIds.length,
            strategy: result.strategy,
          },
          mechanics: mechanicsSummary,
          terrainSummary: {
            layers: terrain.layers.length,
            totalTiles: allTiles.length,
            freeTiles: allTiles.filter(tile => !tile.isConst).length,
            constTiles: allTiles.filter(tile => tile.isConst).length,
            source: basename(path),
          },
          tiles: tileSummary,
        });
      } else if (algorithm === 'tile-explorer') {
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
        const strategy = (teStrategy || 'default') as import('../../src/index.js').TileExplorerStrategy;
        const isSolvability = strategy.startsWith('solvability_coefficient');
        const isLimit = strategy === 'limit_layer_random';
        const isGradient = strategy === 'color_gradient';
        const randomState = typeof placementRandomState === 'string'
          ? (placementRandomState.trim()
              ? JSON.parse(placementRandomState) as import('../../src/index.js').DotNetRandomState
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
          mechanics: mechanicsSummary,
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
          return true;
        }
        const rates = closeRates.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
        if (rates.length === 0 || rates.some(r => r < 0 || r > 1)) {
          json(res, { ok: false, error: '闭合率格式无效，需为 0-1 之间的数字' }, 400);
          return true;
        }

                const dk = parseInt(dock || '7', 10) || 7;
        const sp = parseFloat(spreadParam || '0.5');
        const spread = isNaN(sp) ? 0.5 : Math.max(0, Math.min(1, sp));
        const dpRaw = parseFloat(debtPersistenceWeight || '0');
        const dp = isNaN(dpRaw) ? 0 : Math.max(0, Math.min(1, dpRaw));
        const layerRaw = debtPersistenceLayers == null || String(debtPersistenceLayers).trim() === ''
          ? undefined
          : Number(debtPersistenceLayers);
        const depthCount = buildGenerationLogicalLayers(terrain).layers.length;
        if (layerRaw != null && (!Number.isInteger(layerRaw) || layerRaw < 0 || layerRaw > Math.max(0, depthCount - 1))) {
          throw new Error(`债务跨层上限必须是 0-${Math.max(0, depthCount - 1)} 的整数`);
        }

        const allocMode = (colorAllocationMode === 'single-heavy' ? 'single-heavy' : 'balanced') as import('../../src/types.js').ColorAllocationMode;
        const allocRatioRaw = parseFloat(colorAllocationMaxRatio || '1');
        const allocRatio = isNaN(allocRatioRaw) ? 1 : Math.max(0.01, Math.min(1, allocRatioRaw));
        const result = generateBoardLayerClosure({
          terrain, closeRates: rates, colorCount: k,
          dock: dk, levelHash, spreadParam: spread,
          debtPersistenceWeight: layerRaw == null ? dp : undefined,
          debtPersistenceLayers: layerRaw,
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
          mechanics: mechanicsSummary,
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
          return true;
        }

        const costs = costArray.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
        if (costs.length === 0 || costs.some(c => c < 1)) {
          json(res, { ok: false, error: 'Cost 数组格式无效' }, 400);
          return true;
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
          mechanics: mechanicsSummary,
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
    return true;
  }

export async function handleDecode(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/decode' || req.method !== 'POST') return false;
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
    return true;
  }

export async function handleReplayClosure(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/replay-closure' || req.method !== 'POST') return false;
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
      const dock = MAX_DOCK_SLOTS; // 默认 dock 容量

      const metrics = computeMetrics({
        assignments: elemMap,
        tiles: freeOnly,        // 与生成路径一致：传自由牌，不含固定牌
        depthLayers,
        depthMap,
        tileMap: allTileMap,
        tileDepSets,
        dock,
        colorCount,
        actualCloseRates: layerClosureRates,
        debtPersistenceWeight: 0, // 导入路径无配置，回显 0
      });

      json(res, {
        ok: true,
        levelHash: terrain.levelHash || '',
        metrics,
        totalFreeTiles: freeOnly.length,
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return true;
  }

export async function handleReplayParams(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/replay-params' || req.method !== 'POST') return false;
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
    return true;
  }

export async function handleReplayCostlog(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/replay-costlog' || req.method !== 'POST') return false;
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
    return true;
  }
