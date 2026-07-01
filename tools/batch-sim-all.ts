#!/usr/bin/env npx tsx
/**
 * Multi-strategy batch simulation for all replaykeys.
 *
 * Runs every bot strategy against each level and records win rates to CSV.
 * Also sweeps mistakeRate 0.01–0.15 for the mistake-prone player.
 *
 * Usage:
 *   npx tsx tools/batch-sim-all.ts                     # all strategies + mistake sweep
 *   npx tsx tools/batch-sim-all.ts --quick             # 3 sims, first 5 levels only
 *   npx tsx tools/batch-sim-all.ts --strategy player   # only the named strategy
 *   npx tsx tools/batch-sim-all.ts --mistake-only      # only the mistake sweep
 *   npx tsx tools/batch-sim-all.ts --resume            # resume from checkpoint
 *   npx tsx tools/batch-sim-all.ts --limit 10          # process only first N levels
 *   npx tsx tools/batch-sim-all.ts --output 失误率扫描  # write to output/失误率扫描/
 */

import {
  readFileSync, writeFileSync, appendFileSync, existsSync,
  readdirSync, mkdirSync,
} from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadTerrainFromFile,
  getAllTiles,
  decodeFromString,
  getCanonicalTileOrder,
  setLogLevel,
  LogLevel,
} from '../src/index.js';
import { createGame } from '../src/solver/offline-game.js';
import { solvePlayerBatch } from '../src/solver/solver-player.js';
import { solvePlayerMistakeBatch } from '../src/solver/solver-player-mistake.js';
import { solvePlayerRiskyBatch } from '../src/solver/solver-player-risky.js';
import { solvePlayerCostCapBatch } from '../src/solver/solver-player-costcap.js';
import { solveRandomBatch } from '../src/solver/solver-random.js';
import { solveGreedy } from '../src/solver/solver-greedy.js';
import type { ReplayData, TerrainTile } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ═══ Paths ═══
const TERRAIN_DIRS = [
  '/Users/wenhaowang/WorkSpace/levels_json/正式关卡',
  '/Users/wenhaowang/WorkSpace/levels_json/关卡备份',
  '/Users/wenhaowang/WorkSpace/levels_json/关卡调整',
];
const BASE_OUTPUT = resolve(__dirname, '../output');
const CSV_INPUT = join(BASE_OUTPUT, 'sim_results.csv');

// ═══ Config ═══
let SIM_COUNT = 100;
const MISTAKE_RATES = Array.from({ length: 15 }, (_, i) => (i + 1) * 0.01); // 0.01..0.15

const args = process.argv.slice(2);
const outputArg = args.includes('--output')
  ? args[args.indexOf('--output') + 1]
  : null;
const OUTPUT_DIR = outputArg ? join(BASE_OUTPUT, outputArg) : BASE_OUTPUT;
const CHECKPOINT_FILE = join(OUTPUT_DIR, 'checkpoint.json');
const isQuick = args.includes('--quick');
const isResume = args.includes('--resume');
const mistakeOnly = args.includes('--mistake-only');
const strategyFilter = args.includes('--strategy')
  ? args[args.indexOf('--strategy') + 1]
  : null;
const limitArg = args.includes('--limit')
  ? parseInt(args[args.indexOf('--limit') + 1], 10)
  : Infinity;

if (isQuick) {
  SIM_COUNT = 3;
  console.log('⚠ Quick mode: 3 sims, first 5 levels only');
}

// ═══ Types ═══
interface CsvRow {
  replayKey: string;
  terrainId: string;
  starts: number;
  clears: number;
  onlineWinRate: number;
  replayCode: string;
}

interface SimResult {
  replayKey: string;
  terrainId: string;
  onlineWinRate: number;
  wins: number;
  losses: number;
  winRate: number;
  avgSteps: number;
  elapsedMs: number;
  totalTiles: number;
}

// ═══ Step 1: Read input CSV ═══
function parseCSV(): CsvRow[] {
  console.log(`Reading input: ${CSV_INPUT}`);
  const raw = readFileSync(CSV_INPUT, 'utf-8');
  const lines = raw.trim().split('\n');

  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.replace(/"/g, '').split(',');
    if (parts.length < 6) continue;
    rows.push({
      replayKey: parts[0].trim(),
      terrainId: parts[1].trim(),
      starts: parseInt(parts[2], 10) || 0,
      clears: parseInt(parts[3], 10) || 0,
      onlineWinRate: parseFloat(parts[4]) || 0,
      replayCode: parts[5].trim(),
    });
  }
  console.log(`  Parsed ${rows.length} entries`);
  return rows;
}

// ═══ Step 2: Build terrainId → path map ═══
function buildTerrainMap(): Map<string, string> {
  console.log('Scanning terrain directories...');
  const map = new Map<string, string>();
  for (const dir of TERRAIN_DIRS) {
    if (!existsSync(dir)) {
      console.warn(`  ⚠ Directory not found: ${dir}`);
      continue;
    }
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const id = f.replace('.json', '');
      if (!map.has(id)) {
        map.set(id, join(dir, f));
      }
    }
  }
  console.log(`  ${map.size} terrain files found`);
  return map;
}

// ═══ Step 3: Decode replay ═══
interface DecodedReplay {
  replayData: ReplayData;
  elementValues: Map<number, number>;
  initialDock: { tileId: number; element: number }[];
  eliminatedTileIds: Set<number>;
}

function decodeReplay(replayCode: string, terrainTiles: TerrainTile[]): DecodedReplay | null {
  const replayData = decodeFromString(replayCode);
  if (!replayData) return null;

  const ordered = getCanonicalTileOrder(terrainTiles);
  const elementValues = new Map<number, number>();
  const initialDock: { tileId: number; element: number }[] = [];
  const eliminatedTileIds = new Set<number>();

  for (let i = 0; i < ordered.length && i < replayData.instanceArray.length; i++) {
    const tile = ordered[i];
    const byte = replayData.instanceArray[i];
    const state = (byte >> 6) & 0x3;
    const elementIdx = byte & 0x3f;
    const elementValue = elementIdx + 1;

    elementValues.set(tile.id, elementValue);

    if (state === 1) {
      eliminatedTileIds.add(tile.id);
    } else if (state === 2) {
      initialDock.push({ tileId: tile.id, element: elementValue });
    }
  }

  for (const de of replayData.dockEntries) {
    if (de.tileId >= 0 && de.tileId < ordered.length) {
      const tile = ordered[de.tileId];
      if (!initialDock.some(d => d.tileId === tile.id)) {
        initialDock.push({ tileId: tile.id, element: de.element });
      }
    }
  }

  return { replayData, elementValues, initialDock, eliminatedTileIds };
}

// ═══ Step 4: Run strategies ═══
const terrainCache = new Map<string, TerrainTile[]>();

function getTerrainTiles(terrainId: string, terrainMap: Map<string, string>): TerrainTile[] | null {
  if (terrainCache.has(terrainId)) return terrainCache.get(terrainId)!;

  const path = terrainMap.get(terrainId);
  if (!path) return null;

  try {
    const terrain = loadTerrainFromFile(path);
    const tiles = getAllTiles(terrain);
    terrainCache.set(terrainId, tiles);
    return tiles;
  } catch (e) {
    console.warn(`   ⚠ Failed to load terrain ${terrainId}: ${e}`);
    return null;
  }
}

function simResult(
  row: CsvRow,
  wins: number,
  total: number,
  avgSteps: number,
  elapsedMs: number,
  totalTiles: number,
): SimResult {
  return {
    replayKey: row.replayKey,
    terrainId: row.terrainId,
    onlineWinRate: row.onlineWinRate,
    wins,
    losses: total - wins,
    winRate: total > 0 ? wins / total : 0,
    avgSteps,
    elapsedMs,
    totalTiles,
  };
}

// ═══ CSV helpers ═══
function csvEscape(val: unknown): string {
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const BASE_HEADER = ['关卡牌局代码', '地形编号', '在线胜率(%)', '模拟胜利', '模拟失败', '模拟胜率(%)', '模拟平均步数', '耗时ms', '地形总牌数'];

function resultToRow(r: SimResult): string {
  return [
    csvEscape(r.replayKey),
    csvEscape(r.terrainId),
    r.onlineWinRate.toFixed(2),
    r.wins,
    r.losses,
    (r.winRate * 100).toFixed(2),
    r.avgSteps.toFixed(1),
    Math.round(r.elapsedMs),
    r.totalTiles,
  ].join(',');
}

// ═══ Output file management ═══
function outputPath(name: string): string {
  return join(OUTPUT_DIR, `${name}.csv`);
}

function initOutput(name: string): void {
  const p = outputPath(name);
  if (!existsSync(p)) {
    writeFileSync(p, BASE_HEADER.join(',') + '\n', 'utf-8');
  }
}

function appendResult(name: string, r: SimResult): void {
  appendFileSync(outputPath(name), resultToRow(r) + '\n', 'utf-8');
}

// ═══ Mistake sweep output ═══
const MISTAKE_OUTPUT = join(OUTPUT_DIR, '原始数据.csv');

function initMistakeOutput(): void {
  if (!existsSync(MISTAKE_OUTPUT)) {
    const header = ['关卡牌局代码', '地形编号', '在线胜率(%)', ...MISTAKE_RATES.map(r => `mistake_${r.toFixed(2)}`)].join(',');
    writeFileSync(MISTAKE_OUTPUT, header + '\n', 'utf-8');
  }
}

function appendMistakeRow(row: CsvRow, winRates: number[]): void {
  const cols = [
    csvEscape(row.replayKey),
    csvEscape(row.terrainId),
    row.onlineWinRate.toFixed(2),
    ...winRates.map(w => (w * 100).toFixed(2)),
  ];
  appendFileSync(MISTAKE_OUTPUT, cols.join(',') + '\n', 'utf-8');
}

// ═══ Main ═══
async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  Multi-Strategy Batch Simulation');
  console.log(`  Sims per level: ${SIM_COUNT}`);
  if (strategyFilter) console.log(`  Strategy filter: ${strategyFilter}`);
  if (mistakeOnly) console.log('  Mode: mistake sweep only');
  console.log('═══════════════════════════════════════════\n');

  setLogLevel(LogLevel.Silent);

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  // 1. Read input
  const rows = parseCSV();

  // 2. Build terrain map
  const terrainMap = buildTerrainMap();

  // 3. Filter valid rows (have terrain file)
  const validRows: CsvRow[] = [];
  const skipped: string[] = [];
  for (const row of rows) {
    if (terrainMap.has(row.terrainId)) {
      validRows.push(row);
    } else {
      skipped.push(row.terrainId);
    }
  }
  const missingTerrains = [...new Set(skipped)];
  console.log(`\nValid entries: ${validRows.length}`);
  console.log(`Missing terrains: ${missingTerrains.length} (${missingTerrains.join(', ')})`);
  console.log(`Skipped entries: ${skipped.length}\n`);

  // 4. Apply limit
  const toProcess = validRows.slice(0, isQuick ? 5 : limitArg);
  console.log(`Processing ${toProcess.length} levels\n`);

  // 5. Init output files
  const strategies = ['random', 'greedy', 'player', 'risky', 'costcap'];
  const strategyNames: Record<string, string> = {
    random: '随机策略', greedy: '贪心策略', player: '标准玩家',
    risky: '激进玩家', costcap: '成本上限',
  };
  if (!mistakeOnly) {
    for (const s of strategies) initOutput(strategyNames[s] || s);
  }
  initMistakeOutput();

  // 6. Resume checkpoint
  let startIdx = 0;
  if (isResume && existsSync(CHECKPOINT_FILE)) {
    const cp = JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf-8'));
    startIdx = cp.nextIdx || 0;
    console.log(`Resuming from index ${startIdx}\n`);
  }

  // 7. Run simulations
  const startTime = performance.now();
  let processed = 0;

  for (let i = startIdx; i < toProcess.length; i++) {
    const row = toProcess[i];
    const pct = ((processed / (toProcess.length - startIdx)) * 100).toFixed(1);
    const elapsed = (performance.now() - startTime) / 1000;
    const rate = processed > 0 ? elapsed / processed : 0;
    const eta = rate > 0 ? (toProcess.length - startIdx - processed) * rate : 0;

    console.log(`[${i + 1}/${toProcess.length}] ${pct}% | ${row.replayKey} (terrain ${row.terrainId}) | ETA ${eta.toFixed(0)}s`);

    // Load terrain & decode
    const terrainTiles = getTerrainTiles(row.terrainId, terrainMap);
    if (!terrainTiles) {
      console.log('  ❌ Terrain not found');
      processed++;
      continue;
    }

    const decoded = decodeReplay(row.replayCode, terrainTiles);
    if (!decoded) {
      console.log('  ❌ Replay decode failed');
      processed++;
      continue;
    }

    const game = createGame({
      terrainTiles,
      elementValues: decoded.elementValues,
      initialDock: decoded.initialDock,
      eliminatedTileIds: decoded.eliminatedTileIds,
    });

    const totalTiles = terrainTiles.length;
    const parts: string[] = [];

    // ── Regular strategies ──
    if (!mistakeOnly) {
      // Random
      if (!strategyFilter || strategyFilter === 'random') {
        const t0 = performance.now();
        const r = solveRandomBatch(game, SIM_COUNT);
        const ms = performance.now() - t0;
        appendResult('随机策略', simResult(row, r.wins, SIM_COUNT, r.avgStepsOnWin, ms, totalTiles));
        parts.push(`R:${(r.winRate * 100).toFixed(0)}%`);
      }

      // Greedy (deterministic, single run)
      if (!strategyFilter || strategyFilter === 'greedy') {
        const t0 = performance.now();
        const g = solveGreedy(game);
        const ms = performance.now() - t0;
        appendResult('贪心策略', simResult(row, g.win ? 1 : 0, 1, g.stepCount, ms, totalTiles));
        parts.push(`G:${g.win ? 'W' : 'L'}`);
      }

      // Player (standard)
      if (!strategyFilter || strategyFilter === 'player') {
        const t0 = performance.now();
        const p = solvePlayerBatch(game, SIM_COUNT);
        const ms = performance.now() - t0;
        appendResult('标准玩家', simResult(row, p.wins, SIM_COUNT, p.avgStepsOnWin, ms, totalTiles));
        parts.push(`P:${(p.winRate * 100).toFixed(0)}%`);
      }

      // Risky
      if (!strategyFilter || strategyFilter === 'risky') {
        const t0 = performance.now();
        const r = solvePlayerRiskyBatch(game, SIM_COUNT, 0, { riskThreshold: 3 });
        const ms = performance.now() - t0;
        appendResult('激进玩家', simResult(row, r.wins, SIM_COUNT, r.avgStepsOnWin, ms, totalTiles));
        parts.push(`Rk:${(r.winRate * 100).toFixed(0)}%`);
      }

      // CostCap
      if (!strategyFilter || strategyFilter === 'costcap') {
        const t0 = performance.now();
        const c = solvePlayerCostCapBatch(game, SIM_COUNT, 0, { maxCost: 3 });
        const ms = performance.now() - t0;
        appendResult('成本上限', simResult(row, c.wins, SIM_COUNT, c.avgStepsOnWin, ms, totalTiles));
        parts.push(`Cc:${(c.winRate * 100).toFixed(0)}%`);
      }
    }

    // ── Mistake sweep ──
    const mistakeWinRates: number[] = [];
    for (const mistakeRate of MISTAKE_RATES) {
      const m = solvePlayerMistakeBatch(game, SIM_COUNT, 0, { mistakeRate });
      mistakeWinRates.push(m.winRate);
    }
    appendMistakeRow(row, mistakeWinRates);
    parts.push(`M0.01:${(mistakeWinRates[0] * 100).toFixed(0)}% M0.15:${(mistakeWinRates[14] * 100).toFixed(0)}%`);

    console.log(`  ✅ Online:${row.onlineWinRate.toFixed(1)}% | ${parts.join(' | ')}`);

    processed++;

    // Checkpoint every 5
    if (processed % 5 === 0) {
      writeFileSync(CHECKPOINT_FILE, JSON.stringify({
        nextIdx: i + 1,
        completedCount: processed,
        timestamp: new Date().toISOString(),
      }), 'utf-8');
    }
  }

  // 8. Summary
  const totalElapsed = ((performance.now() - startTime) / 1000).toFixed(0);
  console.log(`\n═══════════════════════════════════════════`);
  console.log(`  Complete!`);
  console.log(`  Processed: ${processed} levels`);
  console.log(`  Total time: ${totalElapsed}s`);
  console.log(`  Output dir: ${OUTPUT_DIR}/`);
  console.log(`═══════════════════════════════════════════`);

  // Final checkpoint
  writeFileSync(CHECKPOINT_FILE, JSON.stringify({
    done: true,
    completedCount: processed,
    timestamp: new Date().toISOString(),
  }), 'utf-8');
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
