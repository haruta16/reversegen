import { generateBoardLayerClosure, getAllTiles } from '../index.js';
import { randomizeParams, type UnifiedParams } from '../batch-generator.js';
import { OfflineGame } from '../solver/offline-game.js';
import { OfflineTile } from '../solver/types.js';
import type { TerrainData } from '../types.js';
import type { CandidateBoard, LayerClosureGeneratorSpec } from './types.js';
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
  spec: LayerClosureGeneratorSpec,
  rootSeed: number,
): GeneratedCandidate {
  const terrainId = String(terrain.levelResId ?? '');
  const seed = deriveSeed(rootSeed, terrainId, attempt, 'candidate');
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
  }, values.get(tile.id) ?? 0)));
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
