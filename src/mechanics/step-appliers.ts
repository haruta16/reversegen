/**
 * 机制步骤应用策略表 — 新增机制步骤时，在这里登记一个应用器即可，
 * OfflineGame 的 applyMechanicStep 通过本表分发，不再维护 switch。
 *
 * 应用器只使用 OfflineGame 的公开机制操作面：
 *   mechanicMoveToDock / mechanicEliminate / mechanicResolveDockMatch /
 *   mechanicAddDockSlot / updateTilesState / applyMechanicStep / mechanics
 *
 * 状态刷新统一由 applyMechanicStep 收尾执行（对齐 Unity 各调用点的 UpdateTilesState），
 * 应用器内部只有链式分发（onMatch）需要在其前刷新一次棋盘。
 */

import type { OfflineGame } from '../solver/offline-game.js';
import { TileFlag } from '../solver/types.js';
import type { MechanicStep } from './types.js';
import { initExtraState, onTileCollected, shuffleBoard } from './extras.js';
import { shuffleBoardSeed } from './seed.js';

export type StepApplier = (game: OfflineGame, step: MechanicStep) => void;

/**
 * 会触发衰减 OnStep 的步骤类型 —— 对齐 Unity StepMgr.AppendStep → OnStepApply。
 * Unity 只有 MagicBottleStep / MagicStep / BubbleCollectStep / ShuffleStep 四类机制步骤
 * 会被 AppendStep；其余机制效果（泡泡指派、蒲公英扩散、礼盒加槽/揭示/施加）是计划类执行，不触发衰减。
 */
export const DECAY_STEP_TYPES: ReadonlySet<MechanicStep['type']> = new Set([
  'magic-bottle-clear',
  'magic-step',
  'bubble-collect',
  'giftbox-shuffle',
]);

/**
 * 魔药清除（MagicBottleStep）：直接消除 + 对每张目标牌触发自身收集钩子。
 * 对齐 Unity MagicBottleStep.Apply：先 Desk/Dock → Discard，再对每张目标牌调用
 * tile.OnTileCollect(tile)（揭示 isDone / 订单 consumed / 衰减有效收集——仅目标牌自身挂件；
 * 不触发三消 OnTileMatch，不广播 battle.OnTileCollect）。
 */
function applyMagicBottleClear(game: OfflineGame, step: MechanicStep): void {
  if (step.type !== 'magic-bottle-clear') return;
  game.mechanicEliminate(step.tileIds);
  for (const id of step.tileIds) {
    const tile = game.allTiles.get(id);
    if (tile) onTileCollected(tile);
  }
}

/** 泡泡指派：动态追加泡泡挂件 + 登记为活跃角标（对齐 Unity AssignBubbleTilesAsync，无步骤计数）。 */
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

/**
 * 泡泡吸取（BubbleCollectStep.Apply 移植）：入 Dock → 照常结算三消（Unity CheckDockMatch）
 * → 收集钩子 → 轮次/冷却结算 → 链式 OnMatch 分发。
 */
function applyBubbleCollect(game: OfflineGame, step: MechanicStep): void {
  if (step.type !== 'bubble-collect') return;
  // 链式机制（蒲公英）读的是本步之前的 Analyzer 旧快照，与 CollectStep 同规约。
  game.mechanics.capturePreMoveContext();
  game.mechanicMoveToDock(step.tileIds);
  const matched = game.mechanicResolveDockMatch();
  if (!matched) game.mechanics.clearPendingMatchContext();

  // 对齐 Unity：三消结算后才对每张收集牌触发 OnTileCollect（揭示/有效收集/订单 consumed）。
  for (const id of step.tileIds) {
    const tile = game.allTiles.get(id);
    if (tile) onTileCollected(tile);
  }

  const bubble = game.mechanics.bubble;
  if (!bubble.activeRoundCounted) {
    bubble.completedCollectRounds += 1;
    bubble.activeRoundCounted = true;
  }
  bubble.cooldownTicks = 1;

  if (matched) {
    game.updateTilesState();
    for (const chainStep of game.mechanics.onMatch(matched)) {
      game.applyMechanicStep(chainStep);
    }
  }
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
}

/** 礼盒加槽（AddDockSlot 计划：槽位 +1，上限 8，与 Unity SetMaxSlotCount(8) 等价）。 */
function applyGiftBoxAddSlot(game: OfflineGame, step: MechanicStep): void {
  if (step.type !== 'giftbox-add-dock-slot') return;
  game.mechanicAddDockSlot();
}

/** 礼盒揭示全部问号（RevealUnknown 计划：仅 Desk 上的 2/202/203）。 */
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

/** 礼盒洗牌（ShuffleStep：依赖优先，棋盘状态派生种子）。 */
function applyGiftBoxShuffle(game: OfflineGame, step: MechanicStep): void {
  if (step.type !== 'giftbox-shuffle') return;
  shuffleBoard(game, shuffleBoardSeed(game));
}

/** 礼盒施加问号/翻转/魔药（挂件追加 + 可选元素改写；计划类执行，无步骤计数）。 */
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
  };
}

/**
 * 魔法棒定向收集（MagicStep.Apply 移植）：进 Dock → 结算三消 → 收集钩子 → 链式 OnMatch。
 * 礼盒 MagicWand / DockAllMagicWand 与泡泡 Dock 魔法共用；tileIds 允许为空（对齐 Unity
 * 空 MagicStep 照常 AppendStep 的步骤计数语义）。
 */
function applyMagicStep(game: OfflineGame, step: MechanicStep): void {
  if (step.type !== 'magic-step') return;
  // 链式三消同样要先捕获蒲公英所需的旧 AnalyzerMgr 快照。
  game.mechanics.capturePreMoveContext();
  game.mechanicMoveToDock(step.tileIds);
  const matched = game.mechanicResolveDockMatch();
  if (!matched) game.mechanics.clearPendingMatchContext();

  // 对齐 MagicStep.Apply：三消结算后对每张收集牌触发 OnTileCollect。
  for (const id of step.tileIds) {
    const tile = game.allTiles.get(id);
    if (tile) onTileCollected(tile);
  }

  if (matched) {
    // 与 Unity 礼盒/泡泡一致：链式 OnMatch 前先刷新状态（Unity 异步回滚后为最新棋盘）。
    game.updateTilesState();
    for (const chainStep of game.mechanics.onMatch(matched)) {
      game.applyMechanicStep(chainStep);
    }
  }
}

/** step.type → 应用器 表（新增机制步骤在此登记，无需改 OfflineGame）。 */
export const STEP_APPLIERS: Partial<Record<MechanicStep['type'], StepApplier>> = {
  'magic-bottle-clear': applyMagicBottleClear,
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
