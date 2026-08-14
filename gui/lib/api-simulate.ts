/**
 * GUI 玩家模拟 API：标准 / 最短当前态 / 激进 / 成本上限 / 失误玩家。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  solvePlayerBatch,
  solvePlayerRiskyBatch,
  solvePlayerCostCapBatch,
  solvePlayerMistakeBatch,
  solvePlayerShortestBatch,
} from '../../src/solver/index.js';
import { buildGameFromReplay, json, parseBody } from './runtime.js';

export async function handlePlayerSim(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/player-sim' || req.method !== 'POST') return false;
    const body = await parseBody(req);
    try {
      const { replayCode, levelId, levelsDir, terrainPath, runs, mechanics, mechanicSeed } = body as {
        replayCode?: string; levelId?: string; levelsDir?: string; terrainPath?: string; mechanics?: string; mechanicSeed?: number;
        runs?: number;
      };
      if (!replayCode) throw new Error('缺少 replayCode');

      const { game } = buildGameFromReplay(replayCode, levelId, levelsDir, terrainPath, mechanics, mechanicSeed);
      const simRuns = runs ?? 100;
      const baseSeed = Date.now() & 0x7fffffff;

      const result = solvePlayerBatch(game, simRuns, baseSeed);

      json(res, {
        ok: true,
        runs: simRuns,
        wins: result.wins,
        losses: result.losses,
        winRate: result.winRate,
        avgStepsOnWin: result.avgStepsOnWin,
        avgStepsOnLoss: result.avgStepsOnLoss,
        elapsedMs: Math.round(result.elapsedMs),
        // 只返回前 10 个详细结果（避免数据太大）
        sampleResults: (result.results ?? []).slice(0, 10).map(r => ({
          win: r.win,
          failReason: r.failReason,
          stepCount: r.stepCount,
          seed: r.seed,
        })),
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return true;
  }

export async function handlePlayerSimShortest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/player-sim-shortest' || req.method !== 'POST') return false;
    const body = await parseBody(req);
    try {
      const { replayCode, levelId, levelsDir, terrainPath, runs, mechanics, mechanicSeed } = body as {
        replayCode?: string; levelId?: string; levelsDir?: string; terrainPath?: string; mechanics?: string; mechanicSeed?: number;
        runs?: number;
      };
      if (!replayCode) throw new Error('缺少 replayCode');

      const { game, totalTiles } = buildGameFromReplay(replayCode, levelId, levelsDir, terrainPath, mechanics, mechanicSeed);
      const simRuns = runs ?? 100;
      const baseSeed = Date.now() & 0x7fffffff;
      const result = solvePlayerShortestBatch(game, simRuns, baseSeed);
      const remainingTilesOnLoss = result.losses > 0
        ? Math.max(0, totalTiles - result.stepsOnLoss)
        : null;
      const remainingRatioOnLoss = remainingTilesOnLoss == null || totalTiles <= 0
        ? null
        : remainingTilesOnLoss / totalTiles;
      const optimalMetrics = {
        runs: simRuns,
        wins: result.wins,
        losses: result.losses,
        winRate: result.winRate,
        avgStepsOnWin: result.avgStepsOnWin,
        forcedPickOnWin: result.forcedPickOnWin,
        starvationOnWin: result.starvationOnWin,
        starvationPerTileOnWin: totalTiles > 0 ? result.starvationOnWin / totalTiles : 0,
        avgStepsOnLoss: result.stepsOnLoss,
        forcedPickOnLoss: result.forcedPickOnLoss,
        starvationOnLoss: result.starvationOnLoss,
        remainingTilesOnLoss,
        remainingRatioOnLoss,
        totalTiles,
      };

      json(res, {
        ok: true,
        mode: 'shortest',
        runs: simRuns,
        wins: result.wins,
        losses: result.losses,
        winRate: result.winRate,
        avgStepsOnWin: result.avgStepsOnWin,
        avgStepsOnLoss: result.avgStepsOnLoss,
        elapsedMs: Math.round(result.elapsedMs),
        forcedPickOnWin: result.forcedPickOnWin,
        starvationOnWin: result.starvationOnWin,
        stepsOnLoss: result.stepsOnLoss,
        forcedPickOnLoss: result.forcedPickOnLoss,
        starvationOnLoss: result.starvationOnLoss,
        totalTiles: totalTiles,
        remainingTilesOnLoss,
        remainingRatioOnLoss,
        optimalMetrics,
        sampleResults: (result.results ?? []).slice(0, 10).map(r => ({
          win: r.win,
          failReason: r.failReason,
          stepCount: r.stepCount,
          seed: r.seed,
        })),
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return true;
  }

export async function handlePlayerSimRisky(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/player-sim-risky' || req.method !== 'POST') return false;
    const body = await parseBody(req);
    try {
      const { replayCode, levelId, levelsDir, terrainPath, runs, riskThreshold, mechanics, mechanicSeed } = body as {
        replayCode?: string; levelId?: string; levelsDir?: string; terrainPath?: string; mechanics?: string; mechanicSeed?: number;
        runs?: number; riskThreshold?: number;
      };
      if (!replayCode) throw new Error('缺少 replayCode');

      const { game } = buildGameFromReplay(replayCode, levelId, levelsDir, terrainPath, mechanics, mechanicSeed);
      const simRuns = runs ?? 100;
      const baseSeed = Date.now() & 0x7fffffff;

      const result = solvePlayerRiskyBatch(game, simRuns, baseSeed, { riskThreshold });

      json(res, {
        ok: true,
        mode: 'risky',
        riskThreshold: riskThreshold ?? 3,
        runs: simRuns,
        wins: result.wins,
        losses: result.losses,
        winRate: result.winRate,
        avgStepsOnWin: result.avgStepsOnWin,
        avgStepsOnLoss: result.avgStepsOnLoss,
        elapsedMs: Math.round(result.elapsedMs),
        sampleResults: (result.results ?? []).slice(0, 10).map(r => ({
          win: r.win,
          failReason: r.failReason,
          stepCount: r.stepCount,
          seed: r.seed,
        })),
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return true;
  }

export async function handlePlayerSimCostcap(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/player-sim-costcap' || req.method !== 'POST') return false;
    const body = await parseBody(req);
    try {
      const { replayCode, levelId, levelsDir, terrainPath, runs, maxCost, mechanics, mechanicSeed } = body as {
        replayCode?: string; levelId?: string; levelsDir?: string; terrainPath?: string; mechanics?: string; mechanicSeed?: number;
        runs?: number; maxCost?: number;
      };
      if (!replayCode) throw new Error('缺少 replayCode');
      if (maxCost == null || maxCost < 1) throw new Error('请提供有效的成本上限 (maxCost ≥ 1)');

      const { game } = buildGameFromReplay(replayCode, levelId, levelsDir, terrainPath, mechanics, mechanicSeed);
      const simRuns = runs ?? 100;
      const baseSeed = Date.now() & 0x7fffffff;

      const result = solvePlayerCostCapBatch(game, simRuns, baseSeed, { maxCost });

      json(res, {
        ok: true,
        mode: 'costcap',
        maxCost,
        runs: simRuns,
        wins: result.wins,
        losses: result.losses,
        winRate: result.winRate,
        avgStepsOnWin: result.avgStepsOnWin,
        avgStepsOnLoss: result.avgStepsOnLoss,
        elapsedMs: Math.round(result.elapsedMs),
        sampleResults: (result.results ?? []).slice(0, 10).map(r => ({
          win: r.win,
          failReason: r.failReason,
          stepCount: r.stepCount,
          seed: r.seed,
        })),
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return true;
  }

export async function handlePlayerSimMistake(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/player-sim-mistake' || req.method !== 'POST') return false;
    const body = await parseBody(req);
    try {
      const { replayCode, levelId, levelsDir, terrainPath, runs, mistakeRate, mechanics, mechanicSeed } = body as {
        replayCode?: string; levelId?: string; levelsDir?: string; terrainPath?: string; mechanics?: string; mechanicSeed?: number;
        runs?: number; mistakeRate?: number;
      };
      if (!replayCode) throw new Error('缺少 replayCode');
      if (mistakeRate == null || mistakeRate < 0 || mistakeRate > 1) {
        throw new Error('失误率需在 0.0 ~ 1.0 之间');
      }

      const { game } = buildGameFromReplay(replayCode, levelId, levelsDir, terrainPath, mechanics, mechanicSeed);
      const simRuns = runs ?? 100;
      const baseSeed = Date.now() & 0x7fffffff;

      const result = solvePlayerMistakeBatch(game, simRuns, baseSeed, { mistakeRate });

      json(res, {
        ok: true,
        mode: 'mistake',
        mistakeRate,
        runs: simRuns,
        wins: result.wins,
        losses: result.losses,
        winRate: result.winRate,
        avgStepsOnWin: result.avgStepsOnWin,
        avgStepsOnLoss: result.avgStepsOnLoss,
        elapsedMs: Math.round(result.elapsedMs),
        sampleResults: (result.results ?? []).slice(0, 10).map(r => ({
          win: r.win,
          failReason: r.failReason,
          stepCount: r.stepCount,
          seed: r.seed,
        })),
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return true;
  }
