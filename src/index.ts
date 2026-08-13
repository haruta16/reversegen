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

import type { TerrainData, ReverseGenOutput, LayerClosureInput, LayerClosureOutput, DebtMetrics, ColorAllocationMode } from './types.js';
import { getAllTiles, getConstTiles } from './terrain-loader.js';
import { MAX_DOCK_SLOTS } from './constants.js';
import { runReverseGen } from './reverse-gen.js';
import { runLayerClosureGen } from './layer-closure-gen.js';
import { runTileExplorerGen } from './tile-explorer/generator.js';
import { runZenMatchGen } from './zen-match/generator.js';
import { generateReplayCode, getCanonicalTileOrder } from './replay-serializer.js';
import { logger } from './logger.js';
import type { TileExplorerBoardOutput, TileExplorerInput } from './tile-explorer/types.js';
import type { ZenMatchBoardOutput, ZenMatchInput } from './zen-match/types.js';

// ── 高层 API 类型 ──

/** generateBoard 的输入参数 */
export interface GenerateBoardInput {
  /** 地形数据（从 JSON 加载或自动生成） */
  terrain: TerrainData;
  /** Cost 目标数组 */
  costArray: number[];
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

// ── LayerClosure 高层 API 类型 ──

/** generateBoardLayerClosure 的输入参数 */
export interface GenerateBoardLayerClosureInput {
  terrain: TerrainData;
  /** 闭合率数组 [0-1]，长度 = 深度层数 - 1 */
  closeRates: number[];
  /** 花色数（花色值自动为 1..colorCount） */
  colorCount: number;
  /** Dock 容量（默认 7，仅用于指标） */
  dock?: number;
  /** Level hash 覆盖 */
  levelHash?: string;
  /**
   * 同色方块分布参数 [0-1]。
   * 0=cluster（紧密） / 0.5=neutral（随机，默认） / 1=spread（分散）。
   */
  spreadParam?: number;
  /**
   * 债务持续权重 [0-1]（默认 0）。
   * 0=尽量清旧债 / 1=尽量延旧债。闭合率负责"每层有多少债务"，此参数负责"是不是同一批债务"。
   */
  debtPersistenceWeight?: number;
  /**
   * 花色配额方式（默认 'balanced'）。
   * 'balanced' = 均匀分配 / 'single-heavy' = 单色极重（一个主花色集中，其余各 1 组）。
   */
  colorAllocationMode?: ColorAllocationMode;
  /** single-heavy 主色占总 triplet 的比例上限。 */
  colorAllocationMaxRatio?: number;
  /** 花色配额随机源；批量任务可传入种子 RNG。 */
  colorAllocationRng?: () => number;
  /** 本次生成的统一随机源；优先于旧的 colorAllocationRng。 */
  rng?: () => number;
}

/** generateBoardLayerClosure 的输出 */
export interface GenerateBoardLayerClosureOutput extends LayerClosureOutput {
  replayCode: string;
  levelHash: string;
}

/** Tile Explorer 第三生成器的高层输入。 */
export interface GenerateBoardTileExplorerInput extends TileExplorerInput {
  /** Level hash 覆盖。 */
  levelHash?: string;
}

/** Tile Explorer 算法结果 + ReverseGen 通用 ReplayCode。 */
export type GenerateBoardTileExplorerOutput = TileExplorerBoardOutput;

/** Zen Match strategy 4/5 input plus an optional ReplayCode hash override. */
export interface GenerateBoardZenMatchInput extends ZenMatchInput {
  levelHash?: string;
}

/** Zen Match semantic generation result plus ReverseGen ReplayCode. */
export type GenerateBoardZenMatchOutput = ZenMatchBoardOutput;

function buildReplay(
  terrain: TerrainData,
  assignments: ReadonlyMap<number, number>,
  hashOverride?: string,
): { replayCode: string; levelHash: string } {
  const allTiles = getAllTiles(terrain);
  const levelHash = hashOverride ?? terrain.levelHash ?? '';
  const elementValues = new Map<number, number>();
  for (const tile of getConstTiles(terrain)) {
    if (tile.constElementValue > 0) elementValues.set(tile.id, tile.constElementValue);
  }
  for (const [tileId, value] of assignments) elementValues.set(tileId, value);
  return {
    replayCode: generateReplayCode(getCanonicalTileOrder(allTiles), elementValues, levelHash),
    levelHash: levelHash || '(none)',
  };
}

/**
 * 高层 API: 加载地形 → 运行 ReverseGen → 生成 ReplayCode。
 * 这是大多数场景的推荐入口。
 */
export function generateBoard(input: GenerateBoardInput): GenerateBoardOutput {
  const { terrain, costArray, colorCount, levelHash: hashOverride } = input;

  const allTiles = getAllTiles(terrain);

  logger.info('═══════════════════════════════════════');
  logger.info('  ReverseGen 牌局生成');
  logger.info('═══════════════════════════════════════');

  // 运行算法
  const algoResult = runReverseGen({ tiles: allTiles, costArray, colorCount });

  if (!algoResult.completed) {
    logger.warn('算法未成功完成！');
  }

  const replay = buildReplay(terrain, algoResult.assignments, hashOverride);

  logger.info('═══════════════════════════════════════');

  return { ...algoResult, ...replay };
}

/**
 * 高层 API: LayerClosure 算法。
 * 加载地形 → 运行 LayerClosure → 生成 ReplayCode。
 */
export function generateBoardLayerClosure(
  input: GenerateBoardLayerClosureInput,
): GenerateBoardLayerClosureOutput {
  const {
    terrain,
    closeRates,
    colorCount,
    dock = MAX_DOCK_SLOTS,
    levelHash: hashOverride,
    spreadParam,
    debtPersistenceWeight,
    colorAllocationMode,
    colorAllocationMaxRatio,
    colorAllocationRng,
    rng,
  } = input;

  logger.info('═══════════════════════════════════════');
  logger.info('  LayerClosure 牌局生成');
  logger.info('═══════════════════════════════════════');

  const algoResult = runLayerClosureGen({
    terrain,
    colorCount,
    dock,
    closeRates,
    spreadParam,
    debtPersistenceWeight,
    colorAllocationMode,
    colorAllocationMaxRatio,
    colorAllocationRng,
    rng,
  });

  const m = algoResult.metrics;
  logger.info(`  层数:${m.depthCount} 方块:${m.totalTiles} 花色:${m.colorCount}`);
  logger.info(`  闭合率: [${m.actualCloseRates.map(r => (r * 100).toFixed(0) + '%').join(', ')}]`);
  logger.info(`  花色使用率: [${m.colorUsageRates.map(r => (r * 100).toFixed(0) + '%').join(', ')}]`);
  logger.info(`  债务保留率: [${m.debtRetentionRates.map(r => (r * 100).toFixed(0) + '%').join(', ')}]`);
  logger.info(`  债务持续权重 p=${m.configuredDebtPersistenceWeight} 保留旧债tile:[${m.retainedOldDebtTilesByLayer.join(', ')}] 总计:${m.totalRetainedOldDebtTiles}`);
  logger.info(`  债务持续长度直方图: [${m.debtDurationHistogram.join(', ')}]`);
  logger.info(`  峰值债务:${m.peakDebt} 暴露峰值:${m.peakExpDebt} OI:${m.oi}`);
  logger.info(`  必输: ${m.isDoomed ? '是' : '否'}`);

  const replay = buildReplay(terrain, algoResult.assignments, hashOverride);

  logger.info('═══════════════════════════════════════');

  return { ...algoResult, ...replay };
}

/**
 * 高层 API: Tile Explorer 正常牌算法。
 * view_layers 由 Terrain Dependencies 自动计算。
 */
export function generateBoardTileExplorer(
  input: GenerateBoardTileExplorerInput,
): GenerateBoardTileExplorerOutput {
  const { levelHash, ...algorithmInput } = input;
  logger.info('═══════════════════════════════════════');
  logger.info(`  TileExplorer 牌局生成 · ${input.strategy ?? 'default'}`);
  logger.info('═══════════════════════════════════════');
  const result = runTileExplorerGen(algorithmInput);
  const replay = buildReplay(input.terrain, result.assignments, levelHash);
  logger.info(`  逻辑层:${result.viewLayers.length} 分组:${result.generatedGroupCount} 花色循环:${result.typeCycle.length}`);
  logger.info('═══════════════════════════════════════');
  return { ...result, ...replay };
}

/**
 * High-level Zen Match generator. Converted Shell tile IDs are used directly;
 * the Zen export's +1 ID offset preserves node ordering without a second ID map.
 */
export function generateBoardZenMatch(
  input: GenerateBoardZenMatchInput,
): GenerateBoardZenMatchOutput {
  const { levelHash, ...algorithmInput } = input;
  logger.info('═══════════════════════════════════════');
  logger.info(`  Zen Match 牌局生成 · strategy ${input.strategy ?? 4}`);
  logger.info('═══════════════════════════════════════');
  const result = runZenMatchGen(algorithmInput);
  const replay = buildReplay(input.terrain, result.assignments, levelHash);
  logger.info(
    `  花色:${result.actualColorCount}/${result.requestedUniqueCount} `
    + `顶部保底:${result.topMatchTileIds.length} Seed:${result.seed}`,
  );
  logger.info('═══════════════════════════════════════');
  return { ...result, ...replay };
}

// ── 公共 API 重新导出 ──

// 类型
export type {
  TerrainTile,
  TerrainData,
  TerrainStructure,
  TransferTerrainStructure,
  FallingTerrainStructure,
  ReverseGenOutput,
  CostStats,
  DockEntry,
  ReplayData,
  LayerClosureInput,
  LayerClosureOutput,
  DebtMetrics,
  ColorAllocationMode,
} from './types.js';

export { TileState } from './types.js';

// 算法
export { runReverseGen } from './reverse-gen.js';
export { runLayerClosureGen, computeDependencyDepth, assignColorTotals } from './layer-closure-gen.js';
export { buildGenerationLogicalLayers } from './logical-layers.js';
export type { GenerationLogicalLayers } from './logical-layers.js';
export { runTileExplorerGen, colorGradientLayerGroups } from './tile-explorer/generator.js';
export { buildTileExplorerTerrainView } from './tile-explorer/view-layers.js';
export { DotNetRandom, seededShuffle } from './tile-explorer/random.js';
export { runZenMatchGen } from './zen-match/generator.js';
export type {
  TileExplorerStrategy,
  TileExplorerInput,
  TileExplorerOutput,
  TileExplorerBoardOutput,
  TileExplorerTile,
} from './tile-explorer/types.js';
export type { DotNetRandomState } from './tile-explorer/random.js';
export type {
  ZenMatchStrategy,
  ZenMatchInput,
  ZenMatchOutput,
  ZenMatchBoardOutput,
} from './zen-match/types.js';

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

// 依赖图 / 贪心模拟 / 闭合率指标
export { transitiveClosure, computeAllDependencies } from './dependency-graph.js';
export { runPureGreedySimulation } from './greedy-sim.js';
export { computeMetrics, computeExpDebt, computeTileDepSets, computeCloseRatesFromAssignments, computeLayerProgressMetrics } from './layer-closure-gen.js';

// 分档
export {
  computeStability,
  checkCondition,
  gradeStandard,
  gradeRefined,
  gradeStrategy1,
  gradeStrategy2,
  estimateStrategy2Passrate,
  gradeFromPassrate,
  gradeFull,
  validateGrade,
  checkStrategyCondition,
} from './grader.js';
export type {
  SimResult,
  SimSnapshot,
  ConditionType,
  GradeCondition,
  StandardTier,
  RefinedTier,
  GradeConfig,
  GradeVerdict,
  GradeResult,
  GradeValidation,
  StrategyMetric,
  StrategyOperator,
  StrategyCondition,
  StrategyTier,
  GradeStrategy1Config,
  GradeStrategy2Result,
} from './grader.js';

// 工具
export { computeCRC16, computeCRC16Bitwise } from './crc16.js';
export { logger, setLogLevel, LogLevel } from './logger.js';

// 常量
export { MAX_DOCK_SLOTS } from './constants.js';

// 特殊机制（挂件）
export {
  mechanicInfo,
  isKnownMechanic,
  MECHANICS,
  MAGIC_BOTTLE_TARGET_WHITELIST,
  MAGIC_BOTTLE_CONSTANTS,
  BUBBLE_CONSTANTS,
  DANDELION_TARGET_WHITELIST,
  DANDELION_CONSTANTS,
  DANDELION_SINGLE_GROUP_PROBABILITY,
  GIFTBOX_CONSTANTS,
  GIFTBOX_EFFECTS,
  GIFTBOX_EFFECT_WEIGHTS,
  REVEAL_EXTRAS,
  DECAY_EXTRAS,
  MECHANIC_SEED_SALTS,
} from './mechanics/registry.js';
export type { MechanicInfo, MechanicKind, MechanicParamSchema, MechanicBehavior } from './mechanics/registry.js';
export {
  parseMechanicCounts,
  serializeMechanicCounts,
  countTerrainExtras,
  validateMechanicCounts,
  formatBoardSpec,
  parseBoardSpec,
} from './mechanics/spec.js';
export type { MechanicCounts, MechanicSpecError, BoardSpec } from './mechanics/spec.js';

// 机制引擎（确定性移植）
export {
  MechanicEngine,
  MATCH_BEHAVIORS,
  magicBottleShuffleSeed,
  isPotionTargetAllowed,
  selectMagicBottleTargets,
  magicBottleOnMatch,
  isBubbleAssignCandidate,
  selectBubbleAssignTargets,
  isBubbleCollectCandidate,
  dockMagicPlan,
  tileExtrasFromTerrain,
} from './mechanics/engine.js';

// 其余挂件行为（衰减/揭示/订单/蒲公英/礼盒/魔法棒/洗牌）
export {
  extraActionSeed,
  initExtraState,
  isExtraConsumed,
  isUnrevealedUnknownTile,
  applyDecayStep,
  onTileCollected,
  isDandelionTargetAllowed,
  selectDandelionTargets,
  isDandelionMatch,
  selectMagicWandTargets,
  dockDirectedMagicPlan,
  giftBoxAvailableEffects,
  rollGiftBoxEffect,
  selectRandomTiles,
  giftBoxConvertibleGroups,
  selectGiftBoxMagicBottleGroups,
  shuffleBoardSeed,
  shuffleBoard,
} from './mechanics/extras.js';
export type { BubbleState } from './mechanics/engine.js';
export type { TileExtra, MechanicStep, MechanicStepRecord } from './mechanics/types.js';

// 机制行为策略表（新增机制登记处）
export { STEP_APPLIERS } from './mechanics/step-appliers.js';
export type { StepApplier } from './mechanics/step-appliers.js';
export { COLLECT_HOOKS } from './mechanics/extras.js';

// Replay 候选收集与导出
export {
  REPLAY_SELECTION_HEADERS,
  appendReplaySelection,
  buildReplaySelections,
  checkReplaySelections,
  createReplaySelectionRow,
  defaultReplaySelectionPaths,
  serializeReplaySelectionCsv,
} from './replay-selection.js';

// 批量生产策略 v2
export { validateStrategyDefinition } from './strategy/definition.js';
export { generateCandidate } from './strategy/generator.js';
export { executeStrategyPipeline } from './strategy/pipeline.js';
export { runSimulationPolicy, runSimulationPolicyVariants, SIMULATION_PROTOCOL_VERSION } from './strategy/simulation.js';
export { deriveSeed, seededRandom } from './strategy/random.js';
export type {
  CandidateBoard,
  ExecutionEngine,
  FilterStage,
  GeneratorSpec,
  GradeStage,
  LayerClosureGeneratorSpec,
  TileExplorerGeneratorSpec,
  TileExplorerGeneratorMetrics,
  PipelineStage,
  SimulateStage,
  SimulationPolicySpec,
  SimulationSummary,
  StageResult,
  StrategyDefinition,
  StrategyRunRecord,
} from './strategy/types.js';
export type {
  AppendReplaySelectionResult,
  BuildReplaySelectionResult,
  ReplaySelectionInput,
  ReplaySelectionPaths,
  ReplaySelectionRow,
  ReplaySelectionSummary,
} from './replay-selection.js';
