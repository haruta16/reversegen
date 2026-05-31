/**
 * ReverseGen 公共 API。
 *
 * 从 Unity 解耦的独立牌局生成工具。三种使用方式:
 *   1. 代码 API: import { generateBoard } from 'reversegen'
 *   2. 命令行: npx tsx cli/generate.ts
 *   3. Web GUI: npm run gui
 *
 * @example
 *   const terrain = loadTerrainFromFile('level.json');
 *   const result = generateBoard({ terrain, costArray: [3, 3, 2], colorCount: 8 });
 *   console.log(result.replayCode);
 */

import type { TerrainData, ReverseGenOutput } from './types.js';
import { getAllTiles, getConstTiles } from './terrain-loader.js';
import { runReverseGen } from './reverse-gen.js';
import { generateReplayCode, getCanonicalTileOrder } from './replay-serializer.js';
import { logger } from './logger.js';

// ── 高层 API 类型 ──

/** generateBoard 的输入参数 */
export interface GenerateBoardInput {
  /** 地形数据（从 JSON 加载或自动生成） */
  terrain: TerrainData;
  /** Cost 目标数组，null 表示自然 minCost 模式 */
  costArray?: number[] | null;
  /** 可用花色数量 */
  colorCount: number;
  /** 可选的 level hash 覆盖（默认使用地形中的 hash） */
  levelHash?: string;
}

/** generateBoard 的输出 — 算法结果 + ReplayCode */
export interface GenerateBoardOutput extends ReverseGenOutput {
  /** 生成的 ReplayCode（Base64 字符串） */
  replayCode: string;
  /** 使用的地形 level hash */
  levelHash: string;
}

/**
 * 高层 API: 加载地形 → 运行 ReverseGen → 生成 ReplayCode。
 * 这是大多数场景的推荐入口。
 */
export function generateBoard(input: GenerateBoardInput): GenerateBoardOutput {
  const { terrain, costArray, colorCount, levelHash: hashOverride } = input;

  const allTiles = getAllTiles(terrain);
  const levelHash = hashOverride ?? terrain.levelHash ?? '';

  logger.info('═══════════════════════════════════════');
  logger.info('  ReverseGen 牌局生成');
  logger.info('═══════════════════════════════════════');

  // 运行算法
  const algoResult = runReverseGen({ tiles: allTiles, costArray, colorCount });

  if (!algoResult.completed) {
    logger.warn('算法未成功完成！');
  }

  // 构建所有牌的花色映射（固定牌 + 已分配牌）
  const elementValues = new Map<number, number>();
  for (const t of getConstTiles(terrain)) {
    if (t.constElementValue > 0) elementValues.set(t.id, t.constElementValue);
  }
  for (const [tileId, normValue] of algoResult.assignments) {
    elementValues.set(tileId, normValue);
  }

  // 规范排序 → 生成 ReplayCode
  const orderedTiles = getCanonicalTileOrder(allTiles);
  const replayCode = generateReplayCode(orderedTiles, elementValues, levelHash);

  logger.info('═══════════════════════════════════════');

  return { ...algoResult, replayCode, levelHash: levelHash || '(none)' };
}

// ── 公共 API 重新导出 ──

// 类型
export type {
  TerrainTile,
  TerrainData,
  ReverseGenOutput,
  CostStats,
  DockEntry,
  ReplayData,
} from './types.js';

export { TileState } from './types.js';

// 算法
export { runReverseGen } from './reverse-gen.js';

// 序列化
export {
  generateReplayCode,
  encodeToString,
  decodeFromString,
  getCanonicalTileOrder,
  looksLikeReplayCode,
  parseLevelHash,
  formatHash,
  FORMAT_VERSION,
} from './replay-serializer.js';

// 地形
export {
  loadTerrainFromFile,
  getAllTiles,
  getConstTiles,
  printTerrainSummary,
} from './terrain-loader.js';

// Cost 生成器
export { generateCostArray, generateForTerrain } from './cost-generator.js';

// 工具
export { computeCRC16, computeCRC16Bitwise } from './crc16.js';
export { logger, setLogLevel, LogLevel } from './logger.js';
