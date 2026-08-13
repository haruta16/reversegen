/**
 * 特殊机制（挂件）注册表 — 与 Unity 侧逐位对齐。
 *
 * 数值来自 TileMatchShell `ssExtraEnum.cs`（DGuo.Common），语义来自
 * `_InnerClient/Client/TileMatch/GamePlay/Core/Extra/` 各 Extra 实现。
 * 修改本表必须同步核对 Unity 侧枚举，任何数值漂移都会导致机制错位。
 */

/** 挂件来源形态。 */
export type MechanicKind =
  | 'tile'
  | 'dynamic'
  | 'both';

/** 挂件参数 schema（对齐 Unity extraParam 语义）。 */
export type MechanicParamSchema =
  | 'none'
  /** 大型地形 footprint: "2" 或 "3" */
  | 'footprint'
  /** 泡泡每轮收集数（extraConfig[39] = 0 表示随机 2-3） */
  | 'collect-count'
  /** 衰减挂件: "[show][value][isValidCollect]" 三字符（黄金/复活节/日历） */
  | 'decay'
  /** 揭示挂件: "[show][done]" 两字符（问号/翻转） */
  | 'reveal';

/** 挂件行为类型（决定引擎如何模拟；与 Unity 各 Extra 实现对应）。 */
export type MechanicBehavior =
  /** 无客户端逻辑（Ice/Linked/Exchange/Monster/Rock/FlipPot/Fairy/LargeTerrain 在 Unity 无行为实现） */
  | 'inert'
  /** 纯固定花色标记（金币：固定 1201，收集即销毁） */
  | 'fixed-marker'
  /** 倒计时衰减挂件（黄金/复活节/日历：每步衰减，收集事件） */
  | 'decay'
  /** 揭示挂件（问号/翻转：收集或可见时 isDone） */
  | 'reveal'
  /** 订单挂件（收集即 consumed，花色由外部订单系统提供） */
  | 'order'
  /** 魔药（三消触发交错清除） */
  | 'magic-bottle'
  /** 蒲公英（三消触发扩散转化） */
  | 'dandelion'
  /** 礼盒（三消触发加权随机效果） */
  | 'giftbox'
  /** 泡泡（轮次指派/吸取/Dock魔法） */
  | 'bubble';

export interface MechanicInfo {
  value: number;
  name: string;
  label: string;
  kind: MechanicKind;
  countMeaning: 'tile-count' | 'behavior-config';
  paramSchema: MechanicParamSchema;
  /** 是否 IsValueExtra（参与洗牌：值挂件随花色包移动，泡泡等不参与） */
  isValueExtra: boolean;
  /** 行为类型（引擎模拟方式） */
  behavior: MechanicBehavior;
  /** 固定花色值（IsFixedElementValue），未设置 = 参与花色分配 */
  fixedElementValue?: number;
  /** 可被机制选为目标的挂件白名单 */
  targetWhitelist?: number[];
  /** 衰减跳过步骤（复活节/日历：MagicBottleStep 不衰减） */
  decaySkip?: string[];
  /** 行为常量 */
  constants?: Record<string, number>;
}

export const MAGIC_BOTTLE_TARGET_WHITELIST: number[] = [-1, 0, 2, 202, 203, 4, 5, 6, 8, 7, 207, 36];
export const DANDELION_TARGET_WHITELIST: number[] = [-1, 0];
export const MAGIC_BOTTLE_CONSTANTS = { TARGET_GROUP_COUNT: 6, TILES_PER_GROUP: 3, FIXED_ELEMENT_VALUE: 1301 } as const;
export const BUBBLE_CONSTANTS = { MIN_COLLECT_COUNT: 1, DEFAULT_COLLECT_COUNT: 3, MAX_COLLECT_COUNT: 4, MAX_COLLECT_ROUNDS: 3 } as const;
export const DANDELION_CONSTANTS = { FIXED_ELEMENT_VALUE: 1402, TILES_PER_GROUP: 3, TOP_CANDIDATE_POOL_SIZE: 7 } as const;
export const DANDELION_SINGLE_GROUP_PROBABILITY = 0.8;
export const GIFTBOX_CONSTANTS = {
  FIXED_ELEMENT_VALUE: 1601,
  MIN_DOCK_SLOT: 3,
  MAX_DOCK_SLOT: 8,
  APPLY_UNKNOWN_MIN_COUNT: 3,
  APPLY_UNKNOWN_MAX_COUNT: 4,
  APPLY_FLIP_MIN_COUNT: 3,
  APPLY_FLIP_MAX_COUNT: 6,
  APPLY_MAGIC_BOTTLE_MIN_GROUP_COUNT: 1,
  APPLY_MAGIC_BOTTLE_MAX_GROUP_COUNT: 2,
  GROUP_TILE_COUNT: 3,
} as const;

/** 礼盒效果枚举（GiftBoxEffectType；注释项为 Unity 侧关闭的效果）。 */
export const GIFTBOX_EFFECTS = {
  None: 0,
  AddDockSlot: 1,
  MagicWand: 2,
  RevealUnknown: 4,
  Shuffle: 5,
  DockAllMagicWand: 6,
  ApplyUnknown: 9,
  ApplyFlip: 10,
  ApplyMagicBottle: 11,
} as const;

/** 礼盒效果权重（EffectWeights，插入顺序 = 选择顺序）。 */
export const GIFTBOX_EFFECT_WEIGHTS: Array<[number, number]> = [
  [GIFTBOX_EFFECTS.AddDockSlot, 30],
  [GIFTBOX_EFFECTS.DockAllMagicWand, 20],
  [GIFTBOX_EFFECTS.RevealUnknown, 25],
  [GIFTBOX_EFFECTS.Shuffle, 5],
  [GIFTBOX_EFFECTS.MagicWand, 5],
  [GIFTBOX_EFFECTS.ApplyMagicBottle, 10],
  [GIFTBOX_EFFECTS.ApplyUnknown, 10],
  [GIFTBOX_EFFECTS.ApplyFlip, 10],
];

/** ssExtraEnum 全表（数值 → 信息）。 */
export const MECHANICS: Record<number, MechanicInfo> = {
  [-1]: { value: -1, name: 'None', label: '无', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none', isValueExtra: false, behavior: 'inert' },
  [0]: { value: 0, name: 'Empty', label: '空挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none', isValueExtra: false, behavior: 'inert' },
  // Ice/Linked/Exchange/Monster/Rock/FlipPot/Fairy/LargeTerrain：Unity 客户端当前无行为实现（纯标记）
  [1]: { value: 1, name: 'Ice', label: '冰封挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none', isValueExtra: true, behavior: 'inert' },
  [2]: { value: 2, name: 'Unknown', label: '问号挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'reveal', isValueExtra: true, behavior: 'reveal' },
  [3]: { value: 3, name: 'Linked', label: '锁链挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none', isValueExtra: false, behavior: 'inert' },
  [4]: { value: 4, name: 'GoldenExtra', label: '黄金挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'decay', isValueExtra: true, behavior: 'decay', fixedElementValue: 1101 },
  [5]: { value: 5, name: 'CoinExtra', label: '金币挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none', isValueExtra: true, behavior: 'fixed-marker', fixedElementValue: 1201 },
  [6]: { value: 6, name: 'AdventCalendarExtra', label: '倒计时日历挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'decay', isValueExtra: true, behavior: 'decay', fixedElementValue: 1102, decaySkip: ['magic-bottle-clear'] },
  [7]: { value: 7, name: 'FlipExtra', label: '翻转挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'reveal', isValueExtra: true, behavior: 'reveal' },
  [8]: { value: 8, name: 'EasterExtra', label: '复活节挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'decay', isValueExtra: true, behavior: 'decay', fixedElementValue: 1103, decaySkip: ['magic-bottle-clear'] },
  [31]: {
    value: 31, name: 'MagicBottleExtra', label: '彩色魔药挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none',
    isValueExtra: true, behavior: 'magic-bottle', fixedElementValue: 1301,
    targetWhitelist: MAGIC_BOTTLE_TARGET_WHITELIST, constants: MAGIC_BOTTLE_CONSTANTS,
  },
  [32]: { value: 32, name: 'ExchangeExtra', label: '兑换挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none', isValueExtra: true, behavior: 'inert' },
  [33]: { value: 33, name: 'MonsterExtra', label: '怪物挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none', isValueExtra: false, behavior: 'inert' },
  [34]: { value: 34, name: 'RockExtra', label: '岩石挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none', isValueExtra: false, behavior: 'inert' },
  [35]: { value: 35, name: 'FlipPotExtra', label: '翻转罐挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none', isValueExtra: false, behavior: 'inert' },
  [36]: {
    value: 36, name: 'DandelionExtra', label: '蒲公英挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none',
    isValueExtra: true, behavior: 'dandelion', fixedElementValue: 1402,
    targetWhitelist: DANDELION_TARGET_WHITELIST, constants: DANDELION_CONSTANTS,
  },
  [37]: {
    value: 37, name: 'GiftBoxExtra', label: '礼盒挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none',
    isValueExtra: true, behavior: 'giftbox', fixedElementValue: 1601, constants: GIFTBOX_CONSTANTS,
  },
  [38]: { value: 38, name: 'OrderExtra', label: '订单挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none', isValueExtra: true, behavior: 'order' },
  [39]: { value: 39, name: 'BubbleExtra', label: '泡泡挂件', kind: 'both', countMeaning: 'behavior-config', paramSchema: 'collect-count', isValueExtra: false, behavior: 'bubble', constants: BUBBLE_CONSTANTS },
  [40]: { value: 40, name: 'FairyExtra', label: '小精灵挂件', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'none', isValueExtra: false, behavior: 'inert' },
  [51]: { value: 51, name: 'LargeTerrainExtra', label: '大型地形注入(2x2)', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'footprint', isValueExtra: false, behavior: 'inert' },
  [52]: { value: 52, name: 'LargeTerrainOrderExtra', label: '大型地形订单(3x3)', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'footprint', isValueExtra: false, behavior: 'inert' },
  [53]: { value: 53, name: 'LargeTerrainTicketExtra', label: '大型地形票券订单', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'footprint', isValueExtra: false, behavior: 'inert' },
  [202]: { value: 202, name: 'Unknown_Interval', label: '问号挂件(间隔策略)', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'reveal', isValueExtra: true, behavior: 'reveal' },
  [203]: { value: 203, name: 'Unknown_BottomFirst', label: '问号挂件(底层优先策略)', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'reveal', isValueExtra: true, behavior: 'reveal' },
  [207]: { value: 207, name: 'FlipExtra_Layer', label: '翻转挂件(层策略)', kind: 'tile', countMeaning: 'tile-count', paramSchema: 'reveal', isValueExtra: true, behavior: 'reveal' },
};

/** 查询机制信息；未知数值返回 undefined。 */
export function mechanicInfo(value: number): MechanicInfo | undefined {
  return MECHANICS[value];
}

/** 数值是否为已知机制枚举（不含 None/Empty）。 */
export function isKnownMechanic(value: number): boolean {
  return value !== -1 && value !== 0 && MECHANICS[value] !== undefined;
}

/** 问号/翻转类（reveal 行为）的枚举集合。 */
export const REVEAL_EXTRAS = new Set([2, 7, 202, 203, 207]);

/** 衰减类（decay 行为）的枚举集合。 */
export const DECAY_EXTRAS = new Set([4, 6, 8]);
