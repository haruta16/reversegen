#!/usr/bin/env npx tsx
/**
 * Batch player simulation for all replaykeys.
 *
 * Reads the online win rate CSV, finds replaycodes from terrain JSONs,
 * runs 200 player simulations per replaykey, and writes results to CSV.
 *
 * Usage:
 *   npx tsx tools/batch-sim.ts              # full run (200 sims)
 *   npx tsx tools/batch-sim.ts --quick      # quick test (3 sims)
 *   npx tsx tools/batch-sim.ts --resume     # resume from last checkpoint
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
import type { ReplayData, TerrainTile } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ═══ Paths ═══
const REPLAYS_DIR =
  '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Replays';
const LEVELS_DIR =
  '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
const CSV_INPUT =
  '/Users/haruta16/baidusync/Obsidiannote/TM/数据分析/全部replaykey胜率.csv';
const OUTPUT_DIR = resolve(__dirname, '../output');
const CSV_OUTPUT = join(OUTPUT_DIR, 'sim_results.csv');
const MAP_FILE = join(OUTPUT_DIR, 'replaykey_code_map.json');
const CHECKPOINT_FILE = join(OUTPUT_DIR, 'checkpoint.json');

// ═══ Config ═══
let SIM_COUNT = 200;
let SAVE_INTERVAL = 5;

const args = process.argv.slice(2);
const isQuick = args.includes('--quick');
const isResume = args.includes('--resume');
if (isQuick) {
  SIM_COUNT = 3;
  SAVE_INTERVAL = 1;
  console.log('⚠ Quick mode: only 3 simulations per replaykey');
}

// ═══ Types ═══
interface CsvRow {
  replayKey: string;
  terrainId: string;
  starts: number;
  clears: number;
  onlineWinRate: number; // 0-100
}

interface SimRow extends CsvRow {
  replayCode: string;
  simWins: number;
  simLosses: number;
  simWinRate: number; // 0-1
  simAvgSteps: number;
  elapsedMs: number;
  totalTiles: number;
}

// ═══ Step 1: Read CSV ═══
function parseCSV(): CsvRow[] {
  console.log(`📖 Reading CSV: ${CSV_INPUT}`);
  const raw = readFileSync(CSV_INPUT, 'utf-8');
  const lines = raw.trim().split('\n');

  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) { // skip header
    const line = lines[i].trim();
    if (!line) continue;
    // Format: "关卡牌局代码",地形编号,开始次数,净过关次数,净胜率(%)
    // Values may be quoted with "
    const parts = line.replace(/"/g, '').split(',');
    if (parts.length < 5) continue;

    rows.push({
      replayKey: parts[0].trim(),
      terrainId: parts[1].trim(),
      starts: parseInt(parts[2], 10) || 0,
      clears: parseInt(parts[3], 10) || 0,
      onlineWinRate: parseFloat(parts[4]) || 0,
    });
  }

  console.log(`   Parsed ${rows.length} entries`);
  return rows;
}

// ═══ Step 2: Build replaykey → replaycode map ═══
interface KeyCodeEntry {
  replayKey: string;
  replayCode: string;
  terrainId: string;
}

function buildReplayKeyMap(): Map<string, KeyCodeEntry> {
  // Check cache first
  if (existsSync(MAP_FILE)) {
    console.log(`📋 Loading cached replaykey map from ${MAP_FILE}`);
    const cached = JSON.parse(readFileSync(MAP_FILE, 'utf-8'));
    const map = new Map<string, KeyCodeEntry>();
    for (const [k, v] of Object.entries(cached)) {
      map.set(k, v as KeyCodeEntry);
    }
    console.log(`   ${map.size} entries loaded from cache`);
    return map;
  }

  console.log(`🔍 Building replaykey → replaycode map from ${REPLAYS_DIR}...`);
  const map = new Map<string, KeyCodeEntry>();
  const files = readdirSync(REPLAYS_DIR).filter(f => f.endsWith('.json'));

  let totalEntries = 0;
  for (const file of files) {
    const terrainId = file.replace('.json', '');
    try {
      const raw = readFileSync(join(REPLAYS_DIR, file), 'utf-8');
      const data = JSON.parse(raw);
      const dict = data.replayInfoDict;
      if (!dict) continue;

      for (const [, entries] of Object.entries(dict) as [string, any[]][]) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (entry.ReplayKey && entry.ReplayCode) {
            map.set(entry.ReplayKey, {
              replayKey: entry.ReplayKey,
              replayCode: entry.ReplayCode,
              terrainId,
            });
            totalEntries++;
          }
        }
      }
    } catch (e) {
      console.warn(`   ⚠ Failed to parse ${file}: ${e}`);
    }
  }

  // Cache to file
  const cacheObj: Record<string, KeyCodeEntry> = {};
  for (const [k, v] of map) cacheObj[k] = v;
  writeFileSync(MAP_FILE, JSON.stringify(cacheObj, null, 2), 'utf-8');

  console.log(`   ${totalEntries} entries from ${files.length} files, cached to ${MAP_FILE}`);
  return map;
}

// ═══ Step 3: Decode replaycode into game-ready data ═══
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
    const elementIdx = byte & 0x3F;
    const elementValue = elementIdx + 1; // 1..K

    elementValues.set(tile.id, elementValue);

    if (state === 1) {
      // Eliminated
      eliminatedTileIds.add(tile.id);
    } else if (state === 2) {
      // InDock
      initialDock.push({ tileId: tile.id, element: elementValue });
    }
  }

  // Also add dock entries from replay data (may include additional dock state)
  for (const de of replayData.dockEntries) {
    // dockEntries use canonical index, map to tile ID
    if (de.tileId >= 0 && de.tileId < ordered.length) {
      const tile = ordered[de.tileId];
      // Only add if not already present
      if (!initialDock.some(d => d.tileId === tile.id)) {
        initialDock.push({ tileId: tile.id, element: de.element });
      }
    }
  }

  return { replayData, elementValues, initialDock, eliminatedTileIds };
}

// ═══ Step 4: Run simulations ═══

// Cache for loaded terrains
const terrainCache = new Map<string, TerrainTile[]>();

function getTerrainTiles(terrainId: string): TerrainTile[] | null {
  if (terrainCache.has(terrainId)) return terrainCache.get(terrainId)!;

  const path = join(LEVELS_DIR, `${terrainId}.json`);
  if (!existsSync(path)) return null;

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

function runSimulation(row: CsvRow, keyEntry: KeyCodeEntry): SimRow | null {
  const { replayKey } = row;
  const { replayCode, terrainId } = keyEntry;

  // Load terrain
  const terrainTiles = getTerrainTiles(terrainId);
  if (!terrainTiles) {
    console.warn(`   ⚠ Terrain ${terrainId} not found for ${replayKey}`);
    return null;
  }

  // Decode replay
  const decoded = decodeReplay(replayCode, terrainTiles);
  if (!decoded) {
    console.warn(`   ⚠ Failed to decode replay for ${replayKey}`);
    return null;
  }

  // Create game
  const game = createGame({
    terrainTiles,
    elementValues: decoded.elementValues,
    initialDock: decoded.initialDock,
    eliminatedTileIds: decoded.eliminatedTileIds,
  });

  // Run batch simulation
  const result = solvePlayerBatch(game, SIM_COUNT);

  return {
    ...row,
    replayCode,
    simWins: result.wins,
    simLosses: result.losses,
    simWinRate: result.winRate,
    simAvgSteps: result.avgStepsOnWin,
    elapsedMs: result.elapsedMs,
    totalTiles: terrainTiles.length,
  };
}

// ═══ Step 5: Write results CSV ═══
function csvEscape(val: unknown): string {
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const CSV_HEADER = [
  '关卡牌局代码', '地形编号', '开始次数', '净过关次数', '净胜率(%)',
  'ReplayCode', '模拟胜利', '模拟失败', '模拟胜率(%)', '模拟平均步数',
  '耗时ms', '地形总牌数',
].join(',');

function rowToCSV(r: SimRow): string {
  return [
    csvEscape(r.replayKey),
    csvEscape(r.terrainId),
    r.starts,
    r.clears,
    r.onlineWinRate,
    csvEscape(r.replayCode),
    r.simWins,
    r.simLosses,
    (r.simWinRate * 100).toFixed(2),
    r.simAvgSteps.toFixed(1),
    Math.round(r.elapsedMs),
    r.totalTiles,
  ].join(',');
}

// ═══ Main ═══
async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  Batch Player Simulation');
  console.log(`  Sims per replaykey: ${SIM_COUNT}`);
  console.log('═══════════════════════════════════════════\n');

  // Suppress verbose decoder logs
  setLogLevel(LogLevel.Silent);

  // Ensure output dir
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  // 1. Parse CSV
  const rows = parseCSV();

  // 2. Build replaykey map
  const keyMap = buildReplayKeyMap();

  // 3. Filter rows that have replaycodes
  const validRows: { row: CsvRow; entry: KeyCodeEntry }[] = [];
  const missing: CsvRow[] = [];
  for (const row of rows) {
    const entry = keyMap.get(row.replayKey);
    if (entry) {
      validRows.push({ row, entry });
    } else {
      missing.push(row);
    }
  }
  console.log(`\n📊 Valid entries with replaycode: ${validRows.length}`);
  console.log(`   Missing replaycode: ${missing.length}`);
  if (missing.length > 0 && missing.length <= 20) {
    for (const m of missing) {
      console.log(`     - ${m.replayKey} (terrain ${m.terrainId})`);
    }
  }

  // 4. Check for checkpoint
  let startIdx = 0;
  const completed: SimRow[] = [];
  if (isResume && existsSync(CHECKPOINT_FILE)) {
    const cp = JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf-8'));
    startIdx = cp.nextIdx || 0;
    if (cp.completed) completed.push(...cp.completed);
    console.log(`\n🔄 Resuming from index ${startIdx} (${completed.length} completed)`);
  }

  // 5. Run simulations
  const totalToProcess = validRows.length - startIdx;
  console.log(`\n🚀 Running simulations for ${totalToProcess} entries...\n`);

  // Initialize output file
  if (!isResume || !existsSync(CSV_OUTPUT)) {
    writeFileSync(CSV_OUTPUT, CSV_HEADER + '\n', 'utf-8');
  }

  const startTime = performance.now();
  let processedCount = 0;

  for (let i = startIdx; i < validRows.length; i++) {
    const { row, entry } = validRows[i];
    const idx = i + 1;
    const pct = ((processedCount / totalToProcess) * 100).toFixed(1);

    const elapsedTotal = (performance.now() - startTime) / 1000;
    const rate = processedCount > 0 ? elapsedTotal / processedCount : 0;
    const eta = rate > 0 ? (totalToProcess - processedCount) * rate : 0;

    console.log(
      `[${idx}/${validRows.length}] ${pct}% | ${row.replayKey} ` +
      `(terrain ${row.terrainId}) | ETA: ${eta.toFixed(0)}s`
    );

    try {
      const result = runSimulation(row, entry);
      if (result) {
        completed.push(result);
        appendFileSync(CSV_OUTPUT, rowToCSV(result) + '\n', 'utf-8');
        console.log(
          `  ✅ Online: ${result.onlineWinRate.toFixed(1)}% | ` +
          `Sim: ${(result.simWinRate * 100).toFixed(1)}% ` +
          `(${result.simWins}/${result.simWins + result.simLosses}) | ` +
          `${result.elapsedMs.toFixed(0)}ms`
        );
      } else {
        console.log(`  ❌ Failed to simulate`);
      }
    } catch (e) {
      console.error(`  ❌ Error: ${e instanceof Error ? e.message : String(e)}`);
    }

    processedCount++;

    // Save checkpoint every SAVE_INTERVAL
    if (processedCount % SAVE_INTERVAL === 0) {
      writeFileSync(CHECKPOINT_FILE, JSON.stringify({
        nextIdx: i + 1,
        completedCount: completed.length,
        timestamp: new Date().toISOString(),
      }), 'utf-8');
    }
  }

  // 6. Summary
  const totalElapsed = ((performance.now() - startTime) / 1000).toFixed(0);
  console.log(`\n═══════════════════════════════════════════`);
  console.log(`  ✅ Complete!`);
  console.log(`  Processed: ${completed.length} entries`);
  console.log(`  Total time: ${totalElapsed}s`);
  console.log(`  Output: ${CSV_OUTPUT}`);
  console.log(`═══════════════════════════════════════════`);

  // Clean checkpoint
  if (existsSync(CHECKPOINT_FILE)) {
    // Keep it for reference but mark as done
    writeFileSync(CHECKPOINT_FILE, JSON.stringify({
      done: true,
      completedCount: completed.length,
      timestamp: new Date().toISOString(),
    }), 'utf-8');
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
