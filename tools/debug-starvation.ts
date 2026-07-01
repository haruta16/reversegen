#!/usr/bin/env npx tsx
import { readFileSync } from 'node:fs';
import { OfflineGame } from '../src/solver/offline-game.js';
import { OfflineTile } from '../src/solver/types.js';
import { decodeFromString, getCanonicalTileOrder } from '../src/replay-serializer.js';
import { loadTerrainFromFile, getAllTiles, LogLevel, setLogLevel } from '../src/index.js';
import { mulberry32 } from '../src/random-utils.js';
import { computeVisibleMatchGroups } from '../src/solver/solver-player-new.js';

setLogLevel(LogLevel.Silent);

const LEVELS_DIR = '/Users/wenhaowang/WorkSpace/TileMatchShell/Tools/Config/Json/Levels';

// Pick the 20-45% board
const text = readFileSync('output/原始数据.csv', 'utf8');
const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
const lines = source.trim().split('\n');
let target: { code: string; lid: string; rate: string; replayCode: string } | null = null;
for (let i = 1; i < lines.length; i++) {
  const cols = lines[i].split(',');
  const rate = parseFloat(cols[4]);
  if (rate >= 20 && rate < 45 && parseInt(cols[2]) > 1000) {
    target = { code: cols[0], lid: cols[1], rate: cols[4], replayCode: cols[5] };
    break;
  }
}

if (!target) { console.log('no match'); process.exit(1); }

const replayData = decodeFromString(target.replayCode)!;
const terrain = loadTerrainFromFile(`${LEVELS_DIR}/${target.lid}.json`);
const allTiles = getAllTiles(terrain);
const ordered = getCanonicalTileOrder(allTiles);
const offlineTiles: OfflineTile[] = [];
for (let i = 0; i < ordered.length && i < replayData.instanceArray.length; i++) {
  const t = ordered[i];
  offlineTiles.push(new OfflineTile({
    id: t.id, layer: t.layer, dependencies: t.dependencies,
    isConst: t.isConst, constElementValue: t.constElementValue,
    posX: t.posX, posY: t.posY,
  }, (replayData.instanceArray[i] & 0x3F) + 1));
}

const game = new OfflineGame(offlineTiles);
const g = game.clone();
const rng = mulberry32(200);
const { pickClickableFromPath, pickMostRevealingTile } = await import('../src/solver/solver-player-new.js');

let starve = 0, forced = 0;
for (let step = 0; step < 200 && !g.isWin && !g.isDead; step++) {
  // color starvation check
  const cb = new Map<number, number>();
  for (const [c, n] of g.getDockCounts()) cb.set(c, n);
  for (const t of g.deskTiles) {
    if (t.isClickable && t.elementValue > 0) {
      cb.set(t.elementValue, (cb.get(t.elementValue) ?? 0) + 1);
    }
  }
  let maxSame = 0; let hasTriple = false;
  for (const n of cb.values()) { if (n > maxSame) maxSame = n; if (n >= 3) hasTriple = true; }
  if (!hasTriple) {
    starve++;
    console.log(`  STARVE step=${step} dock=${[...g.getDockCounts().entries()].map(([c,n])=>`c${c}:${n}`).join(',')} clickable=${g.deskTiles.filter(t=>t.isClickable).length} maxSame=${maxSame}`);
  }

  // select tile
  const visibleGroups = computeVisibleMatchGroups(g);
  const safeGroups = visibleGroups.filter(mg => mg.totalCost <= g.remainSlotCount);
  let tile;
  if (safeGroups.length > 0) {
    tile = pickClickableFromPath(safeGroups[Math.floor(rng() * safeGroups.length)], g);
  }
  if (!tile) {
    forced++;
    tile = pickMostRevealingTile(g, rng);
  }
  if (!tile) break;
  g.collect(tile);
}

console.log(`\n${target.lid} online=${target.rate}% steps=${g.isWin?'WIN':'DEAD'} totalStarve=${starve} totalForced=${forced}`);
