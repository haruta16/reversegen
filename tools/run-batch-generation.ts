#!/usr/bin/env npx tsx
/**
 * Headless batch board generation.
 *
 * This is the CLI counterpart of gui/batch-generate.html. It uses the same
 * src/batch-generator.ts core path and writes the generated CSV directly.
 */

import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BATCH_CSV_HEADERS,
  runBatchGeneration,
  serializeBatchRow,
  type BatchConfig,
  type ParamMode,
  type ParamModeStr,
} from '../src/batch-generator.js';

interface Options {
  levelsDir: string;
  levels: string[];
  output: string;
  closeRates: ParamModeStr;
  colorCount: ParamMode;
  colorCountRatio: number;
  spreadParam: ParamMode;
  debtPersistenceWeight: ParamMode;
  simRuns: number;
  targetPerTier: number;
  maxAttempts: number;
  concurrency: number;
}

function parseNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseMode(value: string | undefined, fallback: ParamMode): ParamMode {
  if (value == null || value === '') return fallback;
  if (value === 'random') return 'random';
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseModeStr(value: string | undefined, fallback: ParamModeStr): ParamModeStr {
  if (value == null || value === '') return fallback;
  return value === 'random' ? 'random' : value;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    levelsDir: join(process.cwd(), '..', 'TileMatchShell', 'Tools', 'Config', 'Json', 'Levels'),
    levels: [],
    output: 'output/batch生成.csv',
    closeRates: 'random',
    colorCount: 'random',
    colorCountRatio: 0.6,
    spreadParam: 'random',
    debtPersistenceWeight: 'random',
    simRuns: 200,
    targetPerTier: 10,
    maxAttempts: 500,
    concurrency: 2,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--levels-dir') opts.levelsDir = next() ?? opts.levelsDir;
    else if (arg === '--levels') opts.levels = (next() ?? '').split(',').map(s => s.trim()).filter(Boolean);
    else if (arg === '--output') opts.output = next() ?? opts.output;
    else if (arg === '--close-rates') opts.closeRates = parseModeStr(next(), opts.closeRates);
    else if (arg === '--color-count') opts.colorCount = parseMode(next(), opts.colorCount);
    else if (arg === '--color-ratio') opts.colorCountRatio = parseNumber(next(), opts.colorCountRatio);
    else if (arg === '--spread') opts.spreadParam = parseMode(next(), opts.spreadParam);
    else if (arg === '--debt') opts.debtPersistenceWeight = parseMode(next(), opts.debtPersistenceWeight);
    else if (arg === '--sim-runs') opts.simRuns = Math.floor(parseNumber(next(), opts.simRuns));
    else if (arg === '--target-per-tier') opts.targetPerTier = Math.floor(parseNumber(next(), opts.targetPerTier));
    else if (arg === '--max-attempts') opts.maxAttempts = Math.floor(parseNumber(next(), opts.maxAttempts));
    else if (arg === '--concurrency') opts.concurrency = Math.floor(parseNumber(next(), opts.concurrency));
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  if (opts.levels.length === 0) throw new Error('请通过 --levels 指定地形ID列表，例如 --levels 100075,100074');
  opts.concurrency = Math.max(1, opts.concurrency);
  return opts;
}

function printHelp(): void {
  console.log(`Usage:
  npx tsx tools/run-batch-generation.ts --levels 100075,100074 --output output/batch.csv [options]

Options:
  --levels-dir <dir>       Terrain JSON directory. Default: ../TileMatchShell/Tools/Config/Json/Levels
  --levels <ids>           Comma-separated terrain IDs. Required.
  --output <csv>           Output CSV. Default: output/batch生成.csv
  --close-rates <value>    random or comma list, e.g. 0.3,0.6,0.8. Default: random
  --color-count <value>    random or fixed integer. Default: random
  --color-ratio <n>        Used when color-count=random. Default: 0.6
  --spread <value>         random or fixed 0..1. Default: random
  --debt <value>           random or fixed 0..1. Default: random
  --sim-runs <n>           Simulation runs. Default: 200
  --target-per-tier <n>    Target rows per grade. Default: 10
  --max-attempts <n>       Max attempts per terrain. Default: 500
  --concurrency <n>        Parallel terrains. Default: 2
`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const terrainPaths = opts.levels.map(level => {
    const path = join(opts.levelsDir, `${level}.json`);
    if (!existsSync(path)) throw new Error(`地形不存在: ${path}`);
    return path;
  });
  const config: BatchConfig = {
    terrainPaths,
    closeRates: opts.closeRates,
    colorCount: opts.colorCount,
    colorCountRatio: opts.colorCountRatio,
    spreadParam: opts.spreadParam,
    debtPersistenceWeight: opts.debtPersistenceWeight,
    simRuns: opts.simRuns,
    targetPerTier: opts.targetPerTier,
    maxAttempts: opts.maxAttempts,
    concurrency: opts.concurrency,
  };

  mkdirSync(dirname(opts.output), { recursive: true });
  writeFileSync(opts.output, `\uFEFF${BATCH_CSV_HEADERS.join(',')}\n`, 'utf8');
  let written = 0;
  await runBatchGeneration(config, progress => {
    for (const tp of progress.terrains) {
      while (tp.rows.length > 0) {
        appendFileSync(opts.output, `${serializeBatchRow(tp.rows.shift()!)}\n`, 'utf8');
        written++;
      }
    }
    const done = progress.terrains.filter(t => t.phase === 'done').length;
    process.stdout.write(`\rprogress terrains ${done}/${progress.terrains.length}, rows ${written}`);
  });
  process.stdout.write(`\n完成。输出: ${opts.output}，rows=${written}\n`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
