#!/usr/bin/env npx tsx
import { readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { availableParallelism } from 'node:os';

const INPUT = 'output/原始数据.csv';
const OUTPUT = 'output/原始数据_with_metrics.csv';
const SIM_RUNS = 50;
const CONCURRENCY = Math.max(1, Math.min(availableParallelism() - 1, 10));

interface Job { code: string; lid: string; replayCode: string; }
interface JobResult {
  code: string; lid: string;
  simPass: number; simWins: number;
  forcedPickOnWin: number; starvationOnWin: number;
  stepsOnLoss: number; forcedPickOnLoss: number; starvationOnLoss: number;
  error?: string;
}
type WorkerMsg = { type: 'done'; result: JobResult } | { type: 'error'; code: string; lid: string; error: string };

// ══════════════════════════════════════════════════════════════════
// Worker process
// ══════════════════════════════════════════════════════════════════
if (process.argv.includes('--worker')) {
  process.on('message', async (msg: any) => {
    try {
      const { OfflineGame } = await import('../src/solver/offline-game.js');
      const { OfflineTile } = await import('../src/solver/types.js');
      const { solvePlayerMistakeBatch } = await import('../src/solver/solver-player-mistake.js');
      const { decodeFromString, getCanonicalTileOrder } = await import('../src/replay-serializer.js');
      const { loadTerrainFromFile, getAllTiles, LogLevel, setLogLevel } = await import('../src/index.js');
      setLogLevel(LogLevel.Silent);
      const LEVELS_DIR = '/Users/wenhaowang/WorkSpace/TileMatchShell/Tools/Config/Json/Levels';

      const rd = decodeFromString(msg.replayCode);
      if (!rd) throw new Error('decode failed');
      const terrain = loadTerrainFromFile(`${LEVELS_DIR}/${msg.lid}.json`);
      const ordered = getCanonicalTileOrder(getAllTiles(terrain));
      const tiles: Array<InstanceType<typeof OfflineTile>> = [];
      for (let i = 0; i < ordered.length && i < rd.instanceArray.length; i++) {
        const t = ordered[i];
        tiles.push(new OfflineTile({ id: t.id, layer: t.layer, dependencies: t.dependencies, isConst: t.isConst, constElementValue: t.constElementValue, posX: t.posX, posY: t.posY }, (rd.instanceArray[i] & 0x3F) + 1));
      }
      const game = new OfflineGame(tiles);
      const r = solvePlayerMistakeBatch(game, msg.simRuns, 100, { mistakeRate: 0.05 });

      const result: JobResult = {
        code: msg.code, lid: msg.lid,
        simPass: r.winRate, simWins: r.wins,
        forcedPickOnWin: r.forcedPickOnWin, starvationOnWin: r.starvationOnWin,
        stepsOnLoss: r.stepsOnLoss, forcedPickOnLoss: r.forcedPickOnLoss, starvationOnLoss: r.starvationOnLoss,
      };
      if (process.send) process.send({ type: 'done', result } as WorkerMsg);
      process.exit(0);
    } catch (e) {
      if (process.send) process.send({ type: 'error', code: msg?.code ?? '?', lid: msg?.lid ?? '?', error: e instanceof Error ? e.message : String(e) } as WorkerMsg);
      process.exit(1);
    }
  });
  // Keep alive
  setInterval(() => {}, 60000);
} else {
  // ══════════════════════════════════════════════════════════════
  // Master process
  // ══════════════════════════════════════════════════════════════
  main().catch(err => { console.error(err); process.exit(1); });
}

async function main() {
  // Parse input
  const text = readFileSync(INPUT, 'utf8');
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = source.trim().split('\n');
  const header = lines[0];
  const jobs: Job[] = [];
  const codeToLine = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const lid = c[1], replayCode = c[5];
    if (lid && replayCode) { jobs.push({ code: c[0], lid, replayCode }); codeToLine.set(c[0], lines[i]); }
  }
  console.log(`待处理: ${jobs.length} 条, 并行: ${CONCURRENCY}`);

  // Init output
  mkdirSync(dirname(resolve(OUTPUT)), { recursive: true });
  writeFileSync(OUTPUT, `﻿${header},simPass,simWins,forcedPickOnWin,starvationOnWin,stepsOnLoss,forcedPickOnLoss,starvationOnLoss\n`, 'utf8');

  // Worker pool
  const script = fileURLToPath(import.meta.url);
  let next = 0, done = 0;

  function runOne(job: Job): Promise<JobResult> {
    return new Promise((res, rej) => {
      const child = fork(script, ['--worker'], {
        execArgv: process.execArgv.filter(a => !['--eval', '-e', '--print', '-p'].includes(a)),
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      child.on('message', (msg: WorkerMsg) => {
        if (msg.type === 'done') { res(msg.result); }
        else if (msg.type === 'error') { rej(new Error(`${msg.code} ${msg.lid}: ${msg.error}`)); }
      });
      child.on('error', rej);
      child.on('exit', code => { if (code !== 0) rej(new Error(`exit ${code}`)); });
      child.send({ code: job.code, lid: job.lid, replayCode: job.replayCode, simRuns: SIM_RUNS });
    });
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        const r = await runOne(job);
        const orig = codeToLine.get(job.code) || '';
        appendFileSync(OUTPUT, `${orig},${r.simPass},${r.simWins},${r.forcedPickOnWin},${r.starvationOnWin},${r.stepsOnLoss},${r.forcedPickOnLoss},${r.starvationOnLoss}\n`, 'utf8');
      } catch (e) {
        const orig = codeToLine.get(job.code) || '';
        appendFileSync(OUTPUT, `${orig},ERR,,,,,,,\n`, 'utf8');
      }
      done++;
      if (done % 20 === 0) {
        const pct = Math.round(done / jobs.length * 100);
        process.stdout.write(`\r\x1b[K${done}/${jobs.length} (${pct}%)`);
      }
    }
  });

  process.stdout.write(`0/${jobs.length} (0%)`);
  await Promise.all(workers);
  process.stdout.write(`\r\x1b[K${done}/${jobs.length} (100%)\n`);
  console.log(`完成: ${OUTPUT}`);
}
