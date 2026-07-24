import { generateBoardLayerClosure, generateBoardTileExplorer, getAllTiles } from '../index.js';
import { colorCountFromRatio, randomizeParams, type UnifiedParams } from '../batch-generator.js';
import { OfflineGame } from '../solver/offline-game.js';
import { OfflineTile } from '../solver/types.js';
import type { TerrainData } from '../types.js';
import type { CandidateBoard, GeneratorSpec, LayerClosureGeneratorSpec, TileExplorerGeneratorSpec } from './types.js';
import { deriveSeed, seededRandom } from './random.js';

function unifiedParameters(spec: LayerClosureGeneratorSpec): UnifiedParams {
  const parameters = spec.parameters;
  const close = parameters.close_rates;
  const colors = parameters.color_count;
  const spread = parameters.spread;
  const debt = parameters.debt;
  return {
    closeRates: close.kind === 'fixed' ? close.values.join(',') : 'random',
    closeRateRange: close.kind === 'range' ? { min: close.min, max: close.max } : undefined,
    colorCount: colors.kind === 'fixed' ? colors.value : 'random',
    colorCountRatio: colors.kind === 'ratio_range' ? colors.min : 0.6,
    colorRatioRange: colors.kind === 'ratio_range' ? { min: colors.min, max: colors.max } : undefined,
    colorJitter: colors.kind === 'ratio_range' ? colors.jitter ?? 0 : 0,
    spreadParam: spread.kind === 'fixed' ? spread.value : 'random',
    spreadRange: spread.kind === 'range' ? { min: spread.min, max: spread.max } : undefined,
    debtPersistenceWeight: debt.kind === 'fixed' ? debt.value : 'random',
    debtRange: debt.kind === 'range' ? { min: debt.min, max: debt.max } : undefined,
    colorAllocationMode: parameters.color_allocation.mode === 'single_heavy' ? 'single-heavy' : 'balanced',
    colorAllocationMaxRatio: parameters.color_allocation.mode === 'single_heavy'
      ? parameters.color_allocation.max_ratio
      : undefined,
  };
}

export interface GeneratedCandidate {
  candidate: CandidateBoard;
  game: OfflineGame;
}

export function generateCandidate(
  terrain: TerrainData,
  terrainPath: string,
  attempt: number,
  spec: GeneratorSpec,
  rootSeed: number,
): GeneratedCandidate {
  const terrainId = String(terrain.levelResId ?? '');
  const seed = deriveSeed(rootSeed, terrainId, attempt, 'candidate');
  if (spec.method === 'tile_explorer') {
    return generateTileExplorerCandidate(terrain, terrainPath, attempt, spec, seed, terrainId);
  }
  const params = randomizeParams(unifiedParameters(spec), terrain, seededRandom(seed, 'parameters'));
  const result = generateBoardLayerClosure({
    terrain,
    closeRates: params.closeRates,
    colorCount: params.colorCount,
    dock: 7,
    spreadParam: params.spreadParam,
    debtPersistenceWeight: params.debtPersistenceWeight,
    colorAllocationMode: params.colorAllocationMode,
    colorAllocationMaxRatio: params.colorAllocationMaxRatio,
    rng: seededRandom(seed, 'generator'),
  });
  const allTiles = getAllTiles(terrain);
  const values = new Map(result.assignments);
  for (const tile of allTiles) {
    if (tile.isConst && tile.constElementValue > 0) values.set(tile.id, tile.constElementValue);
  }
  const game = new OfflineGame(allTiles.map(tile => new OfflineTile({
    id: tile.id,
    layer: tile.layer,
    dependencies: [...tile.dependencies],
    isConst: tile.isConst,
    constElementValue: tile.constElementValue,
    posX: tile.posX,
    posY: tile.posY,
  }, values.get(tile.id) ?? 0)), terrain.terrainStructures);
  return {
    candidate: {
      terrain_id: terrainId,
      terrain_path: terrainPath,
      tile_count: allTiles.length,
      attempt,
      seed,
      generator: {
        method: spec.method,
        version: spec.version,
        parameters: {
          close_rates: params.closeRates,
          color_count: params.colorCount,
          spread: params.spreadParam,
          debt: params.debtPersistenceWeight,
          color_allocation: params.colorAllocationMode,
          color_allocation_max_ratio: params.colorAllocationMaxRatio ?? null,
        },
        metrics: result.metrics,
      },
      assignments: [...result.assignments.entries()].sort((a, b) => a[0] - b[0]),
      replay_code: result.replayCode,
    },
    game,
  };
}

function generateTileExplorerCandidate(
  terrain: TerrainData,
  terrainPath: string,
  attempt: number,
  spec: TileExplorerGeneratorSpec,
  seed: number,
  terrainId: string,
): GeneratedCandidate {
  const parameterRng = seededRandom(seed, 'parameters');
  const difficultySpec = spec.parameters.difficulty;
  const difficulty = difficultySpec.kind === 'fixed'
    ? difficultySpec.value
    : Math.floor(difficultySpec.min + parameterRng() * (difficultySpec.max - difficultySpec.min + 1));
  const colorSpec = spec.parameters.color_count;
  const freeTiles = getAllTiles(terrain).filter(tile => !tile.isConst).length;
  let colorCount: number;
  if (colorSpec.kind === 'fixed') colorCount = colorSpec.value;
  else {
    const ratio = colorSpec.min + parameterRng() * (colorSpec.max - colorSpec.min);
    const jitter = Math.max(0, Math.floor(colorSpec.jitter ?? 0));
    const offset = jitter ? Math.floor(parameterRng() * (jitter * 2 + 1)) - jitter : 0;
    colorCount = Math.max(1, colorCountFromRatio(ratio, freeTiles) + offset);
  }
  const sequenceSeed = deriveSeed(seed, 'tile_explorer', 'sequence') | 0;
  const placementSeed = deriveSeed(seed, 'tile_explorer', 'placement') | 0;
  const p = spec.parameters;
  const result = generateBoardTileExplorer({
    terrain,
    strategy: p.strategy,
    difficulty,
    colorCount,
    typeCycle: p.type_cycle,
    tileTypeWeights: p.tile_type_weights,
    sequenceSeed,
    placementSeed,
    easyLayerCount: p.easy_layer_count,
    levelHardTag: p.level_hard_tag,
    limitFullFirst: p.limit_full_first,
    solvabilityLowerCoefficient: p.solvability_lower_coefficient,
    solvabilityTopCoefficient: p.solvability_top_coefficient,
    fallbackExtraLayers: p.fallback_extra_layers,
    solvabilityRandomMode: p.solvability_random_mode,
    colorGradientTypeGroups: p.color_gradient_type_groups,
  });
  const allTiles = getAllTiles(terrain);
  const values = new Map(result.assignments);
  for (const tile of allTiles) {
    if (tile.isConst && tile.constElementValue > 0) values.set(tile.id, tile.constElementValue);
  }
  const game = new OfflineGame(allTiles.map(tile => new OfflineTile({
    id: tile.id,
    layer: tile.layer,
    dependencies: [...tile.dependencies],
    isConst: tile.isConst,
    constElementValue: tile.constElementValue,
    posX: tile.posX,
    posY: tile.posY,
  }, values.get(tile.id) ?? 0)), terrain.terrainStructures);
  return {
    candidate: {
      terrain_id: terrainId,
      terrain_path: terrainPath,
      tile_count: allTiles.length,
      attempt,
      seed,
      generator: {
        method: spec.method,
        version: spec.version,
        parameters: {
          strategy: p.strategy,
          difficulty,
          color_count: colorCount,
          sequence_seed: sequenceSeed,
          placement_seed: placementSeed,
        },
        metrics: {
          strategy: result.strategy,
          difficulty,
          colorCount,
          depthCount: result.viewLayers.length,
          generatedGroupCount: result.generatedGroupCount,
          typeCycle: result.typeCycle,
          sequenceSeed,
          placementSeed,
        },
      },
      assignments: [...result.assignments.entries()].sort((a, b) => a[0] - b[0]),
      replay_code: result.replayCode,
    },
    game,
  };
}
