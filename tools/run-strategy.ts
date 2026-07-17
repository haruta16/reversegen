#!/usr/bin/env npx tsx

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadTerrainFromFile, LogLevel, setLogLevel } from '../src/index.js';
import { validateStrategyDefinition } from '../src/strategy/definition.js';
import { generateCandidate } from '../src/strategy/generator.js';
import { executeStrategyPipeline } from '../src/strategy/pipeline.js';
import type { StrategyDefinition, StrategyRunRecord } from '../src/strategy/types.js';

setLogLevel(LogLevel.Silent);

let stopRequested = false;
const activeChildren = new Set<ChildProcess>();

interface Options {
  strategyPath: string;
  outputDir?: string;
  levels?: string[];
  maxAttempts?: number;
  concurrency?: number;
  validateOnly: boolean;
  run: boolean;
  resume: boolean;
}

interface ExistingState {
  accepted: Map<string, Map<number, number>>;
  nextAttempt: Map<string, number>;
}

interface StrategyJob {
  id: string;
  definition: StrategyDefinition;
  terrainPath: string;
  needs: Record<number, number>;
  startAttempt: number;
  maxAttempts: number;
}

interface JobStatus {
  level: string;
  status: 'pending' | 'running' | 'complete' | 'partial' | 'error';
  needs: Record<number, number>;
  accepted: Record<number, number>;
  attempts_completed: number;
  attempt_errors: number;
  error?: string;
}

type WorkerMessage =
  | { type: 'record'; job_id: string; record: StrategyRunRecord }
  | { type: 'attempt_error'; job_id: string; attempt: number; error: string }
  | { type: 'progress'; job_id: string; attempts_completed: number; accepted: Record<number, number> }
  | { type: 'done'; job_id: string; attempts_completed: number; accepted: Record<number, number> }
  | { type: 'fatal'; job_id: string; error: string };

function parsePositiveInteger(value: string | undefined, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${option} must be a positive integer`);
  return parsed;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    strategyPath: 'strategies/current_calibration/strategy.v2.json',
    validateOnly: false,
    run: false,
    resume: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--strategy') options.strategyPath = next() ?? '';
    else if (arg === '--output-dir') options.outputDir = next();
    else if (arg === '--levels') options.levels = (next() ?? '').split(',').map(value => value.trim()).filter(Boolean);
    else if (arg === '--max-attempts') options.maxAttempts = parsePositiveInteger(next(), arg);
    else if (arg === '--concurrency') options.concurrency = parsePositiveInteger(next(), arg);
    else if (arg === '--validate') options.validateOnly = true;
    else if (arg === '--run') options.run = true;
    else if (arg === '--resume') options.resume = true;
    else if (arg === '--worker') continue;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage:
  npm run strategy:validate
  npm run strategy:run -- --strategy strategies/current_calibration/strategy.v2.json

Options:
  --strategy <file>       Strategy v2 JSON (default: current calibration)
  --levels <ids>          Override the strategy level list
  --output-dir <dir>      Use an explicit ignored run directory
  --max-attempts <n>      Override the per-level attempt ceiling
  --concurrency <n>       Override runtime.concurrency
  --validate              Validate only; do not create output
  --run                   Execute; without this flag only plan.json is written
  --resume                Continue an explicit --output-dir run`);
}

function strategyHash(definition: StrategyDefinition): string {
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex');
}

function runStamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1Z');
}

function defaultRunDirectory(definition: StrategyDefinition, hash: string): string {
  const runId = `${runStamp()}_v${definition.version}_${hash.slice(0, 8)}`;
  return resolve('output', 'runs', definition.id, runId);
}

function readStrategy(path: string): StrategyDefinition {
  return validateStrategyDefinition(JSON.parse(readFileSync(path, 'utf8')));
}

function readJsonFile(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

function readExisting(path: string, statusPath: string, definition: StrategyDefinition): ExistingState {
  const state: ExistingState = { accepted: new Map(), nextAttempt: new Map() };
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as StrategyRunRecord;
      if (record.strategy.id !== definition.id || record.strategy.version !== definition.version) continue;
      const level = record.candidate.terrain_id;
      state.nextAttempt.set(level, Math.max(state.nextAttempt.get(level) ?? 0, record.candidate.attempt + 1));
      if (!record.decision.accepted) continue;
      const counts = state.accepted.get(level) ?? new Map<number, number>();
      counts.set(record.decision.grade, (counts.get(record.decision.grade) ?? 0) + 1);
      state.accepted.set(level, counts);
    }
  }
  if (existsSync(statusPath)) {
    const status = JSON.parse(readFileSync(statusPath, 'utf8')) as {
      strategy?: { id?: string; version?: number };
      jobs?: Record<string, { attempts_completed?: number }>;
    };
    if (status.strategy?.id === definition.id && status.strategy.version === definition.version) {
      for (const [level, job] of Object.entries(status.jobs ?? {})) {
        if (Number.isInteger(job.attempts_completed)) {
          state.nextAttempt.set(level, Math.max(state.nextAttempt.get(level) ?? 0, job.attempts_completed ?? 0));
        }
      }
    }
  }
  return state;
}

function selectedLevels(definition: StrategyDefinition, override?: string[]): string[] {
  const excluded = new Set((definition.scope.exclude_levels ?? []).map(String));
  const levels = (override ?? definition.scope.levels.map(String)).filter(level => !excluded.has(level));
  return [...new Set(levels)];
}

function appendJsonLine(path: string, value: unknown): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

function sendToParent(message: WorkerMessage): Promise<void> {
  return new Promise((done, reject) => {
    if (!process.send || !process.connected) {
      done();
      return;
    }
    process.send(message, error => error ? reject(error) : done());
  });
}

async function runWorker(job: StrategyJob): Promise<void> {
  try {
    const terrain = loadTerrainFromFile(job.terrainPath);
    const accepted: Record<number, number> = {};
    let attemptsCompleted = job.startAttempt;
    const stillNeeded = () => Object.entries(job.needs).some(([grade, count]) => (accepted[Number(grade)] ?? 0) < count);

    for (let attempt = job.startAttempt; attempt < job.maxAttempts && stillNeeded(); attempt++) {
      attemptsCompleted = attempt + 1;
      try {
        const generated = generateCandidate(
          terrain,
          job.terrainPath,
          attempt,
          job.definition.generator,
          job.definition.runtime.seed,
        );
        const record = executeStrategyPipeline(job.definition, generated.candidate, generated.game);
        const grade = record.decision.grade;
        if (record.decision.accepted) {
          const remaining = job.needs[grade] ?? 0;
          if ((accepted[grade] ?? 0) < remaining) accepted[grade] = (accepted[grade] ?? 0) + 1;
          else {
            record.decision.accepted = false;
            record.decision.reasons.push(`grade ${grade} quota is already filled`);
          }
        }
        await sendToParent({ type: 'record', job_id: job.id, record });
      } catch (error) {
        await sendToParent({
          type: 'attempt_error',
          job_id: job.id,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if ((attemptsCompleted - job.startAttempt) % 10 === 0) {
        await sendToParent({ type: 'progress', job_id: job.id, attempts_completed: attemptsCompleted, accepted });
      }
    }
    await sendToParent({ type: 'done', job_id: job.id, attempts_completed: attemptsCompleted, accepted });
  } catch (error) {
    await sendToParent({ type: 'fatal', job_id: job.id, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

function runJobs(
  jobs: StrategyJob[],
  concurrency: number,
  paths: { records: string; accepted: string; status: string; log: string },
  strategy: StrategyDefinition,
): Promise<void> {
  const started = performance.now();
  const status: Record<string, JobStatus> = Object.fromEntries(jobs.map(job => [job.id, {
    level: job.id,
    status: 'pending',
    needs: job.needs,
    accepted: {},
    attempts_completed: job.startAttempt,
    attempt_errors: 0,
  }]));
  let nextJob = 0;
  let acceptedTotal = 0;
  let recordTotal = 0;
  let failedJobs = 0;
  const stageElapsed: Record<string, number> = {};

  const saveStatus = () => writeFileSync(paths.status, JSON.stringify({
    schema_version: 2,
    strategy: { id: strategy.id, version: strategy.version },
    updated_at: new Date().toISOString(),
    elapsed_ms: performance.now() - started,
    records: recordTotal,
    accepted: acceptedTotal,
    failed_jobs: failedJobs,
    stage_elapsed_ms: stageElapsed,
    jobs: status,
  }, null, 2) + '\n');

  const runOne = (job: StrategyJob): Promise<void> => new Promise(resolveJob => {
    const script = fileURLToPath(import.meta.url);
    const child = fork(script, ['--worker'], {
      execArgv: process.execArgv.filter(arg => !['--eval', '-e', '--print', '-p'].includes(arg)),
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    activeChildren.add(child);
    let receivedDone = false;
    let fatalError = '';
    status[job.id].status = 'running';
    saveStatus();

    child.on('message', (message: WorkerMessage) => {
      if (message.type === 'record') {
        appendJsonLine(paths.records, message.record);
        recordTotal++;
        for (const stage of message.record.stages) {
          stageElapsed[stage.id] = (stageElapsed[stage.id] ?? 0) + stage.elapsed_ms;
        }
        if (message.record.decision.accepted) {
          appendJsonLine(paths.accepted, message.record);
          acceptedTotal++;
          const grade = message.record.decision.grade;
          status[job.id].accepted[grade] = (status[job.id].accepted[grade] ?? 0) + 1;
        }
      } else if (message.type === 'attempt_error') {
        status[job.id].attempt_errors++;
        appendJsonLine(paths.log, { event: 'attempt_error', at: new Date().toISOString(), ...message });
      } else if (message.type === 'progress') {
        status[job.id].attempts_completed = message.attempts_completed;
        status[job.id].accepted = message.accepted;
        saveStatus();
      } else if (message.type === 'done') {
        receivedDone = true;
        status[job.id].attempts_completed = message.attempts_completed;
        status[job.id].accepted = message.accepted;
        const complete = Object.entries(job.needs).every(([grade, count]) => (message.accepted[Number(grade)] ?? 0) >= count);
        status[job.id].status = complete ? 'complete' : 'partial';
        appendJsonLine(paths.log, { event: 'job_done', at: new Date().toISOString(), complete, ...message });
        saveStatus();
      } else if (message.type === 'fatal') {
        fatalError = message.error;
      }
    });
    child.on('error', error => {
      fatalError = error.message;
    });
    child.on('exit', code => {
      activeChildren.delete(child);
      if (!receivedDone || code !== 0) {
        failedJobs++;
        status[job.id].status = 'error';
        status[job.id].error = fatalError || `worker exited with code ${code}`;
        appendJsonLine(paths.log, { event: 'job_error', at: new Date().toISOString(), job_id: job.id, error: status[job.id].error });
      }
      saveStatus();
      resolveJob();
    });
    child.send(job);
  });

  saveStatus();
  appendJsonLine(paths.log, { event: 'run_start', at: new Date().toISOString(), jobs: jobs.length, concurrency });
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (!stopRequested && nextJob < jobs.length) await runOne(jobs[nextJob++]);
  });
  return Promise.all(workers).then(() => {
    const elapsedMs = performance.now() - started;
    appendJsonLine(paths.log, {
      event: 'run_done',
      at: new Date().toISOString(),
      elapsed_ms: elapsedMs,
      records: recordTotal,
      accepted: acceptedTotal,
      failed_jobs: failedJobs,
      stage_elapsed_ms: stageElapsed,
    });
    saveStatus();
    console.log(`run complete: records=${recordTotal}, accepted=${acceptedTotal}, failed_jobs=${failedJobs}, elapsed=${(elapsedMs / 1000).toFixed(2)}s`);
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const strategyPath = resolve(options.strategyPath);
  const definition = readStrategy(strategyPath);
  console.log(`valid strategy: ${definition.id}@${definition.version} (schema v${definition.schema_version})`);
  if (options.validateOnly) return;

  if (options.resume && !options.outputDir) {
    throw new Error('--resume requires --output-dir so the run instance is unambiguous');
  }
  const hash = strategyHash(definition);
  const outputDir = options.outputDir ? resolve(options.outputDir) : defaultRunDirectory(definition, hash);
  const paths = {
    manifest: join(outputDir, 'manifest.json'),
    plan: join(outputDir, 'plan.json'),
    snapshot: join(outputDir, 'strategy.snapshot.json'),
    records: join(outputDir, 'records.jsonl'),
    accepted: join(outputDir, 'accepted.jsonl'),
    status: join(outputDir, 'status.json'),
    log: join(outputDir, 'timing.log.jsonl'),
  };
  if (!options.resume && options.outputDir && existsSync(paths.manifest)) {
    throw new Error(`Run directory already contains a manifest; use --resume or choose another directory: ${outputDir}`);
  }
  mkdirSync(outputDir, { recursive: true });
  const snapshotText = `${JSON.stringify(definition, null, 2)}\n`;
  if (options.run && options.resume) {
    if (!existsSync(paths.snapshot)) throw new Error(`Cannot resume without strategy snapshot: ${paths.snapshot}`);
    const previous = validateStrategyDefinition(JSON.parse(readFileSync(paths.snapshot, 'utf8')));
    if (JSON.stringify(previous) !== JSON.stringify(definition)) {
      throw new Error('Cannot resume: current strategy differs from strategy.snapshot.json');
    }
  } else {
    writeFileSync(paths.snapshot, snapshotText);
  }
  if (options.run && !options.resume) {
    writeFileSync(paths.records, '');
    writeFileSync(paths.accepted, '');
    writeFileSync(paths.log, '');
  }
  const existing = options.resume
    ? readExisting(paths.records, paths.status, definition)
    : { accepted: new Map(), nextAttempt: new Map() };
  const levelsDir = resolve(definition.scope.levels_dir);
  const maxAttempts = options.maxAttempts ?? definition.target.max_attempts_per_level;
  const levels = selectedLevels(definition, options.levels);
  const jobs: StrategyJob[] = [];
  const planLevels = levels.map(level => {
    const terrainPath = join(levelsDir, `${level}.json`);
    if (!existsSync(terrainPath)) throw new Error(`Terrain does not exist: ${terrainPath}`);
    const counts = existing.accepted.get(level) ?? new Map<number, number>();
    const needs = Object.fromEntries(definition.target.grades.map(grade => [
      grade,
      Math.max(0, definition.target.count_per_grade - (counts.get(grade) ?? 0)),
    ]));
    const startAttempt = existing.nextAttempt.get(level) ?? 0;
    if (Object.values(needs).some(value => value > 0) && startAttempt < maxAttempts) {
      jobs.push({ id: level, definition, terrainPath, needs, startAttempt, maxAttempts });
    }
    return { level, terrain_path: terrainPath, start_attempt: startAttempt, max_attempts: maxAttempts, existing: Object.fromEntries(counts), needs };
  });
  const concurrency = options.concurrency
    ?? (definition.runtime.concurrency === 'auto' ? availableParallelism() : definition.runtime.concurrency);
  const createdAt = options.resume && existsSync(paths.manifest)
    ? String(readJsonFile(paths.manifest).created_at ?? new Date().toISOString())
    : new Date().toISOString();
  const writeManifest = (status: 'planned' | 'running' | 'complete' | 'partial' | 'error') => writeFileSync(paths.manifest, JSON.stringify({
    schema_version: 1,
    run_id: outputDir.split(/[\\/]/).pop(),
    strategy: { id: definition.id, version: definition.version, sha256: hash },
    status,
    created_at: createdAt,
    updated_at: new Date().toISOString(),
    runtime: { seed: definition.runtime.seed, concurrency },
    artifacts: {
      plan: 'plan.json',
      strategy_snapshot: 'strategy.snapshot.json',
      records: 'records.jsonl',
      accepted: 'accepted.jsonl',
      status: 'status.json',
      timing: 'timing.log.jsonl',
    },
  }, null, 2) + '\n');
  writeFileSync(paths.plan, JSON.stringify({
    schema_version: 2,
    strategy: { id: definition.id, version: definition.version, file: strategyPath },
    generated_at: new Date().toISOString(),
    output_directory: outputDir,
    strategy_snapshot: paths.snapshot,
    concurrency,
    run_requested: options.run,
    levels: planLevels,
  }, null, 2) + '\n');
  writeManifest(options.run ? 'running' : 'planned');
  console.log(`plan: levels=${levels.length}, jobs=${jobs.length}, concurrency=${concurrency}, output=${outputDir}`);
  if (!options.run) {
    console.log(`plan only: ${paths.plan}`);
    return;
  }
  if (jobs.length === 0) {
    writeManifest('complete');
    console.log('nothing to run');
    return;
  }
  await runJobs(jobs, concurrency, paths, definition);
  const finalJobs = Object.values<any>(readJsonFile(paths.status).jobs ?? {});
  writeManifest(finalJobs.some(job => job.status === 'error')
    ? 'error'
    : finalJobs.some(job => job.status === 'partial')
      ? 'partial'
      : 'complete');
}

if (process.argv.includes('--worker')) {
  process.once('message', (job: StrategyJob) => void runWorker(job));
} else {
  const requestStop = () => {
    stopRequested = true;
    process.exitCode = 130;
    for (const child of activeChildren) child.kill('SIGTERM');
  };
  process.once('SIGTERM', requestStop);
  process.once('SIGINT', requestStop);
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
