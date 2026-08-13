/**
 * 地形 / 关卡领域类型。
 *
 * 从 src/types.ts 拆出，统一由 src/types.ts re-export。
 */

/** 地形中的单张牌（最小数据单元） */
export interface TerrainTile {
  /** 唯一标识 */
  id: number;
  /** TileMatch 物理层（0 = 最顶层/初始可见层，数字越大越靠下） */
  layer: number;
  /** 直接依赖的牌的 ID 列表（这张牌压在哪些牌上面） */
  dependencies: number[];
  /** 是否为固定花色（算法不分配） */
  isConst: boolean;
  /** 固定花色的值（仅 isConst 为 true 时有效） */
  constElementValue: number;
  /** 牌面中心坐标 X（用于几何可视性计算） */
  posX: number;
  /** 牌面中心坐标 Y（用于几何可视性计算） */
  posY: number;
  /**
   * 挂件（特殊机制）枚举，数值与 Unity ssExtraEnum 严格一致。
   * 0 = Empty（无机制挂件）。缺省视为 0。两个来源：
   *  1. 地形 JSON 里每张 tile 写着的 extraEnum（静态摆放）
   *  2. 外部注入的机制配置（enum:count，由生成/模拟入口传入）
   */
  extraEnum?: number;
  /** 挂件参数（如大型地形 footprint "2"/"3"），无参数时为空字符串。 */
  extraParam?: string;
}

/** 一层牌 */
export interface TerrainLayer {
  tiles: TerrainTile[];
}

/** 传送带结构：全部牌在生成逻辑中视为首层牌。 */
export interface TransferTerrainStructure {
  type: 'transfer';
  id?: number;
  tileIds: number[];
  tileNum?: number;
}

/** 掉落结构：首批显示 viewLength 张，之后按 tileIds 顺序补牌。 */
export interface FallingTerrainStructure {
  type: 'falling';
  id?: number;
  tileIds: number[];
  tileNum?: number;
  viewLength: number;
}

export type TerrainStructure = TransferTerrainStructure | FallingTerrainStructure;

/** 完整地形/关卡定义 */
export interface TerrainData {
  levelResId?: number;
  levelHash?: string;       // 16 位小写十六进制，如 "550ede7fd250e2d4"
  layers: TerrainLayer[];
  terrainStructures?: TerrainStructure[];
  LevelWidth?: number;
  LevelHeight?: number;
  elementsPerLevel?: number;
}

