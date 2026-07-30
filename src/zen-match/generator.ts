import { getAllTiles } from '../terrain-loader.js';
import { DotNetRandom } from '../tile-explorer/random.js';
import type { TerrainTile } from '../types.js';
import type { ZenMatchInput, ZenMatchOutput, ZenMatchStrategy } from './types.js';

interface BoardNode {
  id: number;
  layer: number;
  parents: number[];
  children: number[];
  fixedType: number | null;
}

class QueueTileTypeFactory {
  readonly uniqueTileTypes: number;
  private readonly queue: number[] = [];

  constructor(
    readonly totalTileCount: number,
    readonly matchSize: number,
    requestedUnique: number,
  ) {
    if (totalTileCount <= 0 || totalTileCount % matchSize !== 0) {
      throw new Error(`生成牌数量 ${totalTileCount} 必须是 ${matchSize} 的正倍数`);
    }
    this.uniqueTileTypes = Math.max(
      1,
      Math.min(totalTileCount / matchSize, requestedUnique),
    );
    let tileType = 0;
    while (this.queue.length < totalTileCount) {
      for (let count = 0; count < matchSize; count++) this.queue.push(tileType);
      tileType = (tileType + 1) % this.uniqueTileTypes;
    }
    this.queue.length = totalTileCount;
  }

  dequeue(): number {
    const value = this.queue.shift();
    if (value === undefined) throw new Error('Zen Match 牌型队列为空');
    return value;
  }

  removeTile(tileType: number): void {
    const index = this.queue.indexOf(tileType);
    if (index < 0) throw new Error(`Zen Match 牌型队列中不存在类型 ${tileType}`);
    this.queue.splice(index, 1);
  }

  shuffle(random: DotNetRandom): void {
    shuffleInPlace(this.queue, random);
  }
}

class BoardSimulation {
  readonly byId: Map<number, BoardNode>;
  readonly active: Set<number>;

  constructor(readonly nodes: BoardNode[]) {
    this.byId = new Map(nodes.map(node => [node.id, node]));
    this.active = new Set(nodes.map(node => node.id));
  }

  interactable(): number[] {
    return this.nodes
      .filter(node => this.active.has(node.id)
        && !node.parents.some(parentId => this.active.has(parentId)))
      .map(node => node.id);
  }

  interact(nodeId: number): number[] {
    if (!this.active.delete(nodeId)) return [];
    const node = this.byId.get(nodeId);
    if (!node) throw new Error(`Zen Match 模拟器找不到 tile ${nodeId}`);
    return node.children.filter(childId => {
      if (!this.active.has(childId)) return false;
      const child = this.byId.get(childId)!;
      return !child.parents.some(parentId => this.active.has(parentId));
    });
  }

  removeFixed(fixedIds: number[]): void {
    for (const nodeId of fixedIds) this.interact(nodeId);
  }

  /**
   * Preserve Zen's one-step top expansion: remove the initially interactable
   * snapshot and collect tiles exposed by that snapshot, without recursing.
   */
  topCandidates(): number[] {
    const candidates: number[] = [];
    for (const nodeId of this.interactable()) {
      candidates.push(nodeId);
      for (const exposedId of this.interact(nodeId)) {
        if (!candidates.includes(exposedId)) candidates.push(exposedId);
      }
    }
    return candidates;
  }
}

function shuffleInPlace<T>(values: T[], random: DotNetRandom): void {
  let count = values.length;
  while (count >= 2) {
    const index = random.next(count);
    [values[index], values[count - 1]] = [values[count - 1], values[index]];
    count -= 1;
  }
}

function buildBoard(terrain: ZenMatchInput['terrain']): BoardNode[] {
  if (!Array.isArray(terrain.layers) || terrain.layers.length === 0) {
    throw new Error('Zen Match 算法需要非空静态地形');
  }
  if (terrain.terrainStructures?.length) {
    throw new Error('Zen Match 算法暂不支持 transfer/falling 地形结构');
  }

  for (let layerIndex = 0; layerIndex < terrain.layers.length; layerIndex++) {
    for (const tile of terrain.layers[layerIndex].tiles) {
      if (tile.layer !== layerIndex) {
        throw new Error(
          `tile ${tile.id} 的 Layer ${tile.layer} 与所在 layers[${layerIndex}] 不一致`,
        );
      }
    }
  }

  const tiles = getAllTiles(terrain).sort((left, right) => left.id - right.id);
  if (!tiles.length) throw new Error('Zen Match 算法地形中没有牌');
  const sourceById = new Map<number, TerrainTile>();
  for (const tile of tiles) {
    if (!Number.isInteger(tile.id)) throw new Error(`tile ID 必须是整数: ${tile.id}`);
    if (sourceById.has(tile.id)) throw new Error(`地形存在重复 tile ID: ${tile.id}`);
    if (!Number.isInteger(tile.layer) || tile.layer < 0 || tile.layer >= terrain.layers.length) {
      throw new Error(`tile ${tile.id} 的 Layer ${tile.layer} 超出地形层范围`);
    }
    sourceById.set(tile.id, tile);
  }

  const nodes = tiles.map<BoardNode>(tile => ({
    id: tile.id,
    layer: tile.layer,
    parents: [...tile.dependencies],
    children: [],
    fixedType: tile.isConst ? tile.constElementValue : null,
  }));
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const node of nodes) {
    if (node.fixedType !== null && (!Number.isInteger(node.fixedType) || node.fixedType <= 0)) {
      throw new Error(`固定 tile ${node.id} 缺少有效 ConstElementValue`);
    }
    const seen = new Set<number>();
    for (const parentId of node.parents) {
      if (!Number.isInteger(parentId)) {
        throw new Error(`tile ${node.id} 的 Dependency 必须是整数`);
      }
      if (parentId === node.id) throw new Error(`tile ${node.id} 不能依赖自身`);
      if (seen.has(parentId)) throw new Error(`tile ${node.id} 包含重复 Dependency ${parentId}`);
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) throw new Error(`tile ${node.id} 引用了不存在的 Dependency ${parentId}`);
      if (parent.layer >= node.layer) {
        throw new Error(`tile ${node.id} 的 Dependency ${parentId} 不在更高物理层`);
      }
      parent.children.push(node.id);
    }
  }
  return nodes;
}

function strategyFour(
  simulation: BoardSimulation,
  factory: QueueTileTypeFactory,
  random: DotNetRandom,
): { generated: Map<number, number>; topMatchTileIds: number[] } {
  const generated = new Map<number, number>();
  const initialType = random.next(factory.uniqueTileTypes);
  const allIds = simulation.nodes
    .filter(node => simulation.active.has(node.id))
    .map(node => node.id);
  const top = simulation.topCandidates();
  const topMatchTileIds: number[] = [];

  if (top.length >= factory.matchSize) {
    shuffleInPlace(top, random);
    for (let count = 0; count < factory.matchSize; count++) {
      const nodeId = top.pop()!;
      allIds.splice(allIds.indexOf(nodeId), 1);
      factory.removeTile(initialType);
      generated.set(nodeId, initialType);
      topMatchTileIds.push(nodeId);
    }
  }

  while (allIds.length) {
    const index = random.next(allIds.length);
    const [nodeId] = allIds.splice(index, 1);
    generated.set(nodeId, factory.dequeue());
  }
  return { generated, topMatchTileIds };
}

function strategyFive(
  simulation: BoardSimulation,
  factory: QueueTileTypeFactory,
  random: DotNetRandom,
): { generated: Map<number, number>; topMatchTileIds: number[] } {
  const generated = new Map<number, number>();
  const activeNodes = simulation.nodes.filter(node => simulation.active.has(node.id));

  // Zen: OrderBy node ID, GroupBy layer, reverse layer groups, then flatten.
  const grouped = new Map<number, number[]>();
  for (const node of [...activeNodes].sort((left, right) => left.id - right.id)) {
    const group = grouped.get(node.layer) ?? [];
    group.push(node.id);
    grouped.set(node.layer, group);
  }
  const layerOrder = [...grouped.values()].reverse().flat();
  const top = simulation.topCandidates();
  factory.shuffle(random);
  shuffleInPlace(top, random);

  let matchType: number | null = null;
  const topMatchTileIds: number[] = [];
  for (let index = 0; index < Math.min(factory.matchSize, top.length); index++) {
    if (matchType === null) matchType = factory.dequeue();
    else factory.removeTile(matchType);
    const nodeId = top[index];
    generated.set(nodeId, matchType);
    layerOrder.splice(layerOrder.indexOf(nodeId), 1);
    topMatchTileIds.push(nodeId);
  }
  for (const nodeId of layerOrder) generated.set(nodeId, factory.dequeue());
  return { generated, topMatchTileIds };
}

function orderedDistinct(values: Iterable<number>): number[] {
  return [...new Set(values)];
}

/**
 * Preserve Zen's fixed/generated equality groups. Numeric icon permutation is
 * intentionally left to ReverseGen's ReplayCode normalization.
 */
function concatFixedAndGenerated(
  fixed: Map<number, number>,
  generated: Map<number, number>,
  uniqueCount: number,
): Map<number, number> {
  const fixedTypes = orderedDistinct(fixed.values());
  const generatedTypes = orderedDistinct(generated.values());
  const maximumFixed = fixedTypes.length ? Math.max(...fixedTypes) : 0;
  const mapping = new Map<number, number>();

  for (let index = 0; index < generatedTypes.length; index++) {
    const generatedType = generatedTypes[index];
    if (
      index >= fixedTypes.length
      || generatedTypes.length - index + fixedTypes.length <= uniqueCount
    ) {
      mapping.set(generatedType, maximumFixed + index + 1);
    } else {
      mapping.set(generatedType, fixedTypes[index]);
    }
  }
  return new Map([...generated].map(([nodeId, abstractType]) => [
    nodeId,
    mapping.get(abstractType)!,
  ]));
}

export function runZenMatchGen(input: ZenMatchInput): ZenMatchOutput {
  if (!Number.isInteger(input.uniqueCount) || input.uniqueCount < 1) {
    throw new Error('uniqueCount 必须是正整数');
  }
  if (input.uniqueCount > 64) {
    throw new Error('ReverseGen ReplayCode 最多支持 64 种花色');
  }
  if (!Number.isInteger(input.seed)) throw new Error('seed 必须是整数');
  const strategy: ZenMatchStrategy = input.strategy ?? 4;
  if (strategy !== 4 && strategy !== 5) throw new Error('Zen Match strategy 必须是 4 或 5');

  const nodes = buildBoard(input.terrain);
  const matchSize = 3;
  if (nodes.length % matchSize !== 0) {
    throw new Error(`地形牌数量 ${nodes.length} 不是 ${matchSize} 的倍数`);
  }
  const fixed = new Map(
    nodes
      .filter(node => node.fixedType !== null)
      .map(node => [node.id, node.fixedType!] as const),
  );
  const fixedTypeCount = new Set(fixed.values()).size;
  if (fixedTypeCount > input.uniqueCount) {
    throw new Error(
      `固定牌已经使用 ${fixedTypeCount} 种花色，超过请求的 uniqueCount ${input.uniqueCount}`,
    );
  }
  const simulation = new BoardSimulation(nodes);
  simulation.removeFixed([...fixed.keys()]);
  const generatedCount = nodes.length - fixed.size;
  const random = new DotNetRandom(input.seed | 0);

  let abstractAssignments = new Map<number, number>();
  let assignments = new Map<number, number>();
  let topMatchTileIds: number[] = [];
  if (generatedCount > 0) {
    if (generatedCount % matchSize !== 0) {
      throw new Error(`移除固定牌后的自由牌数量 ${generatedCount} 不是 ${matchSize} 的倍数`);
    }
    const factory = new QueueTileTypeFactory(generatedCount, matchSize, input.uniqueCount);
    const result = strategy === 4
      ? strategyFour(simulation, factory, random)
      : strategyFive(simulation, factory, random);
    abstractAssignments = result.generated;
    topMatchTileIds = result.topMatchTileIds;
    assignments = concatFixedAndGenerated(fixed, abstractAssignments, input.uniqueCount);
  }

  const actualColorCount = new Set([
    ...fixed.values(),
    ...assignments.values(),
  ]).size;
  return {
    assignments,
    abstractAssignments,
    topMatchTileIds,
    requestedUniqueCount: input.uniqueCount,
    actualColorCount,
    seed: input.seed | 0,
    strategy,
  };
}
