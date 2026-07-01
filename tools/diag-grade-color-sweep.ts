#!/usr/bin/env npx tsx
/**
 * Diagnostic: for each terrain, max close rate + color sweep 8..maxCC*0.7.
 * Records what grade each color count produces (3 runs each).
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  generateAndEvaluateOne,
} from '../src/batch-generator.js';
import {
  computeDependencyDepth,
  getAllTiles,
  loadTerrainFromFile,
  LogLevel,
  setLogLevel,
} from '../src/index.js';
import { mulberry32 } from '../src/random-utils.js';

setLogLevel(LogLevel.Silent);

const EXCLUDE = new Set(['100001', '100002']);
const LEVELS_DIR = '/Users/wenhaowang/WorkSpace/TileMatchShell/Tools/Config/Json/Levels';
const OUTPUT = 'output/diag_color_sweep.csv';
const RUNS_PER_CC = 3;
const SIM_RUNS = 100;

function listLevels(): string[] {
  const ids: string[] = [];
  for (const name of readdirSync(LEVELS_DIR)) {
    const m = name.match(/^(\d+)\.json$/);
    if (m && !EXCLUDE.has(m[1])) ids.push(m[1]);
  }
  return ids.sort((a, b) => Number(a) - Number(b));
}

function main(): void {
  const levels = listLevels();
  console.log(`待测地形: ${levels.length}`);

  mkdirSync(dirname(resolve(OUTPUT)), { recursive: true });
  writeFileSync(OUTPUT, '﻿levelResId,freeTiles,maxCC,colorCount,run,grade,passrate,sim1Rate,sim5Rate,sim15Rate\n', 'utf8');

  let total = 0;
  for (let idx = 0; idx < levels.length; idx++) {
    const lid = levels[idx];
    const path = `${LEVELS_DIR}/${lid}.json`;
    const terrain = loadTerrainFromFile(path);
    const freeTiles = getAllTiles(terrain).filter(t => !t.isConst).length;
    const maxCC = Math.floor(freeTiles / 3);
    const ccMax = Math.max(8, Math.floor(maxCC * 0.7));
    const ccStart = Math.min(8, maxCC);

    for (let cc = ccStart; cc <= ccMax; cc++) {
      for (let run = 0; run < RUNS_PER_CC; run++) {
        const seed = (Number(lid) * 1000 + cc * 10 + run) * 131;
        const allTiles = getAllTiles(terrain);
        const depth = computeDependencyDepth(
          allTiles.filter(t => !t.isConst),
          new Map(allTiles.map(t => [t.id, t])),
        );
        const layerCount = Math.max(0, (depth.size > 0 ? Math.max(...depth.values()) : 1) - 1);
        const rng = mulberry32(seed);

        const row = generateAndEvaluateOne(terrain, {
          closeRates: Array.from({ length: layerCount }, () => 1.0),
          colorCount: cc,
          spreadParam: 0.5 + rng() * 0.5,
          debtPersistenceWeight: 0,
        }, 0, path, 1, false, SIM_RUNS, seed);

        appendFileSync(OUTPUT, [
          lid, freeTiles, maxCC, cc, run + 1,
          row.grade,
          row.passrate.toFixed(4),
          row.sim1WinRate.toFixed(4),
          row.sim5WinRate.toFixed(4),
          row.sim15WinRate.toFixed(4),
        ].join(',') + '\n', 'utf8');
        total++;
      }
    }
    if ((idx + 1) % 10 === 0 || idx === levels.length - 1) {
      process.stdout.write(`\r\x1b[K${idx + 1}/${levels.length} 地形, ${total} 条`);
    }
  }
  console.log(`\n完成: ${OUTPUT}`);
}

try { main(); }
catch (err) { console.error(err); process.exit(1); }
