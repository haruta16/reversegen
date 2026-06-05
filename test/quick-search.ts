import { loadTerrainFromFile, getAllTiles } from '../src/terrain-loader.js';
import { searchDeath } from '../src/dag-death.js';
import { createGame } from '../src/solver/offline-game.js';
import { solveDFS } from '../src/solver/solver-dfs.js';
import { setLogLevel, LogLevel } from '../src/logger.js';
setLogLevel(LogLevel.Error);
import { join } from 'node:path';
import { readdirSync } from 'node:fs';

const D='E:/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
const files=readdirSync(D).filter(f=>f.endsWith('.json'));
const ids=files.map(f=>parseInt(f.replace('.json',''),10)).filter(id=>id!==100001).sort((a,b)=>a-b);

console.log(`Processing ${ids.length} terrains...`);
let found=0,confirmed=0;

for(const tid of ids) {
  const terrain=loadTerrainFromFile(join(D,`${tid}.json`));
  const f=Math.floor(getAllTiles(terrain).filter(t=>!t.isConst).length/3);
  if(f<2) continue;

  const r=searchDeath(terrain);

  let dfsWin:boolean|null=null;
  if(r.success&&r.deathColors>0){
    try{
      const allTiles=getAllTiles(terrain);
      const ev=new Map<number,number>();
      for(const t of allTiles){ev.set(t.id,r.assignments.get(t.id)??1)}
      const g=createGame({terrainTiles:allTiles,elementValues:ev});
      const dfs=solveDFS(g,{timeoutMs:5000});
      dfsWin=dfs.win;
    }catch{dfsWin=null}
  }

  const status=r.success?(dfsWin===false?'✅':'❌DFS'):'·';
  console.log(`${status} ${String(tid).padEnd(8)} ${String(r.deathStep).padStart(3)} ${r.reason.slice(0,50)}`);
  if(r.success){found++;if(dfsWin===false)confirmed++}
}

console.log(`\nFound: ${found}/${ids.length} | Confirmed: ${confirmed}/${ids.length}`);
