import { loadTerrainFromFile, getAllTiles } from '../src/terrain-loader.js';
import { generateV4 } from '../src/generate-v4.js';
import { createGame } from '../src/solver/offline-game.js';
import { solveDFS } from '../src/solver/solver-dfs.js';
import { setLogLevel, LogLevel } from '../src/logger.js';
setLogLevel(LogLevel.Error);
import { join } from 'node:path';

const D = 'E:/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
const terrain = loadTerrainFromFile(join(D, '100010.json'));
const allTiles = getAllTiles(terrain);
const freeTiles = allTiles.filter((t:any)=>!t.isConst);

// V4 death@9
const r = generateV4({ terrain, solvable: false, deathStep: 9 });
console.log('V4: OK='+r.ok+' branchLog[9]='+r.branchLog[9]+' branchLog='+r.branchLog.join(','));

// Check: how many death colors have >=3 "will-be-freed" tiles?
// will-be-freed = tiles whose ALL blockers are plan tiles
const planColors = new Set<number>();
const deathColors = new Set<number>();
let maxColor = 0;
for (const [_,c] of r.assignments) { if (c > maxColor) maxColor = c; }

// Plan creates 9 triples = 9 colors. Colors <= 9 are plan.
for (let c = 1; c <= 9; c++) planColors.add(c);
for (let c = 10; c <= maxColor; c++) deathColors.add(c);

const planTileSet = new Set<number>();
for (const [tid, c] of r.assignments) { if (planColors.has(c)) planTileSet.add(tid); }

// Check death colors' freed counts
const allDeps = new Map<number, Set<number>>();
const tileMap = new Map<number, any>();
for (const t of allTiles) tileMap.set(t.id, t);

// Compute remaining deps after plan
const remainingDeps = new Map<number, Set<number>>();
for (const t of freeTiles) {
  const rd = new Set<number>();
  for (const d of t.dependencies) { if (tileMap.has(d) && !planTileSet.has(d)) rd.add(d); }
  remainingDeps.set(t.id, rd);
}

// Count freed per death color
const deathFreedCount = new Map<number, number>();
for (const t of freeTiles) {
  const c = r.assignments.get(t.id) ?? 0;
  if (!deathColors.has(c)) continue;
  if ((remainingDeps.get(t.id)?.size ?? 0) === 0) {
    deathFreedCount.set(c, (deathFreedCount.get(c)??0) + 1);
  }
}
console.log('Death colors: '+deathColors.size+' tiles='+[...deathFreedCount.values()].reduce((a,b)=>a+b,0));
const leaked = [...deathFreedCount.entries()].filter(([_,n]) => n >= 3);
console.log('Death colors with >=3 freed (STRUCTURAL): '+leaked.length);
for (const [c, n] of leaked.slice(0,5)) console.log('  color '+c+': '+n+' freed tiles (should be <=2!)');

// DFS verification
const elementValues = new Map<number, number>();
for (const t of allTiles) {
  if (t.isConst && t.constElementValue > 0) elementValues.set(t.id, t.constElementValue);
  else elementValues.set(t.id, r.assignments.get(t.id) ?? 1);
}
const game = createGame({ terrainTiles: allTiles, elementValues });
const dfs = solveDFS(game, { timeoutMs: 30000 });
console.log('\nDFS: win='+dfs.win+' states='+dfs.statesVisited+' stepCount='+dfs.stepCount);
