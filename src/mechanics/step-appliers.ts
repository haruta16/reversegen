/**
 * 机制步骤应用策略表 — 新增机制步骤时，在这里登记一个应用器即可，
 * OfflineGame 的 applyMechanicStep 通过本表分发，不再维护 switch。
 *
 * 应用器只允许使用 OfflineGame 的公开机制操作面：
 *   mechanicMoveToDock / mechanicEliminate / mechanicResolveDockMatch /
 *   mechanicAddDockSlot / updateTilesState / applyMechanicStep / mechanics
 */

import type { OfflineGame } from '../solver/offline-game.js';
import { TileFlag } from '../solver/types.js';
import type { MechanicStep } from './types.js';
import { initExtraState, shuffleBoard } from './extras.js';
import { shuffleBoardSeed } from './seed.js';

export type StepApplier = (game: OfflineGame, step: MechanicStep) => void;

/** 清除类步骤（魔药清除 / Dock 魔法清除）共用同一应用器。 */
function applyClear(game: OfflineGame, step: MechanicStep): void {
  if (step.type !== 'magic-bottle-clear' && step.type !== 'dock-magic-clear') return;
  game.mechanicEliminate(step.tileIds);
  game.updateTilesState();
}
/** 泡泡指派：动态追加泡泡挂件 + 登记为活跃角标。 */
function applyBubbleAssign(game: OfflineGame, step: MechanicStep): void {
  if (step.type !== 'bubble-assign') return;
  for (const id of step.tileIds) {
    const tile = game.allTiles.get(id);
    if (tile && !tile.extras.some(e => e.extraEnum === 39)) {
      tile.extras.push({ extraEnum: 39, extraParam: '' });
    }
  }
  game.mechanics.bubble.activeBubbleTileIds = new Set(step.tileIds);
  game.mechanics.bubble.activeRoundCounted = false;
}

/** 泡泡吸取：标记牌进 Dock（不触发普通三消）+ 轮次/冷却结算。 */
function applyBubbleCollect(game: OfflineGame, step: MechanicStep): void {
  if (step.type !== 'bubble-collect') return;
  game.mechanicMoveToDock(step.tileIds);
  game.updateTilesState();
  const bubble = game.mechanics.bubble;
  if (!bubble.activeRoundCounted) {
    bubble.completedCollectRounds += 1;
    bubble.activeRoundCounted = true;
  }
  bubble.cooldownTicks = 1;
}

/** 蒲公英扩散：目标牌转化为蒲公英（元素 1402 + 挂件）。 */
function applyDandelionSpread(game: OfflineGame, step: MechanicStep): void {
  if (step.type !== 'dandelion-spread') return;
  for (const id of step.tileIds) {
    const tile = game.allTiles.get(id);
    if (!tile || tile.hasFlag(TileFlag.Destroyed)) continue;
    tile.elementValue = 1402;
    if (!tile.extras.some(e => e.extraEnum === 36)) {
      const extra = { extraEnum: 36, extraParam: '' };
      initExtraState(extra);
      tile.extras.push(extra);
    }
  }
  game.updateTilesState();
}

/** 礼盒加槽。 */
function applyGiftBoxAddSlot(game: OfflineGame, step: MechanicStep): void {
  if (step.type !== 'giftbox-add-dock-slot') return;
  game.mechanicAddDockSlot();
}

/** 礼盒揭示全部问号。 */
function applyGiftBoxRevealUnknown(game: OfflineGame, step: MechanicStep): void {
  if (step.type !== 'giftbox-reveal-unknown') return;
  for (const tile of game.deskTiles) {
    for (const extra of tile.extras) {
      if (extra.extraEnum === 2 || extra.extraEnum === 202 || extra.extraEnum === 203) {
        extra.isDone = true;
      }
    }
  }
}
/** 礼盒洗牌（依赖优先，棋盘状态派生种子）。 */
function applyGiftBoxShuffle(game: OfflineGame, step: MechanicStep): void {
  if (step.type !== 'giftbox-shuffle') return;
  shuffleBoard(game, shuffleBoardSeed(game));
  game.updateTilesState();
}

/** 礼盒施加问号/翻转/魔药（挂件追加 + 可选元素改写）。 */
function makeApplyExtraApplier(extraEnum: number, fixedElementValue: number | null): StepApplier {
  return (game, step) => {
    if (step.type !== 'giftbox-apply-unknown' && step.type !== 'giftbox-apply-flip' && step.type !== 'giftbox-apply-magic-bottle') return;
    for (const id of step.tileIds) {
      const tile = game.allTiles.get(id);
      if (!tile || tile.hasFlag(TileFlag.Destroyed)) continue;
      if (fixedElementValue !== null) tile.elementValue = fixedElementValue;
      if (!tile.extras.some(e => e.extraEnum === extraEnum)) {
        const extra = { extraEnum, extraParam: '' };
        initExtraState(extra);
        tile.extras.push(extra);
      }
    }
    if (fixedElementValue !== null) game.updateTilesState();
  };
}

/** 魔法棒：定向收集进 Dock → 结算三消 → 链式 OnMatch。 */
function applyMagicStep(game: OfflineGame, step: MechanicStep): void {
  if (step.type !== 'magic-step') return;
  // 链式三消同样要先捕获蒲公英所需的旧 AnalyzerMgr 快照。
  game.mechanics.capturePreMoveContext();
  game.mechanicMoveToDock(step.tileIds);
  const matched = game.mechanicResolveDockMatch();
  // 与 Unity 礼盒一致：链式 OnMatch 前先刷新状态。
  if (!matched) game.mechanics.clearPendingMatchContext();
  game.updateTilesState();
  if (matched) {
    for (const chainStep of game.mechanics.onMatch(matched)) {
      game.applyMechanicStep(chainStep);
    }
  }
  game.updateTilesState();
}

/** step.type → 应用器 表（新增机制步骤在此登记，无需改 OfflineGame）。 */
export const STEP_APPLIERS: Partial<Record<MechanicStep['type'], StepApplier>> = {
  'magic-bottle-clear': applyClear,
  'dock-magic-clear': applyClear,
  'bubble-assign': applyBubbleAssign,
  'bubble-collect': applyBubbleCollect,
  'dandelion-spread': applyDandelionSpread,
  'giftbox-add-dock-slot': applyGiftBoxAddSlot,
  'giftbox-reveal-unknown': applyGiftBoxRevealUnknown,
  'giftbox-shuffle': applyGiftBoxShuffle,
  'giftbox-apply-unknown': makeApplyExtraApplier(2, null),
  'giftbox-apply-flip': makeApplyExtraApplier(7, null),
  'giftbox-apply-magic-bottle': makeApplyExtraApplier(31, 1301),
  'magic-step': applyMagicStep,
};
