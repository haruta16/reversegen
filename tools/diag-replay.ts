/**
 * Quick diagnostic: check replay code state distributions
 */
import { readFileSync } from 'node:fs';
import {
  loadTerrainFromFile, getAllTiles, decodeFromString, getCanonicalTileOrder,
} from '../src/index.js';

const LEVELS = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
const map = JSON.parse(readFileSync('output/replaykey_code_map.json', 'utf8'));

const testKeys = [
  '5-2-2-9-56717259',       // normal (95.8% online)
  '5-3-7-12-1928426479',    // suspicious (18% online, 99% sim)
  '9-9-5-14-476160617',     // hard (22.4% online)
  '8-6-3-17-582202754',     // very hard (18.9% online)
];

for (const key of testKeys) {
  const entry = map[key];
  if (!entry) { console.log(`${key}: NOT FOUND`); continue; }

  const terrain = loadTerrainFromFile(`${LEVELS}/${entry.terrainId}.json`);
  const tiles = getAllTiles(terrain);
  const data = decodeFromString(entry.replayCode);
  if (!data) { console.log(`${key}: DECODE FAILED`); continue; }

  const ordered = getCanonicalTileOrder(tiles);
  let onField = 0, eliminated = 0, inDock = 0;
  const elemSet = new Set<number>();

  for (let i = 0; i < ordered.length && i < data.instanceArray.length; i++) {
    const state = (data.instanceArray[i] >> 6) & 3;
    const ev = (data.instanceArray[i] & 0x3F) + 1;
    elemSet.add(ev);
    if (state === 0) onField++;
    else if (state === 1) eliminated++;
    else if (state === 2) inDock++;
  }

  console.log(
    `${key.padEnd(28)} terrain=${entry.terrainId} tiles=${tiles.length} ` +
    `elements=${data.elementCount}(e:${elemSet.size}) ` +
    `OnField=${onField} Elim=${eliminated} Dock=${inDock} ` +
    `dockEntries=${data.dockEntries.length}`,
  );
}
