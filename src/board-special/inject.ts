/**
 * 大型地形装载期注入 — 对齐 Unity LoadLevel 的
 * _resolveBoardSpecialMode / _resolveBoardSpecialRandomSeed / _insertPlannedBoardSpecials。
 *
 * 结构不是 Tile：仅记录 footprint/位置/依赖/覆盖，reversegen 不做层平移（解码与分配
 * 都发生在注入之前，层号只用于依赖/覆盖分层）。
 */

import { intersection, boardSpecialBounds, tileBounds, overlaps } from './geometry.js';
import type { BoardSpecialMode, BoardSpecialPlacement, BoardSpecialStructure } from './types.js';
import type { PlacementLayer, PlacementTile } from './placement.js';
import { buildPizzaPlan, buildStandardPlan, buildTicketPlan } from './placement.js';
import { MIN_DEPENDENCY_COVERAGE } from './types.js';

/** 模式解析（对齐 _resolveBoardSpecialMode：53 > 52 > 51 优先级，值仅为触发标记/订单参数）。 */
export function resolveBoardSpecialMode(config: ReadonlyMap<number, number> | undefined): BoardSpecialMode | null {
  if (!config) return null;
  if (config.has(53)) return 'ticket';
  if (config.has(52)) return 'pizza';
  if (config.has(51)) return 'standard';
  return null;
}

/** 稳定种子（对齐 BoardSpecialInsertionSystem.GetStableSeed：FNV-1a 32，不截高位）。 */
export function getStableBoardSpecialSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

/** 注入种子（对齐 _resolveBoardSpecialRandomSeed：显式种子 > replayCode FNV-1a > levelResId）。 */
export function resolveBoardSpecialSeed(
  explicitSeed: number | undefined,
  replayCode: string | undefined,
  levelResId: number | undefined,
): number {
  if (explicitSeed !== undefined) return explicitSeed | 0;
  if (replayCode) return getStableBoardSpecialSeed(replayCode);
  return levelResId ?? 0;
}

/** 从地形构造放置层视图（IsTerrain = 非初始 Dock 且非 51-53）。 */
export function buildPlacementLayers(
  layers: Array<{ layer: number; tiles: Array<{ id: number; posX: number; posY: number; extraEnum: number | undefined }> }>,
  initialDockTileIds: ReadonlySet<number> | undefined,
): PlacementLayer[] {
  const byLayer = new Map<number, PlacementTile[]>();
  for (const layer of layers) {
    for (const tile of layer.tiles) {
      const isBoardSpecial = tile.extraEnum === 51 || tile.extraEnum === 52 || tile.extraEnum === 53;
      if (!byLayer.has(layer.layer)) byLayer.set(layer.layer, []);
      byLayer.get(layer.layer)!.push({
        id: tile.id,
        layer: layer.layer,
        posX: tile.posX,
        posY: tile.posY,
        isInitialDock: initialDockTileIds?.has(tile.id) ?? false,
        isBoardSpecial,
      });
    }
  }
  return [...byLayer.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([layer, tiles], index) => ({ index, layer, tiles }));
}

/** 由放置计划生成运行时结构（依赖/覆盖计算对齐 _recalculateBoardSpecialDependencies）。 */
export function injectBoardSpecialStructures(
  plan: BoardSpecialPlacement[],
  extraEnum: number,
  placementLayers: PlacementLayer[],
  allTerrainTiles: Array<{ id: number; layer: number; posX: number; posY: number; extraEnum: number | undefined }>,
  startId: number,
): BoardSpecialStructure[] {
  const structures: BoardSpecialStructure[] = [];
  for (const placement of plan) {
    const sourceLayer = placementLayers[placement.sourceLayerIndex]?.layer ?? 0;
    const structureLayer = sourceLayer + 1; // 注入层 = 源层 + 1（不做层平移，仅用于分层比较）
    const footprint = placement.footprint;
    const bounds = boardSpecialBounds(placement.posX, placement.posY, footprint);

    // 依赖：下层牌（原层号 < structureLayer，即 ≤ 源层），覆盖面积 ≥ 半格宽高
    const dependencies: number[] = [];
    // 覆盖：更高层牌（注入后平移到 structureLayer 之上，即原层号 ≥ structureLayer），正面积相交
    const coveredTileIds: number[] = [];
    for (const tile of allTerrainTiles) {
      const tileBounds_ = tileBounds(tile.posX, tile.posY);
      if (tile.layer < structureLayer) {
        const overlap = intersection(bounds, tileBounds_);
        if (overlap.xMax - overlap.xMin >= MIN_DEPENDENCY_COVERAGE
          && overlap.yMax - overlap.yMin >= MIN_DEPENDENCY_COVERAGE) {
          dependencies.push(tile.id);
        }
      } else if (tile.layer >= structureLayer && overlaps(bounds, tileBounds_)) {
        coveredTileIds.push(tile.id);
      }
    }
    dependencies.sort((a, b) => a - b);
    coveredTileIds.sort((a, b) => a - b);

    structures.push({
      id: startId++,
      extraEnum,
      footprint,
      layer: structureLayer,
      posX: placement.posX,
      posY: placement.posY,
      dependencies,
      coveredTileIds,
      isRemoved: false,
    });
  }
  return structures;
}

/**
 * 装载期注入入口：模式 → 放置计划 → 结构。
 * boardBounds 来自地形的 LevelWidth/LevelHeight（0/缺省时回退到地形包围盒）。
 */
export function injectBoardSpecials(
  mode: BoardSpecialMode,
  seed: number,
  placementLayers: PlacementLayer[],
  boardBounds: { width: number; height: number },
  allTerrainTiles: Array<{ id: number; layer: number; posX: number; posY: number; extraEnum: number | undefined }>,
  maxTileId: number,
): BoardSpecialStructure[] {
  const effectiveTerrainLayerCount = placementLayers.filter(layer =>
    layer.tiles.some(t => !t.isInitialDock && !t.isBoardSpecial)).length;
  const bounds = { xMin: 0, yMin: 0, xMax: boardBounds.width, yMax: boardBounds.height };

  const plan: BoardSpecialPlacement[] = mode === 'standard'
    ? buildStandardPlan(placementLayers, effectiveTerrainLayerCount, seed)
    : mode === 'pizza'
      ? buildPizzaPlan(placementLayers, bounds, seed)
      : buildTicketPlan(placementLayers, bounds, seed);

  if (plan.length === 0) return [];
  const extraEnum = mode === 'standard' ? 51 : mode === 'pizza' ? 52 : 53;
  return injectBoardSpecialStructures(plan, extraEnum, placementLayers, allTerrainTiles, maxTileId + 1);
}
