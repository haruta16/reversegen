/**
 * Dynamic Exclusive Block: recompute excl matrix after each elimination step.
 * Hypothesis: death at step K iff after step K, the current color's
 * dynamic excl < 3 for ALL target colors.
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

/**
 * Build dynamic exclusive block matrix given current eliminated tile IDs.
 * Only considers tiles still on desk.
 */
function buildDynamicExcl(
  freeTiles: any[],
  suitMap: Map<number, number>,
  eliminatedIds: Set<number>,
  colors: number[],
): Map<number, Map<number, number>> {
  const excl = new Map<number, Map<number, number>>();
  for (const c of colors) { excl.set(c, new Map()); for (const c2 of colors) excl.get(c)!.set(c2, 0); }

  for (const tile of freeTiles) {
    if (eliminatedIds.has(tile.id)) continue;

    const blk = new Set<number>();
    for (const depId of tile.dependencies) {
      // Only count blocker if it's STILL on desk (not yet collected/eliminated)
      if (eliminatedIds.has(depId)) continue;
      const bc = suitMap.get(depId);
      if (bc !== undefined && bc !== suitMap.get(tile.id)) {
        blk.add(bc);
      }
    }

    if (blk.size === 1) {
      const soleBlocker = [...blk][0];
      excl.get(soleBlocker)!.set(
        suitMap.get(tile.id)!,
        (excl.get(soleBlocker)!.get(suitMap.get(tile.id)!) ?? 0) + 1,
      );
    }
  }

  return excl;
}

function main() {
  const files = readdirSync(C).filter(f => f.endsWith('.json'));
  const unsolved: any[] = [];
  for (const f of files) {
    try { const d = JSON.parse(readFileSync(join(C,f),'utf-8')); if (!d.error && d.dfs && !d.dfs.win) unsolved.push(d); } catch {}
  }

  let totalContSteps = 0, correctCont = 0;
  let totalDeathSteps = 0, correctDeath = 0;
  const violations: string[] = [];

  for (const b of unsolved) {
    try {
      const lvl = b.board.levelResId, key = b.board.replayKey;
      const t = loadTerrainFromFile(join(L,`${lvl}.json`));
      const at: any[] = []; for (const ly of t.layers) for (const ti of ly.tiles) at.push(ti);
      const ft = at.filter((t:any)=>!t.isConst);
      const co = getCanonicalTileOrder(at);
      const rj = JSON.parse(readFileSync(join(R,`${lvl}.json`),'utf-8'));
      let e: any = null;
      for (const [,es] of Object.entries(rj.replayInfoDict||{})) {
        if (!Array.isArray(es)) continue;
        for (const x of es as any[]) { if (x.ReplayKey===key) { e=x; break; } } if (e) break;
      }
      if (!e) continue;
      const rd = decodeFromString(e.ReplayCode)!;
      const c2t = new Map<number,number>();
      for (let i=0;i<co.length;i++) c2t.set(i,co[i].id);
      const sm = new Map<number,number>();
      for (let i=0;i<rd.instanceArray.length;i++) { const tid=c2t.get(i); if (tid!==undefined) sm.set(tid,(rd.instanceArray[i]&0x3F)+1); }
      const colors = [...new Set(sm.values())].sort((a,b)=>a-b);

      // ── Run actual path ──
      const sim = (createGame({terrainTiles:at,elementValues:sm,initialDock:[],eliminatedTileIds:new Set()})).clone();
      const path: number[] = [];
      const eliminated = new Set<number>();

      for (let s=0;s<20;s++) {
        const cl = sim.deskTiles.filter(t=>t.isClickable);
        const cc = new Map<number,number[]>(); for (const t of cl) { const c=sm.get(t.id)!; if(!cc.has(c))cc.set(c,[]); cc.get(c)!.push(t.id); }
        const tcs = [...cc.entries()].filter(([,ts])=>ts.length>=3);
        if (tcs.length===0) break;
        const color = tcs[0][0]; path.push(color);
        const tiles = cc.get(color)!.slice(0,3).map(id=>sim.allTiles.get(id)!).filter(Boolean);
        if (tiles.length<3) break;
        for (const tile of tiles) {
          try { sim.collect(tile); eliminated.add(tile.id); } catch { break; }
        }
      }

      // ── Step-by-step dynamic excl check ──
      const stepEliminated = new Set<number>();

      for (let i=0; i<path.length; i++) {
        const color = path[i];

        // Eliminate 3 tiles of this color from the simulation's desk tiles
        // For dynamic excl: we need to know which 3 tiles were clicked
        // Re-simulate step by step to track eliminated tiles
        if (i===0) {
          // First step: find 3 clickable tiles of this color
          const g0 = createGame({terrainTiles:at,elementValues:sm,initialDock:[],eliminatedTileIds:new Set()});
          const c0 = g0.deskTiles.filter(t=>t.isClickable && sm.get(t.id)===color);
          const picked = c0.slice(0,3);
          for (const p of picked) stepEliminated.add(p.id);
          // Simulate collecting them
          for (const p of picked) { const tl=g0.allTiles.get(p.id); if(tl) try{g0.collect(tl);stepEliminated.add(p.id);}catch{} }
        } else {
          // Replay from start to get state at step i
          const gi = createGame({terrainTiles:at,elementValues:sm,initialDock:[],eliminatedTileIds:new Set()});
          for (let j=0; j<i; j++) {
            const clj = gi.deskTiles.filter(t=>t.isClickable);
            const ccj = new Map<number,number[]>(); for (const t of clj) { const cj=sm.get(t.id)!; if(!ccj.has(cj))ccj.set(cj,[]); ccj.get(cj)!.push(t.id); }
            const pj = ccj.get(path[j])!.slice(0,3).map(id=>gi.allTiles.get(id)!).filter(Boolean);
            for (const p of pj) { try{gi.collect(p); if(j===i-1)stepEliminated.add(p.id);}catch{} }
          }
          // Now get the 3 tiles of current color and mark them
          const cli = gi.deskTiles.filter(t=>t.isClickable);
          const cci = new Map<number,number[]>(); for (const t of cli) { const cj=sm.get(t.id)!; if(!cci.has(cj))cci.set(cj,[]); cci.get(cj)!.push(t.id); }
          const picked = cci.get(color)?.slice(0,3).map(id=>gi.allTiles.get(id)!).filter(Boolean) ?? [];
          for (const p of picked) stepEliminated.add(p.id);
        }

        // Build dynamic excl matrix BEFORE this step's elimination
        const dynExcl = buildDynamicExcl(ft, sm, stepEliminated, colors);
        const exclRow = dynExcl.get(color)!;

        let maxExcl = 0, maxTarget = 0;
        for (const [tgt, cnt] of exclRow) { if (cnt > maxExcl) { maxExcl = cnt; maxTarget = tgt; } }

        const isLast = (i === path.length - 1);

        if (isLast) {
          totalDeathSteps++;
          if (maxExcl < 3) {
            correctDeath++;
          } else {
            violations.push(`Lv${lvl} DEATH step ${i+1}: c${color} excl_max=c${maxTarget}:${maxExcl} ≥ 3 but DIED`);
          }
        } else {
          totalContSteps++;
          const nextColor = path[i+1];
          if (maxExcl >= 3 || (exclRow.get(nextColor) ?? 0) >= 3) {
            correctCont++;
          } else {
            violations.push(`Lv${lvl} CONT step ${i+1}: c${color}→c${nextColor} excl=${exclRow.get(nextColor)} max=${maxExcl} < 3 but CONTINUED`);
          }
        }

        // For next iteration: add this step's eliminated tiles to the cumulative set
        // (Actually, the stepEliminated already includes them from the re-simulation above)
      }

    } catch (e:any) { /* skip */ }
  }

  // ── Report ──
  console.log(`${'═'.repeat(80)}`);
  console.log(`  DYNAMIC EXCLUSIVE BLOCK VERIFICATION`);
  console.log(`${'═'.repeat(80)}`);
  console.log();
  console.log(`  Continuation steps:`);
  console.log(`    Total:     ${totalContSteps}`);
  console.log(`    Correct:   ${correctCont} (${(correctCont/totalContSteps*100).toFixed(1)}%)`);
  console.log(`    Wrong:     ${totalContSteps-correctCont}`);
  console.log();
  console.log(`  Death steps:`);
  console.log(`    Total:     ${totalDeathSteps}`);
  console.log(`    Correct:   ${correctDeath} (${(correctDeath/totalDeathSteps*100).toFixed(1)}%)`);
  console.log(`    Wrong:     ${totalDeathSteps-correctDeath}`);

  if (violations.length > 0) {
    console.log(`\n  Violations (${violations.length}):`);
    for (const v of violations.slice(0, 15)) console.log(`    ${v}`);
  }

  console.log(`\n${'═'.repeat(80)}`);
  const overall = (correctCont + correctDeath) / (totalContSteps + totalDeathSteps) * 100;
  console.log(`  Overall: ${(correctCont+correctDeath)}/${(totalContSteps+totalDeathSteps)} (${overall.toFixed(1)}%)`);
}

main();
