/**
 * 跨侧 golden 追踪（Cross-Side Golden Trace）。
 *
 * 目的：证明「同一地形 + 同一 ReplayCode + 同一机制配置 + 同一动作序列」在
 * Unity 客户端与 reversegen 中产生逐位一致的结果。单侧单测的 golden 只能证明
 * 自洽，不能证明对齐；本模块提供可交换的追踪格式、reversegen 侧的录制器与
 * 逐帧比对器（Unity 侧导出器见 docs/cross-side-golden.md）。
 *
 * 使用：
 *   recordCrossSideTrace(game, tileIds)  → 逐帧状态摘要
 *   compareCrossSideTraces(a, b)         → 第一处分歧定位
 *   tools/verify-cross-side.ts           → CLI：重建 + 与 Unity 追踪比对
 */

import type { OfflineGame } from '../solver/offline-game.js';
import type { OfflineTile } from '../solver/types.js';
import type { MechanicStepRecord } from '../mechanics/types.js';

export const CROSS_SIDE_PROTOCOL = 'reversegen-cross-trace';
export const CROSS_SIDE_VERSION = 1;

export interface CrossSideMeta {
  levelResId?: number;
  replayCode?: string;
  mechanics?: string;
  giftboxOpenEffects?: number[];
  boardBounds?: { width: number; height: number };
  mechanicSeed?: number;
}

export interface TraceTileState {
  id: number;
  elementValue: number;
  extras: string;
}

export interface CrossSideFrame {
  /** 本帧执行的动作；首帧（初始状态）为 null */
  action: { type: 'collect'; tileId: number } | null;
  /** Unity Steps.Count / reversegen actionCount */
  actionCount: number;
  desk: TraceTileState[];
  /** Dock 实际顺序（matchedTiles[0] 由它决定） */
  dock: TraceTileState[];
  discardCount: number;
  dockSlotBonus: number;
  bubble: {
    enabled: boolean;
    rounds: number;
    activeRoundCounted: boolean;
    active: number[];
  } | null;
  structures: Array<{ id: number; extraEnum: number; removed: boolean }>;
  /**
   * 本帧新产生的机制步骤。
   * 只包含 Unity StepMgr 会 AppendStep 的步骤类型（magic-bottle-clear / magic-step /
   * bubble-collect / giftbox-shuffle）；泡泡指派在 Unity 不是步骤（其效果经 bubble.active 体现）。
   */
  mechanicSteps: Array<{ type: string; tileIds: number[] }>;
}

export interface CrossSideTrace {
  protocol: typeof CROSS_SIDE_PROTOCOL;
  version: typeof CROSS_SIDE_VERSION;
  meta: CrossSideMeta;
  actions: number[];
  frames: CrossSideFrame[];
}

/** 挂件状态编码（与 OfflineGame.buildStateKey 同口径）。 */
function tileExtraState(tile: OfflineTile): string {
  return tile.extras.map(e => {
    const state = [e.countdown ?? '', e.isDone ? 1 : 0, e.isConsumed ? 1 : 0].join('.');
    return `${e.extraEnum}(${state})`;
  }).join('+');
}

function tileState(tile: OfflineTile): TraceTileState {
  return { id: tile.id, elementValue: tile.elementValue, extras: tileExtraState(tile) };
}

function snapshotFrame(
  game: OfflineGame,
  action: CrossSideFrame['action'],
  mechanicSteps: Array<{ type: string; tileIds: number[] }>,
): CrossSideFrame {
  const bubble = game.mechanics.bubble;
  return {
    action,
    actionCount: game.actionCount,
    desk: [...game.deskTiles].sort((a, b) => a.id - b.id).map(tileState),
    dock: game.dockTiles.map(tileState),
    discardCount: game.discardTiles.length,
    dockSlotBonus: game.dockSlotBonus,
    bubble: {
      enabled: bubble.enabled,
      rounds: bubble.completedCollectRounds,
      activeRoundCounted: bubble.activeRoundCounted,
      active: [...bubble.activeBubbleTileIds].sort((a, b) => a - b),
    },
    structures: game.boardSpecialStructures.map(s => ({
      id: s.id,
      extraEnum: s.extraEnum,
      removed: s.isRemoved,
    })),
    mechanicSteps,
  };
}

/** Unity 不会 AppendStep 的步骤类型（泡泡指派是计划类动作，效果经 bubble.active 体现）。 */
const NON_STEP_TYPES = new Set(['bubble-assign']);

/**
 * 从现成 OfflineGame 录制追踪：初始帧 + 每个动作后一帧。
 * 机制步骤增量取自 game.mechanicLog。
 */
export function recordCrossSideTrace(game: OfflineGame, actions: number[]): CrossSideTrace {
  const frames: CrossSideFrame[] = [];
  const mechanicLog = game.mechanicLog as MechanicStepRecord[];
  let logOffset = 0;

  frames.push(snapshotFrame(game, null, []));
  for (const tileId of actions) {
    const tile = game.allTiles.get(tileId);
    if (!tile) throw new Error(`动作引用了不存在的牌: ${tileId}`);
    game.collect(tile);
    const steps = mechanicLog.slice(logOffset)
      .filter(s => !NON_STEP_TYPES.has(s.type))
      .map(s => ({ type: s.type, tileIds: 'tileIds' in s ? [...s.tileIds] : [] }));
    logOffset = mechanicLog.length;
    frames.push(snapshotFrame(game, { type: 'collect', tileId }, steps));
  }
  return {
    protocol: CROSS_SIDE_PROTOCOL,
    version: CROSS_SIDE_VERSION,
    meta: {},
    actions: [...actions],
    frames,
  };
}

export interface CrossSideDiff {
  ok: boolean;
  message: string;
}

/** 逐帧比对：定位第一处分歧（帧号 + 字段路径 + 两侧值）。 */
export function compareCrossSideTraces(a: CrossSideTrace, b: CrossSideTrace): CrossSideDiff {
  if (a.protocol !== b.protocol || a.version !== b.version) {
    return { ok: false, message: `协议/版本不一致: ${a.protocol}v${a.version} vs ${b.protocol}v${b.version}` };
  }
  if (JSON.stringify(a.actions) !== JSON.stringify(b.actions)) {
    return { ok: false, message: `动作序列不一致` };
  }
  const maxFrames = Math.max(a.frames.length, b.frames.length);
  for (let i = 0; i < maxFrames; i++) {
    const fa = a.frames[i];
    const fb = b.frames[i];
    if (!fa || !fb) {
      return { ok: false, message: `帧数不一致: 第 ${i} 帧只有一侧存在` };
    }
    const diff = diffJsonPath(`frames[${i}]`, fa, fb);
    if (diff) return { ok: false, message: diff };
  }
  return { ok: true, message: `全部 ${a.frames.length} 帧逐位一致` };
}

/** 递归 JSON 路径 diff，返回第一处分歧描述（数组下标用 [i]）。 */
function diffJsonPath(path: string, expected: unknown, actual: unknown): string | null {
  if (expected === actual) return null;
  if (typeof expected !== 'object' || typeof actual !== 'object' || expected === null || actual === null) {
    return `${path}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`;
  }
  const a = expected as Record<string, unknown>;
  const b = actual as Record<string, unknown>;
  const aIsArray = Array.isArray(expected);
  const aKeys = aIsArray ? (expected as unknown[]).map((_, i) => String(i)) : Object.keys(a).sort();
  const bKeys = Array.isArray(actual) ? (actual as unknown[]).map((_, i) => String(i)) : Object.keys(b).sort();
  const keys = new Set([...aKeys, ...bKeys]);
  for (const key of [...keys]) {
    if (!(key in a) || !(key in b)) {
      return `${aIsArray ? `${path}[${key}]` : `${path}.${key}`}: 仅一侧存在`;
    }
    const inner = diffJsonPath(aIsArray ? `${path}[${key}]` : `${path}.${key}`, a[key], b[key]);
    if (inner) return inner;
  }
  return null;
}
