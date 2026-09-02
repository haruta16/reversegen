/**
 * GUI 分档 API：分档配置读取/热更新、计算与校验。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  gradeStandard,
  gradeRefined,
  gradeStrategy1,
  gradeStrategy2,
  gradeFull,
  validateGrade,
  computeStability,
} from '../../src/index.js';
import type {
  GradeConfig,
  GradeStrategy1Config,
  GradeResult,
  GradeVerdict,
  GradeValidation,
  GradeStrategy2Result,
} from '../../src/index.js';
import { solvePlayerMistakeBatch } from '../../src/solver/index.js';
import {
  buildGameFromReplay,
  getGradeConfig,
  getGradeStrategy1Config,
  gradeStrategy2Info,
  loadGradeConfig,
  loadGradeStrategy1Config,
  resetGradeConfigs,
  json,
  parseBody,
} from './runtime.js';
import { evaluateLatestGrade } from './latest-grade.js';

function latestSimulationView(summary: {
  runs: number; wins: number; losses: number; win_rate: number;
  avg_steps_on_win: number; avg_steps_on_loss: number;
}) {
  return {
    runs: summary.runs,
    wins: summary.wins,
    losses: summary.losses,
    winRate: summary.win_rate,
    avgStepsOnWin: summary.avg_steps_on_win,
    avgStepsOnLoss: summary.avg_steps_on_loss,
  };
}

export async function handleGradeConfig(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/grade/config' || req.method !== 'GET') return false;
    try {
      const cfg = getGradeConfig();
      const strategy1 = getGradeStrategy1Config();
      json(res, { ok: true, config: cfg, strategy1, strategy2: gradeStrategy2Info });
    } catch (err) { json(res, { ok: false, error: String(err) }, 500); }
    return true;
  }

export async function handleGradeConfigReload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/grade/config-reload' || req.method !== 'POST') return false;
    try {
      resetGradeConfigs(); // 清除缓存
      const cfg = loadGradeConfig();
      const strategy1 = loadGradeStrategy1Config();
      json(res, { ok: true, message: `已重新加载旧版、${strategy1.name}与${gradeStrategy2Info.name}`, config: cfg, strategy1, strategy2: gradeStrategy2Info });
    } catch (err) { json(res, { ok: false, error: String(err) }, 500); }
    return true;
  }

export async function handleGradeCalculate(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/grade/calculate' || req.method !== 'POST') return false;
    const body = await parseBody(req);
    try {
      const { replayCode, levelId, levelsDir, terrainPath, runs, strategy, mechanics, mechanicSeed } = body as {
        replayCode?: string; levelId?: string; levelsDir?: string; terrainPath?: string; runs?: number; strategy?: string;
        mechanics?: string; mechanicSeed?: number;
      };
      if (!replayCode) throw new Error('缺少 replayCode');

      const built = buildGameFromReplay(replayCode, levelId, levelsDir, terrainPath, mechanics, mechanicSeed);
      const effectiveStrategy = strategy ?? 'latest';
      if (effectiveStrategy === 'latest') {
        const simRuns = runs ?? 100;
        const evaluation = await evaluateLatestGrade(built.game, built.totalTiles, simRuns, 'grade-calculate');
        json(res, {
          ok: true,
          strategy: 'latest',
          runs: simRuns,
          simResults: {
            sim1: latestSimulationView(evaluation.sim1),
            optimal: latestSimulationView(evaluation.optimal),
          },
          optimalLossRemainingRatio: evaluation.optimalLossRemainingRatio,
          grade: { latest: evaluation.verdict },
        });
        return true;
      }
      const gam = built.game;
      const useStrategy1 = effectiveStrategy === 'strategy1';
      const useStrategy2 = effectiveStrategy === 'strategy2';
      const cfg = (useStrategy1 || useStrategy2) ? getGradeStrategy1Config() : getGradeConfig();
      const simRuns = runs ?? cfg.defaultRuns;

      // 串行跑三个失误率
      const simResults: Array<{ rate: number; label: string }> = [
        { rate: cfg.simRates.ceiling, label: 'sim1' },
        { rate: cfg.simRates.baseline, label: 'sim5' },
        { rate: cfg.simRates.floor, label: 'sim15' },
      ];

      const rawResults: Record<string, { winRate: number; wins: number; losses: number; elapsedMs: number }> = {};
      for (const sr of simResults) {
        const baseSeed = (Date.now() + Math.floor(Math.random() * 65536)) & 0x7fffffff;
        const r = solvePlayerMistakeBatch(gam, simRuns, baseSeed, { mistakeRate: sr.rate });
        rawResults[sr.label] = {
          winRate: r.winRate,
          wins: r.wins,
          losses: r.losses,
          elapsedMs: Math.round(r.elapsedMs),
        };
      }

      const snap = {
        sim1: { ...rawResults.sim1, runs: simRuns },
        sim5: { ...rawResults.sim5, runs: simRuns },
        sim15: { ...rawResults.sim15, runs: simRuns },
      };

      const strategyResult: GradeVerdict | null = useStrategy1
        ? gradeStrategy1(snap, cfg as GradeStrategy1Config)
        : null;
      const strategy2Result: GradeStrategy2Result | null = useStrategy2
        ? gradeStrategy2(snap)
        : null;
      const legacyResult: GradeResult | null = (useStrategy1 || useStrategy2)
        ? null
        : gradeFull(snap, cfg as GradeConfig);

      // 计算稳定性（兼容旧版本可能没有的字段，这里用 gradeFull 内部的结果）
      const stability = computeStability(snap.sim1.winRate, snap.sim15.winRate);

      json(res, {
        ok: true,
        strategy: useStrategy1 ? 'strategy1' : useStrategy2 ? 'strategy2' : 'legacy',
        runs: simRuns,
        simResults: {
          sim1: { winRate: snap.sim1.winRate, wins: snap.sim1.wins, losses: snap.sim1.losses, elapsedMs: snap.sim1.elapsedMs },
          sim5: { winRate: snap.sim5.winRate, wins: snap.sim5.wins, losses: snap.sim5.losses, elapsedMs: snap.sim5.elapsedMs },
          sim15: { winRate: snap.sim15.winRate, wins: snap.sim15.wins, losses: snap.sim15.losses, elapsedMs: snap.sim15.elapsedMs },
        },
        stability,
        grade: useStrategy1
          ? { strategy1: strategyResult }
          : useStrategy2
            ? { strategy2: strategy2Result }
            : { standard: legacyResult!.standard, refined: legacyResult!.refined },
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return true;
  }

export async function handleGradeValidate(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/grade/validate' || req.method !== 'POST') return false;
    const body = await parseBody(req);
    try {
      const { replayCode, levelId, levelsDir, terrainPath, runs, targetGrade, strategy, mechanics, mechanicSeed } = body as {
        replayCode?: string; levelId?: string; levelsDir?: string; terrainPath?: string; runs?: number; targetGrade?: number; strategy?: string;
        mechanics?: string; mechanicSeed?: number;
      };
      if (!replayCode) throw new Error('缺少 replayCode');
      const effectiveStrategy = strategy ?? 'latest';
      if (effectiveStrategy === 'latest') {
        if (!Number.isInteger(targetGrade) || targetGrade! < 1 || targetGrade! > 11) {
          throw new Error('targetGrade 需为 1-11 的整数');
        }
        const built = buildGameFromReplay(replayCode, levelId, levelsDir, terrainPath, mechanics, mechanicSeed);
        const simRuns = runs ?? 100;
        const evaluation = await evaluateLatestGrade(built.game, built.totalTiles, simRuns, 'grade-validate');
        const latestMatch = evaluation.verdict.passed && evaluation.verdict.grade === targetGrade;
        json(res, {
          ok: true,
          strategy: 'latest',
          runs: simRuns,
          targetGrade,
          allMatch: latestMatch,
          simResults: {
            sim1: latestSimulationView(evaluation.sim1),
            optimal: latestSimulationView(evaluation.optimal),
          },
          optimalLossRemainingRatio: evaluation.optimalLossRemainingRatio,
          grade: { latest: evaluation.verdict },
          validation: {
            targetGrade,
            latestMatch,
            reasons: latestMatch ? [] : [evaluation.verdict.passed
              ? `最新11档策略: 实际 G${evaluation.verdict.grade}，目标 G${targetGrade}`
              : `最新11档策略: ${evaluation.verdict.reason}`],
          },
        });
        return true;
      }
      const useStrategy1 = effectiveStrategy === 'strategy1';
      const useStrategy2 = effectiveStrategy === 'strategy2';
      const maxGrade = (useStrategy1 || useStrategy2) ? 5 : 7;
      if (targetGrade == null || targetGrade < 0 || targetGrade > maxGrade) {
        throw new Error(`targetGrade 需为 0-${maxGrade} 的整数`);
      }

      const { game: gam } = buildGameFromReplay(replayCode, levelId, levelsDir, terrainPath, mechanics, mechanicSeed);
      const cfg = (useStrategy1 || useStrategy2) ? getGradeStrategy1Config() : getGradeConfig();
      const simRuns = runs ?? cfg.defaultRuns;

      const simResults: Array<{ rate: number; label: string }> = [
        { rate: cfg.simRates.ceiling, label: 'sim1' },
        { rate: cfg.simRates.baseline, label: 'sim5' },
        { rate: cfg.simRates.floor, label: 'sim15' },
      ];

      const rawResults: Record<string, { winRate: number; wins: number; losses: number; elapsedMs: number }> = {};
      for (const sr of simResults) {
        const baseSeed = (Date.now() + Math.floor(Math.random() * 65536)) & 0x7fffffff;
        const r = solvePlayerMistakeBatch(gam, simRuns, baseSeed, { mistakeRate: sr.rate });
        rawResults[sr.label] = {
          winRate: r.winRate,
          wins: r.wins,
          losses: r.losses,
          elapsedMs: Math.round(r.elapsedMs),
        };
      }

      const snap = {
        sim1: { ...rawResults.sim1, runs: simRuns },
        sim5: { ...rawResults.sim5, runs: simRuns },
        sim15: { ...rawResults.sim15, runs: simRuns },
      };

      const strategyResult: GradeVerdict | null = useStrategy1
        ? gradeStrategy1(snap, cfg as GradeStrategy1Config)
        : null;
      const strategy2Result: GradeStrategy2Result | null = useStrategy2
        ? gradeStrategy2(snap)
        : null;
      const legacyResult: GradeResult | null = (useStrategy1 || useStrategy2)
        ? null
        : gradeFull(snap, cfg as GradeConfig);
      const strategy1Match = strategyResult != null
        && strategyResult.passed
        && strategyResult.grade === targetGrade;
      const strategy2Match = strategy2Result != null
        && strategy2Result.passed
        && strategy2Result.grade === targetGrade;
      const validation = useStrategy1
        ? {
            targetGrade,
            strategy1Match,
            reasons: strategy1Match ? [] : [strategyResult!.passed
              ? `分档策略1: 实际档${strategyResult!.grade}(${strategyResult!.label})，目标档${targetGrade}`
              : `分档策略1: ${strategyResult!.reason}`],
          }
        : useStrategy2
          ? {
              targetGrade,
              strategy2Match,
              reasons: strategy2Match ? [] : [
                `评估策略2: 实际档${strategy2Result!.grade}(${strategy2Result!.label})，目标档${targetGrade}，passrate=${(strategy2Result!.passrate * 100).toFixed(1)}%`,
              ],
            }
        : validateGrade(snap, targetGrade, cfg as GradeConfig);
      const stability = computeStability(snap.sim1.winRate, snap.sim15.winRate);

      json(res, {
        ok: true,
        strategy: useStrategy1 ? 'strategy1' : useStrategy2 ? 'strategy2' : 'legacy',
        runs: simRuns,
        targetGrade,
        allMatch: useStrategy1
          ? strategy1Match
          : useStrategy2
            ? strategy2Match
          : (validation as GradeValidation).standardMatch && (validation as GradeValidation).refinedMatch,
        simResults: {
          sim1: { winRate: snap.sim1.winRate, wins: snap.sim1.wins, losses: snap.sim1.losses, elapsedMs: snap.sim1.elapsedMs },
          sim5: { winRate: snap.sim5.winRate, wins: snap.sim5.wins, losses: snap.sim5.losses, elapsedMs: snap.sim5.elapsedMs },
          sim15: { winRate: snap.sim15.winRate, wins: snap.sim15.wins, losses: snap.sim15.losses, elapsedMs: snap.sim15.elapsedMs },
        },
        stability,
        grade: useStrategy1
          ? { strategy1: strategyResult }
          : useStrategy2
            ? { strategy2: strategy2Result }
            : { standard: legacyResult!.standard, refined: legacyResult!.refined },
        validation,
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return true;
  }
