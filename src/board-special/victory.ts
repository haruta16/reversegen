/**
 * 棋盘特殊物胜利条件（对齐 Unity victoryConditionMgr 的组合语义）：
 * 52/53 订单玩法的 victoryConditions = [ConditionDefault, ConditionChicken]，
 * IsConditionsMet 任一满足即胜 —— 即「全部结构移除」或「桌面清空」皆可。
 * 51 Standard 与普通关卡只有 ConditionDefault（桌面清空）。
 */

import type { OfflineGame } from '../solver/offline-game.js';
import type { VictoryCondition } from '../solver/offline-game.js';

/**
 * 全部棋盘特殊物移除即胜，桌面清空也胜（ConditionDefault 兜底）；
 * 无结构时恒 false（调用方应回退默认条件）。
 */
export const boardSpecialVictoryCondition: VictoryCondition = (game: OfflineGame): boolean => {
  return game.boardSpecialStructures.length > 0
    && (game.boardSpecialStructures.every(s => s.isRemoved) || game.deskTiles.length === 0);
};
