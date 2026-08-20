/**
 * 大型地形放置计划 — Unity BoardSpecialPlacementSystem 的逐位移植。
 *
 * 三种计划（对齐 LoadLevel 的调用）：
 *  - Build（51 standard）：targetCount = max(2, 有效层数)，minimumCount = 2，
 *    allowSharedLayer = 层数 < 2，footprint 2/3 交替；
 *  - BuildPizza（52）：Random(seed ^ 0x52)，按牌数选择插入层，footprint 2/3 交替；
 *  - BuildTicket（53）：Random(seed ^ 0x53)，首/末/中间层各一个 3×2，不足整组取消。
 */

import { DotNetRandom } from '../tile-explorer/random.js';
import {
  boardSpecialBounds,
  boundsOf,
  footprintPlacementOffsets,
  hasDependencyCoverage,
  intersection,
  isInside,
  overlaps,
  overlapArea,
  stableOrder,
  tileBounds,
  type IntRect,
} from './geometry.js';
import { BOARD_TILE_UNIT, HALF_TILE_UNIT } from './types.js';
import type { BoardSpecialFootprint, BoardSpecialPlacement } from './types.js';

/** 参与放置计算的地形牌视图。 */
export interface PlacementTile {
  id: number;
  layer: number;
  posX: number;
  posY: number;
  /** 初始 Dock 牌（originalPile==1）不参与 */
  isInitialDock: boolean;
  /** 51-53 棋盘特殊物不参与 */
  isBoardSpecial: boolean;
}

export interface PlacementLayer {
  /** 该层在原始层数组中的下标（sources 是过滤视图，Placement 必须携带原始索引） */
  index: number;
  layer: number;
  tiles: PlacementTile[];
}

function isTerrain(tile: PlacementTile): boolean {
  return !tile.isInitialDock && !tile.isBoardSpecial;
}

/** 相邻实际层中中心坐标距离恰为 1 的 Tower 链对（对齐 TowerPairs）。 */
interface TowerPair {
  upperId: number;
  lowerId: number;
  upperLayer: number;
  lowerLayer: number;
  upperPosX: number;
  upperPosY: number;
  lowerPosX: number;
  lowerPosY: number;
  bounds: IntRect;
}

/** 判断牌是否正是当前 Tower 对的成员（对齐 TowerPair.Contains）。 */
function towerPairContains(pair: TowerPair, tile: PlacementTile): boolean {
  return (tile.layer === pair.upperLayer && tile.posX === pair.upperPosX && tile.posY === pair.upperPosY)
    || (tile.layer === pair.lowerLayer && tile.posX === pair.lowerPosX && tile.posY === pair.lowerPosY);
}

function towerPairs(sources: PlacementLayer[]): TowerPair[] {
  const layers = sources.map(layer => layer.tiles.filter(isTerrain)).filter(tiles => tiles.length > 0);
  const result: TowerPair[] = [];
  if (layers.length < 2) return result;
  for (let i = 0; i < layers.length - 1; i++) {
    for (const upper of layers[i]) {
      for (const lower of layers[i + 1]) {
        if (lower.layer === upper.layer + 1
          && Math.abs(upper.posX - lower.posX) + Math.abs(upper.posY - lower.posY) === 1) {
          const upperBounds = tileBounds(upper.posX, upper.posY);
          const lowerBounds = tileBounds(lower.posX, lower.posY);
          const bounds: IntRect = {
            xMin: Math.min(upperBounds.xMin, lowerBounds.xMin),
            yMin: Math.min(upperBounds.yMin, lowerBounds.yMin),
            xMax: Math.max(upperBounds.xMax, lowerBounds.xMax),
            yMax: Math.max(upperBounds.yMax, lowerBounds.yMax),
          };
          result.push({
            upperId: upper.id, lowerId: lower.id,
            upperLayer: upper.layer, lowerLayer: lower.layer,
            upperPosX: upper.posX, upperPosY: upper.posY,
            lowerPosX: lower.posX, lowerPosY: lower.posY,
            bounds,
          });
        }
      }
    }
  }
  return result;
}

function removeTowerOnlyLayers(sources: PlacementLayer[], towers: TowerPair[]): PlacementLayer[] {
  return sources.filter(layer => layer.tiles.some(t => isTerrain(t) && !towers.some(pair => towerPairContains(pair, t))));
}

/** 候选（footprint 2/3 × 源牌 ± 半格偏移，去重）。 */
function candidates(
  sourceTiles: PlacementTile[],
  boardBounds: IntRect,
  towers: IntRect[],
  coveringTiles?: PlacementTile[],
): Array<{ footprint: number; posX: number; posY: number }> {
  const coveringBounds = coveringTiles?.map(t => tileBounds(t.posX, t.posY));
  const seen = new Set<string>();
  const result: Array<{ footprint: number; posX: number; posY: number }> = [];
  for (const tile of sourceTiles) {
    for (const footprint of [2, 3]) {
      for (const [dx, dy] of footprintPlacementOffsets()) {
        const posX = tile.posX + dx;
        const posY = tile.posY + dy;
        const key = `${footprint}:${posX},${posY}`;
        if (seen.has(key)) continue;
        const candidateBounds = boardSpecialBounds(posX, posY, { width: footprint, height: footprint });
        if (!isInside(candidateBounds, boardBounds)) continue;
        if (towers.some(b => overlaps(candidateBounds, b))) continue;
        if (!hasVisibleArea(candidateBounds, coveringBounds)) continue;
        seen.add(key);
        result.push({ footprint, posX, posY });
      }
    }
  }
  return result;
}

/** 候选至少露出 1/4 牌面积（对齐 HasVisibleArea 的逐点扫描语义）。 */
function hasVisibleArea(candidate: IntRect, covering: IntRect[] | undefined): boolean {
  if (!covering || covering.length === 0) return true;
  const requiredArea = (BOARD_TILE_UNIT * BOARD_TILE_UNIT) / 4;
  let visible = 0;
  for (let x = candidate.xMin; x < candidate.xMax; x++) {
    for (let y = candidate.yMin; y < candidate.yMax; y++) {
      // RectInt.Contains 语义：xMin <= p < xMax
      if (covering.some(b => x >= b.xMin && x < b.xMax && y >= b.yMin && y < b.yMax)) continue;
      if (++visible >= requiredArea) return true;
    }
  }
  return false;
}

function selectPreferred(
  sources: PlacementLayer[],
  bounds: IntRect,
  towers: IntRect[],
  targetCount: number,
  minimumCount: number,
  allowSharedLayer: boolean,
  seed: number,
): BoardSpecialPlacement[] {
  const options: Array<{ sourceIndex: number; footprint: number; posX: number; posY: number }> = [];
  sources.forEach((source, index) => {
    const covering = sources.slice(0, index + 1).flatMap(layer => layer.tiles).filter(isTerrain);
    for (const candidate of candidates(source.tiles.filter(isTerrain), bounds, towers, covering)) {
      options.push({ sourceIndex: source.index, ...candidate });
    }
  });
  options.sort((a, b) => stableOrder(a.posX, a.posY, seed) - stableOrder(b.posX, b.posY, seed));

  let best: BoardSpecialPlacement[] = [];
  for (const seedOption of options.filter(o => o.footprint === 2)) {
    const selected: BoardSpecialPlacement[] = [toPlacement(seedOption)];
    while (selected.length < targetCount) {
      const requiredFootprint = selected.length % 2 === 0 ? 2 : 3;
      const compatible = options
        .filter(o => o.footprint === requiredFootprint && isCompatible(o, selected, allowSharedLayer, false))
        .sort((a, b) => minimumDistanceSquared(b, selected) - minimumDistanceSquared(a, selected));
      if (compatible.length === 0) break;
      selected.push(toPlacement(compatible[0]));
    }
    if (selected.length > best.length) best = selected;
    if (best.length >= targetCount) break;
  }

  while (best.length < minimumCount) {
    const requiredFootprint = best.length % 2 === 0 ? 2 : 3;
    const fallback = options
      .filter(o => o.footprint === requiredFootprint && isCompatible(o, best, allowSharedLayer, true))
      .sort((a, b) =>
        totalOverlapArea(b, best) - totalOverlapArea(a, best)
        || minimumDistanceSquared(b, best) - minimumDistanceSquared(a, best));
    if (fallback.length === 0) break;
    best.push(toPlacement(fallback[0]));
  }
  return best;
}

function toPlacement(option: { sourceIndex: number; footprint: number; posX: number; posY: number }): BoardSpecialPlacement {
  return {
    sourceLayerIndex: option.sourceIndex,
    footprint: { width: option.footprint, height: option.footprint },
    posX: option.posX,
    posY: option.posY,
  };
}

function isCompatible(
  option: { sourceIndex: number; footprint: number; posX: number; posY: number },
  selected: BoardSpecialPlacement[],
  allowSharedLayer: boolean,
  allowOverlap: boolean,
): boolean {
  if (!allowSharedLayer && selected.some(item => item.sourceLayerIndex === option.sourceIndex)) return false;
  if (selected.some(item =>
    item.posX === option.posX && item.posY === option.posY
    && item.footprint.width === option.footprint && item.footprint.height === option.footprint)) return false;
  if (allowOverlap) return true;
  const optionBounds = boardSpecialBounds(option.posX, option.posY, { width: option.footprint, height: option.footprint });
  return selected.every(item => !overlaps(optionBounds, boardSpecialBounds(item.posX, item.posY, item.footprint)));
}

function totalOverlapArea(option: { footprint: number; posX: number; posY: number }, selected: BoardSpecialPlacement[]): number {
  const bounds = boardSpecialBounds(option.posX, option.posY, { width: option.footprint, height: option.footprint });
  return selected.reduce((sum, item) =>
    sum + overlapArea(bounds, boardSpecialBounds(item.posX, item.posY, item.footprint)), 0);
}

function minimumDistanceSquared(option: { posX: number; posY: number }, selected: BoardSpecialPlacement[]): number {
  if (selected.length === 0) return Number.MAX_SAFE_INTEGER;
  return selected.reduce((min, item) => {
    const dx = option.posX - item.posX;
    const dy = option.posY - item.posY;
    return Math.min(min, dx * dx + dy * dy);
  }, Number.MAX_SAFE_INTEGER);
}

function selectInsertionLayers(
  sources: PlacementLayer[],
  terrainLayers: PlacementLayer[],
  random: DotNetRandom,
): number[] {
  const tileCount = terrainLayers.reduce((sum, layer) => sum + layer.tiles.filter(isTerrain).length, 0);
  const tileLimit = tileCount < 61 ? 3 : tileCount < 72 ? 4 : 5;
  const targetCount = Math.min(sources.length, tileLimit, 5);
  const candidatesPool = Array.from({ length: Math.max(0, sources.length - 1) }, (_, i) => i);
  for (let i = candidatesPool.length - 1; i > 0; i--) {
    const other = random.next(i + 1);
    [candidatesPool[i], candidatesPool[other]] = [candidatesPool[other], candidatesPool[i]];
  }
  const selected = candidatesPool.slice(0, Math.max(0, targetCount - 1));
  selected.push(sources.length - 1);
  selected.sort((a, b) => a - b);
  return selected;
}

function buildLayerPlan(
  sources: PlacementLayer[],
  boardBounds: IntRect,
  towers: TowerPair[],
  layerCounts: number[],
  getFootprint: (layerIndex: number) => BoardSpecialFootprint,
  random: DotNetRandom,
  allTerrainLayers: PlacementLayer[] | null,
  excludeTowerMembers: boolean,
  useAllEarlierLayersForCoverage: boolean,
  requiredCount: number,
  retryTowardLaterLayer: boolean,
): BoardSpecialPlacement[] {
  const result: BoardSpecialPlacement[] = [];
  let failedCount = 0;
  const allTerrainTiles = allTerrainLayers?.flatMap(layer => layer.tiles).filter(isTerrain);
  const allTowerMemberBounds = allTerrainTiles
    ?.filter(tile => towers.some(pair => towerPairContains(pair, tile)))
    .map(tile => tileBounds(tile.posX, tile.posY));
  const layerOrder = retryTowardLaterLayer
    ? Array.from({ length: sources.length }, (_, i) => i)
    : Array.from({ length: sources.length }, (_, i) => sources.length - 1 - i);

  for (const layerIndex of layerOrder) {
    const targetCount = failedCount + (layerCounts[layerIndex] ?? 0);
    if (targetCount === 0) continue;
    const footprint = getFootprint(layerIndex);
    const sourceTiles = sources[layerIndex].tiles.filter(isTerrain);
    const sourceLayer = sourceTiles[0].layer;
    const blockedTowers = excludeTowerMembers && allTowerMemberBounds
      ? allTowerMemberBounds
      : towers.filter(pair => pair.upperLayer === sourceLayer).map(pair => pair.bounds);

    let coveringTiles = sourceTiles;
    if (excludeTowerMembers) {
      coveringTiles = useAllEarlierLayersForCoverage
        ? (allTerrainTiles ?? sourceTiles).filter(tile =>
            tile.layer <= sourceLayer && !towers.some(pair => towerPairContains(pair, tile)))
        : sourceTiles.filter(tile => !towers.some(pair => towerPairContains(pair, tile)));
    }
    const centeredPositions = new Set(coveringTiles.map(t => `${t.posX},${t.posY}`));
    const candidatePositions = legalGridCandidates(coveringTiles, boardBounds, blockedTowers, footprint);
    failedCount = targetCount;

    if (requiredCount > 0) {
      const selectedPositions = selectMaximumCandidates(candidatePositions, footprint, targetCount, random, centeredPositions);
      for (const pos of selectedPositions) {
        result.push({ sourceLayerIndex: sources[layerIndex].index, footprint, posX: pos[0], posY: pos[1] });
      }
      failedCount -= selectedPositions.length;
      continue;
    }

    while (failedCount > 0 && candidatePositions.length > 0) {
      const centered = candidatePositions.filter(pos => centeredPositions.has(`${pos[0]},${pos[1]}`));
      const pool = centered.length > 0 ? centered : candidatePositions;
      const selected = pool[random.next(pool.length)];
      result.push({ sourceLayerIndex: sources[layerIndex].index, footprint, posX: selected[0], posY: selected[1] });
      const selectedBounds = boardSpecialBounds(selected[0], selected[1], footprint);
      for (let i = candidatePositions.length - 1; i >= 0; i--) {
        if (overlaps(boardSpecialBounds(candidatePositions[i][0], candidatePositions[i][1], footprint), selectedBounds)) {
          candidatePositions.splice(i, 1);
        }
      }
      failedCount--;
    }
  }
  return requiredCount > 0 && result.length < requiredCount ? [] : result;
}

/** 步长为半格的合法格点，必须被某张覆盖牌以 ≥ 半格宽高覆盖（对齐 LegalGridCandidates）。 */
function legalGridCandidates(
  coveringTiles: PlacementTile[],
  boardBounds: IntRect,
  blockedTowers: IntRect[],
  footprint: BoardSpecialFootprint,
): Array<[number, number]> {
  const coveringBounds = coveringTiles.map(t => tileBounds(t.posX, t.posY));
  const result: Array<[number, number]> = [];
  const step = HALF_TILE_UNIT;
  const halfWidth = (footprint.width * BOARD_TILE_UNIT) / 2;
  const halfHeight = (footprint.height * BOARD_TILE_UNIT) / 2;
  const startX = Math.ceil((boardBounds.xMin + halfWidth) / step) * step;
  const startY = Math.ceil((boardBounds.yMin + halfHeight) / step) * step;
  for (let x = startX; x + halfWidth <= boardBounds.xMax; x += step) {
    for (let y = startY; y + halfHeight <= boardBounds.yMax; y += step) {
      const candidateBounds = boardSpecialBounds(x, y, footprint);
      if (blockedTowers.some(b => overlaps(candidateBounds, b))) continue;
      if (!coveringBounds.some(covering => hasDependencyCoverage(candidateBounds, covering))) continue;
      result.push([x, y]);
    }
  }
  return result;
}

/** 随机打乱 → 中心对齐组前置（稳定）→ 回溯搜最多 targetCount 个互不重叠位置（对齐 SelectMaximumCandidates）。 */
function selectMaximumCandidates(
  candidatePositions: Array<[number, number]>,
  footprint: BoardSpecialFootprint,
  targetCount: number,
  random: DotNetRandom,
  centeredPositions: Set<string>,
): Array<[number, number]> {
  for (let i = candidatePositions.length - 1; i > 0; i--) {
    const other = random.next(i + 1);
    [candidatePositions[i], candidatePositions[other]] = [candidatePositions[other], candidatePositions[i]];
  }
  const ordered = [
    ...candidatePositions.filter(pos => centeredPositions.has(`${pos[0]},${pos[1]}`)),
    ...candidatePositions.filter(pos => !centeredPositions.has(`${pos[0]},${pos[1]}`)),
  ];

  const selected: Array<[number, number]> = [];
  let best: Array<[number, number]> = [];
  const search = (startIndex: number): void => {
    if (selected.length > best.length) best = [...selected];
    if (best.length >= targetCount || selected.length + ordered.length - startIndex <= best.length) return;
    for (let index = startIndex; index < ordered.length; index++) {
      const candidateBounds = boardSpecialBounds(ordered[index][0], ordered[index][1], footprint);
      if (selected.some(item => overlaps(candidateBounds, boardSpecialBounds(item[0], item[1], footprint)))) continue;
      selected.push(ordered[index]);
      search(index + 1);
      selected.pop();
      if (best.length >= targetCount) return;
    }
  };
  search(0);
  return best;
}

// ═══════════════════════════════════════════════════════════
//  三种计划入口（对齐 LoadLevel 的 BoardSpecialMode 分发）
// ═══════════════════════════════════════════════════════════

/** 51 Standard：Build（层数驱动的 2/3 交替放置）。 */
export function buildStandardPlan(
  layers: PlacementLayer[],
  effectiveTerrainLayerCount: number,
  seed: number,
): BoardSpecialPlacement[] {
  const sources = layers.filter(layer => layer.tiles.some(isTerrain));
  const terrain = sources.flatMap(layer => layer.tiles).filter(isTerrain);
  if (sources.length === 0 || terrain.length === 0) return [];
  const targetCount = Math.max(2, effectiveTerrainLayerCount);
  const minimumCount = 2;
  const allowSharedLayer = effectiveTerrainLayerCount < 2;
  const bounds = boundsOf(terrain.map(t => tileBounds(t.posX, t.posY)));
  const towers = towerPairs(sources).map(pair => pair.bounds);
  const strict = selectPreferred(sources, bounds, towers, targetCount, minimumCount, allowSharedLayer, seed);
  if (strict.length >= minimumCount) return strict;
  const relaxed = selectPreferred(sources, bounds, [], targetCount, minimumCount, allowSharedLayer, seed);
  return relaxed.length > strict.length ? relaxed : strict;
}

/** 52 Pizza 盒订单：BuildPizza。 */
export function buildPizzaPlan(
  layers: PlacementLayer[],
  boardBounds: IntRect,
  seed: number,
): BoardSpecialPlacement[] {
  const terrainLayers = layers.filter(layer => layer.tiles.some(isTerrain));
  const towers = towerPairs(terrainLayers);
  const sources = removeTowerOnlyLayers(terrainLayers, towers);
  if (sources.length === 0) return [];
  const random = new DotNetRandom((seed ^ 0x52) | 0);
  const selectedLayers = selectInsertionLayers(sources, terrainLayers, random);
  const layerCounts = sources.map(() => 0);
  for (const layerIndex of selectedLayers) layerCounts[layerIndex] = 1;
  const firstSize = random.next(2) === 0 ? 2 : 3;
  const effectiveBounds = boardBounds.xMax > boardBounds.xMin && boardBounds.yMax > boardBounds.yMin
    ? boardBounds
    : boundsOf(sources.flatMap(layer => layer.tiles).filter(isTerrain).map(t => tileBounds(t.posX, t.posY)));
  return buildLayerPlan(
    sources, effectiveBounds, towers, layerCounts,
    index => {
      const size = (firstSize + selectedLayers.filter(value => value <= index).length - 1) % 2 === 0 ? 2 : 3;
      return { width: size, height: size };
    },
    random, terrainLayers, true, false, 0, true,
  );
}

/** 53 奖券订单：BuildTicket（首/末/随机中间层各一个 3×2，不足整组取消）。 */
export function buildTicketPlan(
  layers: PlacementLayer[],
  boardBounds: IntRect,
  seed: number,
): BoardSpecialPlacement[] {
  const terrainLayers = layers.filter(layer => layer.tiles.some(isTerrain));
  const towers = towerPairs(terrainLayers);
  const sources = removeTowerOnlyLayers(terrainLayers, towers);
  if (sources.length === 0) return [];
  const random = new DotNetRandom((seed ^ 0x53) | 0);
  const effectiveBounds = boardBounds.xMax > boardBounds.xMin && boardBounds.yMax > boardBounds.yMin
    ? boardBounds
    : boundsOf(sources.flatMap(layer => layer.tiles).filter(isTerrain).map(t => tileBounds(t.posX, t.posY)));
  const middleIndices = sources.length > 2
    ? Array.from({ length: sources.length - 2 }, (_, i) => i + 1)
    : Array.from({ length: sources.length }, (_, i) => i);
  for (let i = middleIndices.length - 1; i > 0; i--) {
    const other = random.next(i + 1);
    [middleIndices[i], middleIndices[other]] = [middleIndices[other], middleIndices[i]];
  }
  for (const middleIndex of middleIndices) {
    const layerCounts = sources.map(() => 0);
    for (const index of [0, sources.length - 1, middleIndex]) layerCounts[index]++;
    const plan = buildLayerPlan(
      sources, effectiveBounds, towers, layerCounts,
      () => ({ width: 3, height: 2 }),
      random, terrainLayers, true, true, 3, true,
    );
    if (plan.length === 3) return plan;
  }
  return [];
}
