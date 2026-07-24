/**
 * 地形加载器 — 读取 Unity 关卡 JSON 文件并转换为算法可用的最小数据模型。
 * 支持原始 Unity level JSON 格式和简化格式。
 */

import { readFileSync } from 'node:fs';
import type {
  FallingTerrainStructure,
  TerrainTile,
  TerrainLayer,
  TerrainData,
  TerrainStructure,
  TransferTerrainStructure,
} from './types.js';
import { logger } from './logger.js';

/**
 * 从 JSON 文件加载地形数据。
 */
export function loadTerrainFromFile(filePath: string): TerrainData {
  const raw = readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  return loadTerrainFromJson(raw);
}

/** 从 JSON 字符串解析地形。 */
export function loadTerrainFromJson(json: string): TerrainData {
  const data = JSON.parse(json.replace(/^\uFEFF/, ''));
  return normalizeTerrain(data);
}

/**
 * 将原始 JSON 数据标准化为 TerrainData 格式。
 * 兼容 Unity 原始格式和简化格式。
 */
function normalizeTerrain(raw: Record<string, unknown>): TerrainData {
  const layers: TerrainLayer[] = [];

  if (Array.isArray(raw.layers)) {
    for (const layerRaw of raw.layers as Array<Record<string, unknown>>) {
      const tiles: TerrainTile[] = [];
      if (Array.isArray(layerRaw.tiles)) {
        for (const t of layerRaw.tiles as Array<Record<string, unknown>>) {
          tiles.push(normalizeTile(t));
        }
      }
      layers.push({ tiles });
    }
  }

  const terrainStructures = normalizeTerrainStructures(raw.terrainStructures);

  return {
    levelResId: raw.levelResId as number | undefined,
    levelHash: (raw.LevelHash || raw.levelHash || '') as string,
    layers,
    terrainStructures,
    LevelWidth: raw.LevelWidth as number | undefined,
    LevelHeight: raw.LevelHeight as number | undefined,
    elementsPerLevel: raw.elementsPerLevel as number | undefined,
  };
}

function normalizeTerrainStructures(raw: unknown): TerrainStructure[] {
  if (!Array.isArray(raw)) return [];
  const structures: TerrainStructure[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const source = entry as Record<string, unknown>;
    const type = String(source.type ?? '').trim().toLowerCase();
    if (type !== 'transfer' && type !== 'falling') continue;
    const tileIds = Array.isArray(source.tileIds)
      ? source.tileIds.map(Number).filter(Number.isInteger)
      : [];
    const common = {
      type,
      id: Number.isInteger(Number(source.id)) ? Number(source.id) : undefined,
      tileIds,
      tileNum: Number.isInteger(Number(source.tileNum)) ? Number(source.tileNum) : undefined,
    };
    if (type === 'transfer') {
      structures.push(common as TransferTerrainStructure);
    } else {
      structures.push({
        ...common,
        type: 'falling',
        viewLength: Number(source.viewLength),
      } as FallingTerrainStructure);
    }
  }
  return structures;
}

/** 将单张牌的原始 JSON 标准化为 TerrainTile */
function normalizeTile(raw: Record<string, unknown>): TerrainTile {
  return {
    id: (raw.ID ?? raw.id ?? 0) as number,
    layer: (raw.Layer ?? raw.layer ?? 0) as number,
    dependencies: Array.isArray(raw.Dependencies ?? raw.dependencies)
      ? (raw.Dependencies ?? raw.dependencies) as number[]
      : [],
    isConst: (raw.IsConst ?? raw.isConst ?? false) as boolean,
    constElementValue: (raw.ConstElementValue ?? raw.constElementValue ?? 0) as number,
    posX: (raw.PosX ?? raw.posX ?? 0) as number,
    posY: (raw.PosY ?? raw.posY ?? 0) as number,
  };
}

/** 获取地形中的所有牌（平铺为数组） */
export function getAllTiles(terrain: TerrainData): TerrainTile[] {
  const tiles: TerrainTile[] = [];
  for (const layer of terrain.layers) {
    tiles.push(...layer.tiles);
  }
  return tiles;
}

/**
 * 获取固定花色的牌（isConst 且 constElementValue > 0）。
 * 这些牌不参与算法分配，但需要在 ReplayCode 中保留原始花色。
 */
export function getConstTiles(terrain: TerrainData): TerrainTile[] {
  return getAllTiles(terrain).filter(t => t.isConst && t.constElementValue > 0);
}

/** 在控制台打印地形摘要信息 */
export function printTerrainSummary(terrain: TerrainData): void {
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(t => !t.isConst);
  const constTiles = allTiles.filter(t => t.isConst);

  logger.info('── 地形摘要 ──');
  logger.info(`  关卡: ${terrain.levelResId ?? 'N/A'}`);
  logger.info(`  Hash: ${terrain.levelHash || '(无)'}`);
  logger.info(`  层数: ${terrain.layers.length}`);
  logger.info(`  总牌数: ${allTiles.length}`);
  logger.info(`  自由牌: ${freeTiles.length} (${freeTiles.length / 3} 步)`);
  logger.info(`  固定牌: ${constTiles.length}`);
  if (constTiles.length > 0) {
    const constValues = [...new Set(constTiles.map(t => t.constElementValue))].sort((a, b) => a - b);
    logger.info(`  固定花色值: [${constValues.join(', ')}]`);
  }
  logger.info(`  尺寸: ${terrain.LevelWidth ?? '?'}×${terrain.LevelHeight ?? '?'}`);
}
