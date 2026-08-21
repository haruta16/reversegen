/**
 * 大型地形几何 — 对齐 LargeTerrainTileUtils 的边界/重叠语义（int 网格）。
 */

import { BOARD_TILE_UNIT, HALF_TILE_UNIT, MIN_DEPENDENCY_COVERAGE } from './types.js';
import type { BoardSpecialFootprint } from './types.js';

export interface IntRect {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

/** 普通牌边界（对齐 LargeTerrainTileUtils.GetBounds：TileUnit 网格，半格 = 5）。 */
export function tileBounds(posX: number, posY: number): IntRect {
  return {
    xMin: posX - HALF_TILE_UNIT,
    yMin: posY - HALF_TILE_UNIT,
    xMax: posX + HALF_TILE_UNIT,
    yMax: posY + HALF_TILE_UNIT,
  };
}

/** 大型地形边界：footprint × TileUnit，中心对齐。 */
export function boardSpecialBounds(posX: number, posY: number, footprint: BoardSpecialFootprint): IntRect {
  const halfWidth = (footprint.width * BOARD_TILE_UNIT) / 2;
  const halfHeight = (footprint.height * BOARD_TILE_UNIT) / 2;
  return { xMin: posX - halfWidth, yMin: posY - halfHeight, xMax: posX + halfWidth, yMax: posY + halfHeight };
}

/** 严格正面积相交（对齐 LargeTerrainTileUtils.Overlaps）。 */
export function overlaps(a: IntRect, b: IntRect): boolean {
  return a.xMin < b.xMax && a.xMax > b.xMin && a.yMin < b.yMax && a.yMax > b.yMin;
}

/** 交集。 */
export function intersection(a: IntRect, b: IntRect): IntRect {
  return {
    xMin: Math.max(a.xMin, b.xMin),
    yMin: Math.max(a.yMin, b.yMin),
    xMax: Math.max(a.xMin, b.xMin, Math.min(a.xMax, b.xMax)),
    yMax: Math.max(a.yMin, b.yMin, Math.min(a.yMax, b.yMax)),
  };
}

/** 交集面积。 */
export function overlapArea(a: IntRect, b: IntRect): number {
  const width = Math.max(0, Math.min(a.xMax, b.xMax) - Math.max(a.xMin, b.xMin));
  const height = Math.max(0, Math.min(a.yMax, b.yMax) - Math.max(a.yMin, b.yMin));
  return width * height;
}

/** 候选必须被至少一张上层牌以 ≥ 半格宽高覆盖（对齐 HasDependencyCoverage）。 */
export function hasDependencyCoverage(candidate: IntRect, covering: IntRect): boolean {
  const overlap = intersection(candidate, covering);
  return overlap.xMax - overlap.xMin >= MIN_DEPENDENCY_COVERAGE
    && overlap.yMax - overlap.yMin >= MIN_DEPENDENCY_COVERAGE;
}

/** 候选包围盒是否完整在容器内（对齐 BoardSpecialInsertionSystem.IsInside）。 */
export function isInside(bounds: IntRect, container: IntRect): boolean {
  return bounds.xMin >= container.xMin && bounds.xMax <= container.xMax
    && bounds.yMin >= container.yMin && bounds.yMax <= container.yMax;
}

/** 全部地形牌包围盒。 */
export function boundsOf(rects: IntRect[]): IntRect {
  const result: IntRect = { ...rects[0] };
  for (let i = 1; i < rects.length; i++) {
    result.xMin = Math.min(result.xMin, rects[i].xMin);
    result.yMin = Math.min(result.yMin, rects[i].yMin);
    result.xMax = Math.max(result.xMax, rects[i].xMax);
    result.yMax = Math.max(result.yMax, rects[i].yMax);
  }
  return result;
}

/** 稳定排序哈希（对齐 BoardSpecialPlacementSystem.StableOrder，unchecked int32）。 */
export function stableOrder(posX: number, posY: number, seed: number): number {
  return ((posX * 73856093) ^ (posY * 19349663) ^ seed) | 0;
}

/** 放置候选格点偏移（对齐 GetFootprintPlacementOffsets：中心相对源牌偏移 ±半格）。 */
export function footprintPlacementOffsets(): Array<[number, number]> {
  return [[-HALF_TILE_UNIT, -HALF_TILE_UNIT], [-HALF_TILE_UNIT, HALF_TILE_UNIT],
          [HALF_TILE_UNIT, -HALF_TILE_UNIT], [HALF_TILE_UNIT, HALF_TILE_UNIT]];
}
