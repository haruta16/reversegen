/**
 * 跨侧追踪构建器 — 从「地形 + ReplayCode + 机制 + 动作序列」重建 reversegen 逐帧追踪。
 * CLI（tools/verify-cross-side.ts）与 GUI（/api/trace）共用，避免双份装载逻辑。
 */

import {
  loadTerrainFromFile,
  getAllTiles,
  getCanonicalTileOrder,
  decodeFromString,
  buildReplayElementMap,
  mapReplayElementValue,
  parseMechanicCounts,
} from '../index.js';
import { createGame } from '../solver/index.js';
import { recordCrossSideTrace, type CrossSideMeta, type CrossSideTrace } from './cross-side-trace.js';

export interface TraceBuildInput {
  terrainPath: string;
  replayCode: string;
  mechanics?: string;
  mechanicSeed?: number;
  /** 礼盒开放效果（缺省全开） */
  giftboxOpenEffects?: number[];
  /** 逐帧收牌动作（tileId 序列） */
  actions: number[];
}

/** 从输入重建追踪（含 meta；复用 gui/lib/runtime 同款装载语义）。 */
export function buildTraceFromInputs(input: TraceBuildInput): CrossSideTrace {
  const terrain = loadTerrainFromFile(input.terrainPath);
  const ordered = getCanonicalTileOrder(getAllTiles(terrain));
  const replayData = decodeFromString(input.replayCode);
  if (!replayData) throw new Error('ReplayCode 解码失败');

  const elementMap = buildReplayElementMap(ordered, replayData.instanceArray, replayData.elementCount);
  const elementValues = new Map<number, number>();
  for (let i = 0; i < ordered.length && i < replayData.instanceArray.length; i++) {
    const normValue = (replayData.instanceArray[i] & 0x3f) + 1;
    elementValues.set(ordered[i].id, mapReplayElementValue(normValue, elementMap));
  }

  const mechanics = input.mechanics ? parseMechanicCounts(input.mechanics) : undefined;
  const game = createGame({
    terrainTiles: ordered,
    terrainStructures: terrain.terrainStructures,
    elementValues,
    levelResId: terrain.levelResId,
    replayCode: input.replayCode,
    mechanicConfig: mechanics,
    mechanicSeed: input.mechanicSeed,
    giftboxOpenEffects: input.giftboxOpenEffects ? new Set(input.giftboxOpenEffects) : undefined,
    boardBounds: terrain.LevelWidth && terrain.LevelHeight
      ? { width: terrain.LevelWidth, height: terrain.LevelHeight }
      : undefined,
  });

  const trace = recordCrossSideTrace(game, input.actions);
  const meta: CrossSideMeta = {
    levelResId: terrain.levelResId,
    replayCode: input.replayCode,
    mechanics: input.mechanics,
    giftboxOpenEffects: input.giftboxOpenEffects,
    boardBounds: terrain.LevelWidth && terrain.LevelHeight
      ? { width: terrain.LevelWidth, height: terrain.LevelHeight }
      : undefined,
    mechanicSeed: input.mechanicSeed,
  };
  trace.meta = meta;
  return trace;
}
