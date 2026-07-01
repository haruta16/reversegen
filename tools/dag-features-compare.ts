#!/usr/bin/env npx tsx
/** Compare DAG features: overestimated vs correct hard vs normal levels. */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadTerrainFromFile, getAllTiles, decodeFromString,
  getCanonicalTileOrder, setLogLevel, LogLevel,
} from '../src/index.js';
import { buildBoardDAG, extractDAGFeatures } from './dag/board-dag.js';
import type { TerrainTile } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
setLogLevel(LogLevel.Silent);

const SWEEP_CSV = resolve(__dirname, '../output/失误率扫描/原始数据.csv');
const SIM_CSV = resolve(__dirname, '../output/sim_results.csv');

const raw = readFileSync(SWEEP_CSV, 'utf-8');
const lines = raw.trim().split('\n');

interface Row { key: string; terrainId: string; online: number; sim5: number; group: string; }

const data: Row[] = [];
for (let i = 1; i < lines.length; i++) {
  const parts = lines[i].replace(/"/g, '').split(',');
  const online = parseFloat(parts[2]);
  const sim5 = parseFloat(parts[3 + 4]);
  let group = 'normal';
  if (online < 20 && sim5 >= 20) group = 'over';
  else if (online < 20 && sim5 < 20) group = 'correct_hard';
  if (group === 'normal' && data.filter(r => r.group === 'normal').length >= 100) continue;
  data.push({ key: parts[0], terrainId: parts[1], online, sim5, group });
}

// Replay code map
const simRaw = readFileSync(SIM_CSV, 'utf-8');
const codeMap = new Map<string, string>();
for (const l of simRaw.trim().split('\n').slice(1)) {
  const p = l.replace(/"/g, '').split(',');
  if (p.length >= 6) codeMap.set(p[0], p[5]);
}

// Terrain map
const TERRAIN_DIRS = [
  '/Users/wenhaowang/WorkSpace/levels_json/正式关卡',
  '/Users/wenhaowang/WorkSpace/levels_json/关卡备份',
  '/Users/wenhaowang/WorkSpace/levels_json/关卡调整',
];
const terrainMap = new Map<string, string>();
for (const dir of TERRAIN_DIRS) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.json')) terrainMap.set(f.replace('.json', ''), join(dir, f));
  }
}

const terrainCache = new Map<string, TerrainTile[]>();
const results: string[] = [];
const header = 'key,group,online,sim5,tripleCount,edgeCount,depthMax,avgDepSetSize,leafTripleCount,rootTripleCount,maxParallelism,avgParallelism,maxBottleneckScore,overlapDensity,netPressureAvg,netPressureMax,totalTiles';
results.push(header);

let skip: Record<string, number> = {};
let processed = 0;

for (const d of data) {
  processed++;

  // Terrain
  const tpath = terrainMap.get(d.terrainId);
  if (!tpath) { skip['noTerrain'] = (skip['noTerrain'] || 0) + 1; continue; }

  let tiles: TerrainTile[];
  if (terrainCache.has(d.terrainId)) {
    tiles = terrainCache.get(d.terrainId)!;
  } else {
    try {
      const terrain = loadTerrainFromFile(tpath);
      tiles = getAllTiles(terrain);
      terrainCache.set(d.terrainId, tiles);
    } catch (e) { skip['badTerrain'] = (skip['badTerrain'] || 0) + 1; continue; }
  }

  // Replay
  const code = codeMap.get(d.key);
  if (!code) { skip['noCode'] = (skip['noCode'] || 0) + 1; continue; }

  const rd = decodeFromString(code);
  if (!rd) { skip['badDecode'] = (skip['badDecode'] || 0) + 1; continue; }

  const ordered = getCanonicalTileOrder(tiles);
  const suitMap = new Map<number, number>();
  for (let i = 0; i < ordered.length && i < rd.instanceArray.length; i++) {
    suitMap.set(ordered[i].id, (rd.instanceArray[i] & 0x3F) + 1);
  }

  // DAG
  const freeTiles = tiles.filter(t => !t.isConst);
  try {
    const dag = buildBoardDAG(freeTiles, suitMap);
    const feat = extractDAGFeatures(dag);
    results.push([
      d.key, d.group, d.online, d.sim5,
      feat.tripleCount, feat.edgeCount, feat.depthMax,
      feat.avgDepSetSize, feat.leafTripleCount, feat.rootTripleCount,
      feat.maxParallelism, feat.avgParallelism,
      feat.maxBottleneckScore, feat.overlapDensity,
      feat.netPressure.avg, feat.netPressure.max,
      tiles.length,
    ].join(','));
  } catch (e) { skip['dagFail'] = (skip['dagFail'] || 0) + 1; continue; }

  if (processed % 50 === 0) console.error('  %d/%d (results: %d)...' + String(Object.entries(skip).map(([k,v]) => k + ':' + v).join(' ')), processed, data.length, results.length - 1);
}

// Output
const outPath = resolve(__dirname, '../output/dag_features_compare.csv');
writeFileSync(outPath, results.join('\n'), 'utf-8');

const resultRows = results.slice(1);
console.log('\nResults: ' + resultRows.length + ' levels');
console.log('Groups: over=' + resultRows.filter(r => r.split(',')[1] === 'over').length +
  ' correct_hard=' + resultRows.filter(r => r.split(',')[1] === 'correct_hard').length +
  ' normal=' + resultRows.filter(r => r.split(',')[1] === 'normal').length);
console.log('Skips: ' + JSON.stringify(skip));
console.log('Saved: ' + outPath);
