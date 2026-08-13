#!/usr/bin/env npx tsx
import { readFileSync } from 'node:fs';
import { OfflineGame } from '../src/solver/offline-game.js';
import { OfflineTile } from '../src/solver/types.js';
import { solvePlayerMistakeBatch } from '../src/solver/solver-player-mistake.js';
import { decodeFromString, getCanonicalTileOrder } from '../src/replay-serializer.js';
import { loadTerrainFromFile, getAllTiles, LogLevel, setLogLevel } from '../src/index.js';
setLogLevel(LogLevel.Silent);

const LEVELS_DIR = '/Users/wenhaowang/WorkSpace/TileMatchShell/Tools/Config/Json/Levels';

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

console.log('online%  terrain    0%-simPass  0%-fpLoss  0%-svLoss  |  5%-simPass  5%-fpLoss  5%-svLoss');
console.log('─'.repeat(90));

for (const b of brackets) {
  const pool = data.filter(d => d.onlineRate >= b.lo && d.onlineRate < b.hi).sort((a, b) => b.plays - a.plays);
  for (const s of pool.slice(0, 2)) {
    try {
      const g = buildGame(s.replayCode, s.lid);
      const r0 = solvePlayerMistakeBatch(g, 50, 100, { mistakeRate: 0 });
      const r5 = solvePlayerMistakeBatch(g, 50, 100, { mistakeRate: 0.05 });
      console.log(
        `${String(s.onlineRate.toFixed(0)+'%').padStart(6)}  ${s.lid.padEnd(7)} ` +
        `${r0.winRate.toFixed(2).padStart(6)}   ${r0.forcedPickOnLoss.toFixed(1).padStart(5)}     ${r0.starvationOnLoss.toFixed(1).padStart(5)}    |  ` +
        `${r5.winRate.toFixed(2).padStart(6)}   ${r5.forcedPickOnLoss.toFixed(1).padStart(5)}     ${r5.starvationOnLoss.toFixed(1).padStart(5)}`
      );
    } catch (e) { console.log(`${String(s.onlineRate.toFixed(0)+'%').padStart(6)}  ${s.lid.padEnd(7)} ERR`); }
  }
}
