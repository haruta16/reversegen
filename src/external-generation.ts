import {
  decodeFromString,
  generateBoard,
  generateBoardLayerClosure,
  generateBoardTileExplorer,
  generateBoardZenMatch,
} from './index.js';
import { buildGenerationLogicalLayers } from './logical-layers.js';
import { getAllTiles, loadTerrainFromJson } from './terrain-loader.js';
import type { DotNetRandomState } from './tile-explorer/random.js';
import type { TileExplorerStrategy } from './tile-explorer/types.js';
import type { TerrainData } from './types.js';

export type GenerationParameterSnapshot = Record<string, unknown> & {
  algorithm: 'cost-ladder' | 'closure' | 'tile-explorer' | 'zen-match';
  levelId?: string;
  colorCount?: string | number;
};

export interface ExternalReplayGenerationInput {
  parameterString: string;
  terrain: unknown;
}

export interface ExternalReplayGenerationOutput {
  replayCode: string;
  algorithm: GenerationParameterSnapshot['algorithm'];
  levelResId?: number;
  elementCount: number;
  levelHash: string;
}

function requiredText(value: unknown, name: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${name} 不能为空`);
  return text;
}

function finiteNumber(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} 必须是有效数字`);
  return number;
}

function integer(value: unknown, name: string, min?: number, max?: number): number {
  const number = finiteNumber(value, name);
  if (!Number.isInteger(number)) throw new Error(`${name} 必须是整数`);
  if (min != null && number < min) throw new Error(`${name} 不能小于 ${min}`);
  if (max != null && number > max) throw new Error(`${name} 不能大于 ${max}`);
  return number;
}

function ratio(value: unknown, name: string, fallback?: number): number {
  if ((value == null || value === '') && fallback != null) return fallback;
  const number = finiteNumber(value, name);
  if (number < 0 || number > 1) throw new Error(`${name} 必须在 0–1 之间`);
  return number;
}

function parseIntegerList(value: unknown, name: string): number[] | undefined {
  if (value == null || String(value).trim() === '') return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  return raw.map((item, index) => integer(item, `${name}[${index}]`));
}

function parseOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value == null || value === '') return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`${name} 必须是 true 或 false`);
}

function parseTerrain(value: unknown): TerrainData {
  if (typeof value === 'string') {
    const json = requiredText(value, 'terrain');
    return loadTerrainFromJson(json);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('terrain 必须是关卡 JSON 对象或 JSON 字符串');
  }
  return loadTerrainFromJson(JSON.stringify(value));
}

function decodeBase64UrlJson(encoded: string): GenerationParameterSnapshot {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('RGP1 参数串包含非法字符');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('RGP1 参数串无法解码');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('RGP1 参数串内容无效');
  }
  return parsed as GenerationParameterSnapshot;
}

/**
 * Decode the exact formats currently emitted by the main page's copy button:
 * Cost (4 positional fields), LayerClosure (8 positional fields),
 * Zen Match (5 positional fields), and legacy RGP1.
 */
export function decodeGenerationParameterString(input: string): GenerationParameterSnapshot {
  const raw = requiredText(input, 'parameterString');
  if (raw.length > 128 * 1024) throw new Error('parameterString 不能超过 128 KB');

  if (raw.startsWith('{')) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error('JSON 参数串无法解析'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON 参数串内容无效');
    }
    return parsed as GenerationParameterSnapshot;
  }
  if (raw.startsWith('RGP1.')) return decodeBase64UrlJson(raw.slice(5));

  const parts = raw.replace(/：/g, ':').split(':').map(part => part.trim());
  if (parts.length === 9 && parts[8] === '') parts.pop();
  if (parts.length === 5 && /^zen(?:match)?$/i.test(parts[0])) {
    return {
      algorithm: 'zen-match',
      colorCount: parts[1],
      zenStrategy: parts[2],
      seed: parts[3],
      levelId: parts[4],
    };
  }
  if (parts.length === 8) {
    return {
      levelId: parts[7],
      algorithm: 'closure',
      colorCount: parts[1],
      closeRates: parts[0].split(',').map(value => String(Number(value) / 100)).join(','),
      dock: parts[2],
      spreadParam: String(Number(parts[3]) / 100),
      debtPersistenceWeight: String(Number(parts[4]) / 100),
      colorAllocationMode: parts[5] === '1' ? 'single-heavy' : 'balanced',
      colorAllocationMaxRatio: String(Number(parts[6]) / 100),
    };
  }
  if (parts.length === 4) {
    return {
      levelId: parts[3],
      algorithm: 'cost-ladder',
      colorCount: parts[1],
      costArray: parts[0],
      targetStd: parts[2],
    };
  }
  throw new Error(
    '参数串格式无效：LayerClosure 需要 8 段，CostLadder 需要 4 段，Zen Match 格式为 Zen:花色:策略:seed:关卡，TileExplorer 需要 RGP1',
  );
}

function validateTerrain(params: GenerationParameterSnapshot, terrain: TerrainData): void {
  const tiles = getAllTiles(terrain);
  const freeTiles = tiles.filter(tile => !tile.isConst);
  if (!terrain.layers.length || !tiles.length) throw new Error('关卡 JSON 中没有有效地形牌');
  if (freeTiles.length % 3 !== 0) throw new Error('关卡自由牌数量必须是 3 的倍数');

  const requestedLevelId = String(params.levelId ?? '').trim();
  if (
    requestedLevelId
    && terrain.levelResId != null
    && requestedLevelId !== String(terrain.levelResId)
  ) {
    throw new Error(`参数串关卡 ${requestedLevelId} 与关卡文件 ${terrain.levelResId} 不一致`);
  }
}

function generateCostReplay(
  params: GenerationParameterSnapshot,
  terrain: TerrainData,
): ExternalReplayGenerationOutput {
  const colorCount = integer(params.colorCount, 'colorCount', 1, 99);
  const costArray = requiredText(params.costArray, 'costArray')
    .split(',')
    .map((value, index) => integer(value.trim(), `costArray[${index}]`, 1));
  const expectedSteps = getAllTiles(terrain).filter(tile => !tile.isConst).length / 3;
  if (costArray.length !== expectedSteps) {
    throw new Error(`Cost 数组需要 ${expectedSteps} 项，实际为 ${costArray.length} 项`);
  }
  const result = generateBoard({ terrain, costArray, colorCount });
  const replay = decodeFromString(result.replayCode);
  return {
    replayCode: result.replayCode,
    algorithm: 'cost-ladder',
    levelResId: terrain.levelResId,
    elementCount: replay?.elementCount ?? colorCount,
    levelHash: result.levelHash,
  };
}

function generateClosureReplay(
  params: GenerationParameterSnapshot,
  terrain: TerrainData,
): ExternalReplayGenerationOutput {
  const colorCount = integer(params.colorCount, 'colorCount', 1, 99);
  const dock = integer(params.dock, 'dock', 1, 20);
  const spreadParam = ratio(params.spreadParam, 'spreadParam', 0.5);
  const debtPersistenceWeight = ratio(params.debtPersistenceWeight, 'debtPersistenceWeight', 0);
  const colorAllocationMode = params.colorAllocationMode === 'single-heavy' ? 'single-heavy' : 'balanced';
  const colorAllocationMaxRatio = ratio(params.colorAllocationMaxRatio, 'colorAllocationMaxRatio', 1);
  if (colorAllocationMaxRatio <= 0) throw new Error('colorAllocationMaxRatio 必须大于 0');

  const depthCount = buildGenerationLogicalLayers(terrain).layers.length;
  let closeRates = requiredText(params.closeRates, 'closeRates')
    .split(',')
    .map((value, index) => ratio(value.trim(), `closeRates[${index}]`));
  if (
    closeRates.length === depthCount
    && Math.abs(closeRates[closeRates.length - 1] - 1) < 0.0001
  ) {
    closeRates = closeRates.slice(0, -1);
  }
  const expectedRates = Math.max(0, depthCount - 1);
  if (closeRates.length !== expectedRates) {
    throw new Error(`闭合率需要 ${expectedRates} 项（复制串可额外带末尾 100%），实际为 ${closeRates.length} 项`);
  }

  const result = generateBoardLayerClosure({
    terrain,
    closeRates,
    colorCount,
    dock,
    spreadParam,
    debtPersistenceWeight,
    colorAllocationMode,
    colorAllocationMaxRatio,
  });
  const replay = decodeFromString(result.replayCode);
  return {
    replayCode: result.replayCode,
    algorithm: 'closure',
    levelResId: terrain.levelResId,
    elementCount: replay?.elementCount ?? colorCount,
    levelHash: result.levelHash,
  };
}

function generateTileExplorerReplay(
  params: GenerationParameterSnapshot,
  terrain: TerrainData,
): ExternalReplayGenerationOutput {
  const colorCount = integer(params.colorCount, 'colorCount', 1, 99);
  const strategy = String(params.teStrategy || 'default') as TileExplorerStrategy;
  const difficulty = integer(params.difficulty ?? 1, 'difficulty', 1);
  const sequenceSeed = integer(params.sequenceSeed ?? 0, 'sequenceSeed');
  const placementSeed = integer(params.placementSeed ?? 0, 'placementSeed');
  const placementRandomState = params.placementRandomState == null || params.placementRandomState === ''
    ? undefined
    : typeof params.placementRandomState === 'string'
      ? JSON.parse(params.placementRandomState) as DotNetRandomState
      : params.placementRandomState as DotNetRandomState;
  const isSolvability = strategy.startsWith('solvability_coefficient');
  const isLimit = strategy === 'limit_layer_random';
  const isGradient = strategy === 'color_gradient';
  const explicitCycle = parseIntegerList(params.typeCycle, 'typeCycle');
  const gradientGroups = params.colorGradientTypeGroups == null || params.colorGradientTypeGroups === ''
    ? undefined
    : typeof params.colorGradientTypeGroups === 'string'
      ? JSON.parse(params.colorGradientTypeGroups) as number[][]
      : params.colorGradientTypeGroups as number[][];

  const result = generateBoardTileExplorer({
    terrain,
    strategy,
    difficulty,
    colorCount,
    tileTypesCanUse: colorCount,
    sequenceSeed,
    placementSeed,
    placementRandomState,
    typeCycle: isGradient ? undefined : explicitCycle,
    tileTypeWeights: isGradient || explicitCycle ? undefined : parseIntegerList(params.typeWeights, 'typeWeights'),
    easyLayerCount: strategy === 'default' ? integer(params.easyLayerCount ?? 0, 'easyLayerCount', 0) : undefined,
    levelHardTag: isLimit || isSolvability ? integer(params.hardTag ?? 1, 'hardTag') : undefined,
    limitFullFirst: isLimit ? parseOptionalBoolean(params.limitFullFirst, 'limitFullFirst') : undefined,
    solvabilityLowerCoefficient: isSolvability && params.lowerCoefficient != null && params.lowerCoefficient !== ''
      ? ratio(params.lowerCoefficient, 'lowerCoefficient')
      : undefined,
    solvabilityTopCoefficient: isSolvability && params.topCoefficient != null && params.topCoefficient !== ''
      ? ratio(params.topCoefficient, 'topCoefficient')
      : undefined,
    fallbackExtraLayers: isSolvability && params.fallbackExtraLayers != null && params.fallbackExtraLayers !== ''
      ? integer(params.fallbackExtraLayers, 'fallbackExtraLayers', 0)
      : undefined,
    solvabilityRandomMode: isSolvability
      ? parseOptionalBoolean(params.solvabilityRandomMode, 'solvabilityRandomMode')
      : undefined,
    colorGradientTypeGroups: isGradient ? gradientGroups : undefined,
  });
  const replay = decodeFromString(result.replayCode);
  return {
    replayCode: result.replayCode,
    algorithm: 'tile-explorer',
    levelResId: terrain.levelResId,
    elementCount: replay?.elementCount ?? colorCount,
    levelHash: result.levelHash,
  };
}

function generateZenMatchReplay(
  params: GenerationParameterSnapshot,
  terrain: TerrainData,
): ExternalReplayGenerationOutput {
  const uniqueCount = integer(params.colorCount, 'colorCount', 1, 64);
  const seed = integer(params.seed ?? 0, 'seed');
  const strategy = integer(params.zenStrategy ?? 4, 'zenStrategy');
  if (strategy !== 4 && strategy !== 5) throw new Error('zenStrategy 必须是 4 或 5');
  const result = generateBoardZenMatch({
    terrain,
    uniqueCount,
    seed,
    strategy,
  });
  const replay = decodeFromString(result.replayCode);
  return {
    replayCode: result.replayCode,
    algorithm: 'zen-match',
    levelResId: terrain.levelResId,
    elementCount: replay?.elementCount ?? result.actualColorCount,
    levelHash: result.levelHash,
  };
}

export function generateReplayFromExternalInput(
  input: ExternalReplayGenerationInput,
): ExternalReplayGenerationOutput {
  const params = decodeGenerationParameterString(input.parameterString);
  if (!['cost-ladder', 'closure', 'tile-explorer', 'zen-match'].includes(params.algorithm)) {
    throw new Error('参数串缺少有效 algorithm');
  }
  const terrain = parseTerrain(input.terrain);
  validateTerrain(params, terrain);
  if (params.algorithm === 'cost-ladder') return generateCostReplay(params, terrain);
  if (params.algorithm === 'closure') return generateClosureReplay(params, terrain);
  if (params.algorithm === 'zen-match') return generateZenMatchReplay(params, terrain);
  return generateTileExplorerReplay(params, terrain);
}
