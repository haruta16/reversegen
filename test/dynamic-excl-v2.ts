/**
 * Dynamic Excl v2 — correct computation.
 *
 * For each step in the actual path:
 *   1. Take game state BEFORE this step's elimination
 *   2. Compute: which tiles would become clickable IF the 3 specific tiles were eliminated?
 *   3. Check: does any color reach ≥3 clickable?
 *   4. Compare prediction with actual (continuation/death)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadTerrainFromFile } from '../src/terrain-loader.js';
import { decodeFromString, getCanonicalTileOrder } from '../src/replay-serializer.js';
import { createGame, OfflineGame } from '../src/solver/offline-game.js';
import { logger, setLogLevel, LogLevel } from '../src/logger.js';
setLogLevel(LogLevel.Error);

const L = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
const R = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Replays';
const C = join(process.cwd(), '.reversegen-cache', 'board-results-v2');

/**
 * Given game state BEFORE eliminating 3 tiles of `color`,
 * compute: after eliminating those 3, which colors have ≥3 clickable?
 */
function predictAfter(
  game: OfflineGame,
  color: number,
  suitMap: Map<number, number>,
): { nextColors: number[]; freedTiles: Map<number, number> } {
  const clickable = game.deskTiles.filter(t => t.isClickable);
  const ofColor = clickable.filter(t => suitMap.get(t.id) === color);

  if (ofColor.length < 3) return { nextColors: [], freedTiles: new Map() };

  const picked = ofColor.slice(0, 3);
  const pickedIds = new Set(picked.map(t => t.id));

  // Count per-color clickable AFTER elimination
  const afterClickable = new Map<number, number>();
  for (const [, c] of suitMap) { if (!afterClickable.has(c)) afterClickable.set(c, 0); }

  // Start with current clickable (excluding picked)
  for (const t of clickable) {
    if (pickedIds.has(t.id)) continue;
    afterClickable.set(suitMap.get(t.id)!, (afterClickable.get(suitMap.get(t.id)!) ?? 0) + 1);
  }

  // For each blocked tile on desk: would it become clickable?
  const freedTiles = new Map<number, number>();
  for (const tile of game.deskTiles) {
    if (tile.isClickable) continue;
    if (pickedIds.has(tile.id)) continue;

    // Check: are ALL of this tile's remaining blockers among the picked tiles?
    // (plus any blockers that are ALREADY eliminated/not on desk)
    let allBlockersGone = true;
    let blockedByPicked = false;

    for (const depId of tile.config.dependencies) {
      const depTile = game.allTiles.get(depId);
      if (!depTile || depTile.pileType !== 1) continue; // already gone
      if (pickedIds.has(depId)) {
        blockedByPicked = true;
        continue; // this blocker is being eliminated
      }
      // This blocker is still on desk and not being picked → tile stays blocked
      allBlockersGone = false;
      break;
    }

    if (allBlockersGone && blockedByPicked) {
      // This tile becomes clickable
      const tc = suitMap.get(tile.id)!;
      afterClickable.set(tc, (afterClickable.get(tc) ?? 0) + 1);
      freedTiles.set(tc, (freedTiles.get(tc) ?? 0) + 1);
    }
  }

  const nextColors = [...afterClickable.entries()]
    .filter(([, n]) => n >= 3)
    .map(([c]) => c);

  return { nextColors, freedTiles };
}

function main() {
  const files = readdirSync(C).filter(f => f.endsWith('.json'));
  const unsolved: any[] = [];
  for (const f of files) {
    try { const d = JSON.parse(readFileSync(join(C,f),'utf-8')); if (!d.error && d.dfs && !d.dfs.win) unsolved.push(d); } catch {}
  }

  let totalCont = 0, correctCont = 0;
  let totalDeath = 0, correctDeath = 0;
  const detail: string[] = [];

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

      // Replay the actual path step by step
      let game = createGame({terrainTiles:at,elementValues:sm,initialDock:[],eliminatedTileIds:new Set()});
      const path: number[] = [];

      // Build path
      {
        const sim = game.clone();
        for (let s=0;s<20;s++) {
          const cl = sim.deskTiles.filter(t=>t.isClickable);
          const cc = new Map<number,number[]>(); for (const t of cl) { const c=sm.get(t.id)!; if(!cc.has(c))cc.set(c,[]); cc.get(c)!.push(t.id); }
          const tcs = [...cc.entries()].filter(([,ts])=>ts.length>=3);
          if (tcs.length===0) break;
          const col = tcs[0][0]; path.push(col);
          const tiles = cc.get(col)!.slice(0,3).map(id=>sim.allTiles.get(id)!).filter(Boolean);
          if (tiles.length<3) break;
          for (const tile of tiles) try{sim.collect(tile);}catch{break;}
        }
      }

      if (path.length === 0) continue; // depth 0 board

      // Now replay step by step, predicting at each step
      game = createGame({terrainTiles:at,elementValues:sm,initialDock:[],eliminatedTileIds:new Set()});

      for (let i = 0; i < path.length; i++) {
        const color = path[i];
        const isLast = (i === path.length - 1);

        // Predict: after eliminating 3 tiles of `color`, what happens?
        const pred = predictAfter(game, color, sm);

        // Actual: simulate the elimination
        const clickable = game.deskTiles.filter(t => t.isClickable);
        const ofColor = clickable.filter(t => sm.get(t.id) === color);
        const toClick = ofColor.slice(0, 3).map(t => game.allTiles.get(t.id)!).filter(Boolean);

        if (toClick.length < 3) break;
        for (const tile of toClick) {
          try { game.collect(tile); } catch { break; }
        }

        if (isLast) {
          totalDeath++;
          if (pred.nextColors.length === 0) {
            correctDeath++;
          } else {
            detail.push(`Lv${lvl} DEATH step ${i+1}: predicted next=[${pred.nextColors}] but actual=death`);
          }
        } else {
          totalCont++;
          if (pred.nextColors.length > 0) {
            correctCont++;
          } else {
            const actualNext = path[i+1];
            detail.push(`Lv${lvl} CONT step ${i+1}: c${color}→c${actualNext} predicted next=[] but actual=continued (freed: ${[...pred.freedTiles].map(([c,n])=>`c${c}:${n}`).join(' ')})`);
          }
        }
      }

    } catch {}
  }

  console.log(`${'═'.repeat(80)}`);
  console.log(`  CORRECT DYNAMIC PREDICTION (per-step simulation)`);
  console.log(`${'═'.repeat(80)}`);
  console.log();
  console.log(`  Continuation: ${correctCont}/${totalCont} (${(correctCont/totalCont*100).toFixed(0)}%)`);
  console.log(`  Death:        ${correctDeath}/${totalDeath} (${(correctDeath/totalDeath*100).toFixed(0)}%)`);
  console.log(`  Overall:      ${correctCont+correctDeath}/${totalCont+totalDeath} (${((correctCont+correctDeath)/(totalCont+totalDeath)*100).toFixed(0)}%)`);

  if (detail.length > 0) {
    console.log(`\n  Details (first 15):`);
    for (const d of detail.slice(0, 15)) console.log(`    ${d}`);
  }
}

main();
