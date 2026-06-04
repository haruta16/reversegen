/**
 * Exclusive Blocking: predict death depth from exclusive-block counts.
 *
 * Core: for color A → color B, how many of B's tiles are blocked ONLY by A?
 * If high → eliminating A directly frees B → chain continues.
 * If low → B is multiply-blocked → chain breaks.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadTerrainFromFile } from '../src/terrain-loader.js';
import { decodeFromString, getCanonicalTileOrder } from '../src/replay-serializer.js';
import { createGame } from '../src/solver/offline-game.js';
import { logger, setLogLevel, LogLevel } from '../src/logger.js';
setLogLevel(LogLevel.Error);

const L = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
const R = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Replays';
const C = join(process.cwd(), '.reversegen-cache', 'board-results-v2');

function main() {
  const files = readdirSync(C).filter(f => f.endsWith('.json'));
  const unsolved: any[] = [];
  for (const f of files) {
    try { const d = JSON.parse(readFileSync(join(C, f), 'utf-8')); if (!d.error && d.dfs && !d.dfs.win) unsolved.push(d); } catch {}
  }

  const results: any[] = [];

  for (const b of unsolved) {
    try {
      const lvl = b.board.levelResId;
      const key = b.board.replayKey;
      const t = loadTerrainFromFile(join(L, `${lvl}.json`));
      const at: any[] = []; for (const ly of t.layers) for (const ti of ly.tiles) at.push(ti);
      const ft = at.filter((t: any) => !t.isConst);
      const co = getCanonicalTileOrder(at);
      const rj = JSON.parse(readFileSync(join(R, `${lvl}.json`), 'utf-8'));
      let e: any = null;
      for (const [, es] of Object.entries(rj.replayInfoDict||{})) {
        if (!Array.isArray(es)) continue;
        for (const x of es as any[]) { if (x.ReplayKey === key) { e = x; break; } } if (e) break;
      }
      if (!e) continue;
      const rd = decodeFromString(e.ReplayCode)!;
      const c2t = new Map<number,number>();
      for (let i=0;i<co.length;i++) c2t.set(i,co[i].id);
      const sm = new Map<number,number>();
      for (let i=0;i<rd.instanceArray.length;i++) { const tid=c2t.get(i); if (tid!==undefined) sm.set(tid,(rd.instanceArray[i]&0x3F)+1); }
      const g = createGame({terrainTiles:at,elementValues:sm,initialDock:[],eliminatedTileIds:new Set()});
      const colors = [...new Set(sm.values())].sort((a,b)=>a-b);

      // ── Build exclusive block matrix ──
      const exclBlocks = new Map<number, Map<number, number>>();
      const totalBlocks = new Map<number, Map<number, number>>();
      const tileBlockers = new Map<number, Set<number>>();
      for (const c of colors) { exclBlocks.set(c,new Map()); totalBlocks.set(c,new Map()); for (const c2 of colors) { exclBlocks.get(c)!.set(c2,0); totalBlocks.get(c)!.set(c2,0); }}

      for (const tile of ft) {
        const blk = new Set<number>();
        for (const dep of tile.dependencies) { const bc=sm.get(dep); if (bc!==undefined && bc!==sm.get(tile.id)) blk.add(bc); }
        tileBlockers.set(tile.id, blk);
        for (const bc of blk) { totalBlocks.get(bc)!.set(sm.get(tile.id)!, (totalBlocks.get(bc)!.get(sm.get(tile.id)!)??0)+1); }
        if (blk.size===1) { const sb=[...blk][0]; exclBlocks.get(sb)!.set(sm.get(tile.id)!, (exclBlocks.get(sb)!.get(sm.get(tile.id)!)??0)+1); }
      }

      // ── Initial clickable ──
      const clickable = g.deskTiles.filter(t=>t.isClickable);
      const initClk = new Map<number,number>(); for (const c of colors) initClk.set(c,0);
      for (const t of clickable) initClk.set(sm.get(t.id)!,(initClk.get(sm.get(t.id)!)!+1));
      const startColors = [...initClk.entries()].filter(([,n])=>n>=3).map(([c])=>c);

      // ── Actual death depth (greedy) ──
      const sim = g.clone();
      const actualPath: number[] = [];
      let actualDepth = 0;
      for (let s=0;s<20;s++) {
        const cl = sim.deskTiles.filter(t=>t.isClickable);
        const cc = new Map<number,number[]>(); for (const t of cl) { const c=sm.get(t.id)!; if(!cc.has(c))cc.set(c,[]); cc.get(c)!.push(t.id); }
        const tcs = [...cc.entries()].filter(([,ts])=>ts.length>=3);
        if (tcs.length===0) break;
        const color = tcs[0][0]; actualPath.push(color);
        const tiles = cc.get(color)!.slice(0,3).map(id=>sim.allTiles.get(id)!).filter(Boolean);
        if (tiles.length<3) break;
        for (const tile of tiles) try{sim.collect(tile);}catch{break;}
        actualDepth++;
      }

      // ── Readable summary ──
      const topExcl: string[] = [];
      for (const [c, m] of exclBlocks) {
        const best = [...m.entries()].sort((a,b)=>b[1]-a[1])[0];
        if (best[1] > 0) topExcl.push(`c${c}⊸c${best[0]}:${best[1]}`);
      }

      results.push({
        lvl, ft:ft.length, colors:colors.length,
        startColors,
        actualDepth, actualPath,
        topExcl: topExcl.slice(0,8).join(' '),
        // For each step in actual path: what's the exclusive block count?
        pathExcl: actualPath.map((c,i) => {
          if (i===actualPath.length-1) {
            // Last step: why did chain break?
            const best = [...(exclBlocks.get(c)?.entries()??[])].sort((a,b)=>b[1]-a[1])[0];
            return `c${c}(last):best⊸c${best?.[0]}:${best?.[1]??0}`;
          }
          const next = actualPath[i+1];
          const excl = exclBlocks.get(c)?.get(next)??0;
          const total = totalBlocks.get(c)?.get(next)??0;
          return `c${c}⊸c${next}:excl${excl}/tot${total}`;
        }).join(' '),
      });
    } catch {}
  }

  // ── Print ──
  const byDepth = new Map<number, any[]>();
  for (const r of results) { const d=r.actualDepth; if(!byDepth.has(d))byDepth.set(d,[]); byDepth.get(d)!.push(r); }

  console.log(`${'═'.repeat(100)}`);
  console.log(`  DEATH CHAIN: EXCLUSIVE BLOCK ANALYSIS (${results.length} boards)`);
  console.log(`${'═'.repeat(100)}`);

  for (const [depth, boards] of [...byDepth.entries()].sort((a,b)=>a[0]-b[0])) {
    console.log(`\n── Depth ${depth} (${boards.length} boards) ──`);
    for (const r of boards.slice(0, 3)) {
      console.log(`  Lv${r.lvl} (${r.ft}t ${r.colors}c) start=[${r.startColors.slice(0,3)}] path=[${r.actualPath.join('→')}]`);
      console.log(`    ${r.pathExcl}`);
    }
  }

  // ── Deterministic insight ──
  console.log(`\n${'═'.repeat(100)}`);
  console.log(`  DETERMINISTIC INSIGHT`);
  console.log(`${'═'.repeat(100)}`);

  // For each depth, what's the exclusive block count at the LAST step?
  console.log(`\n  Excl block count at death step (last color → best target):`);
  for (const [depth, boards] of [...byDepth.entries()].sort((a,b)=>a[0]-b[0])) {
    const lastExcls: number[] = [];
    for (const r of boards) {
      const lastColor = r.actualPath[r.actualDepth - 1];
      // Find from the raw data
      const idx = results.indexOf(r);
      if (idx < 0) continue;
      // Re-extract from pathExcl
      const parts = r.pathExcl.split(' ');
      const lastPart = parts[parts.length-1];
      const match = lastPart.match(/:(\d+)$/);
      if (match) lastExcls.push(parseInt(match[1]));
    }
    if (lastExcls.length > 0) {
      const avg = lastExcls.reduce((a,b)=>a+b,0)/lastExcls.length;
      const min = Math.min(...lastExcls);
      const max = Math.max(...lastExcls);
      console.log(`  Depth ${depth}: avg=${avg.toFixed(0)} min=${min} max=${max} (${lastExcls.length} boards)`);
    }
  }
}

main();
