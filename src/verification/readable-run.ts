/**
 * 可读跑关日志 — 把「动作序列 → 牌局演化」翻译成人工可读的操作结果序列。
 * 定位：人工对照 Unity 的验证工具。机器逐帧比对请用 cross-side-trace。
 *
 * 每个条目同时携带纯文本行（lines，供复制）与结构化字段（entries，供 GUI 分色渲染）：
 *   overview  初始概览
 *   click     点击（含消除组 / Dock 计数 / 警告）
 *   mechanic  机制步骤（魔药/泡泡/魔法棒/礼盒/蒲公英）
 *   structure 大型地形移除
 *   summary   结束判定
 */

import type { OfflineGame } from '../solver/offline-game.js';
import { PileType } from '../solver/types.js';
import type { MechanicStepRecord } from '../mechanics/types.js';

export type RunLogEntry =
  | { kind: 'overview'; text: string }
  | { kind: 'click'; text: string; step: number; tileId: number; color: number; matchedIds: number[]; dockCounts: Array<[number, number]>; warn: string | null }
  | { kind: 'mechanic'; text: string; mechanic: string; tileIds: number[] }
  | { kind: 'structure'; text: string; structureId: number }
  | { kind: 'summary'; text: string; win: boolean; dead: boolean; desk: number; dock: number; maxDock: number };

export interface RunLogResult {
  /** 结构化条目（GUI 分色渲染） */
  entries: RunLogEntry[];
  /** 纯文本行（复制用；lines = entries.map(text)） */
  lines: string[];
  win: boolean;
  dead: boolean;
}

const MECHANIC_LABELS: Record<string, string> = {
  'magic-bottle-clear': '魔药清除',
  'bubble-assign': '泡泡指派',
  'bubble-collect': '泡泡吸取',
  'dandelion-spread': '蒲公英扩散',
  'magic-step': '魔法棒收集',
  'giftbox-add-dock-slot': '礼盒·Dock槽位+1',
  'giftbox-reveal-unknown': '礼盒·揭示全部问号',
  'giftbox-shuffle': '礼盒·洗牌',
  'giftbox-apply-unknown': '礼盒·施加问号',
  'giftbox-apply-flip': '礼盒·施加翻转',
  'giftbox-apply-magic-bottle': '礼盒·转化为魔药',
};

/** Dock 内容摘要：[301×2,302×1]。 */
function dockSig(counts: Array<[number, number]>): string {
  return `[${counts.map(([c, n]) => `${c}×${n}`).join(',')}]`;
}

/**
 * 按动作序列跑关并生成可读日志（会就地推进 game）。
 * 机制步骤、Dock 演化、消除组、泡泡轮次、大 tile 移除都会落成一条。
 */
export function runSequenceLog(game: OfflineGame, actions: number[]): RunLogResult {
  const entries: RunLogEntry[] = [];
  const log = game.mechanicLog as MechanicStepRecord[];

  // 初始概览
  const colorCounts = new Map<number, number>();
  for (const t of game.deskTiles) colorCounts.set(t.elementValue, (colorCounts.get(t.elementValue) ?? 0) + 1);
  const colorSig = [...colorCounts.entries()].map(([c, n]) => `${c}×${n}`).join(',');
  const bubble = game.mechanics.bubble;
  const specialSig = game.boardSpecialStructures.length
    ? ` · 大型地形${game.boardSpecialStructures.map(s => `#${s.id}`).join(',')}`
    : '';
  entries.push({
    kind: 'overview',
    text:
      `初始: 桌面 ${game.deskTiles.length} 张 · 花色 ${colorSig}`
      + (bubble.enabled ? ` · 泡泡每轮${bubble.useRandomCollectCount ? '随机2-3' : bubble.configuredCollectCount}` : '')
      + specialSig,
  });

  let logOffset = 0;
  for (let i = 0; i < actions.length; i++) {
    const tile = game.allTiles.get(actions[i]);
    if (!tile) {
      entries.push({
        kind: 'click', step: i + 1, tileId: actions[i], color: 0,
        matchedIds: [], dockCounts: [], warn: '牌不存在（序列终止）',
        text: `步${i + 1} 点击 #${actions[i]} → ⚠ 牌不存在（序列终止）`,
      });
      break;
    }
    if (!tile.isClickable || tile.pileType !== PileType.Desk) {
      entries.push({
        kind: 'click', step: i + 1, tileId: tile.id, color: tile.elementValue,
        matchedIds: [], dockCounts: [], warn: '不可点击（序列终止）',
        text: `步${i + 1} 点击 #${tile.id}(色${tile.elementValue}) → ⚠ 不可点击（序列终止）`,
      });
      break;
    }
    const removedBefore = new Set(game.boardSpecialStructures.filter(s => s.isRemoved).map(s => s.id));

    const matched = game.collect(tile);
    const matchedIds = matched ? matched.map(m => m.id) : [];
    const dockCounts: Array<[number, number]> = [];
    {
      const counts = new Map<number, number>();
      for (const t of game.dockTiles) counts.set(t.elementValue, (counts.get(t.elementValue) ?? 0) + 1);
      for (const [c, n] of counts) dockCounts.push([c, n]);
    }
    const matchText = matchedIds.length > 0 ? ` → 消除 ${matchedIds.map(id => `#${id}`).join(',')}` : '';
    entries.push({
      kind: 'click',
      step: i + 1,
      tileId: tile.id,
      color: tile.elementValue,
      matchedIds,
      dockCounts,
      warn: null,
      text: `步${i + 1} 点击 #${tile.id}(色${tile.elementValue}) → Dock${dockSig(dockCounts)}${matchText}`,
    });

    for (const step of log.slice(logOffset)) {
      const label = MECHANIC_LABELS[step.type];
      if (!label) continue;
      const tileIds = 'tileIds' in step ? step.tileIds : [];
      const idsText = tileIds.length ? ` #${tileIds.join(',#')}` : '';
      entries.push({
        kind: 'mechanic',
        mechanic: step.type,
        tileIds,
        text: `　└ ${label}${idsText}`,
      });
    }
    logOffset = log.length;

    for (const structure of game.boardSpecialStructures) {
      if (structure.isRemoved && !removedBefore.has(structure.id)) {
        entries.push({
          kind: 'structure',
          structureId: structure.id,
          text: `　└ 大型地形 #${structure.id} 移除（依赖已清空）`,
        });
      }
    }
  }

  const dead = game.isDead;
  const win = game.isWin;
  entries.push({
    kind: 'summary',
    win,
    dead,
    desk: game.deskTiles.length,
    dock: game.dockTiles.length,
    maxDock: game.maxSlotCount,
    text: `—— 结束: 桌面 ${game.deskTiles.length} 张 · ${win ? '✅ 通关' : dead ? `❌ 死亡（Dock ${game.dockTiles.length}/${game.maxSlotCount}）` : `未通关（Dock ${game.dockTiles.length}/${game.maxSlotCount}）`} ——`,
  });

  return { entries, lines: entries.map(e => e.text), win, dead };
}
