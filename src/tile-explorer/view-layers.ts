import type { TerrainData, TerrainTile } from '../types.js';
import { buildGenerationLogicalLayers } from '../logical-layers.js';
import type { TileExplorerTile } from './types.js';

export interface TileExplorerTerrainView {
  /** Tile Explorer physical layers, bottom -> top. */
  physicalLayers: TileExplorerTile[][];
  /** Tile Explorer logical/view layers, bottom -> top. */
  viewLayers: number[][];
  depthById: Map<number, number>;
  sourceById: Map<number, TerrainTile>;
}

/**
 * Convert TileMatch terrain into Tile Explorer's normal-board model.
 * TileMatch layer 0 is topmost; Tile Explorer consumes physical layers bottom -> top.
 */
export function buildTileExplorerTerrainView(terrain: TerrainData): TileExplorerTerrainView {
  if (!Array.isArray(terrain.layers) || terrain.layers.length === 0) {
    throw new Error('Tile Explorer 算法需要非空地形层');
  }

  const sourceById = new Map<number, TerrainTile>();
  for (let outer = 0; outer < terrain.layers.length; outer++) {
    for (const tile of terrain.layers[outer].tiles) {
      if (sourceById.has(tile.id)) throw new Error(`地形存在重复 tile ID: ${tile.id}`);
      if (!Number.isInteger(tile.layer) || tile.layer < 0 || tile.layer >= terrain.layers.length) {
        throw new Error(`tile ${tile.id} 的 Layer ${tile.layer} 超出地形层范围`);
      }
      if (tile.layer !== outer) {
        throw new Error(`tile ${tile.id} 的 Layer=${tile.layer} 与所在 layers[${outer}] 不一致`);
      }
      sourceById.set(tile.id, tile);
    }
  }
  if (sourceById.size === 0) throw new Error('Tile Explorer 算法地形中没有牌');

  for (const tile of sourceById.values()) {
    const seen = new Set<number>();
    for (const depId of tile.dependencies) {
      if (depId === tile.id) throw new Error(`tile ${tile.id} 不能依赖自身`);
      if (seen.has(depId)) throw new Error(`tile ${tile.id} 包含重复 Dependency ${depId}`);
      seen.add(depId);
      const blocker = sourceById.get(depId);
      if (!blocker) throw new Error(`tile ${tile.id} 引用了不存在的 Dependency ${depId}`);
      if (blocker.layer >= tile.layer) {
        throw new Error(`tile ${tile.id} 的 Dependency ${depId} 不在更高物理层`);
      }
    }
  }

  const logicalTerrain = buildGenerationLogicalLayers(terrain);
  if (logicalTerrain.hasTerrainStructures) {
    const physicalLayers = [...logicalTerrain.layers].reverse().map((layer, physicalLayer) =>
      layer.map(tile => ({
        id: tile.id,
        physicalLayer,
        shuffleable: !tile.isConst,
        suit: tile.isConst && tile.constElementValue > 0 ? tile.constElementValue : undefined,
      })));
    const viewLayers = physicalLayers.map(layer => layer.map(tile => tile.id));
    return {
      physicalLayers,
      viewLayers,
      depthById: logicalTerrain.depthById,
      sourceById,
    };
  }

  const depthById = new Map<number, number>();
  const visiting = new Set<number>();
  function depth(tileId: number): number {
    const cached = depthById.get(tileId);
    if (cached !== undefined) return cached;
    if (visiting.has(tileId)) throw new Error(`Dependencies 存在环，涉及 tile ${tileId}`);
    visiting.add(tileId);
    const tile = sourceById.get(tileId)!;
    let maxDependencyDepth = 0;
    for (const depId of tile.dependencies) {
      maxDependencyDepth = Math.max(maxDependencyDepth, depth(depId));
    }
    visiting.delete(tileId);
    const result = maxDependencyDepth + 1;
    depthById.set(tileId, result);
    return result;
  }
  for (const id of sourceById.keys()) depth(id);

  const physicalLayers: TileExplorerTile[][] = [];
  for (let tmLayer = terrain.layers.length - 1; tmLayer >= 0; tmLayer--) {
    const teLayer = terrain.layers.length - 1 - tmLayer;
    physicalLayers.push(terrain.layers[tmLayer].tiles.map(tile => ({
      id: tile.id,
      physicalLayer: teLayer,
      shuffleable: !tile.isConst,
      suit: tile.isConst && tile.constElementValue > 0 ? tile.constElementValue : undefined,
    })));
  }

  const maxDepth = Math.max(...depthById.values());
  const viewLayers = Array.from({ length: maxDepth }, () => [] as number[]);
  // Preserve the verified Python implementation's bottom->top physical scan order.
  for (const layer of physicalLayers) {
    for (const tile of layer) {
      viewLayers[maxDepth - depthById.get(tile.id)!].push(tile.id);
    }
  }

  return { physicalLayers, viewLayers, depthById, sourceById };
}
