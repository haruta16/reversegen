import { loadTerrainFromFile, getAllTiles } from '../src/terrain-loader.js';
import { generateV4 } from '../src/generate-v4.js';
import { createGame } from '../src/solver/offline-game.js';
import { solveDFS } from '../src/solver/solver-dfs.js';
import { setLogLevel, LogLevel } from '../src/logger.js';
setLogLevel(LogLevel.Error);
import { join } from 'node:path';

const D='E:/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
const terrains = [100002,100006,100010,100050,100075];

for(const tid of terrains) {
  const t = loadTerrainFromFile(join(D,tid+'.json'));
  const all = getAllTiles(t); const free = all.filter((x:any)=>!x.isConst);
  const steps = Math.floor(free.length/3);
  console.log(`\n${tid} (${free.length}t ${steps}st):`);

  for(const ds of [0, Math.floor(steps/4), Math.floor(steps/2)]) {
    const r = generateV4({terrain:t, solvable:false, deathStep:ds});
    const ev = new Map<number,number>();
    for(const tile of all) ev.set(tile.id, r.assignments.get(tile.id)??1);
    const g = createGame({terrainTiles:all, elementValues:ev});
    const dfs = solveDFS(g, {timeoutMs:15000});
    const mod3ok = r.colorSizes.every((x:number)=>x%3===0);
    const branchAtDs = r.branchLog[ds]??-1;
    const preOk = r.branchLog.slice(0,ds).every((b:number)=>b>=1);
    console.log(`  D@${ds}: V4ok=${r.ok} branch[${ds}]=${branchAtDs} preOk=${preOk} DFSwin=${dfs.win} mod3=${mod3ok} states=${dfs.statesVisited}`);
  }
}
