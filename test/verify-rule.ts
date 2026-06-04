/**
 * Verify: "excl ≥ 3 for some target → chain CAN continue. excl < 3 for all → death."
 * Against all 74 unsolved boards, step by step.
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
    try { const d = JSON.parse(readFileSync(join(C,f),'utf-8')); if (!d.error && d.dfs && !d.dfs.win) unsolved.push(d); } catch {}
  }

  // Stats
  let totalSteps = 0;
  let successfulSteps = 0, successfulStepsWithExclGE3 = 0;
  let deathSteps = 0, deathStepsWithExclAllLT3 = 0;
  let violations: string[] = [];

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
      const g = createGame({terrainTiles:at,elementValues:sm,initialDock:[],eliminatedTileIds:new Set()});
      const colors = [...new Set(sm.values())].sort((a,b)=>a-b);

      // Build initial exclusive block matrix
      function buildMatrix() {
        const excl = new Map<number,Map<number,number>>();
        for (const c of colors) { excl.set(c,new Map()); for (const c2 of colors) excl.get(c)!.set(c2,0); }
        for (const tile of ft) {
          const blk = new Set<number>();
          for (const dep of tile.dependencies) { const bc=sm.get(dep); if (bc!==undefined&&bc!==sm.get(tile.id)) blk.add(bc); }
          if (blk.size===1) { const sb=[...blk][0]; excl.get(sb)!.set(sm.get(tile.id)!,(excl.get(sb)!.get(sm.get(tile.id)!)??0)+1); }
        }
        return excl;
      }

      const exclMatrix = buildMatrix();

      // Initial check for depth 0 boards
      const initClk = g.deskTiles.filter(t=>t.isClickable);
      const initCC = new Map<number,number>(); for (const c of colors) initCC.set(c,0);
      for (const t of initClk) initCC.set(sm.get(t.id)!,(initCC.get(sm.get(t.id)!)!+1));
      const startColors = [...initCC.entries()].filter(([,n])=>n>=3).map(([c])=>c);

      // Run actual path
      const sim = g.clone();
      const path: number[] = [];
      for (let s=0;s<20;s++) {
        const cl = sim.deskTiles.filter(t=>t.isClickable);
        const cc = new Map<number,number[]>(); for (const t of cl) { const c=sm.get(t.id)!; if(!cc.has(c))cc.set(c,[]); cc.get(c)!.push(t.id); }
        const tcs = [...cc.entries()].filter(([,ts])=>ts.length>=3);
        if (tcs.length===0) break;
        const color = tcs[0][0]; path.push(color);
        const tiles = cc.get(color)!.slice(0,3).map(id=>sim.allTiles.get(id)!).filter(Boolean);
        if (tiles.length<3) break;
        for (const tile of tiles) try{sim.collect(tile);}catch{break;}
      }

      totalSteps += path.length;

      // Check each step
      for (let i = 0; i < path.length; i++) {
        const color = path[i];
        const exclRow = exclMatrix.get(color)!;

        // Find max exclusive block for this color
        let maxExcl = 0, maxTarget = 0;
        for (const [tgt, cnt] of exclRow) { if (cnt > maxExcl) { maxExcl = cnt; maxTarget = tgt; } }

        const isDeathStep = (i === path.length - 1);

        if (isDeathStep) {
          deathSteps++;
          if (maxExcl < 3) {
            deathStepsWithExclAllLT3++;
          } else {
            violations.push(`Lv${lvl} death step ${i+1}: c${color} excl_max=c${maxTarget}:${maxExcl} — SHOULD continue but died!`);
          }
        } else {
          successfulSteps++;
          if (maxExcl >= 3) {
            successfulStepsWithExclGE3++;
          } else {
            // Successful step but maxExcl < 3 — how?
            // Check: did the next color already have clickable tiles?
            const nextColor = path[i+1];
            const nextExcl = exclRow.get(nextColor) ?? 0;
            violations.push(`Lv${lvl} step ${i+1}: c${color}→c${nextColor} excl=${nextExcl} max_excl=c${maxTarget}:${maxExcl} < 3 but succeeded (pre-existing clickable?)`);
          }
        }
      }

    } catch {}
  }

  // ── Report ──
  console.log(`${'═'.repeat(80)}`);
  console.log(`  EXCLUSIVE BLOCK RULE VERIFICATION (${unsolved.length} boards)`);
  console.log(`${'═'.repeat(80)}`);
  console.log();
  console.log(`  Rule:`);
  console.log(`    SUCCESS step:  current color has excl ≥ 3 for SOME target`);
  console.log(`    DEATH step:    current color has excl < 3 for ALL targets`);
  console.log();
  console.log(`  Total steps analyzed:     ${totalSteps}`);
  console.log(`  Successful steps:          ${successfulSteps}`);
  console.log(`    With excl ≥ 3:           ${successfulStepsWithExclGE3} (${(successfulStepsWithExclGE3/successfulSteps*100).toFixed(0)}%)`);
  console.log(`    With excl < 3 (violation): ${successfulSteps-successfulStepsWithExclGE3} (${((successfulSteps-successfulStepsWithExclGE3)/successfulSteps*100).toFixed(0)}%)`);
  console.log();
  console.log(`  Death steps:               ${deathSteps}`);
  console.log(`    With excl < 3 (correct):  ${deathStepsWithExclAllLT3} (${(deathStepsWithExclAllLT3/deathSteps*100).toFixed(0)}%)`);
  console.log(`    With excl ≥ 3 (violation): ${deathSteps-deathStepsWithExclAllLT3}`);

  if (violations.length > 0) {
    console.log(`\n${'═'.repeat(80)}`);
    console.log(`  VIOLATIONS (${violations.length})`);
    console.log(`${'═'.repeat(80)}`);
    for (const v of violations.slice(0, 20)) {
      console.log(`  ${v}`);
    }
  }

  // ── Verdict ──
  console.log(`\n${'═'.repeat(80)}`);
  if (violations.length === 0) {
    console.log(`  ★ VERIFIED: Rule holds for ALL ${totalSteps} steps across ${unsolved.length} boards`);
  } else {
    console.log(`  ⚠ ${violations.length} violations found`);
    const deathViolations = violations.filter(v => v.includes('SHOULD continue but died'));
    const successViolations = violations.filter(v => v.includes('but succeeded'));
    console.log(`    Death violations (excl≥3 but died): ${deathViolations.length}`);
    console.log(`    Success violations (excl<3 but succeeded): ${successViolations.length}`);
  }
}

main();
