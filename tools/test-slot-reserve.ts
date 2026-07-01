#!/usr/bin/env npx tsx
/**
 * Test slotReserve + mistakeRate on sample levels.
 * Usage: npx tsx tools/test-slot-reserve.ts
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadTerrainFromFile, getAllTiles, decodeFromString,
  getCanonicalTileOrder, setLogLevel, LogLevel,
} from '../src/index.js';
import { createGame, OfflineGame } from '../src/solver/offline-game.js';
import { OfflineTile } from '../src/solver/types.js';
import {
  computeVisibleMatchGroups,
  pickClickableFromPath,
  pickMostRevealingTile,
} from '../src/solver/solver-player.js';
import type { TerrainTile, ReplayData } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
setLogLevel(LogLevel.Silent);

const TERRAIN_DIRS = [
  '/Users/wenhaowang/WorkSpace/levels_json/正式关卡',
  '/Users/wenhaowang/WorkSpace/levels_json/关卡备份',
  '/Users/wenhaowang/WorkSpace/levels_json/关卡调整',
];

// ═══ SlotReserve + Mistake solver ═══
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickRandomClickable(game: OfflineGame, rng: () => number): OfflineTile | null {
  const clickable = game.deskTiles.filter(t => t.isClickable);
  if (clickable.length === 0) return null;
  return clickable[Math.floor(rng() * clickable.length)];
}

function selectTileWithReserve(
  game: OfflineGame, rng: () => number,
  mistakeRate: number, slotReserve: number,
): OfflineTile | null {
  // Mistake check
  if (rng() < mistakeRate) {
    return pickRandomClickable(game, rng);
  }

  const visibleGroups = computeVisibleMatchGroups(game);
  const dockRemain = game.remainSlotCount;
  const maxSlots = game.maxSlotCount;

  // Step 1: standard player logic — find ALL safe groups
  const allSafeGroups = visibleGroups.filter(g => g.totalCost <= dockRemain);

  if (allSafeGroups.length > 0) {
    // Step 2: apply slotReserve filter on top of standard logic
    const conservativeCost = Math.min(dockRemain, maxSlots - slotReserve);
    const conservativeGroups = allSafeGroups.filter(g => g.totalCost <= conservativeCost);

    // Pick from conservative if available, otherwise fall back to all safe
    const pickFrom = conservativeGroups.length > 0 ? conservativeGroups : allSafeGroups;

    const chosen = pickFrom[Math.floor(rng() * pickFrom.length)];
    const tile = pickClickableFromPath(chosen, game);
    if (tile) return tile;
    for (const g of pickFrom) {
      const t = pickClickableFromPath(g, game);
      if (t) return t;
    }
  }

  return pickMostRevealingTile(game, rng);
}

function simulateOne(game: OfflineGame, seed: number, mistakeRate: number, slotReserve: number, maxSteps = 2000) {
  const g = game.clone();
  const rng = mulberry32(seed);
  for (let step = 0; step < maxSteps; step++) {
    if (g.isWin) return { win: true, steps: step };
    if (g.isDead) return { win: false, steps: step, reason: 'dead' };
    const tile = selectTileWithReserve(g, rng, mistakeRate, slotReserve);
    if (!tile) return { win: false, steps: step, reason: 'stuck' };
    g.collect(tile);
  }
  return { win: g.isWin, steps: maxSteps, reason: 'maxsteps' };
}

function simulateBatch(game: OfflineGame, runs: number, mistakeRate: number, slotReserve: number) {
  let wins = 0;
  for (let i = 0; i < runs; i++) {
    const r = simulateOne(game, i, mistakeRate, slotReserve);
    if (r.win) wins++;
  }
  return wins / runs;
}

// ═══ Load data ═══
const SWEEP_CSV = resolve(__dirname, '../output/失误率扫描/原始数据.csv');
const SIM_CSV = resolve(__dirname, '../output/sim_results.csv');

const sweepRaw = readFileSync(SWEEP_CSV, 'utf-8').trim().split('\n');
const sweepHeader = sweepRaw[0].replace(/"/g, '').split(',');

// Load sweep data
interface SweepRow { key: string; terrainId: string; online: number; sim5: number; sim1: number; sim15: number; }
const sweepRows: SweepRow[] = [];
for (let i = 1; i < sweepRaw.length; i++) {
  const parts = sweepRaw[i].replace(/"/g, '').split(',');
  sweepRows.push({
    key: parts[1], terrainId: parts[2], online: parseFloat(parts[3]),
    sim5: parseFloat(parts[3 + 5]), sim1: parseFloat(parts[3 + 1]), sim15: parseFloat(parts[3 + 15]),
  });
}

// Replay codes
const simRaw = readFileSync(SIM_CSV, 'utf-8').trim().split('\n');
const codeMap = new Map<string, string>();
for (let i = 1; i < simRaw.length; i++) {
  const p = simRaw[i].replace(/"/g, '').split(',');
  if (p.length >= 6) codeMap.set(p[0], p[5]);
}

// Terrain map
const terrainMap = new Map<string, string>();
for (const dir of TERRAIN_DIRS) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.json')) terrainMap.set(f.replace('.json', ''), join(dir, f));
  }
}

// ═══ Pick 20 levels ═══
// 5 overestimated (online<20, sim5>=20)
// 5 correct hard (online<20, sim5<20)
// 5 mid (online 40-60)
// 5 easy (online>=80)

const samples: { row: SweepRow; group: string }[] = [];
for (const r of sweepRows) {
  if (r.online < 20 && r.sim5 >= 20 && samples.filter(s => s.group === 'over').length < 5)
    samples.push({ row: r, group: 'over' });
  if (r.online < 20 && r.sim5 < 20 && samples.filter(s => s.group === 'hard').length < 5)
    samples.push({ row: r, group: 'hard' });
  if (r.online >= 40 && r.online < 60 && samples.filter(s => s.group === 'mid').length < 5)
    samples.push({ row: r, group: 'mid' });
  if (r.online >= 80 && samples.filter(s => s.group === 'easy').length < 5)
    samples.push({ row: r, group: 'easy' });
}

const terrainCache = new Map<string, TerrainTile[]>();
const SIMS = 100;

const sep75 = '='.repeat(75);
const sep75dash = '-'.repeat(75);

console.log('SlotReserve=1 + Mistake=1%-5% 测试');
console.log(sep75);
console.log('组别  关卡                        在线    sim5%  R1+m1% R1+m2% R1+m3% R1+m4% R1+m5%');
console.log(sep75dash);

for (const { row, group } of samples) {
  const code = codeMap.get(row.key);
  if (!code) continue;

  const tpath = terrainMap.get(row.terrainId);
  if (!tpath) continue;

  let tiles: TerrainTile[];
  if (terrainCache.has(row.terrainId)) {
    tiles = terrainCache.get(row.terrainId)!;
  } else {
    try {
      const terrain = loadTerrainFromFile(tpath);
      tiles = getAllTiles(terrain);
      terrainCache.set(row.terrainId, tiles);
    } catch (e) { continue; }
  }

  const rd = decodeFromString(code);
  if (!rd) continue;

  const ordered = getCanonicalTileOrder(tiles);
  const elemValues = new Map<number, number>();
  const initialDock: { tileId: number; element: number }[] = [];
  const eliminatedTileIds = new Set<number>();

  for (let i = 0; i < ordered.length && i < rd.instanceArray.length; i++) {
    const byte = rd.instanceArray[i];
    const state = (byte >> 6) & 0x3;
    const elementIdx = byte & 0x3F;
    const elementValue = elementIdx + 1;
    elemValues.set(ordered[i].id, elementValue);
    if (state === 1) eliminatedTileIds.add(ordered[i].id);
    else if (state === 2) initialDock.push({ tileId: ordered[i].id, element: elementValue });
  }
  // Extra dock entries from replay data
  for (const de of rd.dockEntries) {
    if (de.tileId >= 0 && de.tileId < ordered.length) {
      const tile = ordered[de.tileId];
      if (!initialDock.some(d => d.tileId === tile.id)) {
        initialDock.push({ tileId: tile.id, element: de.element });
      }
    }
  }

  const game = createGame({ terrainTiles: tiles, elementValues: elemValues, initialDock, eliminatedTileIds });

  // Test: slotReserve=1 + mistake 1%-5%
  const rates: number[] = [];
  for (const mr of [0.01, 0.02, 0.03, 0.04, 0.05]) {
    rates.push(simulateBatch(game, SIMS, mr, 1) * 100);
  }
  // Baseline: slotReserve=0 (should equal standard player)
  const r0m5 = simulateBatch(game, SIMS, 0.05, 0) * 100;

  // Short group label
  const label = { over: '高估', hard: '困难', mid: '中等', easy: '简单' }[group] || group;
  console.log(label.padEnd(4) + ' ' + row.key.padEnd(26) + ' ' +
    String(row.online).padStart(3) + '%  ' +
    String(row.sim5).padStart(4) + '%   ' +
    rates.map(r => String(Math.round(r)).padStart(4) + '%').join('   ') +
    '   R0m5=' + String(Math.round(r0m5)) + '%');
}

console.log('\nR1 = slotReserve=1,  m1%-m5% = mistake 1%-5%');
