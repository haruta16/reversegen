/**
 * 特殊机制（挂件）注册表 — 与 Unity 侧逐位对齐。
 *
 * 数值来自 TileMatchShell `ssExtraEnum.cs`（DGuo.Common），语义来自
 * `_InnerClient/Client/TileMatch/GamePlay/Core/Extra/` 各 Extra 实现。
 * 修改本表必须同步核对 Unity 侧枚举，任何数值漂移都会导致机制错位。
 */

/** 挂件来源形态。 */
export type MechanicKind =
  /** 静态：挂在具体 tile 上（地形 JSON 的 extraEnum/extraParam），如魔药 */
  | 'tile'
  /** 动态：对局中按规则产生（泡泡角标），不占具体 tile 初始位 */
  | 'dynamic'
  /** 静态与动态语义并存（如泡泡：tile 上可预挂 + 对局中指派） */
  | 'both';

/** 挂件参数 schema（对齐 Unity extraParam 语义）。 */
export type MechanicParamSchema =
  | 'none'
  /** 大型地形 footprint: "2" 或 "3" */
  | 'footprint'
  /** 泡泡每轮收集数（extraConfig[39] = 0 表示随机 2-3） */
  | 'collect-count';

export interface MechanicInfo {
  /** ssExtraEnum 数值（权威标识，跨语言契约） */
  value: number;
  /** C# 枚举名 */
  name: string;
  /** 中文显示名 */
  label: string;
  /** 来源形态 */
  kind: MechanicKind;
  /**
   * extraConfig 计数的含义（对齐 Unity 各 Manager 的读法）：
   * - 'tile-count': 数值 = 挂该机制的 tile 数量（魔药等静态挂件）
   * - 'behavior-config': 数值 = 行为参数而非数量（泡泡 39：每轮收集数，0=随机 2-3）
   */
  countMeaning: 'tile-count' | 'behavior-config';
  /** 参数 schema */
  paramSchema: MechanicParamSchema;
  /** 固定花色值（IsFixedElementValue），未设置 = 参与花色分配 */
  fixedElementValue?: number;
  /** 可被机制选为目标的挂件白名单（魔药索敌用） */
  targetWhitelist?: number[];
  /** 行为常量（对齐 C# 实现中的 const） */
  constants?: Record<string, number>;
}

// ── 魔药索敌白名单（MagicBottleExtra.MagicBottleTargetExtraWhitelist）──
// 注意：Unity 侧 Ice 与 Linked 被注释排除，保持相同。
export const MAGIC_BOTTLE_TARGET_WHITELIST: number[] = [
  -1, // None
  0,  // Empty
  2,  // Unknown
  202,// Unknown_Interval
  203,// Unknown_BottomFirst
  4,  // GoldenExtra
  5,  // CoinExtra
  6,  // AdventCalendarExtra
  8,  // EasterExtra
  7,  // FlipExtra
  207,// FlipExtra_Layer
  36, // DandelionExtra
];

/** 魔药行为常量（MagicBottleExtra）。 */
export const MAGIC_BOTTLE_CONSTANTS = {
  TARGET_GROUP_COUNT: 6,
  TILES_PER_GROUP: 3,
  FIXED_ELEMENT_VALUE: 1301,
} as const;

/** 泡泡行为常量（TileMatchBubbleCollectMgr）。 */
export const BUBBLE_CONSTANTS = {
  MIN_COLLECT_COUNT: 1,
  DEFAULT_COLLECT_COUNT: 3,
  MAX_COLLECT_COUNT: 4,
  MAX_COLLECT_ROUNDS: 3,
} as const;

/** ssExtraEnum 全表（数值 → 信息）。 */
export const MECHANICS: Record<number, MechanicInfo> = {
  [-1]: { value: -1, name: 'None', label: '无', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none' },
  [0]: { value: 0, name: 'Empty', label: '空挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none' },
  [1]: { value: 1, name: 'Ice', label: '冰封挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none' },
  [2]: { value: 2, name: 'Unknown', label: '问号挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none' },
  [3]: { value: 3, name: 'Linked', label: '锁链挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none' },
  [4]: { value: 4, name: 'GoldenExtra', label: '黄金挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none' },
  [5]: { value: 5, name: 'CoinExtra', label: '金币挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none' },
  [6]: { value: 6, name: 'AdventCalendarExtra', label: '倒计时日历挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none' },
  [7]: { value: 7, name: 'FlipExtra', label: '翻转挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none' },
  [8]: { value: 8, name: 'EasterExtra', label: '复活节挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none' },
  [31]: {
    value: 31, name: 'MagicBottleExtra', label: '彩色魔药挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none',
    fixedElementValue: MAGIC_BOTTLE_CONSTANTS.FIXED_ELEMENT_VALUE,
    targetWhitelist: MAGIC_BOTTLE_TARGET_WHITELIST,
    constants: MAGIC_BOTTLE_CONSTANTS,
  },
  [32]: { value: 32, name: 'ExchangeExtra', label: '兑换挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none' },
  [33]: { value: 33, name: 'MonsterExtra', label: '怪物挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none' },
  [34]: { value: 34, name: 'RockExtra', label: '岩石挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none' },
  [35]: { value: 35, name: 'FlipPotExtra', label: '翻转罐挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none' },
  [36]: { value: 36, name: 'DandelionExtra', label: '蒲公英挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none' },
  [37]: { value: 37, name: 'GiftBoxExtra', label: '礼盒挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none' },
  [38]: { value: 38, name: 'OrderExtra', label: '订单挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none' },
  [39]: {
    value: 39, name: 'BubbleExtra', label: '泡泡挂件', kind: 'both', countMeaning: 'behavior-config', paramSchema: 'collect-count',
    constants: BUBBLE_CONSTANTS,
  },
  [40]: { value: 40, name: 'FairyExtra', label: '小精灵挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none' },
  [51]: { value: 51, name: 'LargeTerrainExtra', label: '大型地形注入(2x2)', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'footprint' },
  [52]: { value: 52, name: 'LargeTerrainOrderExtra', label: '大型地形订单(3x3)', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'footprint' },
  [53]: { value: 53, name: 'LargeTerrainTicketExtra', label: '大型地形票券订单', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'footprint' },
  [202]: { value: 202, name: 'Unknown_Interval', label: '问号挂件(间隔策略)', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none' },
  [203]: { value: 203, name: 'Unknown_BottomFirst', label: '问号挂件(底层优先策略)', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none' },
  [207]: { value: 207, name: 'FlipExtra_Layer', label: '翻转挂件(层策略)', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none' },
};

/** 查询机制信息；未知数值返回 undefined。 */
export function mechanicInfo(value: number): MechanicInfo | undefined {
  return MECHANICS[value];
}

/** 数值是否为已知机制枚举（不含 None/Empty）。 */
export function isKnownMechanic(value: number): boolean {
  return value !== -1 && value !== 0 && MECHANICS[value] !== undefined;
}
