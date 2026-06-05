import { loadTerrainFromFile, getAllTiles } from '../src/terrain-loader.js';
import { generateV4 } from '../src/generate-v4.js';
import { createGame } from '../src/solver/offline-game.js';
import { solveDFS } from '../src/solver/solver-dfs.js';
import { computeAllDependencies } from '../src/dependency-graph.js';
import { setLogLevel, LogLevel } from '../src/logger.js';
setLogLevel(LogLevel.Error);
import { join } from 'node:path';

const D='E:/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
const terrain = loadTerrainFromFile(join(D,'100002.json'));
const allTiles = getAllTiles(terrain);
const freeTiles = allTiles.filter((t:any)=>!t.isConst);

// Generate death@0
const r = generateV4({ terrain, solvable: false, deathStep: 0 });
console.log('V4: OK='+r.ok+' mod3='+r.colorSizes.every((x:number)=>x%3===0)+' branchLog[0]='+r.branchLog[0]);

// Step 1: Check freed per color at init — what does computeBranches see?
const nodes = new Map<number,{id:number,directDeps:number[]}>();
const tileMap = new Map<number,any>();
for (const t of allTiles) tileMap.set(t.id, t);
for (const t of freeTiles) {
  nodes.set(t.id, {id:t.id, directDeps: t.dependencies.filter((d:number)=>tileMap.has(d))});
}
const remainingDeps = new Map<number,Set<number>>();
for (const [tid,n] of nodes) remainingDeps.set(tid, new Set(n.directDeps));

// Compute initial freed
const initFreed: number[] = [];
for (const [tid,rd] of remainingDeps) if (rd.size===0) initFreed.push(tid);
console.log('Initial freed tiles: '+initFreed.length+' (should match isFreed count)');

// Count freed per color
const freedPerColor = new Map<number,number>();
for (const tid of initFreed) {
  const c = r.assignments.get(tid)??0;
  freedPerColor.set(c, (freedPerColor.get(c)??0)+1);
}
const badColors = [...freedPerColor.entries()].filter(([_,n])=>n>=3);
console.log('Colors with >=3 init freed: '+badColors.length);
for (const [c,n] of badColors.slice(0,5)) console.log('  color '+c+': '+n+' freed tiles');

// Check packDeathColors output: all color sizes
const colorSizes = new Map<number,number>();
for (const [tid,c] of r.assignments) colorSizes.set(c, (colorSizes.get(c)??0)+1);
const nonMod3 = [...colorSizes.entries()].filter(([_,n])=>n%3!==0);
console.log('Non-mod3 colors: '+nonMod3.length);
for (const [c,n] of nonMod3.slice(0,5)) console.log('  color '+c+': '+n+' tiles');

// DFS
const ev = new Map<number,number>();
for (const t of allTiles) ev.set(t.id, r.assignments.get(t.id)??1);
const game = createGame({terrainTiles:allTiles, elementValues:ev});
const dfs = solveDFS(game, {timeoutMs:10000});
console.log('\nDFS: win='+dfs.win+' states='+dfs.statesVisited+' picks='+dfs.picks.slice(0,20).join(','));

// If DFS wins, check first 3 picks' colors
if (dfs.win && dfs.picks.length >= 3) {
  const c1 = ev.get(dfs.picks[0]), c2=ev.get(dfs.picks[1]), c3=ev.get(dfs.picks[2]);
  console.log('First 3 picks: tiles='+dfs.picks.slice(0,3).join(',')+' colors='+c1+','+c2+','+c3+' same='+(c1===c2&&c2===c3));
}
