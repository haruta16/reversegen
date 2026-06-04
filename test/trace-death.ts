/**
 * Trace death for Type A (post-first-triple death) boards.
 *
 * Simulates the first triple elimination, then analyzes why further progress is impossible.
 * Goal: find the ATOMIC mechanism — which color dependency creates the bottleneck.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadTerrainFromFile } from '../src/terrain-loader.js';
import { decodeFromString, getCanonicalTileOrder } from '../src/replay-serializer.js';
import { createGame, OfflineGame } from '../src/solver/offline-game.js';
import { solveDFS } from '../src/solver/solver-dfs.js';
import { buildColorGroupDAG } from '../src/analysis/board-dag.js';
import { computeAllDependencies } from '../src/dependency-graph.js';
import { logger, setLogLevel, LogLevel } from '../src/logger.js';
setLogLevel(LogLevel.Error);

const LEVELS_DIR = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
const REPLAYS_DIR = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Replays';
const cacheDir = join(process.cwd(), '.reversegen-cache', 'board-results-v2');

// ============================================
// Find Type A boards: CanTriple=true at start but still unsolvable
// ============================================
const files = readdirSync(cacheDir).filter(f => f.endsWith('.json'));
const typeABoards: any[] = [];

for (const f of files) {
  try {
    const d = JSON.parse(readFileSync(join(cacheDir, f), 'utf-8'));
    if (!d.error && d.dfs && !d.dfs.win) {
      // Check if it's Type A by loading and checking clickable
      typeABoards.push(d);
    }
  } catch {}
}

function analyzeTypeA(b: any) {
  const levelResId = b.board.levelResId;
  const rk = b.board.replayKey;

  // Load board
  const terrain = loadTerrainFromFile(join(LEVELS_DIR, `${levelResId}.json`));
  const allTiles: any[] = [];
  for (const l of terrain.layers) for (const t of l.tiles) allTiles.push(t);
  const freeTiles = allTiles.filter((t: any) => !t.isConst);
  const co = getCanonicalTileOrder(allTiles);

  const rj = JSON.parse(readFileSync(join(REPLAYS_DIR, `${levelResId}.json`), 'utf-8'));
  let entry: any = null;
  for (const [, entries] of Object.entries(rj.replayInfoDict || {})) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries as any[]) { if (e.ReplayKey === rk) { entry = e; break; } }
    if (entry) break;
  }
  if (!entry) return null;

  const rd = decodeFromString(entry.ReplayCode)!;
  const c2t = new Map<number, number>();
  for (let i = 0; i < co.length; i++) c2t.set(i, co[i].id);

  const suitMap = new Map<number, number>();
  for (let i = 0; i < rd.instanceArray.length; i++) {
    const tid = c2t.get(i);
    if (tid !== undefined) suitMap.set(tid, (rd.instanceArray[i] & 0x3F) + 1);
  }

  const game = createGame({ terrainTiles: allTiles, elementValues: suitMap, initialDock: [], eliminatedTileIds: new Set() });
  const allDeps = computeAllDependencies(freeTiles);
  const cgDAG = buildColorGroupDAG(freeTiles, suitMap);

  // ============================================
  // Step 1: Find all possible first triples
  // ============================================
  const dockCounts = game.getDockCounts();
  const clickable = game.deskTiles.filter(t => t.isClickable);

  // Find colors with ≥3 clickable
  const colorClickable = new Map<number, number[]>();
  for (const t of clickable) {
    const c = suitMap.get(t.id)!;
    if (!colorClickable.has(c)) colorClickable.set(c, []);
    colorClickable.get(c)!.push(t.id);
  }

  const canTripleColors = [...colorClickable.entries()].filter(([, tiles]) => tiles.length >= 3);
  if (canTripleColors.length === 0) {
    return { type: 'B (no first triple)', levelResId };
  }

  // ============================================
  // For EACH possible first triple color, simulate what happens after
  // ============================================
  interface AftermathAnalysis {
    firstTripleColor: number;
    /** State after eliminating the first triple */
    colorsAfter: Map<number, { total: number; clickable: number; canTriple: boolean }>;
    /** Which new colors became clickable */
    newlyClickableColors: Set<number>;
    /** Colors that gained ≥3 clickable (can form next triple) */
    nextTripleColors: number[];
    /** Why can't we continue? (if nextTripleColors is empty) */
    bottleneck: string;
    /** Dock size after first triple */
    dockAfter: number;
  }

  const aftermaths: AftermathAnalysis[] = [];

  for (const [color, clickableTiles] of canTripleColors) {
    // Clone and simulate: click 3 tiles of this color, then let match happen
    const sim = game.clone();

    // Click the 3 clickable tiles
    const tilesToClick = clickableTiles.slice(0, 3).map(tid => sim.allTiles.get(tid)!).filter(Boolean);
    if (tilesToClick.length < 3) continue;

    for (const tile of tilesToClick) {
      sim.collect(tile);
    }

    // Now analyze the aftermath
    const clickableAfter = sim.deskTiles.filter(t => t.isClickable);
    const colorAfter = new Map<number, { total: number; clickableTiles: number[] }>();

    for (const [, c] of suitMap) {
      if (!colorAfter.has(c)) colorAfter.set(c, { total: 0, clickableTiles: [] });
    }
    for (const t of freeTiles) {
      const c = suitMap.get(t.id)!;
      if (sim.allTiles.get(t.id)?.pileType === 1) { // still on desk
        colorAfter.get(c)!.total++;
        if (sim.allTiles.get(t.id)?.isClickable) {
          colorAfter.get(c)!.clickableTiles.push(t.id);
        }
      }
    }
    // Also account for tiles already eliminated
    for (const [, c] of suitMap) {
      const orig = colorAfter.get(c);
      // Count eliminated tiles of this color
      let eliminated = 0;
      for (const t of freeTiles) {
        if (suitMap.get(t.id) === c && sim.allTiles.get(t.id)?.pileType === 9) {
          eliminated++;
        }
      }
      // Adjust total to include eliminated (for correct divisibility check)
      orig!.total += eliminated;
    }

    const nextTripleColors: number[] = [];
    const newlyClickable = new Set<number>();

    for (const [c, info] of colorAfter) {
      if (info.clickableTiles.length >= 3) nextTripleColors.push(c);
      // Check if this color gained clickable tiles
      const origClickable = colorClickable.get(c)?.length ?? 0;
      if (info.clickableTiles.length > origClickable) newlyClickable.add(c);
    }

    let bottleneck = '';
    if (nextTripleColors.length === 0) {
      // WHY is there no next triple?
      const reasons: string[] = [];
      for (const [c, info] of colorAfter) {
        if (info.total >= 3 && info.clickableTiles.length < 3 && info.clickableTiles.length > 0) {
          // This color COULD form a triple but doesn't have enough clickable
          // Show what blocks the remaining tiles
          const remaining = info.total - info.clickableTiles.length;
          for (const t of freeTiles) {
            if (suitMap.get(t.id) === c && sim.allTiles.get(t.id)?.pileType === 1 && !sim.allTiles.get(t.id)?.isClickable) {
              const blockers = t.dependencies
                .map((d: number) => suitMap.get(d))
                .filter((bc: number | undefined) => bc !== undefined && bc !== c);
              if (blockers.length > 0) {
                reasons.push(`color ${c}: tile ${t.id} blocked by colors [${[...new Set(blockers)].join(',')}]`);
              }
              break; // just show first blocked tile
            }
          }
        } else if (info.total < 3) {
          reasons.push(`color ${c}: only ${info.total} tiles remain (eliminated)`);
        }
      }
      bottleneck = reasons.join('; ');
    }

    aftermaths.push({
      firstTripleColor: color,
      colorsAfter: new Map([...colorAfter].map(([c, info]) => [c, {
        total: info.total,
        clickable: info.clickableTiles.length,
        canTriple: info.clickableTiles.length >= 3,
      }])),
      newlyClickableColors: newlyClickable,
      nextTripleColors,
      bottleneck,
      dockAfter: sim.dockTiles.length,
    });
  }

  return { type: 'A', levelResId, freeTiles: freeTiles.length, colors: colorClickable.size, aftermaths };
}

// ============================================
// Run analysis on first 10 Type A boards
// ============================================
function main() {
  let typeACount = 0;
  for (const b of typeABoards) {
    if (typeACount >= 8) break;
    let result: any; try { result = analyzeTypeA(b); } catch(e: any) { console.log(`  ERR ${b.board.levelResId}: ${e.message?.slice(0,80)}`); continue; }
    if (!result || !result.type) { console.log(`  NULL ${b.board.levelResId}`); continue; }
    if (!result.type.startsWith('A')) { /* Type B - skip */ continue; }
    typeACount++;

    console.log(`${'═'.repeat(70)}`);
    console.log(`  Level ${result.levelResId} — ${result.freeTiles} tiles, ${result.colors} colors`);
    console.log(`  First triple options: ${result.aftermaths.length} colors`);

    // Show which first-triple colors lead to a next triple
    const withNext = result.aftermaths.filter(a => a.nextTripleColors.length > 0);
    const withoutNext = result.aftermaths.filter(a => a.nextTripleColors.length === 0);

    console.log(`  → ${withNext.length} lead to next triple, ${withoutNext.length} dead-end immediately`);

    // For dead-end paths: show bottleneck
    for (const a of withoutNext.slice(0, 3)) {
      console.log(`\n  Dead-end via color ${a.firstTripleColor}:`);
      console.log(`    Dock after: ${a.dockAfter}`);
      console.log(`    New clickable colors: [${[...a.newlyClickableColors].join(', ')}]`);
      console.log(`    Bottleneck: ${a.bottleneck}`);

      // Show per-color status
      console.log(`    Color status:`);
      const entries = [...a.colorsAfter.entries()]
        .filter(([, info]) => info.total > 0)
        .sort((a, b) => b[1].clickable - a[1].clickable);
      for (const [c, info] of entries.slice(0, 10)) {
        const marker = info.canTriple ? ' ✓ TRIPLE' : info.clickable > 0 ? ` (${info.clickable}/${info.total})` : ' BLOCKED';
        console.log(`      c${String(c).padStart(2)}: ${info.clickable}/${info.total} clickable${marker}`);
      }
    }

    // For paths WITH next triple: what happens after?
    for (const a of withNext.slice(0, 2)) {
      console.log(`\n  Viable via color ${a.firstTripleColor}:`);
      console.log(`    Next triple colors: [${a.nextTripleColors.join(', ')}]`);
      console.log(`    New clickable colors: [${[...a.newlyClickableColors].join(', ')}]`);
      console.log(`    Dock after: ${a.dockAfter}`);
    }
  }

  console.log(`\nAnalyzed ${typeACount} Type A boards`);
}

main();
