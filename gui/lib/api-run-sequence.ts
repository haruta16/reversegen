/**
 * GUI 操作序列跑关 API：给定 ReplayCode + 机制 + 操作序列（可省略 = 机器人跑），
 * 返回人工可读的操作结果序列（人工对照 Unity 使用）。
 * 机器人策略跟随模拟面板当前选择（normal/shortest/risky/costcap/mistake）。
 * 定位：验证工具（非玩法功能）；机器逐帧比对请用 tools/verify-cross-side.ts。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  solvePlayer,
  solvePlayerShortest,
  solvePlayerRisky,
  solvePlayerCostCap,
  solvePlayerMistake,
  solvePlayerMistakeMechanic,
} from '../../src/solver/index.js';
import { runSequenceLog } from '../../src/verification/index.js';
import { buildGameFromReplay, json, parseBody } from './runtime.js';

type RobotStrategy = 'normal' | 'shortest' | 'risky' | 'costcap' | 'mistake' | 'mistake-mechanic';

/** 机器人策略 → 跑关 picks（与模拟面板五个画像同实现同参数）。 */
function robotPicks(
  game: Parameters<typeof solvePlayer>[0],
  strategy: RobotStrategy,
  seed: number,
  riskThreshold: number | undefined,
  maxCost: number | undefined,
  mistakeRate: number | undefined,
): number[] {
  switch (strategy) {
    case 'shortest':
      return solvePlayerShortest(game, seed).picks;
    case 'risky':
      return solvePlayerRisky(game, seed, { riskThreshold: riskThreshold ?? 3 }).picks;
    case 'costcap':
      return solvePlayerCostCap(game, seed, { maxCost: maxCost ?? 5 }).picks;
    case 'mistake':
      return solvePlayerMistake(game, seed, { mistakeRate: mistakeRate ?? 0.1 }).picks;
    case 'mistake-mechanic':
      return solvePlayerMistakeMechanic(game, seed, { mistakeRate: mistakeRate ?? 0.1 }).picks;
    case 'normal':
    default:
      return solvePlayer(game, seed).picks;
  }
}

export async function handleRunSequence(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/run-sequence' || req.method !== 'POST') return false;
  const body = await parseBody(req);
  try {
    const {
      replayCode, levelId, levelsDir, terrainPath, mechanics, mechanicSeed, actions,
      strategy, riskThreshold, maxCost, mistakeRate,
    } = body as {
      replayCode?: string;
      levelId?: string;
      levelsDir?: string;
      terrainPath?: string;
      mechanics?: string;
      mechanicSeed?: number;
      actions?: number[];
      strategy?: RobotStrategy;
      riskThreshold?: number;
      maxCost?: number;
      mistakeRate?: number;
    };
    if (!replayCode) throw new Error('缺少 replayCode');

    const { game } = buildGameFromReplay(replayCode, levelId, levelsDir, terrainPath, mechanics, mechanicSeed);

    // 机器人 = 模拟面板当前策略（各画像内部自带 clone，不污染本次跑关的 game）
    let sequence: number[];
    let robot = false;
    if (Array.isArray(actions) && actions.length > 0) {
      sequence = actions;
    } else {
      robot = true;
      const robotStrategy: RobotStrategy = strategy ?? 'mistake';
      sequence = robotPicks(
        game,
        robotStrategy,
        Date.now() & 0x7fffffff,
        riskThreshold,
        maxCost,
        mistakeRate,
      );
    }

    const result = runSequenceLog(game, sequence);
    json(res, {
      ok: true,
      robot,
      strategy: strategy ?? 'mistake',
      actions: sequence,
      win: result.win,
      dead: result.dead,
      lines: result.lines,
      entries: result.entries,
    });
    return true;
  } catch (e) {
    json(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
    return true;
  }
}
