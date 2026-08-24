#!/usr/bin/env npx tsx

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism } from 'node:os';
import { createHash } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeFromString,
  buildTileExplorerTerrainView,
  generateBoardTileExplorer,
  loadTerrainFromFile,
  LogLevel,
  setLogLevel,
} from '../src/index.js';
import {
  buildTileExplorerProductionTasks,
  productionRecordToReplaySelection,
  readTileExplorerProductionInput,
  serializeTileExplorerProductionRecord,
  TILE_EXPLORER_PRODUCTION_CSV_HEADERS,
  tileExplorerPlacementSeed,
  type TileExplorerProductionInput,
  type TileExplorerProductionRecord,
  type TileExplorerProductionTask,
} from '../src/tile-explorer/production.js';
import {
  REPLAY_SELECTION_HEADERS,
  checkReplaySelections,
  serializeReplaySelectionCsv,
  serializeReplaySelectionRow,
} from '../src/replay-selection.js';

setLogLevel(LogLevel.Silent);

interface Options {
  inputPath: string;
  outputDir?: string;
  concurrency: number;
  run: boolean;
  resume: boolean;
}

interface WorkerJob {
  task: TileExplorerProductionTask;
  productionId: string;
  rootSeed: number;
  startAttempt: number;
  existingReplayCodes: string[];
  acceptedBefore: number;
}

interface TaskStatus {
  task_id: string;
  output_level_id: number;
  terrain_id: string;
  difficulty: number;
  color_count: number;
  target: number;
  accepted: number;
  attempts_completed: number;
  duplicate_attempts: number;
  generation_errors: number;
  status: 'pending' | 'running' | 'complete' | 'partial' | 'error';
  error?: string;
}

type WorkerMessage =
  | { type: 'record'; task_id: string; record: TileExplorerProductionRecord }
  | { type: 'progress'; task_id: string; attempts_completed: number; accepted_added: number; duplicate_attempts: number; generation_errors: number }
  | { type: 'attempt_error'; task_id: string; attempt: number; error: string }
  | { type: 'done'; task_id: string; attempts_completed: number; accepted_added: number; duplicate_attempts: number; generation_errors: number }
  | { type: 'fatal'; task_id: string; error: string };

const activeChildren = new Set<ChildProcess>();
let stopRequested = false;

function positiveInteger(raw: string | undefined, name: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    inputPath: 'config/tile-explorer-production.example.json',
    concurrency: Math.max(1, availableParallelism()),
    run: false,
    resume: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--input') options.inputPath = next() ?? '';
    else if (arg === '--output-dir') options.outputDir = next();
    else if (arg === '--concurrency') options.concurrency = positiveInteger(next(), arg);
    else if (arg === '--run') options.run = true;
    else if (arg === '--resume') options.resume = true;
    else if (arg === '--worker') continue;
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage:
  npm run tile-explorer:plan -- --input <production.json>
  npm run tile-explorer:run -- --input <production.json>

Options:
  --input <file>          Canonical TileExplorer production JSON
  --output-dir <dir>     Explicit ignored run directory
  --concurrency <n>      Parallel terrain+difficulty tasks (default: CPU count)
  --run                   Execute; otherwise only write plan and manifest
  --resume                Resume an explicit --output-dir run`);
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, jsonText(value), 'utf8');
  renameSync(temporary, path);
}

function appendJsonLine(path: string, value: unknown): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

function inputHash(input: TileExplorerProductionInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function runStamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1Z');
}

function defaultOutputDir(input: TileExplorerProductionInput, hash: string): string {
  return resolve('output', 'runs', 'tile_explorer_default', `${runStamp()}_${input.production_id}_${hash.slice(0, 8)}`);
}

function readRecords(path: string, productionId: string): TileExplorerProductionRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    const raw = JSON.parse(line) as TileExplorerProductionRecord & { replay_element_count?: number };
    const record: TileExplorerProductionRecord = {
      ...raw,
      replay_element_count: raw.replay_element_count ?? raw.element_count,
    };
    if (record.production_id !== productionId) throw new Error(`records.jsonl line ${index + 1} belongs to ${record.production_id}`);
    return record;
  });
}

function writeDerivedCsv(productionPath: string, selectionPath: string, records: TileExplorerProductionRecord[]): void {
  const ordered = [...records].sort((left, right) =>
    left.output_level_id - right.output_level_id
    || left.difficulty - right.difficulty
    || left.attempt - right.attempt);
  const production = `\uFEFF${TILE_EXPLORER_PRODUCTION_CSV_HEADERS.join(',')}\n${ordered.map(serializeTileExplorerProductionRecord).join('\n')}${ordered.length ? '\n' : ''}`;
  writeFileSync(productionPath, production, 'utf8');
  writeFileSync(selectionPath, serializeReplaySelectionCsv(ordered.map(productionRecordToReplaySelection)), 'utf8');
}

function sendToParent(message: WorkerMessage): Promise<void> {
  return new Promise((done, reject) => {
    if (!process.send || !process.connected) return done();
    process.send(message, error => error ? reject(error) : done());
  });
}

async function runWorker(job: WorkerJob): Promise<void> {
  const task = job.task;
  try {
    const terrain = loadTerrainFromFile(task.terrain_path);
    const viewLayerCount = buildTileExplorerTerrainView(terrain).viewLayers.length;
    const replayCodes = new Set(job.existingReplayCodes);
    let acceptedAdded = 0;
    let attemptsCompleted = job.startAttempt;
    let duplicateAttempts = 0;
    let generationErrors = 0;
    const needed = Math.max(0, task.target_count - job.acceptedBefore);

    for (let attempt = job.startAttempt; attempt < task.max_attempts && acceptedAdded < needed; attempt++) {
      attemptsCompleted = attempt + 1;
      try {
        const started = performance.now();
        const placementSeed = tileExplorerPlacementSeed(job.rootSeed, task, attempt);
        const result = generateBoardTileExplorer({
          terrain,
          strategy: 'default',
          difficulty: task.difficulty,
          colorCount: task.color_count,
          tileTypesCanUse: task.color_count,
          tileTypeWeights: task.tile_type_weights,
          sequenceSeed: task.sequence_seed,
          placementSeed,
          easyLayerCount: 0,
        });
        const decoded = decodeFromString(result.replayCode);
        if (!decoded) throw new Error('generated ReplayCode cannot be decoded');
        if (decoded.elementCount > task.color_count) {
          throw new Error(`Replay ElementCount ${decoded.elementCount} exceeds requested color_count ${task.color_count}`);
        }
        if (replayCodes.has(result.replayCode)) {
          duplicateAttempts++;
          continue;
        }
        replayCodes.add(result.replayCode);
        const record: TileExplorerProductionRecord = {
          schema_version: 1,
          production_id: job.productionId,
          task_id: task.id,
          output_level_id: task.output_level_id,
          terrain_id: task.terrain_id,
          terrain_path: task.terrain_path,
          strategy: 'default',
          difficulty: task.difficulty,
          grade: task.difficulty,
          color_count: task.color_count,
          tile_type_weights: [...task.tile_type_weights],
          type_cycle: [...result.typeCycle],
          sequence_seed: result.sequenceSeed,
          placement_seed: result.placementSeed,
          attempt,
          replay_key: `1-2-3-${task.color_count}-`,
          replay_code: result.replayCode,
          level_hash: result.levelHash,
          element_count: task.color_count,
          replay_element_count: decoded.elementCount,
          generated_group_count: result.generatedGroupCount,
          view_layer_count: result.viewLayers.length,
          elapsed_ms: performance.now() - started,
        };
        acceptedAdded++;
        await sendToParent({ type: 'record', task_id: task.id, record });
      } catch (error) {
        generationErrors++;
        await sendToParent({
          type: 'attempt_error',
          task_id: task.id,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if ((attemptsCompleted - job.startAttempt) % 10 === 0) {
        await sendToParent({ type: 'progress', task_id: task.id, attempts_completed: attemptsCompleted, accepted_added: acceptedAdded, duplicate_attempts: duplicateAttempts, generation_errors: generationErrors });
      }
    }
    await sendToParent({ type: 'done', task_id: task.id, attempts_completed: attemptsCompleted, accepted_added: acceptedAdded, duplicate_attempts: duplicateAttempts, generation_errors: generationErrors });
  } catch (error) {
    await sendToParent({ type: 'fatal', task_id: task.id, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

function runJobs(
  jobs: WorkerJob[],
  concurrency: number,
  paths: { records: string; productionCsv: string; selectionCsv: string; status: string; timing: string },
  initialRecords: TileExplorerProductionRecord[],
  productionId: string,
): Promise<'complete' | 'partial' | 'error'> {
  const started = performance.now();
  const records = [...initialRecords];
  const initialByTask = new Map<string, number>();
  for (const record of initialRecords) initialByTask.set(record.task_id, (initialByTask.get(record.task_id) ?? 0) + 1);
  const status = Object.fromEntries(jobs.map(job => [job.task.id, {
    task_id: job.task.id,
    output_level_id: job.task.output_level_id,
    terrain_id: job.task.terrain_id,
    difficulty: job.task.difficulty,
    color_count: job.task.color_count,
    target: job.task.target_count,
    accepted: initialByTask.get(job.task.id) ?? 0,
    attempts_completed: job.startAttempt,
    duplicate_attempts: 0,
    generation_errors: 0,
    status: 'pending',
  } satisfies TaskStatus])) as Record<string, TaskStatus>;
  let next = 0;

  const saveStatus = () => writeJsonAtomic(paths.status, {
    schema_version: 1,
    production_id: productionId,
    updated_at: new Date().toISOString(),
    elapsed_ms: performance.now() - started,
    records: records.length,
    tasks: status,
  });

  const runOne = (job: WorkerJob): Promise<void> => new Promise(resolveJob => {
    const child = fork(fileURLToPath(import.meta.url), ['--worker'], {
      execArgv: process.execArgv.filter(arg => !['--eval', '-e', '--print', '-p'].includes(arg)),
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    activeChildren.add(child);
    let receivedDone = false;
    let fatalError = '';
    status[job.task.id].status = 'running';
    saveStatus();

    child.on('message', (message: WorkerMessage) => {
      const taskStatus = status[job.task.id];
      if (message.type === 'record') {
        records.push(message.record);
        appendJsonLine(paths.records, message.record);
        appendFileSync(paths.productionCsv, `${serializeTileExplorerProductionRecord(message.record)}\n`, 'utf8');
        appendFileSync(paths.selectionCsv, `${serializeReplaySelectionRow(productionRecordToReplaySelection(message.record))}\n`, 'utf8');
        taskStatus.accepted++;
      } else if (message.type === 'attempt_error') {
        appendJsonLine(paths.timing, { event: 'attempt_error', at: new Date().toISOString(), ...message });
      } else if (message.type === 'progress' || message.type === 'done') {
        taskStatus.attempts_completed = message.attempts_completed;
        taskStatus.duplicate_attempts = message.duplicate_attempts;
        taskStatus.generation_errors = message.generation_errors;
        if (message.type === 'done') {
          receivedDone = true;
          taskStatus.status = taskStatus.accepted >= taskStatus.target ? 'complete' : 'partial';
          appendJsonLine(paths.timing, { event: 'task_done', at: new Date().toISOString(), ...message, accepted_total: taskStatus.accepted });
        }
        saveStatus();
      } else if (message.type === 'fatal') {
        fatalError = message.error;
      }
    });
    child.on('error', error => { fatalError = error.message; });
    child.on('exit', code => {
      activeChildren.delete(child);
      if (!receivedDone || code !== 0) {
        status[job.task.id].status = 'error';
        status[job.task.id].error = fatalError || `worker exited with code ${code}`;
        appendJsonLine(paths.timing, { event: 'task_error', at: new Date().toISOString(), task_id: job.task.id, error: status[job.task.id].error });
      }
      saveStatus();
      resolveJob();
    });
    child.send(job);
  });

  saveStatus();
  appendJsonLine(paths.timing, { event: 'run_start', at: new Date().toISOString(), jobs: jobs.length, concurrency });
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (!stopRequested && next < jobs.length) await runOne(jobs[next++]);
  });
  return Promise.all(workers).then(() => {
    const states = Object.values(status).map(task => task.status);
    const finalStatus = states.some(state => state === 'error') ? 'error' : states.some(state => state === 'partial') ? 'partial' : 'complete';
    appendJsonLine(paths.timing, { event: 'run_done', at: new Date().toISOString(), status: finalStatus, records: records.length, elapsed_ms: performance.now() - started });
    saveStatus();
    return finalStatus;
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = resolve(options.inputPath);
  const input = readTileExplorerProductionInput(inputPath);
  const hash = inputHash(input);
  if (options.resume && !options.outputDir) throw new Error('--resume requires --output-dir');
  const outputDir = options.outputDir ? resolve(options.outputDir) : defaultOutputDir(input, hash);
  const paths = {
    manifest: join(outputDir, 'manifest.json'),
    inputSnapshot: join(outputDir, 'input.snapshot.json'),
    plan: join(outputDir, 'plan.json'),
    status: join(outputDir, 'status.json'),
    records: join(outputDir, 'records.jsonl'),
    productionCsv: join(outputDir, 'production.csv'),
    selectionCsv: join(outputDir, 'selection.csv'),
    timing: join(outputDir, 'timing.log.jsonl'),
  };
  if (!options.resume && options.outputDir && existsSync(paths.manifest)) {
    throw new Error(`Run directory already exists; use --resume or another --output-dir: ${outputDir}`);
  }
  mkdirSync(outputDir, { recursive: true });
  if (options.resume) {
    if (!existsSync(paths.inputSnapshot)) throw new Error(`Cannot resume without ${paths.inputSnapshot}`);
    const previousHash = inputHash(readTileExplorerProductionInput(paths.inputSnapshot));
    if (previousHash !== hash) throw new Error('Cannot resume because the production input changed');
  } else writeFileSync(paths.inputSnapshot, jsonText(input), 'utf8');

  const tasks = buildTileExplorerProductionTasks(input);
  const plan = {
    schema_version: 1,
    production_id: input.production_id,
    generated_at: new Date().toISOString(),
    input_file: inputPath,
    input_sha256: hash,
    output_directory: outputDir,
    strategy: 'default',
    grade_method: 'tile_explorer_difficulty',
    concurrency: options.concurrency,
    task_count: tasks.length,
    expected_replay_count: tasks.reduce((sum, task) => sum + task.target_count, 0),
    tasks,
  };
  writeJsonAtomic(paths.plan, plan);
  const previousManifest = options.resume && existsSync(paths.manifest) ? JSON.parse(readFileSync(paths.manifest, 'utf8')) as Record<string, unknown> : {};
  const createdAt = String(previousManifest.created_at ?? new Date().toISOString());
  const writeManifest = (status: 'planned' | 'running' | 'complete' | 'partial' | 'error') => writeJsonAtomic(paths.manifest, {
    schema_version: 1,
    run_id: outputDir.split(/[\\/]/).pop(),
    production_id: input.production_id,
    input_sha256: hash,
    status,
    created_at: createdAt,
    updated_at: new Date().toISOString(),
    artifacts: {
      input_snapshot: 'input.snapshot.json', plan: 'plan.json', status: 'status.json',
      records: 'records.jsonl', production_csv: 'production.csv', selection_csv: 'selection.csv',
      timing: 'timing.log.jsonl', replays: 'replays/',
    },
  });

  if (!options.run) {
    writeManifest('planned');
    console.log(`plan: tasks=${plan.task_count}, expected_replays=${plan.expected_replay_count}, output=${outputDir}`);
    return;
  }

  const existingRecords = options.resume ? readRecords(paths.records, input.production_id) : [];
  if (options.resume) writeDerivedCsv(paths.productionCsv, paths.selectionCsv, existingRecords);
  else {
    writeFileSync(paths.records, '', 'utf8');
    writeFileSync(paths.productionCsv, `\uFEFF${TILE_EXPLORER_PRODUCTION_CSV_HEADERS.join(',')}\n`, 'utf8');
    writeFileSync(paths.selectionCsv, `\uFEFF${REPLAY_SELECTION_HEADERS.join(',')}\n`, 'utf8');
    writeFileSync(paths.timing, '', 'utf8');
  }

  const byTask = new Map<string, TileExplorerProductionRecord[]>();
  for (const record of existingRecords) {
    const rows = byTask.get(record.task_id) ?? [];
    rows.push(record);
    byTask.set(record.task_id, rows);
  }
  const jobs = tasks.filter(task => (byTask.get(task.id)?.length ?? 0) < task.target_count).map(task => {
    const rows = byTask.get(task.id) ?? [];
    return {
      task,
      productionId: input.production_id,
      rootSeed: input.root_seed,
      startAttempt: rows.reduce((max, row) => Math.max(max, row.attempt + 1), 0),
      existingReplayCodes: rows.map(row => row.replay_code),
      acceptedBefore: rows.length,
    } satisfies WorkerJob;
  });
  writeManifest('running');
  if (!jobs.length) {
    writeManifest('complete');
    console.log(`nothing to run: ${existingRecords.length}/${plan.expected_replay_count} records already exist`);
    return;
  }
  console.log(`run: tasks=${jobs.length}, expected_replays=${plan.expected_replay_count}, concurrency=${options.concurrency}, output=${outputDir}`);
  const finalStatus = await runJobs(jobs, options.concurrency, paths, existingRecords, input.production_id);
  const finalRecords = readRecords(paths.records, input.production_id);
  writeDerivedCsv(paths.productionCsv, paths.selectionCsv, finalRecords);
  let verifiedStatus = finalStatus;
  try {
    const summary = checkReplaySelections(paths.selectionCsv);
    if (summary.rowsRead !== finalRecords.length) throw new Error(`selection rows ${summary.rowsRead} differ from records ${finalRecords.length}`);
  } catch (error) {
    verifiedStatus = 'error';
    appendJsonLine(paths.timing, { event: 'selection_validation_error', at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
  }
  writeManifest(verifiedStatus);
  console.log(`run ${verifiedStatus}: records=${finalRecords.length}/${plan.expected_replay_count}, selection=${paths.selectionCsv}`);
  if (verifiedStatus === 'error') process.exitCode = 1;
}

if (process.argv.includes('--worker')) {
  process.once('message', (job: WorkerJob) => void runWorker(job));
} else {
  const requestStop = () => {
    stopRequested = true;
    process.exitCode = 130;
    for (const child of activeChildren) child.kill('SIGTERM');
  };
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
