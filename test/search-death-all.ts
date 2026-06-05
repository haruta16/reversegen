/**
 * CSP死亡搜索 — 全地形批量运行。
 * 每个地形: 搜索可行的deathStep, DFS验证, 报告通过率。
 */

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadTerrainFromFile, getAllTiles } from '../src/terrain-loader.js';
import { searchDeath, type DeathSearchResult } from '../src/dag-death.js';
import { createGame } from '../src/solver/offline-game.js';
import { solveDFS } from '../src/solver/solver-dfs.js';
import { setLogLevel, LogLevel } from '../src/logger.js';
setLogLevel(LogLevel.Error);

const D = 'E:/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';

interface TerrainResult {
  id: number;
  tiles: number;
  steps: number;
  found: boolean;
  deathStep: number;
  planColors: number;
  deathColors: number;
  dfsWin: boolean | null;
  dfsStates: number;
  dfsTime: number;
  reason: string;
}

function main() {
  const files = readdirSync(D).filter(f => f.endsWith('.json'));
  const ids = files.map(f => parseInt(f.replace('.json',''),10))
    .filter(id => id !== 100001)
    .sort((a,b) => a-b);

  console.log(`Searching ${ids.length} terrains for death steps...\n`);

  const results: TerrainResult[] = [];
  let found = 0, confirmed = 0;

  for (const tid of ids) {
    const terrain = loadTerrainFromFile(join(D, `${tid}.json`));
    const allTiles = getAllTiles(terrain);
    const free = allTiles.filter(t => !t.isConst);
    const steps = Math.floor(free.length / 3);
    if (steps < 2) continue;

    const r = searchDeath(terrain);

    // DFS verification (only if CSP found a candidate)
    let dfsWin: boolean | null = null;
    let dfsStates = 0, dfsTime = 0;

    if (r.success && r.deathColors > 0) {
      try {
        const ev = new Map<number, number>();
        for (const t of allTiles) {
          if (t.isConst && t.constElementValue > 0) ev.set(t.id, t.constElementValue);
          else ev.set(t.id, r.assignments.get(t.id) ?? 1);
        }
        const game = createGame({ terrainTiles: allTiles, elementValues: ev });
        const dfs = solveDFS(game, { timeoutMs: 5000 });
        dfsWin = dfs.win;
        dfsStates = dfs.statesVisited;
        dfsTime = Math.round(dfs.elapsedMs);
      } catch { dfsWin = null; }
    }

    results.push({
      id: tid, tiles: free.length, steps,
      found: r.success,
      deathStep: r.deathStep,
      planColors: r.planColors,
      deathColors: r.deathColors,
      dfsWin,
      dfsStates,
      dfsTime,
      reason: r.reason,
    });

    if (r.success) {
      found++;
      if (dfsWin === false) confirmed++;
    }

    if (results.length % 20 === 0) {
      console.log(`  ${results.length}/${ids.length} | found=${found} confirmed=${confirmed}`);
    }
  }

  // ── Report ──
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  CSP DEATH SEARCH — ${ids.length} terrains`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  CSP found death step:  ${found}/${ids.length} (${(found*100/ids.length).toFixed(1)}%)`);
  console.log(`  DFS confirmed death:   ${confirmed}/${ids.length} (${(confirmed*100/ids.length).toFixed(1)}%)`);
  console.log(`  CSP found but DFS win: ${found - confirmed}`);
  console.log('');

  // Per-terrain
  console.log(`  ${'ID'.padEnd(8)} ${'Tiles'.padStart(5)} ${'Steps'.padStart(5)} ${'Found'.padStart(5)} ${'K'.padStart(4)} ${'DFSwin'.padStart(7)} ${'States'.padStart(9)} ${'Time'.padStart(6)} ${'Reason'}`);
  console.log(`  ${'-'.repeat(8)} ${'-'.repeat(5)} ${'-'.repeat(5)} ${'-'.repeat(5)} ${'-'.repeat(4)} ${'-'.repeat(7)} ${'-'.repeat(9)} ${'-'.repeat(6)} ${'-'.repeat(30)}`);

  for (const r of results) {
    const foundStr = r.found ? '✓' : '✗';
    const kStr = r.found ? String(r.deathStep) : '-';
    const dfsStr = r.dfsWin === null ? 'N/A' : r.dfsWin ? 'WIN' : 'DEAD';
    const timeStr = r.dfsTime > 0 ? (r.dfsTime/1000).toFixed(1)+'s' : '-';
    const reason = r.reason.length > 30 ? r.reason.slice(0,30) : r.reason;
    console.log(`  ${String(r.id).padEnd(8)} ${String(r.tiles).padStart(5)} ${String(r.steps).padStart(5)} ${foundStr.padStart(5)} ${kStr.padStart(4)} ${dfsStr.padStart(7)} ${String(r.dfsStates).padStart(9)} ${timeStr.padStart(6)} ${reason}`);
  }
}

main();
