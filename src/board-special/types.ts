/**
 * 大型地形（棋盘特殊物，ssExtraEnum 51/52/53）— 类型与常量。
 *
 * 对齐 Unity BoardSpecialInsertionSystem / BoardSpecialRuntimeSystem：
 * - 结构不是 Tile，不进 Desk/Dock/洗牌/分析，只作为遮挡障碍物叠加在普通牌上；
 * - 装载期按模式生成放置计划并注入（独立派生种子）；
 * - 运行期：被覆盖牌保持不可点击；结构的全部依赖离开 Desk 后自动移除（FadeOut → IsRemoved）。
 */

/** 注入模式（对齐 BoardSpecialModeConfig：53 > 52 > 51 优先级）。 */
export type BoardSpecialMode =
  /** 51 大型地形：层数驱动的标准放置（footprint 2/3 交替） */
  | 'standard'
  /** 52 Pizza 盒订单：披萨放置计划 */
  | 'pizza'
  /** 53 奖券订单：3 个 3×2 奖券 */
  | 'ticket';

/** 结构 footprint（格子数，对齐 BoardSpecialFootprint）。 */
export interface BoardSpecialFootprint {
  width: number;
  height: number;
}

/** 运行时棋盘特殊物结构（对齐 BoardSpecialStructure 的逻辑面）。 */
export interface BoardSpecialStructure {
  id: number;
  /** 51 / 52 / 53 */
  extraEnum: number;
  footprint: BoardSpecialFootprint;
  /** 注入层（源层 + 1，reversegen 不做层平移，仅用于依赖/覆盖分层） */
  layer: number;
  posX: number;
  posY: number;
  /** 下层覆盖面积 ≥ 半格（50）的普通牌 —— 全部离开 Desk 后结构自动移除 */
  dependencies: number[];
  /** 被本结构压住的更高层普通牌（不可点击直至结构移除） */
  coveredTileIds: number[];
  isRemoved: boolean;
}

/** 放置计划条目（对齐 BoardSpecialPlacementSystem.Placement）。 */
export interface BoardSpecialPlacement {
  sourceLayerIndex: number;
  footprint: BoardSpecialFootprint;
  posX: number;
  posY: number;
}

/**
 * 几何单元（对齐 LargeTerrainTileUtils.TileUnit）：普通牌 10×10、中心间距 10，
 * TileUnit = 10（tile 宽度）；半格 = 5。棋盘边界（LevelWidth/Height）与 tile 坐标同量纲。
 */
export const BOARD_TILE_UNIT = 10;
export const HALF_TILE_UNIT = 5;
/** 依赖覆盖最小宽度/高度（对齐 HasDependencyCoverage：≥ 半格）。 */
export const MIN_DEPENDENCY_COVERAGE = 5;
