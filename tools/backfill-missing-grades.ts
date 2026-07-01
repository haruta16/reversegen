#!/usr/bin/env npx tsx
/**
 * Build and optionally execute a missing-grade backfill plan.
 *
 * Default behavior is plan-only:
 *   npx tsx tools/backfill-missing-grades.ts
 *
 * Run generation:
 *   npx tsx tools/backfill-missing-grades.ts --run --concurrency 5
 *
 * G0 policy:
 *   - no simulation
 *   - grade/passrate are written as 0/1
 *   - closeRates are all 1, meaning each layer takes its maximum closure target
 *   - colorCount = colorRatio * floor(freeTiles / 3)
 *   - spreadParam defaults to 0 (tight)
 *   - debtPersistenceWeight defaults to 0
 *
 * G1-G5 policy:
 *   - colorCount keeps the same colorRatio
 *   - closeRates and spreadParam are randomized
 *   - debtPersistenceWeight is randomized by default
 *   - rows are accepted only when gradeStrategy2 returns the target grade
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import {
  decodeFromString,
  computeCloseRatesFromAssignments,
  computeDependencyDepth,
  computeMetrics,
  computeTileDepSets,
  generateBoardLayerClosure,
  generateReplayCode,
  getAllTiles,
  getCanonicalTileOrder,
  loadTerrainFromFile,
  LogLevel,
  setLogLevel,
} from '../src/index.js';
import { createGame } from '../src/solver/offline-game.js';
import { solvePlayerMistakeBatch } from '../src/solver/index.js';
import { solvePlayerShortestBatch } from '../src/solver/solver-player-shortest.js';
import { gradeStrategy2, type SimSnapshot } from '../src/grader.js';
import {
  BATCH_CSV_HEADERS,
  colorCountFromRatio,
  generateAndEvaluateOne,
  randomizeCloseRatesFromTiles,
  serializeBatchRow,
  type BatchRow,
  type GenerationParams,
} from '../src/batch-generator.js';
import { mulberry32 } from '../src/random-utils.js';
import type { TerrainData, TerrainTile } from '../src/types.js';

setLogLevel(LogLevel.Silent);

const DEFAULT_INPUT = 'output/100003～100071_100073+_合并去少_无尽限制.csv';
const DEFAULT_PLAN = 'output/无尽补缺计划.csv';
const DEFAULT_OUTPUT = 'output/无尽补缺生成.csv';
const DEFAULT_STATUS = 'output/无尽补缺状态.json';
const GRADES = [0, 1, 2, 3, 4, 5];

interface OptimalGradeConstraint {
  min_win_rate?: number;
  min_win_rate_exclusive?: number;
  max_win_rate_exclusive?: number;
  min_win_starvation_per_tile?: number;
  max_win_starvation_per_tile?: number;
  max_loss_remaining_ratio?: number;
}

interface OptimalAcceptanceConfig {
  runs: number;
  grade_constraints: Record<string, OptimalGradeConstraint>;
}

interface CliOptions {
  input: string;
  plan: string;
  output: string;
  status: string;
  levelsDir: string;
  targetPerGrade: number;
  targetPolicy: 'downward-to-target' | 'replace-filtered';
  minExistingCount: number;
  gradesToBackfill: Set<number>;
  excludeLevels: Set<string>;
  colorRatio: number;
  colorRatioMin: number;
  colorRatioMax: number;
  g0Spread: number;
  g0Debt: number;
  colorJitter: number;
  searchCloseMin: number | null;
  searchCloseMax: number | null;
  searchCloseMode: 'targeted' | 'project-random' | 'strict-range';
  searchDebtMin: number | null;
  searchDebtMax: number | null;
  searchSpreadMin: number | null;
  searchSpreadMax: number | null;
  simRuns: number;
  acceptMinSim1Wins: number | null;
  acceptMinSim5Wins: number | null;
  acceptMinSim15Wins: number | null;
  acceptMinPassrate: number | null;
  optimalAcceptance: OptimalAcceptanceConfig | null;
  maxAttemptsPerMissing: number;
  maxAttemptsPerLevel: number | null;
  templateAttempts: number;
  reuseTemplateParams: boolean;
  shuffleJobs: boolean;
  concurrency: number;
  run: boolean;
  resume: boolean;
  targetFromOutputOnly: boolean;
  progressLines: boolean;
  adaptiveSearch: boolean;
  adaptiveExploreRate: number;
  adaptivePoolSize: number;
  adaptiveMinSamples: number;
  adaptiveContinuousStep: number;
  optimalFirst: boolean;
  placementMode: 'layer-closure' | 'random-color';
}

interface ExistingRow {
  levelResId: string;
  grade: number;
  terrainPath: string;
  accepted: boolean;
  countForTarget: boolean;
  definesTarget: boolean;
}

interface LevelCoverage {
  levelResId: string;
  terrainPath: string;
  counts: Record<number, number>;
  supportedGrades: number[];
  maxGrade: number;
  targets: Record<number, number>;
  missing: Record<number, number>;
}

interface SearchJob {
  jobId: string;
  levelResId: string;
  terrainPath: string;
  targetNeeds: Record<number, number>;
  maxAttempts: number;
  templateAttempts: number;
  simRuns: number;
  acceptMinSim1Wins: number | null;
  acceptMinSim5Wins: number | null;
  acceptMinSim15Wins: number | null;
  acceptMinPassrate: number | null;
  optimalAcceptance: OptimalAcceptanceConfig | null;
  colorRatioMin: number;
  colorRatioMax: number;
  colorJitter: number;
  searchCloseMin: number | null;
  searchCloseMax: number | null;
  searchCloseMode: 'targeted' | 'project-random' | 'strict-range';
  searchDebtMin: number | null;
  searchDebtMax: number | null;
  searchSpreadMin: number | null;
  searchSpreadMax: number | null;
  reuseTemplateParams: boolean;
  adaptiveSearch: boolean;
  adaptiveExploreRate: number;
  adaptivePoolSize: number;
  adaptiveMinSamples: number;
  adaptiveContinuousStep: number;
  optimalFirst: boolean;
  placementMode: 'layer-closure' | 'random-color';
  historicalTemplates: Record<number, GenerationParams[]>;
  seedBase: number;
}

interface AdaptiveCandidate {
  params: GenerationParams;
  score: number;
  direction: -1 | 0 | 1;
}

interface WorkerProgress {
  type: 'progress';
  jobId: string;
  attempts: number;
  foundByGrade: Record<number, number>;
}

interface WorkerRow {
  type: 'row';
  jobId: string;
  row: BatchRow;
  attempts: number;
  foundByGrade: Record<number, number>;
}

interface WorkerDone {
  type: 'done';
  jobId: string;
  attempts: number;
  foundByGrade: Record<number, number>;
}

interface WorkerError {
  type: 'error';
  jobId: string;
  error: string;
}

type WorkerMessage = WorkerProgress | WorkerRow | WorkerDone | WorkerError;

interface SearchSummary {
  totalJobs: number;
  doneJobs: number;
  totalNeeded: number;
  totalFound: number;
  totalAttempts: number;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    input: DEFAULT_INPUT,
    plan: DEFAULT_PLAN,
    output: DEFAULT_OUTPUT,
    status: DEFAULT_STATUS,
    levelsDir: '/Users/wenhaowang/WorkSpace/TileMatchShell/Tools/Config/Json/Levels',
    targetPerGrade: 5,
    targetPolicy: 'downward-to-target',
    minExistingCount: 1,
    gradesToBackfill: new Set([0, 1, 2, 3, 4, 5]),
    excludeLevels: new Set(['100004']),
    colorRatio: 0.6,
    colorRatioMin: 0.6,
    colorRatioMax: 0.6,
    g0Spread: 0,
    g0Debt: 0,
    colorJitter: 2,
    searchCloseMin: null,
    searchCloseMax: null,
    searchCloseMode: 'targeted',
    searchDebtMin: null,
    searchDebtMax: null,
    searchSpreadMin: null,
    searchSpreadMax: null,
    simRuns: 100,
    acceptMinSim1Wins: null,
    acceptMinSim5Wins: null,
    acceptMinSim15Wins: null,
    acceptMinPassrate: null,
    optimalAcceptance: null,
    maxAttemptsPerMissing: 300,
    maxAttemptsPerLevel: null,
    templateAttempts: 100,
    reuseTemplateParams: true,
    shuffleJobs: true,
    concurrency: Math.max(1, Math.min(availableParallelism() - 1, 5)),
    run: false,
    resume: false,
    targetFromOutputOnly: false,
    progressLines: false,
    adaptiveSearch: false,
    adaptiveExploreRate: 0.2,
    adaptivePoolSize: 5,
    adaptiveMinSamples: 3,
    adaptiveContinuousStep: 0.08,
    optimalFirst: false,
    placementMode: 'layer-closure',
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? '';
    const nextNumber = (fallback: number) => {
      const value = Number(next());
      return Number.isFinite(value) ? value : fallback;
    };
    if (a === '--input') opts.input = next();
    else if (a === '--plan') opts.plan = next();
    else if (a === '--output') opts.output = next();
    else if (a === '--status') opts.status = next();
    else if (a === '--levels-dir') opts.levelsDir = next();
    else if (a === '--target' || a === '--target-per-grade') opts.targetPerGrade = nextNumber(opts.targetPerGrade);
    else if (a === '--target-policy') {
      const value = next();
      if (value === 'downward-to-target' || value === 'replace-filtered') opts.targetPolicy = value;
      else throw new Error(`未知target policy: ${value}`);
    }
    else if (a === '--min-existing-count') opts.minExistingCount = nextNumber(opts.minExistingCount);
    else if (a === '--grades') opts.gradesToBackfill = new Set(next().split(',').map(s => Number(s.trim())).filter(Number.isFinite));
    else if (a === '--exclude-levels') opts.excludeLevels = new Set(next().split(',').map(s => s.trim()).filter(Boolean));
    else if (a === '--color-ratio') {
      opts.colorRatio = nextNumber(opts.colorRatio);
      opts.colorRatioMin = opts.colorRatio;
      opts.colorRatioMax = opts.colorRatio;
    }
    else if (a === '--color-ratio-min') opts.colorRatioMin = nextNumber(opts.colorRatioMin);
    else if (a === '--color-ratio-max') opts.colorRatioMax = nextNumber(opts.colorRatioMax);
    else if (a === '--color-jitter') opts.colorJitter = nextNumber(opts.colorJitter);
    else if (a === '--g0-spread') opts.g0Spread = nextNumber(opts.g0Spread);
    else if (a === '--g0-debt') opts.g0Debt = nextNumber(opts.g0Debt);
    else if (a === '--search-close-min') opts.searchCloseMin = nextNumber(0);
    else if (a === '--search-close-max') opts.searchCloseMax = nextNumber(1);
    else if (a === '--search-close-mode') {
      const value = next();
      if (value === 'targeted' || value === 'project-random' || value === 'strict-range') {
        opts.searchCloseMode = value;
      }
    }
    else if (a === '--search-debt-min') opts.searchDebtMin = nextNumber(0);
    else if (a === '--search-debt-max') opts.searchDebtMax = nextNumber(1);
    else if (a === '--search-spread-min') opts.searchSpreadMin = nextNumber(0);
    else if (a === '--search-spread-max') opts.searchSpreadMax = nextNumber(1);
    else if (a === '--sim-runs') opts.simRuns = nextNumber(opts.simRuns);
    else if (a === '--accept-min-sim1-wins') opts.acceptMinSim1Wins = nextNumber(0);
    else if (a === '--accept-min-sim5-wins') opts.acceptMinSim5Wins = nextNumber(0);
    else if (a === '--accept-min-sim15-wins') opts.acceptMinSim15Wins = nextNumber(0);
    else if (a === '--accept-min-passrate') opts.acceptMinPassrate = nextNumber(0);
    else if (a === '--optimal-acceptance-json') opts.optimalAcceptance = parseOptimalAcceptance(next());
    else if (a === '--max-attempts-per-missing') opts.maxAttemptsPerMissing = nextNumber(opts.maxAttemptsPerMissing);
    else if (a === '--max-attempts-per-level') opts.maxAttemptsPerLevel = nextNumber(300);
    else if (a === '--template-attempts') opts.templateAttempts = nextNumber(opts.templateAttempts);
    else if (a === '--no-reuse-template') opts.reuseTemplateParams = false;
    else if (a === '--reuse-template') opts.reuseTemplateParams = true;
    else if (a === '--concurrency') opts.concurrency = nextNumber(opts.concurrency);
    else if (a === '--shuffle-jobs') opts.shuffleJobs = true;
    else if (a === '--no-shuffle') opts.shuffleJobs = false;
    else if (a === '--run') opts.run = true;
    else if (a === '--resume') opts.resume = true;
    else if (a === '--target-from-output-only') opts.targetFromOutputOnly = true;
    else if (a === '--progress-lines') opts.progressLines = true;
    else if (a === '--adaptive-search') opts.adaptiveSearch = true;
    else if (a === '--adaptive-explore-rate') opts.adaptiveExploreRate = nextNumber(opts.adaptiveExploreRate);
    else if (a === '--adaptive-pool-size') opts.adaptivePoolSize = nextNumber(opts.adaptivePoolSize);
    else if (a === '--adaptive-min-samples') opts.adaptiveMinSamples = nextNumber(opts.adaptiveMinSamples);
    else if (a === '--adaptive-continuous-step') opts.adaptiveContinuousStep = nextNumber(opts.adaptiveContinuousStep);
    else if (a === '--optimal-first') opts.optimalFirst = true;
    else if (a === '--placement-mode') {
      const value = next();
      if (value === 'layer-closure' || value === 'random-color') opts.placementMode = value;
      else throw new Error(`未知placement mode: ${value}`);
    }
    else if (a === '--include-100004') opts.excludeLevels.delete('100004');
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  opts.concurrency = Math.max(1, Math.min(opts.concurrency, availableParallelism()));
  opts.adaptiveExploreRate = clamp01(opts.adaptiveExploreRate);
  opts.adaptivePoolSize = Math.max(1, Math.floor(opts.adaptivePoolSize));
  opts.adaptiveMinSamples = Math.max(1, Math.min(opts.adaptivePoolSize, Math.floor(opts.adaptiveMinSamples)));
  opts.adaptiveContinuousStep = Math.max(0.01, Math.min(0.5, opts.adaptiveContinuousStep));
  if (opts.colorRatioMin > opts.colorRatioMax) {
    [opts.colorRatioMin, opts.colorRatioMax] = [opts.colorRatioMax, opts.colorRatioMin];
  }
  return opts;
}

function parseOptimalAcceptance(raw: string): OptimalAcceptanceConfig {
  const parsed = JSON.parse(raw) as Partial<OptimalAcceptanceConfig>;
  const runs = Number(parsed.runs ?? 100);
  if (!Number.isInteger(runs) || runs <= 0) throw new Error('optimal acceptance runs必须是正整数');
  if (!parsed.grade_constraints || typeof parsed.grade_constraints !== 'object') {
    throw new Error('optimal acceptance缺少grade_constraints');
  }
  return { runs, grade_constraints: parsed.grade_constraints };
}

function printHelp(): void {
  console.log(`Usage:
  npx tsx tools/backfill-missing-grades.ts [options]
  npx tsx tools/backfill-missing-grades.ts --run --concurrency 5

Options:
  --input <csv>                    Existing batch CSV. Default: ${DEFAULT_INPUT}
  --plan <csv>                     Missing plan CSV. Default: ${DEFAULT_PLAN}
  --output <csv>                   Generated rows CSV. Default: ${DEFAULT_OUTPUT}
  --status <json>                  Runtime status JSON. Default: ${DEFAULT_STATUS}
  --levels-dir <dir>               Resolve terrain JSON when input has no terrainPath
  --target <n>                     Target rows per expected grade. Default: 5
  --target-policy <mode>           downward-to-target | replace-filtered. Default: downward-to-target
  --min-existing-count <n>         Grade is supported if existing count >= n. Default: 1
  --grades <list>                  Grades to backfill. Default: 0,1,2,3,4,5
  --exclude-levels <list>          Comma-separated level IDs to ignore. Default: 100004
  --include-100004                 Do not exclude 100004
  --color-ratio <n>                colorCount ratio. Default: 0.6
  --color-ratio-min <n>            Random color ratio lower bound
  --color-ratio-max <n>            Random color ratio upper bound
  --color-jitter <n>               Random integer colorCount jitter ±n. Default: 2
  --g0-spread <n>                  G0 spreadParam. Default: 0
  --g0-debt <n>                    G0 debtPersistenceWeight. Default: 0
  --search-close-min <n>           Override G1-G5 closeRates lower bound
  --search-close-max <n>           Override G1-G5 closeRates upper bound
  --search-close-mode <mode>       targeted | project-random | strict-range. Default: targeted
  --search-debt-min <n>            Override G1-G5 debtPersistenceWeight lower bound
  --search-debt-max <n>            Override G1-G5 debtPersistenceWeight upper bound
  --search-spread-min <n>          Override G1-G5 spreadParam lower bound
  --search-spread-max <n>          Override G1-G5 spreadParam upper bound
  --sim-runs <n>                   Simulation runs for G1/G2. Default: 100
  --accept-min-sim1-wins <n>       Count/write only rows with sim1Wins >= n
  --accept-min-sim5-wins <n>       Count/write only rows with sim5Wins >= n
  --accept-min-sim15-wins <n>      Count/write only rows with sim15Wins >= n
  --accept-min-passrate <n>        Count/write only rows with passrate >= n
  --optimal-acceptance-json <json> Per-grade Optimal runs and acceptance constraints
  --max-attempts-per-missing <n>   Search attempts per missing row. Default: 300
  --max-attempts-per-level <n>     Attempt budget per target grade, pooled within each level
  --template-attempts <n>          Attempts to find the first target-grade parameter template. Default: 100
  --no-reuse-template              Keep randomizing parameters after each accepted row
  --concurrency <n>                Parallel search workers. Default: min(cpu-1, 5)
  --shuffle-jobs                   Shuffle search jobs before running. Default: on
  --no-shuffle                     Keep deterministic level/grade order
  --run                            Execute generation after writing the plan
  --resume                         Count existing output rows before computing missing rows
  --target-from-output-only        Use input only for grade support; count output rows toward target
  --progress-lines                 Print one progress line per update instead of refreshing in place
  --adaptive-search               Mutate near-hit parameters toward the focused target grade
  --adaptive-explore-rate <n>      Fresh-random probability in adaptive mode. Default: 0.2
  --adaptive-pool-size <n>         Near-hit parameter states kept per grade. Default: 5
  --adaptive-min-samples <n>       Random samples required before adaptive mutation. Default: 3
  --adaptive-continuous-step <n>   Spread/debt mutation step. Default: 0.08
  --optimal-first                  Run Optimal screening before Strategy2 simulations
  --placement-mode <mode>          layer-closure | random-color. Default: layer-closure
`);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter(r => r.some(c => c !== ''));
}

function csvEscape(value: unknown): string {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function numberAt(row: string[], idx: number): number | null {
  if (idx < 0) return null;
  const raw = row[idx]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

interface OptimalMetrics {
  winRate: number;
  winStarvationPerTile: number;
  lossRemainingRatio: number;
}

function headerNumber(row: string[], headers: string[], names: string[]): number | null {
  for (const name of names) {
    const value = numberAt(row, headers.indexOf(name));
    if (value != null) return value;
  }
  return null;
}

function optimalConstraintFor(
  config: OptimalAcceptanceConfig | null,
  grade: number,
): OptimalGradeConstraint | null {
  return config?.grade_constraints[String(grade)] ?? null;
}

function acceptsOptimalMetrics(metrics: OptimalMetrics, constraint: OptimalGradeConstraint): boolean {
  if (constraint.min_win_rate != null && metrics.winRate < constraint.min_win_rate) return false;
  if (constraint.min_win_rate_exclusive != null && metrics.winRate <= constraint.min_win_rate_exclusive) return false;
  if (constraint.max_win_rate_exclusive != null && metrics.winRate >= constraint.max_win_rate_exclusive) return false;
  if (
    constraint.min_win_starvation_per_tile != null &&
    metrics.winStarvationPerTile < constraint.min_win_starvation_per_tile
  ) return false;
  if (
    constraint.max_win_starvation_per_tile != null &&
    metrics.winStarvationPerTile >= constraint.max_win_starvation_per_tile
  ) return false;
  if (
    constraint.max_loss_remaining_ratio != null &&
    metrics.lossRemainingRatio > constraint.max_loss_remaining_ratio
  ) return false;
  return true;
}

function optimalMetricsFromCsv(row: string[], headers: string[]): OptimalMetrics | null {
  const englishWinRate = headerNumber(row, headers, ['optimalWinRate']);
  const chineseWinRate = headerNumber(row, headers, ['最优机器人胜率(%)']);
  const winRate = englishWinRate ?? (chineseWinRate == null ? null : chineseWinRate / 100);
  const totalTiles = headerNumber(row, headers, ['totalTiles', '地形总牌数']);
  const winStarvation = headerNumber(row, headers, [
    'optimalStarvationOnWin',
    '最优机器人胜局平均断色次数',
  ]);
  const englishRemainingRatio = headerNumber(row, headers, ['optimalRemainingRatioOnLoss']);
  const chineseRemainingRatio = headerNumber(row, headers, ['最优机器人负局平均剩余牌比例(%)']);
  const remainingTiles = headerNumber(row, headers, [
    'optimalRemainingTilesOnLoss',
    '最优机器人负局平均剩余牌数',
  ]);
  const lossSteps = headerNumber(row, headers, [
    'optimalStepsOnLoss',
    '最优机器人负局平均已走步数',
  ]);
  if (winRate == null || totalTiles == null || totalTiles <= 0 || winStarvation == null) return null;
  const lossRemainingRatio = englishRemainingRatio
    ?? (chineseRemainingRatio == null ? null : chineseRemainingRatio / 100)
    ?? (remainingTiles == null ? null : remainingTiles / totalTiles)
    ?? (lossSteps == null ? null : Math.max(0, totalTiles - lossSteps) / totalTiles);
  if (lossRemainingRatio == null) return null;
  return {
    winRate,
    winStarvationPerTile: winStarvation / totalTiles,
    lossRemainingRatio,
  };
}

function acceptsMetricsFromCsv(row: string[], headers: string[], grade: number, opts: CliOptions): boolean {
  const idx = (name: string) => headers.indexOf(name);
  const checks: Array<[number | null, number | null]> = [
    [numberAt(row, idx('sim1Wins')), opts.acceptMinSim1Wins],
    [numberAt(row, idx('sim5Wins')), opts.acceptMinSim5Wins],
    [numberAt(row, idx('sim15Wins')), opts.acceptMinSim15Wins],
    [numberAt(row, idx('passrate')), opts.acceptMinPassrate],
  ];
  if (!checks.every(([value, min]) => min == null || (value != null && value >= min))) return false;
  const constraint = optimalConstraintFor(opts.optimalAcceptance, grade);
  if (!constraint) return true;
  const metrics = optimalMetricsFromCsv(row, headers);
  return metrics != null && acceptsOptimalMetrics(metrics, constraint);
}

function acceptsMetrics(row: BatchRow, job: SearchJob): boolean {
  if (job.acceptMinSim1Wins != null && row.sim1Wins < job.acceptMinSim1Wins) return false;
  if (job.acceptMinSim5Wins != null && row.sim5Wins < job.acceptMinSim5Wins) return false;
  if (job.acceptMinSim15Wins != null && row.sim15Wins < job.acceptMinSim15Wins) return false;
  if (job.acceptMinPassrate != null && row.passrate < job.acceptMinPassrate) return false;
  const constraint = optimalConstraintFor(job.optimalAcceptance, row.grade);
  if (constraint) {
    if (
      row.optimalWinRate == null ||
      row.optimalStarvationOnWin == null ||
      row.optimalRemainingRatioOnLoss == null ||
      row.totalTiles <= 0
    ) return false;
    if (!acceptsOptimalMetrics({
      winRate: row.optimalWinRate,
      winStarvationPerTile: row.optimalStarvationOnWin / row.totalTiles,
      lossRemainingRatio: row.optimalRemainingRatioOnLoss,
    }, constraint)) return false;
  }
  return true;
}

function readExistingRows(
  path: string,
  excludeLevels: Set<string>,
  opts: CliOptions,
  countForTarget: boolean,
  definesTarget: boolean,
): ExistingRow[] {
  if (!existsSync(path)) return [];
  const rows = parseCsv(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  if (rows.length === 0) return [];
  const headers = rows[0];
  const idx = (name: string) => headers.indexOf(name);
  const levelIdx = idx('levelResId');
  const gradeIdx = idx('grade');
  const terrainIdx = idx('terrainPath');
  const probeIdx = idx('isMaxGradeProbe');
  const statusIdx = idx('CompletionStatus');
  if (levelIdx < 0 || gradeIdx < 0) {
    throw new Error(`CSV缺少必要列: ${path}`);
  }

  const out: ExistingRow[] = [];
  for (const r of rows.slice(1)) {
    const levelResId = (r[levelIdx] ?? '').trim();
    if (!levelResId || excludeLevels.has(levelResId)) continue;
    if (probeIdx >= 0 && String(r[probeIdx] ?? '').trim() === '1') continue;
    if (statusIdx >= 0 && !String(r[statusIdx] ?? '').startsWith('Success')) continue;
    const grade = Number(r[gradeIdx]);
    if (!Number.isInteger(grade) || grade < 0 || grade > 5) continue;
    const csvTerrainPath = terrainIdx >= 0 ? (r[terrainIdx] ?? '').trim() : '';
    const terrainPath = csvTerrainPath || resolve(opts.levelsDir, `${levelResId}.json`);
    if (!existsSync(terrainPath)) {
      throw new Error(`找不到地形JSON: ${levelResId} -> ${terrainPath}`);
    }
    out.push({
      levelResId,
      grade,
      terrainPath,
      accepted: acceptsMetricsFromCsv(r, headers, grade, opts),
      countForTarget,
      definesTarget,
    });
  }
  return out;
}

function readHistoricalTemplatePools(
  path: string,
  excludeLevels: Set<string>,
  opts: CliOptions,
): Map<string, Record<number, GenerationParams[]>> {
  const pools = new Map<string, Record<number, GenerationParams[]>>();
  if (!existsSync(path)) return pools;
  const rows = parseCsv(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  if (rows.length === 0) return pools;
  const headers = rows[0];
  const idx = (name: string) => headers.indexOf(name);
  const levelIdx = idx('levelResId');
  const gradeIdx = idx('grade');
  const colorIdx = idx('colorCount');
  const closeIdx = idx('closeRates');
  const spreadIdx = idx('spreadParam');
  const debtIdx = idx('debtPersistenceWeight');
  const levelTagsIdx = idx('LevelTags');
  if ([levelIdx, gradeIdx, colorIdx, closeIdx, spreadIdx, debtIdx].some(index => index < 0)) return pools;

  for (const row of rows.slice(1)) {
    const levelResId = String(row[levelIdx] ?? '').trim();
    const grade = Number(row[gradeIdx]);
    if (!levelResId || excludeLevels.has(levelResId) || !Number.isInteger(grade) || grade < 1 || grade > 5) continue;
    if (levelTagsIdx >= 0 && String(row[levelTagsIdx] ?? '').trim() === 'random') continue;
    if (!acceptsMetricsFromCsv(row, headers, grade, opts)) continue;
    const colorCount = Number(row[colorIdx]);
    const closeRates = String(row[closeIdx] ?? '').split(',').map(Number);
    const spreadParam = Number(row[spreadIdx]);
    const debtPersistenceWeight = Number(row[debtIdx]);
    if (
      !Number.isInteger(colorCount) || colorCount <= 0 ||
      closeRates.length === 0 || closeRates.some(value => !Number.isFinite(value)) ||
      !Number.isFinite(spreadParam) || !Number.isFinite(debtPersistenceWeight)
    ) continue;
    const byGrade = pools.get(levelResId) ?? {};
    const gradePool = byGrade[grade] ?? [];
    gradePool.push({ colorCount, closeRates, spreadParam, debtPersistenceWeight });
    byGrade[grade] = gradePool;
    pools.set(levelResId, byGrade);
  }
  return pools;
}

function buildCoverage(
  rows: ExistingRow[],
  targetPerGrade: number,
  minExistingCount: number,
  targetPolicy: CliOptions['targetPolicy'],
): LevelCoverage[] {
  const byLevel = new Map<string, LevelCoverage>();
  for (const row of rows) {
    const current = byLevel.get(row.levelResId) ?? {
      levelResId: row.levelResId,
      terrainPath: row.terrainPath,
      counts: Object.fromEntries(GRADES.map(g => [g, 0])) as Record<number, number>,
      supportedGrades: [],
      maxGrade: -1,
      targets: Object.fromEntries(GRADES.map(g => [g, 0])) as Record<number, number>,
      missing: Object.fromEntries(GRADES.map(g => [g, 0])) as Record<number, number>,
    };
    if (row.accepted && row.countForTarget) current.counts[row.grade]++;
    if (!current.terrainPath && row.terrainPath) current.terrainPath = row.terrainPath;
    byLevel.set(row.levelResId, current);
  }

  const coverages = [...byLevel.values()];
  for (const c of coverages) {
    const rawCounts: Record<number, number> = Object.fromEntries(GRADES.map(g => [g, 0])) as Record<number, number>;
    for (const row of rows) {
      if (row.levelResId === c.levelResId && row.definesTarget) rawCounts[row.grade]++;
    }
    c.supportedGrades = GRADES.filter(g => rawCounts[g] >= minExistingCount);
    c.maxGrade = c.supportedGrades.length > 0 ? Math.max(...c.supportedGrades) : -1;
    for (const g of GRADES) {
      c.targets[g] = targetPolicy === 'replace-filtered'
        ? (rawCounts[g] >= minExistingCount ? Math.min(targetPerGrade, rawCounts[g]) : 0)
        : (c.maxGrade >= g ? targetPerGrade : 0);
      c.missing[g] = Math.max(0, c.targets[g] - c.counts[g]);
    }
  }
  return coverages.sort((a, b) => Number(a.levelResId) - Number(b.levelResId));
}

function writePlanCsv(path: string, coverages: LevelCoverage[]): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const headers = [
    'levelResId', 'terrainPath', 'maxGrade', 'supportedGrades',
    ...GRADES.map(g => `countG${g}`),
    ...GRADES.map(g => `targetG${g}`),
    ...GRADES.map(g => `missingG${g}`),
    'totalMissing',
  ];
  const lines = [headers.join(',')];
  for (const c of coverages) {
    const totalMissing = GRADES.reduce((sum, g) => sum + c.missing[g], 0);
    lines.push([
      c.levelResId,
      c.terrainPath,
      c.maxGrade,
      c.supportedGrades.join('|'),
      ...GRADES.map(g => c.counts[g]),
      ...GRADES.map(g => c.targets[g]),
      ...GRADES.map(g => c.missing[g]),
      totalMissing,
    ].map(csvEscape).join(','));
  }
  writeFileSync(path, `\uFEFF${lines.join('\n')}\n`, 'utf8');
}

function summarizeCoverage(coverages: LevelCoverage[], targetGrades: number[]): object {
  const byMax: Record<string, number> = {};
  const missingByGrade: Record<string, number> = {};
  const expectedByGrade: Record<string, number> = {};
  const reportGrades = targetGrades.length > 0 ? targetGrades : GRADES;
  for (const c of coverages) {
    byMax[String(c.maxGrade)] = (byMax[String(c.maxGrade)] ?? 0) + 1;
    for (const g of reportGrades) {
      if (c.targets[g] > 0) {
        expectedByGrade[`G${g}`] = (expectedByGrade[`G${g}`] ?? 0) + 1;
        if (c.missing[g] > 0) missingByGrade[`G${g}`] = (missingByGrade[`G${g}`] ?? 0) + 1;
      }
    }
  }
  return {
    levels: coverages.length,
    targetGrades: reportGrades.map(g => `G${g}`),
    byMax,
    expectedByGrade,
    missingByGrade,
  };
}

function computeDepthCount(terrain: TerrainData): number {
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(t => !t.isConst);
  const tileMap = new Map(allTiles.map(t => [t.id, t]));
  const depthMemo = new Map<number, number>();
  const walk = (id: number): number => {
    const cached = depthMemo.get(id);
    if (cached !== undefined) return cached;
    const tile = tileMap.get(id);
    if (!tile || tile.dependencies.length === 0) {
      depthMemo.set(id, 1);
      return 1;
    }
    const depth = Math.max(...tile.dependencies.map(dep => walk(dep))) + 1;
    depthMemo.set(id, depth);
    return depth;
  };
  for (const tile of freeTiles) walk(tile.id);
  return depthMemo.size > 0 ? Math.max(...depthMemo.values()) : 1;
}

function createG0Row(
  levelIndex: number,
  terrainPath: string,
  attemptIndex: number,
  colorRatio: number,
  colorJitter: number,
  spreadParam: number,
  debtPersistenceWeight: number,
): BatchRow {
  const terrain = loadTerrainFromFile(terrainPath);
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(t => !t.isConst).length;
  const depthCount = computeDepthCount(terrain);
  const colorRng = mulberry32((Number(terrain.levelResId ?? levelIndex) * 10000 + attemptIndex) & 0x7fffffff);
  const params: GenerationParams = {
    closeRates: Array.from({ length: Math.max(0, depthCount - 1) }, () => 1),
    colorCount: colorCountWithJitter(colorRatio, freeTiles, colorRng, colorJitter),
    spreadParam,
    debtPersistenceWeight,
  };
  const t0 = performance.now();
  const result = generateBoardLayerClosure({
    terrain,
    closeRates: params.closeRates,
    colorCount: params.colorCount,
    dock: 7,
    spreadParam: params.spreadParam,
    debtPersistenceWeight: params.debtPersistenceWeight,
  });
  const m = result.metrics;
  return {
    terrainIndex: levelIndex,
    terrainPath,
    levelResId: String(terrain.levelResId ?? ''),
    attemptIndex,
    isMaxGradeProbe: false,
    colorCount: params.colorCount,
    closeRates: params.closeRates,
    spreadParam: params.spreadParam,
    debtPersistenceWeight: params.debtPersistenceWeight,
    freeTiles,
    totalTiles: allTiles.length,
    depthCount: m.depthCount,
    peakDebt: m.peakDebt,
    peakExpDebt: m.peakExpDebt,
    oi: m.oi,
    consecutiveOI: m.consecutiveOI,
    suitSpreadNorm: m.suitSpreadNorm,
    isDoomed: m.isDoomed,
    actualCloseRates: m.actualCloseRates,
    weightedDebtRetentionRate: m.weightedDebtRetentionRate,
    replayCode: result.replayCode,
    grade: 0,
    passrate: 1,
    label: 'G0_no_sim',
    simRuns: 0,
    sim1WinRate: 0,
    sim1Wins: 0,
    sim5WinRate: 0,
    sim5Wins: 0,
    sim15WinRate: 0,
    sim15Wins: 0,
    elapsedMs: Math.round(performance.now() - t0),
    success: true,
  };
}

function buildSearchParams(terrain: TerrainData, colorRatio: number, colorJitter: number, rng: () => number): GenerationParams {
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(t => !t.isConst).length;
  return {
    closeRates: randomizeCloseRatesFromTiles(allTiles, rng),
    colorCount: colorCountWithJitter(colorRatio, freeTiles, rng, colorJitter),
    spreadParam: rng(),
    debtPersistenceWeight: rng(),
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function randomBetween(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

function colorCountWithJitter(colorRatio: number, freeTiles: number, rng: () => number, jitterRange: number): number {
  const base = colorCountFromRatio(colorRatio, freeTiles);
  const range = Math.max(0, Math.floor(jitterRange));
  const jitter = range === 0 ? 0 : Math.floor(rng() * (range * 2 + 1)) - range;
  return Math.max(1, base + jitter);
}

function strictCloseRates(terrain: TerrainData, min: number, max: number, rng: () => number): number[] {
  const depthCount = computeDepthCount(terrain);
  return Array.from({ length: Math.max(0, depthCount - 1) }, () => clamp01(randomBetween(rng, min, max)));
}

function targetedCloseRates(terrain: TerrainData, targetGrade: number, rng: () => number): number[] {
  const base = randomizeCloseRatesFromTiles(getAllTiles(terrain), rng);
  if (targetGrade === 1) {
    return base.map(rate => clamp01(Math.max(rate, randomBetween(rng, 0.55, 0.95))));
  }
  if (targetGrade === 2) {
    return base.map(rate => clamp01((rate + randomBetween(rng, 0.35, 0.85)) / 2));
  }
  if (targetGrade === 3) {
    return base.map(rate => clamp01((rate + randomBetween(rng, 0.15, 0.7)) / 2));
  }
  if (targetGrade >= 4) {
    return base.map(rate => clamp01(Math.min(rate, randomBetween(rng, 0, 0.45))));
  }
  return base;
}

function buildTargetedSearchParams(
  terrain: TerrainData,
  targetGrade: number,
  colorRatioMin: number,
  colorRatioMax: number,
  colorJitter: number,
  overrides: Pick<SearchJob,
    'searchCloseMin' | 'searchCloseMax' | 'searchCloseMode' |
    'searchDebtMin' | 'searchDebtMax' |
    'searchSpreadMin' | 'searchSpreadMax'
  >,
  rng: () => number,
): GenerationParams {
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(t => !t.isConst).length;
  const colorRatio = randomBetween(rng, colorRatioMin, colorRatioMax);
  let spreadParam = rng();
  let debtPersistenceWeight = rng();
  let closeRates = overrides.searchCloseMode === 'project-random'
    ? randomizeCloseRatesFromTiles(allTiles, rng)
    : targetedCloseRates(terrain, targetGrade, rng);

  if (targetGrade === 1) {
    spreadParam = randomBetween(rng, 0, 0.35);
    debtPersistenceWeight = randomBetween(rng, 0, 0.35);
  } else if (targetGrade === 2) {
    spreadParam = randomBetween(rng, 0.1, 0.65);
    debtPersistenceWeight = randomBetween(rng, 0.1, 0.65);
  } else if (targetGrade === 3) {
    spreadParam = randomBetween(rng, 0.35, 0.85);
    debtPersistenceWeight = randomBetween(rng, 0.25, 0.85);
  } else if (targetGrade >= 4) {
    spreadParam = randomBetween(rng, 0.65, 1);
    debtPersistenceWeight = randomBetween(rng, 0.55, 1);
  }

  if (
    overrides.searchCloseMode === 'strict-range' ||
    overrides.searchCloseMin != null ||
    overrides.searchCloseMax != null
  ) {
    closeRates = strictCloseRates(
      terrain,
      overrides.searchCloseMin ?? 0,
      overrides.searchCloseMax ?? 1,
      rng,
    );
  }
  if (overrides.searchDebtMin != null || overrides.searchDebtMax != null) {
    debtPersistenceWeight = randomBetween(
      rng,
      overrides.searchDebtMin ?? 0,
      overrides.searchDebtMax ?? 1,
    );
  }
  if (overrides.searchSpreadMin != null || overrides.searchSpreadMax != null) {
    spreadParam = randomBetween(
      rng,
      overrides.searchSpreadMin ?? 0,
      overrides.searchSpreadMax ?? 1,
    );
  }

  return {
    closeRates,
    colorCount: colorCountWithJitter(colorRatio, freeTiles, rng, colorJitter),
    spreadParam,
    debtPersistenceWeight,
  };
}

function createGameForReplay(replayCode: string, terrain: TerrainData) {
  const replayData = decodeFromString(replayCode);
  if (!replayData) throw new Error('Optimal验收无法解析ReplayCode');
  const terrainTiles = getAllTiles(terrain);
  const ordered = getCanonicalTileOrder(terrainTiles);
  const elementValues = new Map<number, number>();
  const initialDock: { tileId: number; element: number }[] = [];
  const eliminatedTileIds = new Set<number>();

  for (let i = 0; i < ordered.length && i < replayData.instanceArray.length; i++) {
    const tile = ordered[i];
    const byte = replayData.instanceArray[i];
    const state = (byte >> 6) & 0x3;
    const element = (byte & 0x3f) + 1;
    elementValues.set(tile.id, element);
    if (state === 1) eliminatedTileIds.add(tile.id);
    else if (state === 2) initialDock.push({ tileId: tile.id, element });
  }
  for (const entry of replayData.dockEntries) {
    if (entry.tileId < 0 || entry.tileId >= ordered.length) continue;
    const tile = ordered[entry.tileId];
    if (!initialDock.some(item => item.tileId === tile.id)) {
      initialDock.push({ tileId: tile.id, element: entry.element });
    }
  }

  return {
    game: createGame({ terrainTiles, elementValues, initialDock, eliminatedTileIds }),
    terrainTiles,
  };
}

function evaluateOptimal(
  row: BatchRow,
  terrain: TerrainData,
  config: OptimalAcceptanceConfig,
  seed: number,
): BatchRow {
  const { game, terrainTiles } = createGameForReplay(row.replayCode, terrain);
  const batch = solvePlayerShortestBatch(game, config.runs, seed);
  const lossResults = batch.results.filter(result => !result.win);
  const remainingTiles = lossResults.length > 0
    ? lossResults.reduce(
      (sum, result) => sum + Math.max(0, terrainTiles.length - result.stepCount),
      0,
    ) / lossResults.length
    : 0;
  return {
    ...row,
    optimalRuns: config.runs,
    optimalWins: batch.wins,
    optimalLosses: batch.losses,
    optimalWinRate: batch.winRate,
    optimalForcedPickOnWin: batch.forcedPickOnWin,
    optimalStarvationOnWin: batch.starvationOnWin,
    optimalStepsOnLoss: batch.stepsOnLoss,
    optimalForcedPickOnLoss: batch.forcedPickOnLoss,
    optimalStarvationOnLoss: batch.starvationOnLoss,
    optimalRemainingTilesOnLoss: remainingTiles,
    optimalRemainingRatioOnLoss: terrainTiles.length > 0 ? remainingTiles / terrainTiles.length : 0,
  };
}

function evaluateStrategy2(
  row: BatchRow,
  terrain: TerrainData,
  runs: number,
  seed: number,
): BatchRow {
  const { game } = createGameForReplay(row.replayCode, terrain);
  const simulate = (mistakeRate: number, offset: number) => {
    const result = solvePlayerMistakeBatch(game, runs, seed + offset, { mistakeRate });
    return {
      winRate: result.winRate,
      wins: result.wins,
      losses: result.losses,
      runs,
      elapsedMs: result.elapsedMs,
    };
  };
  const sim1 = simulate(0.01, 1);
  const sim5 = simulate(0.05, 2);
  const sim15 = simulate(0.15, 3);
  const snapshot: SimSnapshot = { sim1, sim5, sim15 };
  const verdict = gradeStrategy2(snapshot);
  return {
    ...row,
    grade: verdict.grade,
    passrate: verdict.passrate,
    label: verdict.label,
    simRuns: runs,
    sim1WinRate: sim1.winRate,
    sim1Wins: sim1.wins,
    sim5WinRate: sim5.winRate,
    sim5Wins: sim5.wins,
    sim15WinRate: sim15.winRate,
    sim15Wins: sim15.wins,
  };
}

function generateCandidateOnly(
  terrain: TerrainData,
  params: GenerationParams,
  terrainPath: string,
  attemptIndex: number,
): BatchRow {
  const started = performance.now();
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(tile => !tile.isConst).length;
  try {
    const result = generateBoardLayerClosure({
      terrain,
      closeRates: params.closeRates,
      colorCount: params.colorCount,
      dock: 7,
      spreadParam: params.spreadParam,
      debtPersistenceWeight: params.debtPersistenceWeight,
    });
    const metrics = result.metrics;
    return {
      terrainIndex: 0,
      terrainPath,
      levelResId: String(terrain.levelResId ?? ''),
      attemptIndex,
      isMaxGradeProbe: false,
      colorCount: params.colorCount,
      closeRates: params.closeRates,
      spreadParam: params.spreadParam,
      debtPersistenceWeight: params.debtPersistenceWeight,
      freeTiles,
      totalTiles: allTiles.length,
      depthCount: metrics.depthCount,
      peakDebt: metrics.peakDebt,
      peakExpDebt: metrics.peakExpDebt,
      oi: metrics.oi,
      consecutiveOI: metrics.consecutiveOI,
      suitSpreadNorm: metrics.suitSpreadNorm,
      isDoomed: metrics.isDoomed,
      actualCloseRates: metrics.actualCloseRates,
      weightedDebtRetentionRate: metrics.weightedDebtRetentionRate,
      replayCode: result.replayCode,
      grade: -1,
      passrate: 0,
      label: 'Optimal预筛',
      simRuns: 0,
      sim1WinRate: 0,
      sim1Wins: 0,
      sim5WinRate: 0,
      sim5Wins: 0,
      sim15WinRate: 0,
      sim15Wins: 0,
      elapsedMs: Math.round(performance.now() - started),
      success: true,
    };
  } catch (error) {
    return {
      terrainIndex: 0,
      terrainPath,
      levelResId: String(terrain.levelResId ?? ''),
      attemptIndex,
      isMaxGradeProbe: false,
      colorCount: params.colorCount,
      closeRates: params.closeRates,
      spreadParam: params.spreadParam,
      debtPersistenceWeight: params.debtPersistenceWeight,
      freeTiles,
      totalTiles: allTiles.length,
      depthCount: 0,
      peakDebt: 0,
      peakExpDebt: 0,
      oi: 0,
      consecutiveOI: 0,
      suitSpreadNorm: 0,
      isDoomed: false,
      actualCloseRates: [],
      weightedDebtRetentionRate: 0,
      replayCode: '',
      grade: -1,
      passrate: 0,
      label: '生成失败',
      simRuns: 0,
      sim1WinRate: 0,
      sim1Wins: 0,
      sim5WinRate: 0,
      sim5Wins: 0,
      sim15WinRate: 0,
      sim15Wins: 0,
      elapsedMs: Math.round(performance.now() - started),
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function generateRandomColorCandidate(
  terrain: TerrainData,
  colorCount: number,
  terrainPath: string,
  attemptIndex: number,
  rng: () => number,
): BatchRow {
  const started = performance.now();
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(tile => !tile.isConst);
  try {
    if (freeTiles.length === 0 || freeTiles.length % 3 !== 0) {
      throw new Error(`自由牌数量 ${freeTiles.length} 不是正的3倍数`);
    }
    const tripletCount = freeTiles.length / 3;
    const actualColorCount = Math.max(1, Math.min(colorCount, tripletCount));
    const baseTriplets = Math.floor(tripletCount / actualColorCount);
    const extraTriplets = tripletCount % actualColorCount;
    const colorBag: number[] = [];
    for (let color = 1; color <= actualColorCount; color++) {
      const tileCount = (baseTriplets + (color <= extraTriplets ? 1 : 0)) * 3;
      for (let i = 0; i < tileCount; i++) colorBag.push(color);
    }
    shuffleInPlace(colorBag, rng);

    const assignments = new Map<number, number>();
    const elementValues = new Map<number, number>();
    for (const tile of allTiles) {
      if (tile.isConst && tile.constElementValue > 0) elementValues.set(tile.id, tile.constElementValue);
    }
    freeTiles.forEach((tile, index) => {
      assignments.set(tile.id, colorBag[index]);
      elementValues.set(tile.id, colorBag[index]);
    });

    const tileMap = new Map(allTiles.map(tile => [tile.id, tile]));
    const depthMap = computeDependencyDepth(allTiles, tileMap);
    const maxDepth = depthMap.size > 0 ? Math.max(...depthMap.values()) : 1;
    const depthLayers = Array.from({ length: maxDepth }, (_, index) =>
      allTiles.filter(tile => depthMap.get(tile.id) === index + 1));
    const tileDepSets = computeTileDepSets(allTiles, tileMap);
    const actualCloseRates = computeCloseRatesFromAssignments(assignments, depthLayers);
    const metrics = computeMetrics(
      assignments,
      allTiles,
      depthLayers,
      depthMap,
      tileMap,
      tileDepSets,
      7,
      actualColorCount,
      actualCloseRates,
      0,
      [],
    );
    const replayCode = generateReplayCode(
      getCanonicalTileOrder(allTiles),
      elementValues,
      terrain.levelHash ?? '',
    );
    return {
      terrainIndex: 0,
      terrainPath,
      levelResId: String(terrain.levelResId ?? ''),
      attemptIndex,
      isMaxGradeProbe: false,
      colorCount: actualColorCount,
      closeRates: metrics.actualCloseRates.slice(0, -1),
      spreadParam: 0,
      debtPersistenceWeight: 0,
      freeTiles: freeTiles.length,
      totalTiles: allTiles.length,
      depthCount: metrics.depthCount,
      peakDebt: metrics.peakDebt,
      peakExpDebt: metrics.peakExpDebt,
      oi: metrics.oi,
      consecutiveOI: metrics.consecutiveOI,
      suitSpreadNorm: metrics.suitSpreadNorm,
      isDoomed: metrics.isDoomed,
      actualCloseRates: metrics.actualCloseRates,
      weightedDebtRetentionRate: metrics.weightedDebtRetentionRate,
      replayCode,
      grade: -1,
      passrate: 0,
      label: '随机落位·Optimal预筛',
      levelTags: 'random',
      simRuns: 0,
      sim1WinRate: 0,
      sim1Wins: 0,
      sim5WinRate: 0,
      sim5Wins: 0,
      sim15WinRate: 0,
      sim15Wins: 0,
      elapsedMs: Math.round(performance.now() - started),
      success: true,
    };
  } catch (error) {
    return {
      terrainIndex: 0,
      terrainPath,
      levelResId: String(terrain.levelResId ?? ''),
      attemptIndex,
      isMaxGradeProbe: false,
      colorCount,
      closeRates: [],
      spreadParam: 0,
      debtPersistenceWeight: 0,
      freeTiles: freeTiles.length,
      totalTiles: allTiles.length,
      depthCount: 0,
      peakDebt: 0,
      peakExpDebt: 0,
      oi: 0,
      consecutiveOI: 0,
      suitSpreadNorm: 0,
      isDoomed: false,
      actualCloseRates: [],
      weightedDebtRetentionRate: 0,
      replayCode: '',
      grade: -1,
      passrate: 0,
      label: '随机落位生成失败',
      levelTags: 'random',
      simRuns: 0,
      sim1WinRate: 0,
      sim1Wins: 0,
      sim5WinRate: 0,
      sim5Wins: 0,
      sim15WinRate: 0,
      sim15Wins: 0,
      elapsedMs: Math.round(performance.now() - started),
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function gradesPassingOptimal(
  row: BatchRow,
  grades: number[],
  config: OptimalAcceptanceConfig,
): Set<number> {
  if (
    row.optimalWinRate == null ||
    row.optimalStarvationOnWin == null ||
    row.optimalRemainingRatioOnLoss == null ||
    row.totalTiles <= 0
  ) return new Set();
  const metrics: OptimalMetrics = {
    winRate: row.optimalWinRate,
    winStarvationPerTile: row.optimalStarvationOnWin / row.totalTiles,
    lossRemainingRatio: row.optimalRemainingRatioOnLoss,
  };
  return new Set(grades.filter(grade => {
    const constraint = optimalConstraintFor(config, grade);
    return constraint != null && acceptsOptimalMetrics(metrics, constraint);
  }));
}

function cloneTemplateParams(template: GenerationParams): GenerationParams {
  return {
    closeRates: [...template.closeRates],
    colorCount: template.colorCount,
    spreadParam: template.spreadParam,
    debtPersistenceWeight: template.debtPersistenceWeight,
  };
}

function targetPassrateCenter(grade: number): number {
  if (grade === 1) return 0.75;
  if (grade === 2) return 0.50;
  if (grade === 3) return 0.30;
  if (grade === 4) return 0.15;
  return 0.05;
}

function adaptiveCandidate(
  row: BatchRow,
  targetGrade: number,
  params: GenerationParams,
  config: OptimalAcceptanceConfig | null,
): AdaptiveCandidate {
  const center = targetPassrateCenter(targetGrade);
  let score = Math.abs(row.passrate - center);
  let hardenWeight = row.passrate > center ? Math.abs(row.passrate - center) : 0;
  let simplifyWeight = row.passrate < center ? Math.abs(row.passrate - center) : 0;
  const constraint = optimalConstraintFor(config, targetGrade);
  if (row.grade === targetGrade && constraint && row.totalTiles > 0 && row.optimalWinRate != null) {
    const winRate = row.optimalWinRate;
    const starvation = (row.optimalStarvationOnWin ?? 0) / row.totalTiles;
    const remaining = row.optimalRemainingRatioOnLoss ?? 0;
    const add = (distance: number, direction: 'harder' | 'simpler') => {
      const penalty = Math.max(0, distance);
      score += penalty;
      if (direction === 'harder') hardenWeight += penalty;
      else simplifyWeight += penalty;
    };
    if (constraint.min_win_rate != null) add(constraint.min_win_rate - winRate, 'simpler');
    if (constraint.min_win_rate_exclusive != null && winRate <= constraint.min_win_rate_exclusive) {
      add(constraint.min_win_rate_exclusive - winRate + 0.05, 'simpler');
    }
    if (constraint.max_win_rate_exclusive != null && winRate >= constraint.max_win_rate_exclusive) {
      add(winRate - constraint.max_win_rate_exclusive + 0.05, 'harder');
    }
    if (constraint.min_win_starvation_per_tile != null) {
      add(constraint.min_win_starvation_per_tile - starvation, 'harder');
    }
    if (constraint.max_win_starvation_per_tile != null) {
      add(starvation - constraint.max_win_starvation_per_tile, 'simpler');
    }
    if (constraint.max_loss_remaining_ratio != null) {
      add(remaining - constraint.max_loss_remaining_ratio, 'simpler');
    }
  }
  const direction: -1 | 0 | 1 = hardenWeight > simplifyWeight
    ? 1
    : simplifyWeight > hardenWeight
      ? -1
      : 0;
  return {
    params: {
      ...params,
      closeRates: [...params.closeRates],
    },
    score,
    direction,
  };
}

function updateAdaptivePool(
  pools: Map<number, AdaptiveCandidate[]>,
  grade: number,
  candidate: AdaptiveCandidate,
  poolSize: number,
): void {
  const key = JSON.stringify(candidate.params);
  const current = pools.get(grade) ?? [];
  const unique = current.filter(item => JSON.stringify(item.params) !== key);
  unique.push(candidate);
  unique.sort((a, b) => a.score - b.score);
  pools.set(grade, unique.slice(0, poolSize));
}

function mutateClosureTargets(
  terrain: TerrainData,
  closeRates: number[],
  direction: -1 | 1,
  rng: () => number,
): number[] {
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(tile => !tile.isConst);
  const tileMap = new Map(allTiles.map(tile => [tile.id, tile]));
  const depthMap = computeDependencyDepth(freeTiles, tileMap);
  const maxDepth = depthMap.size > 0 ? Math.max(...depthMap.values()) : 1;
  const capacities: number[] = [];
  let cumulativeTiles = 0;
  for (let depth = 1; depth < maxDepth; depth++) {
    cumulativeTiles += freeTiles.filter(tile => depthMap.get(tile.id) === depth).length;
    capacities.push(Math.floor(cumulativeTiles / 3));
  }
  const targets = capacities.map((capacity, index) => Math.max(
    0,
    Math.min(capacity, Math.round((closeRates[index] ?? 0) * capacity)),
  ));
  let previous = 0;
  for (let i = 0; i < targets.length; i++) {
    const earlyFloor = i < 2 ? Math.min(1, capacities[i]) : 0;
    targets[i] = Math.max(previous, earlyFloor, Math.min(capacities[i], targets[i]));
    previous = targets[i];
  }
  const mutable = targets.map((target, index) => {
    const previousTarget = index > 0 ? targets[index - 1] : 0;
    const earlyFloor = index < 2 ? Math.min(1, capacities[index]) : 0;
    const lower = Math.max(previousTarget, earlyFloor);
    return direction > 0 ? target > lower : target < capacities[index];
  }).map((canMutate, index) => canMutate ? index : -1).filter(index => index >= 0);
  if (mutable.length === 0) return [...closeRates];
  const index = mutable[Math.floor(rng() * mutable.length)];
  targets[index] += direction > 0 ? -1 : 1;
  previous = 0;
  for (let i = 0; i < targets.length; i++) {
    const earlyFloor = i < 2 ? Math.min(1, capacities[i]) : 0;
    targets[i] = Math.max(previous, earlyFloor, Math.min(capacities[i], targets[i]));
    previous = targets[i];
  }
  return capacities.map((capacity, index) => capacity > 0 ? targets[index] / capacity : 0);
}

function mutateAdaptiveParams(
  terrain: TerrainData,
  base: GenerationParams,
  requestedDirection: -1 | 0 | 1,
  job: SearchJob,
  rng: () => number,
): GenerationParams {
  const direction: -1 | 1 = requestedDirection === 0
    ? (rng() < 0.5 ? -1 : 1)
    : requestedDirection;
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(tile => !tile.isConst).length;
  const colorMin = Math.max(1, colorCountFromRatio(job.colorRatioMin, freeTiles) - Math.floor(job.colorJitter));
  const colorMax = Math.max(colorMin, colorCountFromRatio(job.colorRatioMax, freeTiles) + Math.floor(job.colorJitter));
  const spreadMin = job.searchSpreadMin ?? 0;
  const spreadMax = job.searchSpreadMax ?? 1;
  const debtMin = job.searchDebtMin ?? 0;
  const debtMax = job.searchDebtMax ?? 1;
  const result: GenerationParams = { ...base, closeRates: [...base.closeRates] };
  const controls = ['color', 'closure', 'spread', 'debt'];
  shuffleInPlace(controls, rng);
  const mutationCount = rng() < 0.25 ? 2 : 1;
  for (const control of controls.slice(0, mutationCount)) {
    if (control === 'color') {
      result.colorCount = Math.max(colorMin, Math.min(colorMax, result.colorCount + direction));
    } else if (control === 'closure') {
      result.closeRates = mutateClosureTargets(terrain, result.closeRates, direction, rng);
    } else if (control === 'spread') {
      const delta = job.adaptiveContinuousStep * (0.75 + rng() * 0.5) * direction;
      result.spreadParam = Math.max(spreadMin, Math.min(spreadMax, result.spreadParam + delta));
    } else if (control === 'debt') {
      const delta = job.adaptiveContinuousStep * (0.75 + rng() * 0.5) * direction;
      result.debtPersistenceWeight = Math.max(
        debtMin,
        Math.min(debtMax, result.debtPersistenceWeight + delta),
      );
    }
  }
  return result;
}

function ensureOutputCsv(path: string, resume: boolean): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  if (!resume || !existsSync(path)) {
    writeFileSync(path, `\uFEFF${BATCH_CSV_HEADERS.join(',')}\n`, 'utf8');
  }
}

function appendRow(path: string, row: BatchRow): void {
  appendFileSync(path, `${serializeBatchRow(row)}\n`, 'utf8');
}

function writeStatus(path: string, status: object): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
}

function buildSearchJobs(
  coverages: LevelCoverage[],
  opts: CliOptions,
  historicalTemplatePools: Map<string, Record<number, GenerationParams[]>>,
): SearchJob[] {
  const jobs: SearchJob[] = [];
  for (const c of coverages) {
    const targetNeeds: Record<number, number> = {};
    for (const g of [1, 2, 3, 4, 5]) {
      if (!opts.gradesToBackfill.has(g)) continue;
      const needed = c.missing[g] ?? 0;
      if (needed > 0) targetNeeds[g] = needed;
    }
    const targetGrades = Object.keys(targetNeeds).map(Number);
    if (targetGrades.length === 0) continue;
    const totalNeeded = Object.values(targetNeeds).reduce((sum, needed) => sum + needed, 0);
    jobs.push({
      jobId: c.levelResId,
      levelResId: c.levelResId,
      terrainPath: c.terrainPath,
      targetNeeds,
      maxAttempts: opts.maxAttemptsPerLevel != null
        ? opts.maxAttemptsPerLevel * targetGrades.length
        : totalNeeded * opts.maxAttemptsPerMissing,
      templateAttempts: opts.templateAttempts,
      simRuns: opts.simRuns,
      acceptMinSim1Wins: opts.acceptMinSim1Wins,
      acceptMinSim5Wins: opts.acceptMinSim5Wins,
      acceptMinSim15Wins: opts.acceptMinSim15Wins,
      acceptMinPassrate: opts.acceptMinPassrate,
      optimalAcceptance: opts.optimalAcceptance,
      colorRatioMin: opts.colorRatioMin,
      colorRatioMax: opts.colorRatioMax,
      colorJitter: opts.colorJitter,
      searchCloseMin: opts.searchCloseMin,
      searchCloseMax: opts.searchCloseMax,
      searchCloseMode: opts.searchCloseMode,
      searchDebtMin: opts.searchDebtMin,
      searchDebtMax: opts.searchDebtMax,
      searchSpreadMin: opts.searchSpreadMin,
      searchSpreadMax: opts.searchSpreadMax,
      reuseTemplateParams: opts.reuseTemplateParams,
      adaptiveSearch: opts.adaptiveSearch,
      adaptiveExploreRate: opts.adaptiveExploreRate,
      adaptivePoolSize: opts.adaptivePoolSize,
      adaptiveMinSamples: opts.adaptiveMinSamples,
      adaptiveContinuousStep: opts.adaptiveContinuousStep,
      optimalFirst: opts.optimalFirst,
      placementMode: opts.placementMode,
      historicalTemplates: historicalTemplatePools.get(c.levelResId) ?? {},
      seedBase: (Date.now() + Number(c.levelResId) * 97) & 0x7fffffff,
    });
  }
  if (opts.shuffleJobs) shuffleInPlace(jobs, mulberry32(Date.now() & 0x7fffffff));
  return jobs;
}

function shuffleInPlace<T>(items: T[], rng: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

async function runWorkerJob(job: SearchJob): Promise<void> {
  const terrain = loadTerrainFromFile(job.terrainPath);
  let attempts = 0;
  const foundByGrade: Record<number, number> = Object.fromEntries(
    Object.keys(job.targetNeeds).map(grade => [Number(grade), 0]),
  ) as Record<number, number>;
  const focusAttempts: Record<number, number> = Object.fromEntries(
    Object.keys(job.targetNeeds).map(grade => [Number(grade), 0]),
  ) as Record<number, number>;
  const templatePools = new Map<number, GenerationParams[]>(
    Object.entries(job.historicalTemplates ?? {}).map(([grade, templates]) => [Number(grade), templates]),
  );
  const adaptivePools = new Map<number, AdaptiveCandidate[]>();
  const pendingGrades = () => Object.keys(job.targetNeeds)
    .map(Number)
    .filter(grade => foundByGrade[grade] < job.targetNeeds[grade]);

  while (pendingGrades().length > 0 && attempts < job.maxAttempts) {
    const eligibleFocusGrades = pendingGrades().filter(grade => (
      !job.reuseTemplateParams ||
      (templatePools.get(grade)?.length ?? 0) > 0 ||
      focusAttempts[grade] < job.templateAttempts
    ));
    if (eligibleFocusGrades.length === 0) break;
    const seed = job.seedBase + attempts * 17;
    const rng = mulberry32(seed + 999);
    const totalRemaining = eligibleFocusGrades.reduce(
      (sum, grade) => sum + job.targetNeeds[grade] - foundByGrade[grade],
      0,
    );
    let selected = Math.floor(rng() * totalRemaining);
    let focusGrade = eligibleFocusGrades[0];
    for (const grade of eligibleFocusGrades) {
      selected -= job.targetNeeds[grade] - foundByGrade[grade];
      if (selected < 0) {
        focusGrade = grade;
        break;
      }
    }
    focusAttempts[focusGrade]++;
    const templatePool = templatePools.get(focusGrade) ?? [];
    const template = templatePool.length > 0
      ? templatePool[Math.floor(rng() * templatePool.length)]
      : null;
    const adaptivePool = adaptivePools.get(focusGrade) ?? [];
    const useAdaptiveCandidate = job.adaptiveSearch &&
      adaptivePool.length >= job.adaptiveMinSamples &&
      rng() >= job.adaptiveExploreRate;
    const baseCandidate = useAdaptiveCandidate
      ? adaptivePool[Math.floor(rng() * rng() * adaptivePool.length)]
      : null;
    const params: GenerationParams = useAdaptiveCandidate
      ? mutateAdaptiveParams(
        terrain,
        baseCandidate!.params,
        baseCandidate!.direction,
        job,
        rng,
      )
      : job.reuseTemplateParams && template
        ? cloneTemplateParams(template)
        : buildTargetedSearchParams(
        terrain,
        focusGrade,
        job.colorRatioMin,
        job.colorRatioMax,
        job.colorJitter,
        job,
          rng,
        );
    let optimalPassedGrades: Set<number> | null = null;
    let row = job.placementMode === 'random-color'
      ? generateRandomColorCandidate(terrain, params.colorCount, job.terrainPath, attempts + 1, rng)
      : job.optimalFirst && job.optimalAcceptance
        ? generateCandidateOnly(terrain, params, job.terrainPath, attempts + 1)
        : generateAndEvaluateOne(
          terrain,
          params,
          0,
          job.terrainPath,
          attempts + 1,
          false,
          job.simRuns,
          seed,
        );
    if (row.success && job.placementMode === 'random-color' && !job.optimalFirst) {
      row = evaluateStrategy2(row, terrain, job.simRuns, seed);
    }
    if (row.success && job.optimalFirst && job.optimalAcceptance) {
      row = evaluateOptimal(row, terrain, job.optimalAcceptance, seed + 700000);
      optimalPassedGrades = gradesPassingOptimal(row, pendingGrades(), job.optimalAcceptance);
      if (optimalPassedGrades.size > 0) {
        row = evaluateStrategy2(row, terrain, job.simRuns, seed);
      }
    }
    attempts++;
    const isPendingTarget = row.success && (
      job.targetNeeds[row.grade] != null &&
      foundByGrade[row.grade] < job.targetNeeds[row.grade] &&
      (optimalPassedGrades == null || optimalPassedGrades.has(row.grade))
    );
    if (isPendingTarget && !job.optimalFirst) {
      if (optimalConstraintFor(job.optimalAcceptance, row.grade) && job.optimalAcceptance) {
        row = evaluateOptimal(row, terrain, job.optimalAcceptance, seed + 700000);
      }
    }
    if (row.success && job.adaptiveSearch) {
      const focusLearningRow = row.grade >= 0
        ? row
        : { ...row, grade: focusGrade, passrate: targetPassrateCenter(focusGrade) };
      updateAdaptivePool(
        adaptivePools,
        focusGrade,
        adaptiveCandidate(focusLearningRow, focusGrade, params, job.optimalAcceptance),
        job.adaptivePoolSize,
      );
      if (row.grade >= 0 && row.grade !== focusGrade && job.targetNeeds[row.grade] != null) {
        updateAdaptivePool(
          adaptivePools,
          row.grade,
          adaptiveCandidate(row, row.grade, params, job.optimalAcceptance),
          job.adaptivePoolSize,
        );
      }
    }
    if (isPendingTarget && acceptsMetrics(row, job)) {
      if (job.reuseTemplateParams && job.placementMode === 'layer-closure') {
        const pool = templatePools.get(row.grade) ?? [];
        pool.push({ ...params, closeRates: [...params.closeRates] });
        if (pool.length > 20) pool.shift();
        templatePools.set(row.grade, pool);
      }
      foundByGrade[row.grade]++;
      sendWorkerMessage({
        type: 'row',
        jobId: job.jobId,
        row,
        attempts,
        foundByGrade: { ...foundByGrade },
      });
    }
    if (attempts % 10 === 0) {
      sendWorkerMessage({
        type: 'progress',
        jobId: job.jobId,
        attempts,
        foundByGrade: { ...foundByGrade },
      });
    }
  }
  sendWorkerMessage({
    type: 'done',
    jobId: job.jobId,
    attempts,
    foundByGrade: { ...foundByGrade },
  });
}

function sendWorkerMessage(message: WorkerMessage): void {
  if (process.send) process.send(message);
}

async function runSearchJobs(jobs: SearchJob[], opts: CliOptions): Promise<SearchSummary> {
  let next = 0;
  let doneJobs = 0;
  let totalFound = 0;
  const totalNeeded = jobs.reduce(
    (sum, job) => sum + Object.values(job.targetNeeds).reduce((jobSum, needed) => jobSum + needed, 0),
    0,
  );
  const totalAttemptLimit = jobs.reduce((sum, j) => sum + j.maxAttempts, 0);
  let lastLoggedPercent = -1;
  let lastLoggedText = '';
  const jobState: Record<string, {
    levelResId: string;
    targetNeeds: Record<number, number>;
    foundByGrade: Record<number, number>;
    needed: number;
    found: number;
    attempts: number;
    status: string;
  }> = {};
  for (const j of jobs) {
    const foundByGrade = Object.fromEntries(
      Object.keys(j.targetNeeds).map(grade => [Number(grade), 0]),
    ) as Record<number, number>;
    jobState[j.jobId] = {
      levelResId: j.levelResId,
      targetNeeds: j.targetNeeds,
      foundByGrade,
      needed: Object.values(j.targetNeeds).reduce((sum, needed) => sum + needed, 0),
      found: 0,
      attempts: 0,
      status: 'pending',
    };
  }

  const updateStatus = () => {
    const progressText = `${totalFound}/${totalNeeded}`;
    const totalAttempts = Object.values(jobState).reduce((sum, state) => sum + state.attempts, 0);
    const successfulJobs = Object.values(jobState).filter(state => state.status === 'done').length;
    const failedJobs = Object.values(jobState).filter(
      state => state.status === 'partial' || state.status === 'error',
    ).length;
    const unfinishedJobs = jobs.length - successfulJobs - failedJobs;
    const attemptPercent = totalAttemptLimit > 0
      ? Math.min(100, totalAttempts / totalAttemptLimit * 100)
      : 100;
    const attemptProgressText = `${totalAttempts}/${totalAttemptLimit} (${attemptPercent.toFixed(1)}%)`;
    const displayText = `progress 命中 ${progressText} | 搜索 ${attemptProgressText} | 成功 ${successfulJobs} | 失败 ${failedJobs} | 未完成 ${unfinishedJobs}`;
    writeStatus(opts.status, {
      updatedAt: new Date().toISOString(),
      totalJobs: jobs.length,
      doneJobs,
      totalNeeded,
      totalFound,
      progressText,
      totalAttempts,
      totalAttemptLimit,
      attemptPercent,
      attemptProgressText,
      successfulJobs,
      failedJobs,
      unfinishedJobs,
      concurrency: opts.concurrency,
      jobs: jobState,
    });
    if (!opts.progressLines) {
      process.stdout.write(`\r\x1b[2K${displayText}`);
    } else {
      const integerPercent = Math.floor(attemptPercent);
      if ((integerPercent > lastLoggedPercent || doneJobs === jobs.length) && displayText !== lastLoggedText) {
        lastLoggedPercent = integerPercent;
        lastLoggedText = displayText;
        console.log(displayText);
      }
    }
  };

  const script = fileURLToPath(import.meta.url);
  const runOne = (job: SearchJob) => new Promise<void>((resolvePromise, reject) => {
    jobState[job.jobId].status = 'running';
    updateStatus();
    const child = fork(script, ['--worker'], {
      execArgv: process.execArgv.filter(arg => !['--eval', '-e', '--print', '-p'].includes(arg)),
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    child.on('message', (message: WorkerMessage) => {
      if (message.type === 'row') {
        appendRow(opts.output, message.row);
        jobState[job.jobId].foundByGrade = message.foundByGrade;
        jobState[job.jobId].found = Object.values(message.foundByGrade)
          .reduce((sum, found) => sum + found, 0);
        jobState[job.jobId].attempts = message.attempts;
        totalFound++;
      } else if (message.type === 'progress') {
        jobState[job.jobId].foundByGrade = message.foundByGrade;
        jobState[job.jobId].found = Object.values(message.foundByGrade)
          .reduce((sum, found) => sum + found, 0);
        jobState[job.jobId].attempts = message.attempts;
      } else if (message.type === 'done') {
        jobState[job.jobId].foundByGrade = message.foundByGrade;
        jobState[job.jobId].found = Object.values(message.foundByGrade)
          .reduce((sum, found) => sum + found, 0);
        jobState[job.jobId].attempts = message.attempts;
        jobState[job.jobId].status = Object.entries(job.targetNeeds).every(
          ([grade, needed]) => (message.foundByGrade[Number(grade)] ?? 0) >= needed,
        ) ? 'done' : 'partial';
        doneJobs++;
      } else if (message.type === 'error') {
        jobState[job.jobId].status = 'error';
        reject(new Error(message.error));
      }
      updateStatus();
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolvePromise();
      else reject(new Error(`worker ${job.jobId} exited with code ${code}`));
    });
    child.send(job);
  });

  const workers = Array.from({ length: Math.min(opts.concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      await runOne(job);
    }
  });
  updateStatus();
  await Promise.all(workers);
  updateStatus();
  if (!opts.progressLines && jobs.length > 0) process.stdout.write('\n');
  const totalAttempts = Object.values(jobState).reduce((sum, state) => sum + state.attempts, 0);
  return {
    totalJobs: jobs.length,
    doneJobs,
    totalNeeded,
    totalFound,
    totalAttempts,
  };
}

async function runMain(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const existingRows = [
    ...readExistingRows(opts.input, opts.excludeLevels, opts, !opts.targetFromOutputOnly, true),
    ...(opts.resume ? readExistingRows(opts.output, opts.excludeLevels, opts, true, false) : []),
  ];
  const coverages = buildCoverage(existingRows, opts.targetPerGrade, opts.minExistingCount, opts.targetPolicy);
  const historicalTemplatePools = opts.resume && opts.reuseTemplateParams
    ? readHistoricalTemplatePools(opts.output, opts.excludeLevels, opts)
    : new Map<string, Record<number, GenerationParams[]>>();
  if (opts.reuseTemplateParams) {
    const templatePairs = [...historicalTemplatePools.values()]
      .reduce((sum, byGrade) => sum + Object.values(byGrade).filter(pool => pool.length > 0).length, 0);
    const templateRows = [...historicalTemplatePools.values()]
      .reduce((sum, byGrade) => sum + Object.values(byGrade)
        .reduce((gradeSum, pool) => gradeSum + pool.length, 0), 0);
    console.log(`历史参数模板: ${templateRows} 条，覆盖 ${templatePairs} 个地形档位`);
  }
  writePlanCsv(opts.plan, coverages);
  const targetGrades = [...opts.gradesToBackfill].sort((a, b) => a - b);
  const summary = summarizeCoverage(coverages, targetGrades);
  console.log(`已写补缺计划: ${opts.plan}`);
  console.log(JSON.stringify(summary, null, 2));

  if (!opts.run) {
    console.log('当前是 plan-only。需要生成时运行: npx tsx tools/backfill-missing-grades.ts --run --concurrency 5');
    return;
  }

  ensureOutputCsv(opts.output, opts.resume);

  let g0Generated = 0;
  if (opts.gradesToBackfill.has(0)) {
    for (let i = 0; i < coverages.length; i++) {
      const c = coverages[i];
      const needed = c.missing[0] ?? 0;
      for (let n = 0; n < needed; n++) {
        const row = createG0Row(i, c.terrainPath, n + 1, opts.colorRatio, opts.colorJitter, opts.g0Spread, opts.g0Debt);
        appendRow(opts.output, row);
        g0Generated++;
      }
      if ((i + 1) % 10 === 0) console.log(`G0 已处理 ${i + 1}/${coverages.length} 个地形，生成 ${g0Generated} 条`);
    }
  }

  const jobs = buildSearchJobs(coverages, opts, historicalTemplatePools);
  const searchGrades = targetGrades.filter(g => g > 0).map(g => `G${g}`).join(',') || '无';
  if (opts.gradesToBackfill.has(0)) {
    console.log(`规则G0生成完成: ${g0Generated} 条。`);
  }
  console.log(`按地形搜索(${searchGrades}): ${jobs.length} 个地形任务，并发 ${opts.concurrency}`);
  writeStatus(opts.status, {
    updatedAt: new Date().toISOString(),
    g0Generated,
    searchJobs: jobs.length,
    status: 'search-starting',
  });
  const searchSummary = jobs.length > 0
    ? await runSearchJobs(jobs, opts)
    : { totalJobs: 0, doneJobs: 0, totalNeeded: 0, totalFound: 0, totalAttempts: 0 };
  const completionText = searchSummary.totalNeeded > 0
    ? `命中 ${searchSummary.totalFound}/${searchSummary.totalNeeded}`
    : '无搜索目标';
  console.log(`搜索结束，${completionText}。输出: ${opts.output}，状态: ${opts.status}`);
}

if (process.argv.includes('--worker')) {
  process.on('message', message => {
    runWorkerJob(message as SearchJob)
      .then(() => process.exit(0))
      .catch(err => {
        sendWorkerMessage({
          type: 'error',
          jobId: (message as Partial<SearchJob>)?.jobId ?? 'unknown',
          error: err instanceof Error ? err.message : String(err),
        });
        process.exit(1);
      });
  });
} else {
  runMain().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
