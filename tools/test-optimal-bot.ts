#!/usr/bin/env npx tsx
import { readFileSync } from 'node:fs';
import { OfflineGame } from '../src/solver/offline-game.js';
import { OfflineTile, TileFlag } from '../src/solver/types.js';
import { computeVisibleMatchGroups, pickClickableFromPath, pickMostRevealingTile } from '../src/solver/solver-player-new.js';
import { decodeFromString, getCanonicalTileOrder } from '../src/replay-serializer.js';
import { loadTerrainFromFile, getAllTiles, LogLevel, setLogLevel } from '../src/index.js';
import { mulberry32 } from '../src/random-utils.js';
setLogLevel(LogLevel.Silent);

const LEVELS_DIR = '/Users/wenhaowang/WorkSpace/TileMatchShell/Tools/Config/Json/Levels';

// ── Optimal bot: always pick lowest-cost safe group (no mistakes, no random) ──

function solveOptimal(game: OfflineGame, maxSteps = 2000) {
  const g = game.clone();
  let forcedPick = 0, starve = 0;
  for (let step = 0; step < maxSteps; step++) {
    if (g.isWin) return { win: true, steps: step, forcedPick, starve };
    if (g.isDead) return { win: false, steps: step, forcedPick, starve };

    // starvation check
    const cb = new Map<number, number>();
    for (const [c, n] of g.getDockCounts()) cb.set(c, n);
    for (const t of g.deskTiles) {
      if (t.isClickable && t.elementValue > 0) cb.set(t.elementValue, (cb.get(t.elementValue) ?? 0) + 1);
    }
    if (![...cb.values()].some(n => n >= 3)) starve++;

    const groups = computeVisibleMatchGroups(g);
    const safe = groups.filter(mg => mg.totalCost <= g.remainSlotCount);

    let tile;
    if (safe.length > 0) {
      // optimal: always pick the one with lowest totalCost
      let best = safe[0];
      for (const mg of safe) { if (mg.totalCost < best.totalCost) best = mg; }
      tile = pickClickableFromPath(best, g);
    }
    if (!tile) {
      forcedPick++;
      tile = pickMostRevealingTile(g, () => 0.5); // deterministic
    }
    if (!tile) return { win: false, steps: step, forcedPick, starve };
    g.collect(tile);
  }
  return { win: false, steps: maxSteps, forcedPick, starve };
}

function solveOptimalBatch(game: OfflineGame, runs: number) {
  let wins = 0, totalFPWin = 0, totalSVWin = 0, totalStepsLoss = 0, totalFPLoss = 0, totalSVLoss = 0;
  for (let i = 0; i < runs; i++) {
    const r = solveOptimal(game);
    if (r.win) { wins++; totalFPWin += r.forcedPick; totalSVWin += r.starve; }
    else { totalStepsLoss += r.steps; totalFPLoss += r.forcedPick; totalSVLoss += r.starve; }
  }
  const losses = runs - wins;
  return {
    simPass: wins / runs,
    fpWin: wins > 0 ? totalFPWin / wins : 0,
    svWin: wins > 0 ? totalSVWin / wins : 0,
    fpLoss: losses > 0 ? totalFPLoss / losses : 0,
    svLoss: losses > 0 ? totalSVLoss / losses : 0,
  };
}

// ── Parse data, pick samples ──

interface Row { lid: string; plays: number; onlineRate: number; replayCode: string; totalTiles: number; }
const data: Row[] = [];
const text = readFileSync('output/原始数据.csv', 'utf8');
for (const line of text.charCodeAt(0) === 0xfeff ? text.slice(1) : text.trim().split('\n').slice(1)) {
  const c = line.split(','); const plays = parseInt(c[2]), rate = parseFloat(c[4]);
  if (plays > 100 && rate >= 0) data.push({ lid: c[1], plays, onlineRate: rate, replayCode: c[5], totalTiles: parseInt(c[11]) });
}

function buildGame(replayCode: string, lid: string): OfflineGame {
  const rd = decodeFromString(replayCode); if (!rd) throw new Error('decode');
  const terrain = loadTerrainFromFile(`${LEVELS_DIR}/${lid}.json`);
  const ordered = getCanonicalTileOrder(getAllTiles(terrain));
  const tiles: OfflineTile[] = [];
  for (let i = 0; i < ordered.length && i < rd.instanceArray.length; i++) {
    const t = ordered[i];
    tiles.push(new OfflineTile({ id: t.id, layer: t.layer, dependencies: t.dependencies, isConst: t.isConst, constElementValue: t.constElementValue, posX: t.posX, posY: t.posY }, (rd.instanceArray[i] & 0x3F) + 1));
  }
  return new OfflineGame(tiles);
}

const brackets = [
  { lo: 0, hi: 20 }, { lo: 20, hi: 35 }, { lo: 35, hi: 50 },
  { lo: 50, hi: 65 }, { lo: 65, hi: 80 }, { lo: 80, hi: 100 },
];

console.log(' 最优bot（min-cost safe group, 0% mistake）');
console.log('online%  terrain  simPass   fpWin  svWin   fpLoss  svLoss');
console.log('─'.repeat(62));

for (const b of brackets) {
  const pool = data.filter(d => d.onlineRate >= b.lo && d.onlineRate < b.hi).sort((a, b) => b.plays - a.plays);
  for (const s of pool.slice(0, 2)) {
    try {
      const g = buildGame(s.replayCode, s.lid);
      const r = solveOptimalBatch(g, 50);
      console.log(
        `${String(s.onlineRate.toFixed(0)+'%').padStart(6)}  ${s.lid.padEnd(7)} ${r.simPass.toFixed(2).padStart(6)}  ${r.fpWin.toFixed(1).padStart(5)} ${r.svWin.toFixed(1).padStart(5)}  ${r.fpLoss.toFixed(1).padStart(5)} ${r.svLoss.toFixed(1).padStart(5)}`
      );
    } catch (e) { console.log(`${String(s.onlineRate.toFixed(0)+'%').padStart(6)}  ${s.lid.padEnd(7)} ERR: ${e}`); }
  }
}
