/**
 * 可读跑关日志 — 把「动作序列 → 牌局演化」翻译成人工可读的操作结果序列。
 * 定位：人工对照 Unity 的验证工具。机器逐帧比对请用 cross-side-trace。
 *
 * 输出示例：
 *   初始: 桌面 30 张 · 花色 301×10,302×10,303×10 · 泡泡每轮3
 *   步1 点击 #1(色301) → Dock[301]
 *   步2 点击 #4(色301) → Dock[301×2]
 *   步3 点击 #7(色301) → Dock[301×3] → 消除 #1,#4,#7
 *     └ 泡泡指派 #10,#2,#3
 *     └ 泡泡吸取 #2,#3,#10
 *     └ 魔法棒收集 #5,#8 → 消除 #2,#5,#8
 *   —— 结束: 桌面 9 张 · 未通关（Dock 0/7） ——
 */

import type { OfflineGame } from '../solver/offline-game.js';
import { PileType } from '../solver/types.js';
import type { MechanicStepRecord } from '../mechanics/types.js';

export interface RunLogResult {
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
function dockSig(game: OfflineGame): string {
  const counts = new Map<number, number>();
  for (const t of game.dockTiles) counts.set(t.elementValue, (counts.get(t.elementValue) ?? 0) + 1);
  return `[${[...counts.entries()].map(([c, n]) => `${c}×${n}`).join(',')}]`;
}

function mechanicLine(step: MechanicStepRecord): string | null {
  const label = MECHANIC_LABELS[step.type];
  if (!label) return null;
  const tileIds = 'tileIds' in step ? step.tileIds : [];
  return `　└ ${label}${tileIds.length ? ` #${tileIds.join(',#')}` : ''}`;
}

/**
 * 按动作序列跑关并生成可读日志（会就地推进 game）。
 * 机制步骤、Dock 演化、消除组、泡泡轮次、大 tile 移除都会落成一行。
 */
export function runSequenceLog(game: OfflineGame, actions: number[]): RunLogResult {
  const lines: string[] = [];
  const log = game.mechanicLog as MechanicStepRecord[];

  // 初始概览
  const colorCounts = new Map<number, number>();
  for (const t of game.deskTiles) colorCounts.set(t.elementValue, (colorCounts.get(t.elementValue) ?? 0) + 1);
  const colorSig = [...colorCounts.entries()].map(([c, n]) => `${c}×${n}`).join(',');
  const bubble = game.mechanics.bubble;
  const specialSig = game.boardSpecialStructures.length
    ? ` · 大型地形${game.boardSpecialStructures.map(s => `#${s.id}`).join(',')}`
    : '';
  lines.push(
    `初始: 桌面 ${game.deskTiles.length} 张 · 花色 ${colorSig}`
    + (bubble.enabled ? ` · 泡泡每轮${bubble.useRandomCollectCount ? '随机2-3' : bubble.configuredCollectCount}` : '')
    + specialSig,
  );

  let logOffset = 0;
  for (let i = 0; i < actions.length; i++) {
    const tile = game.allTiles.get(actions[i]);
    if (!tile) {
      lines.push(`步${i + 1} 点击 #${actions[i]} → ⚠ 牌不存在（序列终止）`);
      break;
    }
    if (!tile.isClickable || tile.pileType !== PileType.Desk) {
      lines.push(`步${i + 1} 点击 #${tile.id}(色${tile.elementValue}) → ⚠ 不可点击（序列终止）`);
      break;
    }
    const removedBefore = new Set(game.boardSpecialStructures.filter(s => s.isRemoved).map(s => s.id));

    const matched = game.collect(tile);
    const matchText = matched && matched.length > 0
      ? ` → 消除 ${matched.map(m => `#${m.id}`).join(',')}`
      : '';
    lines.push(`步${i + 1} 点击 #${tile.id}(色${tile.elementValue}) → Dock${dockSig(game)}${matchText}`);

    for (const step of log.slice(logOffset)) {
      const line = mechanicLine(step);
      if (line) lines.push(line);
    }
    logOffset = log.length;

    for (const structure of game.boardSpecialStructures) {
      if (structure.isRemoved && !removedBefore.has(structure.id)) {
        lines.push(`　└ 大型地形 #${structure.id} 移除（依赖已清空）`);
      }
    }
  }

  const dead = game.isDead;
  const win = game.isWin;
  lines.push(
    `—— 结束: 桌面 ${game.deskTiles.length} 张 · ${win ? '✅ 通关' : dead ? `❌ 死亡（Dock ${game.dockTiles.length}/${game.maxSlotCount}）` : `未通关（Dock ${game.dockTiles.length}/${game.maxSlotCount}）`} ——`,
  );
  return { lines, win, dead };
}
