import { loadTerrainFromFile, getAllTiles } from '../src/terrain-loader.js';
import { setLogLevel, LogLevel } from '../src/logger.js';
setLogLevel(LogLevel.Error);
import { join } from 'node:path';

const D='E:/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
const terrain = loadTerrainFromFile(join(D,'100002.json'));
const allTiles = getAllTiles(terrain);
const freeTiles = allTiles.filter((t:any)=>!t.isConst);

// Build graph
const tileMap = new Map<number,any>();
const nodes = new Map<number,{id:number,freeDeps:number[],blocks:number[]}>();
for(const t of freeTiles) tileMap.set(t.id,t);
for(const t of freeTiles) {
  nodes.set(t.id,{id:t.id,freeDeps:t.dependencies.filter((d:number)=>tileMap.has(d)),blocks:[]});
}
for(const t of freeTiles){
  const n=nodes.get(t.id);
  if(!n)continue;
  for(const d of n.freeDeps){const bn=nodes.get(d);if(bn)bn.blocks.push(t.id);}
}

// Classify
const F:number[]=[],B:number[]=[];
for(const [tid,n] of nodes){
  if(n.freeDeps.length===0)F.push(tid);
  else B.push(tid);
}
console.log('100002: F='+F.length+' B='+B.length+' total='+(F.length+B.length));
console.log('B>=F/2?',B.length,'>=',Math.ceil(F.length/2),'=',B.length>=Math.ceil(F.length/2));

// Precompute blocking
const freeBlocks=new Map<number,Set<number>>();
for(const fid of F){
  const nd=nodes.get(fid);const set=new Set<number>();
  if(nd)for(const bid of nd.blocks){if(B.includes(bid))set.add(bid)}
  freeBlocks.set(fid,set);
}
const blockedBy=new Map<number,number[]>();
for(const bid of B){
  const nd=nodes.get(bid);const bl:number[]=[];
  if(nd)for(const depId of nd.freeDeps){if(F.includes(depId))bl.push(depId)}
  blockedBy.set(bid,bl);
}

// Greedy CSP: ≤2 freed per color, no same-color blocking
const free=[...F],blocked=[...B];
const assignments=new Map<number,number>();
let c=1,colors=0;

while(free.length>0){
  const groupFreed:number[]=[];
  for(let take=0;take<2&&free.length>0;take++){
    let bestIdx=0,bestCnt=Infinity;
    for(let i=0;i<Math.min(free.length,50);i++){
      const cnt=freeBlocks.get(free[i])?.size??0;
      if(cnt<bestCnt){bestCnt=cnt;bestIdx=i}
    }
    groupFreed.push(free.splice(bestIdx,1)[0]);
  }

  const need=3-groupFreed.length;
  const candidates:number[]=[];
  for(let i=blocked.length-1;i>=0&&candidates.length<need;i--){
    const bid=blocked[i];
    const bl=blockedBy.get(bid)??[];
    if(groupFreed.some(fid=>bl.includes(fid)))continue;
    let ok=true;
    const bnd=nodes.get(bid);
    for(const cid of candidates){
      if(bnd&&bnd.blocks.includes(cid)){ok=false;break}
      const cnd=nodes.get(cid);
      if(cnd&&cnd.blocks.includes(bid)){ok=false;break}
    }
    if(!ok)continue;
    candidates.push(bid);
  }

  if(candidates.length<need){console.log('CSP broke: need='+need+' found='+candidates.length+' freeLeft='+free.length);break}
  for(const bid of candidates)blocked.splice(blocked.indexOf(bid),1);
  for(const fid of groupFreed)assignments.set(fid,c);
  for(const bid of candidates)assignments.set(bid,c);
  c++;colors++;
}

console.log('CSP result: colors='+colors+' freeLeft='+free.length+' blockedLeft='+blocked.length);
// Count freed per color
const colorFreed=new Map<number,number>();
for(const fid of F){const col=assignments.get(fid);if(col)colorFreed.set(col,(colorFreed.get(col)??0)+1)}
const leakColors=[...colorFreed.entries()].filter(([_,n])=>n>=3);
console.log('Colors with ≥3 freed:',leakColors.length);
for(const [col,n] of leakColors.slice(0,5))console.log('  color '+col+': '+n+' freed');
