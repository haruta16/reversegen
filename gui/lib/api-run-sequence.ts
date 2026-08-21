/**
 * GUI 操作序列跑关 API：给定 ReplayCode + 机制 + 操作序列（可省略 = 机器人跑），
 * 返回人工可读的操作结果序列（人工对照 Unity 使用）。
 * 定位：验证工具（非玩法功能）；机器逐帧比对请用 tools/verify-cross-side.ts。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { solvePlayer } from '../../src/solver/index.js';
import { runSequenceLog } from '../../src/verification/index.js';
import { buildGameFromReplay, json, parseBody } from './runtime.js';

export async function handleRunSequence(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/run-sequence' || req.method !== 'POST') return false;
  const body = await parseBody(req);
  try {
    const { replayCode, levelId, levelsDir, terrainPath, mechanics, mechanicSeed, actions } = body as {
      replayCode?: string;
      levelId?: string;
      levelsDir?: string;
      terrainPath?: string;
      mechanics?: string;
      mechanicSeed?: number;
      actions?: number[];
    };
    if (!replayCode) throw new Error('缺少 replayCode');

    const { game } = buildGameFromReplay(replayCode, levelId, levelsDir, terrainPath, mechanics, mechanicSeed);

    // 机器人 = 与现有 GUI 玩家模拟同一策略（标准玩家画像，模拟侧自带 clone）
    let sequence: number[];
    let robot = false;
    if (Array.isArray(actions) && actions.length > 0) {
      sequence = actions;
    } else {
      robot = true;
      const sim = solvePlayer(game, Date.now() & 0x7fffffff, 2000);
      sequence = sim.picks;
    }

    const result = runSequenceLog(game, sequence);
    json(res, {
      ok: true,
      robot,
      actions: sequence,
      win: result.win,
      dead: result.dead,
      lines: result.lines,
    });
    return true;
  } catch (e) {
    json(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
    return true;
  }
}
