/**
 * 机制（挂件）引擎类型。
 *
 * 步骤类型对齐 Unity `_InnerClient/.../Core/Step/` 下的机制步骤：
 * MagicBottleStep / BubbleCollectStep，以及泡泡的指派（AssignBubbleTilesAsync）。
 */

/** 挂在 tile 上的挂件（对齐 Unity TileData.extraEnum/extraParam 与运行时 ExtraBase 实例）。 */
export interface TileExtra {
  /** ssExtraEnum 数值 */
  extraEnum: number;
  /** 挂件参数（空串表示无参数） */
  extraParam: string;
}

/** 机制步骤（对局中由机制产生的动作，跑关重放与验证的载体）。 */
export type MechanicStep =
  /** 魔药触发：清除索敌选中的 6 组 × 3 张牌 */
  | { type: 'magic-bottle-clear'; tileIds: number[] }
  /** 泡泡指派：给 tileIds 挂上泡泡角标 */
  | { type: 'bubble-assign'; tileIds: number[] }
  /** 泡泡吸取：收集被标记的 tileIds（进入 Dock） */
  | { type: 'bubble-collect'; tileIds: number[] }
  /** 泡泡后续 Dock 魔法：按 Dock 花色补齐清除（DockAllMagicWand） */
  | { type: 'dock-magic-clear'; tileIds: number[] };

/** 机制步骤日志条目（含触发时的动作序号，供跑关对照）。 */
export type MechanicStepRecord = MechanicStep & {
  /** 触发时累计动作序号（点击/复活/机制步骤统一计数） */
  stepIndex: number;
};
