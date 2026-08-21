/**
 * 棋盘特殊物胜利条件（对齐 Unity VictoryConditionType.Chicken）：
 * 52/53 订单玩法的胜利 = 全部注入结构收集完毕（移除），而非清空桌面。
 * 51 Standard 与普通关卡沿用 defaultVictoryCondition（清空可匹配牌）。
 */

import type { OfflineGame } from '../solver/offline-game.js';
import type { VictoryCondition } from '../solver/offline-game.js';

/** 全部棋盘特殊物移除即胜；无结构时恒 false（调用方应回退默认条件）。 */
export const boardSpecialVictoryCondition: VictoryCondition = (game: OfflineGame): boolean => {
  return game.boardSpecialStructures.length > 0
    && game.boardSpecialStructures.every(s => s.isRemoved);
};
