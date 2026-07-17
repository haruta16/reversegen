/**
 * Reproducible Rust-vs-TypeScript benchmark for one multi-variant simulate stage.
 *
 * Usage:
 *   npm run strategy:rust:build
 *   node --import tsx tools/benchmark-rust-strategy-sim.ts
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  computeDependencyDepth,
  generateBoardLayerClosure,
  getAllTiles,
  loadTerrainFromFile,
  LogLevel,
  setLogLevel,
} from '../src/index.js';
import { OfflineGame } from '../src/solver/offline-game.js';
import { solvePlayerMistakeBatch } from '../src/solver/index.js';
import { OfflineTile } from '../src/solver/types.js';
import { mulberry32 } from '../src/random-utils.js';

setLogLevel(LogLevel.Silent);

const ROOT = resolve(import.meta.dirname, '..');
const LEVELS_DIR = resolve(ROOT, '../TileMatchShell/Tools/Config/Json/Levels');
const RUST_BINARY = resolve(ROOT, 'rust/strategy-sim/target/release/reversegen-strategy-sim');
const LEVELS = ['100075', '100074'];
const RATES = [0.01, 0.05, 0.15];
const RUNS = 200;

interface RustVariantOutput {
  id: string;
  summary: {
    wins: number;
    losses: number;
    total_win_steps: number;
    total_loss_steps: number;
  };
  elapsed_ms: number;
}

interface RustOutput {
  variants: RustVariantOutput[];
  elapsed_ms: number;
}

function totalSteps(avg: number, count: number): number {
  return Math.round(avg * count);
}

const workDir = mkdtempSync(join(tmpdir(), 'reversegen-rust-bench-'));
let tsTotal = 0;
let rustKernelTotal = 0;
let rustWallTotal = 0;

for (const [levelIndex, levelId] of LEVELS.entries()) {
  const terrain = loadTerrainFromFile(join(LEVELS_DIR, `${levelId}.json`));
  const terrainTiles = getAllTiles(terrain);
  const tileMap = new Map(terrainTiles.map(tile => [tile.id, tile]));
  const depth = computeDependencyDepth(terrainTiles.filter(tile => !tile.isConst), tileMap);
  const depthCount = Math.max(...depth.values(), 1);
  const colorCount = Math.floor(0.6 * Math.floor(terrainTiles.filter(tile => !tile.isConst).length / 3));
  const board = generateBoardLayerClosure({
    terrain,
    closeRates: Array.from({ length: Math.max(0, depthCount - 1) }, () => 0.5),
    colorCount,
    spreadParam: 0.5,
    debtPersistenceWeight: 0.5,
    colorAllocationMode: 'balanced',
    rng: mulberry32(40_000 + levelIndex),
  });
  const colors = new Map(board.assignments);
  const offlineTiles = terrainTiles.map(tile => new OfflineTile(tile, colors.get(tile.id) ?? tile.constElementValue ?? 0));
  const variants = RATES.map((rate, rateIndex) => ({
    id: `mistake_${String(Math.round(rate * 100)).padStart(2, '0')}`,
    config: { mistake_rate: rate },
    base_seed: 10_021 + levelIndex * 10_000 + rateIndex * 1_000,
    collect_trace: false,
  }));
  const request = {
    protocol_version: 2,
    request_id: `benchmark:${levelId}`,
    policy: { id: 'mistake_player', version: 1 },
    variants,
    board: {
      tiles: terrainTiles.map(tile => ({
        id: tile.id,
        dependencies: tile.dependencies,
        element: colors.get(tile.id) ?? tile.constElementValue ?? 0,
        pos_x: tile.posX,
        pos_y: tile.posY,
        pile: 'desk',
      })),
    },
    execution: { runs: RUNS, max_steps: 2000 },
  };
  const inputPath = join(workDir, `${levelId}.json`);
  writeFileSync(inputPath, JSON.stringify(request));

  const tsStart = performance.now();
  const tsResults = variants.map(variant => solvePlayerMistakeBatch(
    new OfflineGame(offlineTiles),
    RUNS,
    variant.base_seed,
    { mistakeRate: variant.config.mistake_rate, collectTrace: false },
  ));
  const tsElapsed = performance.now() - tsStart;

  const rustStart = performance.now();
  const stdout = execFileSync(RUST_BINARY, [inputPath], { encoding: 'utf8' });
  const rustWall = performance.now() - rustStart;
  const rust = JSON.parse(stdout) as RustOutput;
  for (const [index, variant] of rust.variants.entries()) {
    const ts = tsResults[index];
    const same = variant.summary.wins === ts.wins
      && variant.summary.losses === ts.losses
      && variant.summary.total_win_steps === totalSteps(ts.avgStepsOnWin, ts.wins)
      && variant.summary.total_loss_steps === totalSteps(ts.avgStepsOnLoss, ts.losses);
    if (!same) throw new Error(`result mismatch: level=${levelId}, variant=${variant.id}`);
  }

  tsTotal += tsElapsed;
  rustKernelTotal += rust.elapsed_ms;
  rustWallTotal += rustWall;
  console.log(JSON.stringify({
    level: levelId,
    variants: variants.length,
    simulations: variants.length * RUNS,
    ts_ms: Number(tsElapsed.toFixed(1)),
    rust_kernel_ms: Number(rust.elapsed_ms.toFixed(1)),
    rust_process_ms: Number(rustWall.toFixed(1)),
    process_speedup: Number((tsElapsed / rustWall).toFixed(2)),
    parity: true,
  }));
}

console.log(JSON.stringify({
  strategy_stage: 'mistake_player@1 multi-variant sample',
  levels: LEVELS,
  rates: RATES,
  simulations: LEVELS.length * RATES.length * RUNS,
  ts_ms: Number(tsTotal.toFixed(1)),
  rust_kernel_ms: Number(rustKernelTotal.toFixed(1)),
  rust_process_ms: Number(rustWallTotal.toFixed(1)),
  kernel_speedup: Number((tsTotal / rustKernelTotal).toFixed(2)),
  process_speedup: Number((tsTotal / rustWallTotal).toFixed(2)),
  work_dir: workDir,
}));
