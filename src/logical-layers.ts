import { getAllTiles } from './terrain-loader.js';
import type { TerrainData, TerrainTile } from './types.js';

export interface GenerationLogicalLayers {
  /** 生成逻辑层，顺序为初始可见层 -> 最深层。 */
  layers: TerrainTile[][];
  /** 每张牌唯一所属的生成逻辑层，层号从 1 开始。 */
  depthById: Map<number, number>;
  /** 普通牌原本由 Dependencies 形成的逻辑深度。 */
  ordinaryDepthCount: number;
  /** 是否实际应用了 transfer/falling 结构。 */
  hasTerrainStructures: boolean;
}

/** 计算普通地形的依赖深度：无依赖为第 1 层。 */
export function computeDependencyDepth(
  tiles: TerrainTile[],
  tileMap: Map<number, TerrainTile>,
): Map<number, number> {
  const depth = new Map<number, number>();
  const visiting = new Set<number>();

  function walk(tileId: number): number {
    const cached = depth.get(tileId);
    if (cached !== undefined) return cached;
    if (visiting.has(tileId)) throw new Error(`Dependencies 存在环，涉及 tile ${tileId}`);

    const tile = tileMap.get(tileId);
    if (!tile || tile.dependencies.length === 0) {
      depth.set(tileId, 1);
      return 1;
    }

    visiting.add(tileId);
    let maxDep = 0;
    for (const depId of tile.dependencies) {
      const d = walk(depId);
      if (d > maxDep) maxDep = d;
    }
    visiting.delete(tileId);
    const result = maxDep + 1;
    depth.set(tileId, result);
    return result;
  }

  for (const tile of tiles) walk(tile.id);
  return depth;
}

/**
 * 合并普通依赖层与特殊地形结构。
 *
 * - 普通牌保留原 Dependencies 深度。
 * - transfer 全部并入第 1 层。
 * - falling 第 1 层放首批 viewLength 张；后续每层放 1 张；
 *   普通棋盘最后一层吸收尚未放入的 falling。
 * - 普通棋盘没有有效的多层依赖时，由最长 falling 建立简单逻辑层。
 */
export function buildGenerationLogicalLayers(terrain: TerrainData): GenerationLogicalLayers {
  const allTiles = getAllTiles(terrain);
  const tileById = new Map<number, TerrainTile>();
  for (const tile of allTiles) {
    if (tileById.has(tile.id)) throw new Error(`地形存在重复 tile ID: ${tile.id}`);
    tileById.set(tile.id, tile);
  }

  const structures = terrain.terrainStructures ?? [];
  if (!structures.length) {
    const depthById = computeDependencyDepth(allTiles, tileById);
    const depthCount = depthById.size ? Math.max(...depthById.values()) : 0;
    const layers = Array.from({ length: depthCount }, (_, index) =>
      allTiles.filter(tile => depthById.get(tile.id) === index + 1));
    return {
      layers,
      depthById,
      ordinaryDepthCount: depthCount,
      hasTerrainStructures: false,
    };
  }

  const structuredIds = new Set<number>();
  let maxFallingDepth = 1;
  for (const structure of structures) {
    if (structure.tileNum != null && structure.tileNum !== structure.tileIds.length) {
      throw new Error(
        `${structure.type}#${structure.id ?? '?'} 的 tileNum=${structure.tileNum}，`
        + `但 tileIds 有 ${structure.tileIds.length} 张`,
      );
    }
    if (!structure.tileIds.length) {
      throw new Error(`${structure.type}#${structure.id ?? '?'} 没有 tileIds`);
    }
    for (const tileId of structure.tileIds) {
      if (!tileById.has(tileId)) {
        throw new Error(`${structure.type}#${structure.id ?? '?'} 引用了不存在的 tile ${tileId}`);
      }
      if (structuredIds.has(tileId)) {
        throw new Error(`tile ${tileId} 同时属于多个 terrainStructures`);
      }
      structuredIds.add(tileId);
    }
    if (structure.type === 'falling') {
      if (!Number.isInteger(structure.viewLength)
        || structure.viewLength < 1
        || structure.viewLength > structure.tileIds.length) {
        throw new Error(
          `falling#${structure.id ?? '?'} 的 viewLength 必须在 1..${structure.tileIds.length} 之间`,
        );
      }
      maxFallingDepth = Math.max(
        maxFallingDepth,
        structure.tileIds.length - structure.viewLength + 1,
      );
    }
  }

  const dependencyDepth = computeDependencyDepth(allTiles, tileById);
  const ordinaryTiles = allTiles.filter(tile => !structuredIds.has(tile.id));
  const ordinaryDepthCount = ordinaryTiles.length
    ? Math.max(...ordinaryTiles.map(tile => dependencyDepth.get(tile.id) ?? 1))
    : 0;
  const depthCount = ordinaryDepthCount > 1
    ? ordinaryDepthCount
    : Math.max(ordinaryDepthCount, maxFallingDepth, 1);
  const layers = Array.from({ length: depthCount }, () => [] as TerrainTile[]);
  const depthById = new Map<number, number>();

  function add(tileId: number, depth: number): void {
    const tile = tileById.get(tileId)!;
    if (depthById.has(tileId)) throw new Error(`tile ${tileId} 被重复加入生成逻辑层`);
    const normalizedDepth = Math.max(1, Math.min(depthCount, depth));
    layers[normalizedDepth - 1].push(tile);
    depthById.set(tileId, normalizedDepth);
  }

  for (const tile of ordinaryTiles) add(tile.id, dependencyDepth.get(tile.id) ?? 1);

  for (const structure of structures) {
    if (structure.type === 'transfer') {
      for (const tileId of structure.tileIds) add(tileId, 1);
      continue;
    }

    const initiallyVisible = structure.tileIds.slice(0, structure.viewLength);
    const hidden = structure.tileIds.slice(structure.viewLength);
    for (const tileId of initiallyVisible) add(tileId, 1);
    for (let index = 0; index < hidden.length; index++) {
      add(hidden[index], Math.min(index + 2, depthCount));
    }
  }

  if (depthById.size !== allTiles.length) {
    throw new Error(`生成逻辑层只覆盖 ${depthById.size}/${allTiles.length} 张牌`);
  }

  return {
    layers,
    depthById,
    ordinaryDepthCount,
    hasTerrainStructures: true,
  };
}
