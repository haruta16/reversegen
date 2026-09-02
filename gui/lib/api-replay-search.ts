import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildGameFromReplay, json, parseBody } from './runtime.js';
import { evaluateLatestGrade } from './latest-grade.js';

export async function handleReplaySearchEvaluate(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname !== '/api/replay-search/evaluate' || req.method !== 'POST') return false;
  const body = await parseBody(req);
  try {
    const {
      replayCode,
      levelId,
      levelsDir,
      terrainPath,
      targetGrade,
      mechanics,
      mechanicSeed,
    } = body as {
      replayCode?: string;
      levelId?: string;
      levelsDir?: string;
      terrainPath?: string;
      targetGrade?: number;
      mechanics?: string;
      mechanicSeed?: number;
    };
    if (!replayCode) throw new Error('缺少 replayCode');
    if (typeof targetGrade !== 'number' || !Number.isInteger(targetGrade) || targetGrade < 1 || targetGrade > 11) {
      throw new Error('targetGrade 必须是 1-11 的整数');
    }
    const built = buildGameFromReplay(
      replayCode,
      levelId,
      levelsDir,
      terrainPath,
      mechanics,
      mechanicSeed,
    );
    const evaluation = await evaluateLatestGrade(
      built.game,
      built.totalTiles,
      100,
      `replay-search:g${targetGrade}`,
    );
    json(res, {
      ok: true,
      targetGrade,
      matched: evaluation.verdict.passed && evaluation.verdict.grade === targetGrade,
      runsPerRobot: 100,
      sim1: evaluation.sim1,
      optimal: evaluation.optimal,
      optimalLossRemainingRatio: evaluation.optimalLossRemainingRatio,
      grade: evaluation.verdict,
    });
  } catch (error) {
    json(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
  return true;
}
