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
 * 合并普通物理层与特殊地形结构（对齐 Tile Explorer 真机）。
 *
 * - 层数 = 地形物理层数（Shell layers），普通牌按 Shell Layer（0=顶）入层，
 *   不使用 Dependencies 深度（Dependencies 只用于遮挡/可点，不用于分层）。
 * - transfer 全部并入第 1 层。
 * - falling 展示牌（前 viewLength 张）并入第 1 层；
 *   隐藏牌逐层下探：第 k 张在第 k+1 层，超过物理层数后由最后一层吸收剩余隐藏牌。
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
    }
  }

  const dependencyDepth = computeDependencyDepth(allTiles, tileById);
  const ordinaryTiles = allTiles.filter(tile => !structuredIds.has(tile.id));
  const ordinaryDepthCount = ordinaryTiles.length
    ? Math.max(...ordinaryTiles.map(tile => dependencyDepth.get(tile.id) ?? 1))
    : 0;
  // 物理层基准：层数 = 地形物理层数（Shell layers），对齐 Tile Explorer 的 OriginTileLayerList。
  const depthCount = Math.max(1, terrain.layers.length);
  const layers = Array.from({ length: depthCount }, () => [] as TerrainTile[]);
  const depthById = new Map<number, number>();

  function add(tileId: number, depth: number): void {
    const tile = tileById.get(tileId)!;
    if (depthById.has(tileId)) throw new Error(`tile ${tileId} 被重复加入生成逻辑层`);
    const normalizedDepth = Math.max(1, Math.min(depthCount, depth));
    layers[normalizedDepth - 1].push(tile);
    depthById.set(tileId, normalizedDepth);
  }

  // 普通牌按 Shell Layer 入层（0=顶 → 逻辑深度 1）。
  for (const tile of ordinaryTiles) add(tile.id, tile.layer + 1);

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
