/**
 * GUI 逐帧追踪 API：给定 ReplayCode + 机制 + 动作序列，返回跨侧 golden 追踪 JSON。
 * 定位：验证/复现工具（非玩法功能）——同一输入在 Unity 与 reversegen 双端导出后逐帧比对。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { decodeFromString } from '../../src/index.js';
import { buildTraceFromInputs } from '../../src/verification/index.js';
import { findTerrainByLevelHash, json, parseBody, resolveTerrainPath } from './runtime.js';

export async function handleTraceExport(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/trace' || req.method !== 'POST') return false;
  const body = await parseBody(req);
  try {
    const { replayCode, levelId, levelsDir, terrainPath, mechanics, mechanicSeed, giftboxOpenEffects, actions } = body as {
      replayCode?: string;
      levelId?: string;
      levelsDir?: string;
      terrainPath?: string;
      mechanics?: string;
      mechanicSeed?: number;
      giftboxOpenEffects?: number[];
      actions?: number[];
    };
    if (!replayCode) throw new Error('缺少 replayCode');
    if (!Array.isArray(actions) || actions.length === 0) throw new Error('缺少动作序列 actions');

    // 地形解析与 buildGameFromReplay 同口径：优先 replay 内嵌 levelHash，其次 levelId/terrainPath
    const replayData = decodeFromString(replayCode);
    let path: string | null = null;
    if (replayData && replayData.levelHash !== 0n) {
      path = findTerrainByLevelHash(replayData.levelHash.toString(16).padStart(16, '0'), levelsDir);
    }
    if (!path) path = resolveTerrainPath(levelId, levelsDir, terrainPath);
    if (!path) throw new Error('无法解析地形（需要 levelId / terrainPath 或带 levelHash 的有效 ReplayCode）');

    const trace = buildTraceFromInputs({
      terrainPath: path,
      replayCode,
      mechanics,
      mechanicSeed,
      giftboxOpenEffects,
      actions,
    });
    json(res, {
      ok: true,
      terrainPath: path,
      frames: trace.frames.length,
      mechanicStepCount: trace.frames.reduce((sum, f) => sum + f.mechanicSteps.length, 0),
      trace,
    });
    return true;
  } catch (e) {
    json(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
    return true;
  }
}
