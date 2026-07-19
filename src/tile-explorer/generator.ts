import { DotNetRandom, seededShuffle } from './random.js';
import { buildTileExplorerTerrainView } from './view-layers.js';
import type {
  TileExplorerInput,
  TileExplorerOutput,
  TileExplorerStrategy,
  TileExplorerTile,
} from './types.js';

function buildTypeCycle(weights: number[], tileTypesCanUse: number | undefined, sequenceSeed: number): number[] {
  if (weights.some(weight => !Number.isInteger(weight) || weight < 0)) {
    throw new Error('tileTypeWeights 不能包含负数或非整数');
  }
  const available = weights.length || 5;
  let useCount = tileTypesCanUse == null ? available : Math.trunc(tileTypesCanUse);
  if (available) useCount = Math.min(useCount, available);
  if (useCount < 1) throw new Error('tileTypesCanUse 必须至少解析出 1 种花色');

  const paddedWeights = weights.map(Math.trunc);
  while (paddedWeights.length < useCount) paddedWeights.push(1);
  const typeIds = Array.from({ length: useCount }, (_, index) => index + 1);
  let cycle: number[];
  if (weights.length) {
    seededShuffle(typeIds, sequenceSeed);
    cycle = [];
    for (let index = 0; index < useCount; index++) {
      for (let repeat = 0; repeat < paddedWeights[index]; repeat++) cycle.push(typeIds[index]);
    }
  } else {
    cycle = typeIds;
  }
  if (!cycle.length) throw new Error('tileTypeWeights 生成了空花色循环');
  seededShuffle(cycle, sequenceSeed);
  return cycle;
}

function resolveTypeCycle(input: TileExplorerInput, sequenceSeed: number): number[] {
  if (input.strategy === 'color_gradient') {
    return (input.colorGradientTypeGroups ?? []).flat().map(Math.trunc);
  }
  if (input.typeCycle) {
    if (!input.typeCycle.length) throw new Error('typeCycle 不能为空');
    if (input.typeCycle.some(value => !Number.isInteger(value) || value < 1)) {
      throw new Error('typeCycle 必须全部是正整数');
    }
    return [...input.typeCycle];
  }
  if (input.tileTypeWeights?.length) {
    return buildTypeCycle(input.tileTypeWeights, input.tileTypesCanUse, sequenceSeed);
  }
  if (input.colorCount != null) {
    if (!Number.isInteger(input.colorCount) || input.colorCount < 1 || input.colorCount > 99) {
      throw new Error('colorCount 必须是 1-99 的整数');
    }
    return buildTypeCycle(Array.from({ length: input.colorCount }, () => 1), input.colorCount, sequenceSeed);
  }
  return buildTypeCycle([], input.tileTypesCanUse, sequenceSeed);
}

function layerBatchSize(
  strategy: TileExplorerStrategy,
  currentLayer: number,
  layerCount: number,
  difficulty: number,
  firstBatch: boolean,
  easyBatchesLeft: number,
  limitFullFirst: boolean,
): number {
  if (strategy === 'default') return easyBatchesLeft > 0 ? 1 : difficulty;
  if (strategy === 'top_two_easy') return currentLayer >= layerCount - 2 ? 2 : difficulty;
  if (strategy === 'limit_layer_random') {
    if (firstBatch && limitFullFirst) return difficulty;
    const remainder = layerCount % difficulty;
    return firstBatch ? (remainder || difficulty) : difficulty;
  }
  if (strategy === 'easy_hard_easy') {
    if (layerCount < 3) return layerCount;
    if (currentLayer >= layerCount - 2) return Math.max(2, 3 - layerCount + currentLayer);
    if (currentLayer === 0) return 1;
    return Math.min(difficulty, currentLayer);
  }
  throw new Error(`该策略不使用普通物理层分配器: ${strategy}`);
}

function assignPhysical(
  layers: TileExplorerTile[][],
  cycle: number[],
  difficulty: number,
  rng: DotNetRandom,
  strategy: TileExplorerStrategy,
  easyLayerCount: number,
  limitFullFirst: boolean,
): void {
  const candidateCount = layers.flat().filter(tile => tile.shuffleable && tile.suit == null).length;
  if (candidateCount % 3 !== 0) throw new Error(`自由牌数量 ${candidateCount} 不是 3 的倍数`);

  const generationLayers = strategy === 'default'
    ? layers
    : layers.filter(layer => layer.some(tile => tile.shuffleable && tile.suit == null));
  const pool: TileExplorerTile[] = [];
  let current = generationLayers.length - 1;
  let groupIndex = 0;
  let firstBatch = true;
  let easyLeft = Math.max(0, Math.trunc(easyLayerCount));

  while (current >= 0 || pool.length) {
    if (pool.length <= 2 && current >= 0) {
      const batch = Math.max(1, layerBatchSize(
        strategy, current, generationLayers.length, difficulty,
        firstBatch, easyLeft, limitFullFirst,
      ));
      for (let count = 0; count < batch; count++) {
        if (current < 0) break;
        pool.push(...generationLayers[current].filter(tile => tile.shuffleable && tile.suit == null));
        current -= 1;
      }
      firstBatch = false;
      if (strategy === 'default' && easyLeft > 0) easyLeft -= 1;
    }
    const take = Math.min(3, pool.length);
    if (!take) continue;
    const suit = cycle[groupIndex % cycle.length];
    for (let count = 0; count < take; count++) {
      const [tile] = pool.splice(rng.next(pool.length), 1);
      tile.suit = suit;
      tile.group = groupIndex;
    }
    groupIndex += 1;
  }
}

function assignSlidingWindow(
  layers: TileExplorerTile[][],
  cycle: number[],
  difficulty: number,
  rng: DotNetRandom,
): void {
  const generationLayers = layers.filter(layer => layer.some(tile => tile.shuffleable && tile.suit == null));
  const pool: TileExplorerTile[] = [];
  const activeLayers = new Set<number>();
  let current = generationLayers.length - 1;
  let groupIndex = 0;

  function addNextLayer(): void {
    if (current < 0) return;
    activeLayers.add(generationLayers[current][0].physicalLayer);
    pool.push(...generationLayers[current].filter(tile => tile.shuffleable && tile.suit == null));
    current -= 1;
  }
  for (let count = 0; count < Math.max(1, difficulty); count++) addNextLayer();

  while (pool.length || current >= 0) {
    if (!pool.length) {
      addNextLayer();
      continue;
    }
    const suit = cycle[groupIndex % cycle.length];
    const take = Math.min(3, pool.length);
    for (let count = 0; count < take; count++) {
      const [tile] = pool.splice(rng.next(pool.length), 1);
      tile.suit = suit;
      tile.group = groupIndex;
    }
    groupIndex += 1;

    const remainingLayers = new Set(pool.map(tile => tile.physicalLayer));
    const exhausted = [...activeLayers].filter(layer => !remainingLayers.has(layer));
    if (current >= 0 && (exhausted.length || pool.length <= 2)) {
      for (const layer of exhausted) activeLayers.delete(layer);
      const slideCount = Math.max(exhausted.length, pool.length <= 2 ? 1 : 0);
      for (let count = 0; count < slideCount; count++) addNextLayer();
    }
  }
}

function assignSolvability(
  layers: TileExplorerTile[][],
  viewLayers: number[][],
  cycle: number[],
  difficulty: number,
  rng: DotNetRandom,
  lowerCoefficient: number,
  topCoefficient: number,
  fallbackExtraLayers: number,
  randomizeLowerCoefficient: boolean,
  solvabilityRandomMode: boolean,
): void {
  const byId = new Map(layers.flat().map(tile => [tile.id, tile]));
  let groupIndex = 0;
  const viewCount = viewLayers.length;

  for (let viewIndex = viewCount - 1; viewIndex >= 0; viewIndex--) {
    const candidates = viewLayers[viewIndex]
      .map(id => byId.get(id))
      .filter((tile): tile is TileExplorerTile => !!tile && tile.shuffleable && tile.suit == null);
    let coefficient: number;
    if (viewIndex >= viewCount - 2) coefficient = topCoefficient;
    else if (randomizeLowerCoefficient) {
      const randomValue = rng.nextDouble();
      coefficient = solvabilityRandomMode ? 0.2 + randomValue * 0.3 : randomValue * 0.2;
    } else coefficient = lowerCoefficient;

    const protectedGroups = Math.min(
      Math.ceil(candidates.length * coefficient / 3),
      Math.floor(candidates.length / 3),
    );
    for (let group = 0; group < protectedGroups; group++) {
      const suit = cycle[groupIndex % cycle.length];
      for (let count = 0; count < 3; count++) {
        const [tile] = candidates.splice(rng.next(candidates.length), 1);
        tile.suit = suit;
        tile.group = groupIndex;
      }
      groupIndex += 1;
    }
  }

  const pool: TileExplorerTile[] = [];
  let current = viewLayers.length - 1;
  const batchSize = Math.max(1, difficulty + fallbackExtraLayers);
  while (current >= 0 || pool.length) {
    if (pool.length <= 2 && current >= 0) {
      for (let count = 0; count < batchSize; count++) {
        if (current < 0) break;
        pool.push(...viewLayers[current]
          .map(id => byId.get(id))
          .filter((tile): tile is TileExplorerTile => !!tile && tile.shuffleable && tile.suit == null));
        current -= 1;
      }
    }
    if (!pool.length) continue;
    const suit = cycle[groupIndex % cycle.length];
    const take = Math.min(3, pool.length);
    for (let count = 0; count < take; count++) {
      const [tile] = pool.splice(rng.next(pool.length), 1);
      tile.suit = suit;
      tile.group = groupIndex;
    }
    groupIndex += 1;
  }
}

export function colorGradientLayerGroups(viewLayerCount: number): number[] {
  if (viewLayerCount <= 0) return [];
  if (viewLayerCount <= 2) return [viewLayerCount];
  if (viewLayerCount <= 4) return [2, viewLayerCount - 2];
  if (viewLayerCount <= 6) return [3, viewLayerCount - 3];
  return [3, 3, viewLayerCount - 6];
}

function assignColorGradient(
  layers: TileExplorerTile[][],
  viewLayers: number[][],
  colorTypeGroups: number[][],
  rng: DotNetRandom,
): void {
  const layerGroups = colorGradientLayerGroups(viewLayers.length);
  if (colorTypeGroups.length !== layerGroups.length) {
    throw new Error(`ColorGradient 需要 ${layerGroups.length} 个花色分组`);
  }
  if (colorTypeGroups.some(group => !group.length || group.some(value => !Number.isInteger(value) || value < 1))) {
    throw new Error('ColorGradient 花色分组必须是非空正整数数组');
  }

  const byId = new Map(layers.flat().map(tile => [tile.id, tile]));
  const viewIndexById = new Map<number, number>();
  viewLayers.forEach((viewLayer, viewIndex) => viewLayer.forEach(id => viewIndexById.set(id, viewIndex)));
  const orderedViewBuckets = Array.from({ length: viewLayers.length }, () => [] as number[]);
  for (const layer of layers) {
    for (const tile of layer) {
      const index = viewIndexById.get(tile.id);
      if (index !== undefined) orderedViewBuckets[index].push(tile.id);
    }
  }
  const orderedViews = [...orderedViewBuckets].reverse();
  const pool: TileExplorerTile[] = [];
  let viewCursor = 0;
  let groupIndex = 0;
  let carryCount = 0;
  let carrySuit: number | undefined;

  function addView(): void {
    pool.push(...orderedViews[viewCursor]
      .map(id => byId.get(id))
      .filter((tile): tile is TileExplorerTile => !!tile && tile.shuffleable && tile.suit == null));
    viewCursor += 1;
  }

  for (let segment = 0; segment < layerGroups.length; segment++) {
    const layerCount = layerGroups[segment];
    const typeGroup = colorTypeGroups[segment];
    const segmentEnd = viewCursor + layerCount;
    if (carryCount) {
      const needed = 3 - carryCount;
      while (pool.length < needed && viewCursor < segmentEnd) addView();
      if (pool.length < needed || carrySuit == null) {
        throw new Error('ColorGradient 没有足够候选牌补齐跨段三元组');
      }
      for (let count = 0; count < needed; count++) {
        const [tile] = pool.splice(rng.next(pool.length), 1);
        tile.suit = carrySuit;
        tile.group = groupIndex - 1;
      }
      carryCount = 0;
      carrySuit = undefined;
    }
    while (viewCursor < segmentEnd) addView();

    let typeIndex = 0;
    while (pool.length > 2) {
      const suit = typeGroup[typeIndex % typeGroup.length];
      for (let count = 0; count < 3; count++) {
        const [tile] = pool.splice(rng.next(pool.length), 1);
        tile.suit = suit;
        tile.group = groupIndex;
      }
      typeIndex += 1;
      groupIndex += 1;
    }
    if (pool.length) {
      const suit = typeGroup[typeIndex % typeGroup.length];
      carryCount = pool.length;
      carrySuit = suit;
      while (pool.length) {
        const tile = pool.pop()!;
        tile.suit = suit;
        tile.group = groupIndex;
      }
      groupIndex += 1;
    }
  }
  if (pool.length || carryCount) throw new Error('ColorGradient 最后留下了不完整三元组');
}

export function runTileExplorerGen(input: TileExplorerInput): TileExplorerOutput {
  const strategy = input.strategy ?? 'default';
  const supportedStrategies = new Set<TileExplorerStrategy>([
    'default', 'top_two_easy', 'sliding_window', 'limit_layer_random', 'easy_hard_easy',
    'solvability_coefficient', 'solvability_coefficient_v2', 'solvability_coefficient_v3', 'color_gradient',
  ]);
  if (!supportedStrategies.has(strategy)) throw new Error(`不支持的 Tile Explorer 策略: ${String(strategy)}`);
  const difficulty = input.difficulty ?? 1;
  if (!Number.isInteger(difficulty) || difficulty < 1) throw new Error('difficulty 必须是 >= 1 的整数');
  const rawSequenceSeed = input.sequenceSeed ?? 0;
  const rawPlacementSeed = input.placementSeed ?? 0;
  if (!Number.isInteger(rawSequenceSeed) || !Number.isInteger(rawPlacementSeed)) {
    throw new Error('sequenceSeed 和 placementSeed 必须是整数');
  }
  const sequenceSeed = rawSequenceSeed | 0;
  const placementSeed = rawPlacementSeed | 0;
  const typeCycle = resolveTypeCycle({ ...input, strategy }, sequenceSeed);
  const terrainView = buildTileExplorerTerrainView(input.terrain);
  const freeTileCount = terrainView.physicalLayers.flat().filter(tile => tile.shuffleable).length;
  if (freeTileCount % 3 !== 0) throw new Error(`自由牌数量 ${freeTileCount} 不是 3 的倍数`);
  const rng = input.placementRandomState
    ? DotNetRandom.fromState(input.placementRandomState)
    : new DotNetRandom(placementSeed);

  if (strategy === 'color_gradient') {
    if (!input.colorGradientTypeGroups?.length) {
      throw new Error('ColorGradient 需要 colorGradientTypeGroups');
    }
    assignColorGradient(terrainView.physicalLayers, terrainView.viewLayers, input.colorGradientTypeGroups, rng);
  } else if (strategy === 'sliding_window') {
    assignSlidingWindow(terrainView.physicalLayers, typeCycle, difficulty, rng);
  } else if (
    strategy === 'solvability_coefficient'
    || strategy === 'solvability_coefficient_v2'
    || strategy === 'solvability_coefficient_v3'
  ) {
    const hardTag = Math.trunc(input.levelHardTag ?? 1);
    const defaults = strategy === 'solvability_coefficient'
      ? [hardTag === 1 ? 0.3 : 0.1, 0.6, 0] as const
      : strategy === 'solvability_coefficient_v2'
        ? [hardTag === 1 ? 0.2 : 0.1, 0.5, 1] as const
        : [0, 0.5, 1] as const;
    assignSolvability(
      terrainView.physicalLayers,
      terrainView.viewLayers,
      typeCycle,
      difficulty,
      rng,
      input.solvabilityLowerCoefficient ?? defaults[0],
      input.solvabilityTopCoefficient ?? defaults[1],
      Math.trunc(input.fallbackExtraLayers ?? defaults[2]),
      strategy === 'solvability_coefficient_v3',
      input.solvabilityRandomMode ?? (strategy === 'solvability_coefficient_v3' && hardTag === 1),
    );
  } else {
    assignPhysical(
      terrainView.physicalLayers,
      typeCycle,
      difficulty,
      rng,
      strategy,
      input.easyLayerCount ?? 0,
      input.limitFullFirst ?? (input.levelHardTag !== undefined && input.levelHardTag === 1),
    );
  }

  const assignments = new Map<number, number>();
  const groups = new Map<number, number>();
  for (const tile of terrainView.physicalLayers.flat()) {
    if (tile.shuffleable) {
      if (tile.suit == null || tile.group == null) throw new Error(`tile ${tile.id} 未完成花色分配`);
      assignments.set(tile.id, tile.suit);
      groups.set(tile.id, tile.group);
    }
  }
  return {
    assignments,
    groups,
    viewLayers: terrainView.viewLayers.map(layer => [...layer]),
    typeCycle,
    generatedGroupCount: groups.size / 3,
    strategy,
    sequenceSeed,
    placementSeed,
    placementRandomStateAfter: rng.state(),
  };
}
