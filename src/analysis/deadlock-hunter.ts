/**
 * Deadlock Hunter — deep structural analysis of unsolvable boards.
 *
 * Goes beyond aggregate features to identify the SPECIFIC mechanism
 * causing unsolvability. Tests provable patterns:
 *
 *   P1: Mutual dependency cycle (A blocks B, B blocks A, no escape)
 *   P2: Entry bottleneck with dock overflow (only 1 entry point, depSet too large)
 *   P3: Color-count mismatch (tiles of a color blocked by tiles that MUST be in same color)
 *   P4: Sink starvation (last color group's tiles can't all become clickable)
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TerrainData, TerrainTile } from '../types.js';
import { TileState } from '../types.js';
import { loadTerrainFromFile } from '../terrain-loader.js';
import { decodeFromString, getCanonicalTileOrder } from '../replay-serializer.js';
import { buildColorGroupDAG, buildBoardDAG, type ColorGroupDAG, type BoardDAG } from './board-dag.js';
import { computeAllDependencies } from '../dependency-graph.js';
import { logger, setLogLevel, LogLevel } from '../logger.js';
setLogLevel(LogLevel.Error);

// ═══════════════════════════════════════════════════
//  Deep board representation
// ═══════════════════════════════════════════════════

interface DeepBoard {
  levelResId: number;
  replayKey: string;
  freeTiles: TerrainTile[];
  suitMap: Map<number, number>;
  allDeps: Map<number, Set<number>>;
  cgDAG: ColorGroupDAG;
  tDAG: BoardDAG;
  /** For each color, which colors directly block its tiles */
  colorBlockers: Map<number, Set<number>>;
  /** For each color, which colors it directly blocks */
  colorBlocked: Map<number, Set<number>>;
  /** Entry colors: colors whose ALL tiles are clickable at start (no deps on other colors) */
  entryColors: number[];
  /** Exit colors: colors that block NO other colors */
  exitColors: number[];
}

interface DeadlockFinding {
  type: 'DEADLOCK_CYCLE' | 'ENTRY_OVERFLOW' | 'SINK_STARVATION' | 'COLOR_PARITY_TRAP' | 'BOTTLENECK_TILE';
  severity: 'FATAL' | 'LIKELY_FATAL' | 'WARNING';
  description: string;
  /** Which colors are involved */
  colors: number[];
  /** Which tiles are the bottleneck */
  bottleneckTiles: number[];
  /** Can this deadlock be broken? If so, how? */
  canBreak: boolean;
  breakCondition: string;
}

// ═══════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════

function main() {
  // Select unsolved boards from cache
  const cacheDir = join(process.cwd(), '.reversegen-cache', 'board-results-v2');
  const files = readdirSync(cacheDir).filter(f => f.endsWith('.json'));
  const unsolved: any[] = [];
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(join(cacheDir, f), 'utf-8'));
      if (!d.error && d.dfs && !d.dfs.win) unsolved.push(d);
    } catch {}
  }

  console.log(`Analyzing ${unsolved.length} unsolved boards for deadlock patterns...\n`);
  const allFindings: { board: string; findings: DeadlockFinding[] }[] = [];

  for (const b of unsolved) {
    try {
      const deep = loadDeepBoard(b.board.levelResId, b.board.replayKey);
      const findings = huntDeadlocks(deep);

      if (findings.length > 0) {
        allFindings.push({ board: `${b.board.levelResId}/${b.board.replayKey}`, findings });
      }

      // Print findings with FATAL severity
      const fatal = findings.filter(f => f.severity === 'FATAL');
      if (fatal.length > 0) {
        console.log(`${'═'.repeat(60)}`);
        console.log(`  ${b.board.levelResId} — cgEdges:${b.features.cgEdgeCount} colors:${b.features.colorCount} tripleNodes:${b.features.tdagTripleCount}`);
        for (const f of fatal) {
          console.log(`  [${f.type}] ${f.description}`);
          console.log(`    Colors: [${f.colors.join(', ')}]`);
          if (f.bottleneckTiles.length > 0) console.log(`    Bottleneck tiles: [${f.bottleneckTiles.join(', ')}]`);
          console.log(`    Breakable: ${f.canBreak} — ${f.breakCondition}`);
        }
      }
    } catch (e: any) {
      // skip load errors
    }
  }

  // ── Summary ──
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  SUMMARY: Deadlock patterns across ${unsolved.length} unsolved boards`);
  console.log(`${'═'.repeat(60)}`);

  const counts: Record<string, { total: number; fatal: number }> = {};
  for (const { findings } of allFindings) {
    for (const f of findings) {
      if (!counts[f.type]) counts[f.type] = { total: 0, fatal: 0 };
      counts[f.type].total++;
      if (f.severity === 'FATAL') counts[f.type].fatal++;
    }
  }

  for (const [type, c] of Object.entries(counts)) {
    console.log(`  ${type}: ${c.total} occurrences (${c.fatal} fatal)`);
  }

  // ── Deterministic rule candidates ──
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  DETERMINISTIC RULE CANDIDATES`);
  console.log(`${'═'.repeat(60)}`);

  // Check: do ALL unsolved boards have a specific pattern?
  const boardsWithPattern = (pattern: string) =>
    allFindings.filter(b => b.findings.some(f => f.type === pattern && f.severity === 'FATAL')).length;

  for (const type of ['DEADLOCK_CYCLE', 'ENTRY_OVERFLOW', 'SINK_STARVATION', 'COLOR_PARITY_TRAP']) {
    const cnt = boardsWithPattern(type);
    console.log(`  ${type}: ${cnt}/${unsolved.length} boards`);
    if (cnt === unsolved.length) {
      console.log(`    ★ EVERY unsolved board has this pattern!`);
    }
  }

  // Also check solved boards for false positives
  // (Pick 5 random solved boards with high cgEdgeCount to test)
  const solved = [];
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(join(cacheDir, f), 'utf-8'));
      if (!d.error && d.dfs?.win && (d.features.cgEdgeCount || 0) > 150) solved.push(d);
    } catch {}
  }
  const sampleSolved = solved.sort(() => Math.random() - 0.5).slice(0, 10);

  console.log(`\n  False positive check (10 solved high-edge boards):`);
  let falsePositives = 0;
  for (const s of sampleSolved) {
    try {
      const deep = loadDeepBoard(s.board.levelResId, s.board.replayKey);
      const findings = huntDeadlocks(deep);
      const fatal = findings.filter(f => f.severity === 'FATAL');
      if (fatal.length > 0) {
        falsePositives++;
        console.log(`    ✗ ${s.board.levelResId}: ${fatal.map(f => f.type).join(', ')} — FALSE POSITIVE`);
      }
    } catch {}
  }
  console.log(`    False positives: ${falsePositives}/${sampleSolved.length}`);
}

// ═══════════════════════════════════════════════════
//  Load deep board
// ═══════════════════════════════════════════════════

function loadDeepBoard(levelResId: number, replayKey: string): DeepBoard {
  const LEVELS_DIR = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
  const REPLAYS_DIR = '/Users/haruta16/workspace/tilematch/TileMatchShell/Tools/Config/Json/Replays';

  const terrain: TerrainData = loadTerrainFromFile(join(LEVELS_DIR, `${levelResId}.json`));
  const allTiles: TerrainTile[] = [];
  for (const l of terrain.layers) for (const t of l.tiles) allTiles.push(t);
  const freeTiles = allTiles.filter(t => !t.isConst);
  const co = getCanonicalTileOrder(allTiles);

  const rj = JSON.parse(readFileSync(join(REPLAYS_DIR, `${levelResId}.json`), 'utf-8'));
  let entry: any = null;
  for (const [, entries] of Object.entries(rj.replayInfoDict || {})) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries as any[]) { if (e.ReplayKey === replayKey) { entry = e; break; } }
    if (entry) break;
  }
  if (!entry) throw new Error('ReplayKey not found');

  const rd = decodeFromString(entry.ReplayCode);
  if (!rd) throw new Error('Decode failed');

  const c2t = new Map<number, number>();
  for (let i = 0; i < co.length; i++) c2t.set(i, co[i].id);

  const suitMap = new Map<number, number>();
  for (let i = 0; i < rd.instanceArray.length; i++) {
    const tid = c2t.get(i);
    if (tid !== undefined) suitMap.set(tid, (rd.instanceArray[i] & 0x3F) + 1);
  }
  for (const de of rd.dockEntries) {
    const tid = c2t.get(de.tileId);
    if (tid !== undefined) suitMap.set(tid, de.element);
  }

  const allDeps = computeAllDependencies(freeTiles);
  const cgDAG = buildColorGroupDAG(freeTiles, suitMap);
  const tDAG = buildBoardDAG(freeTiles, suitMap);

  // Build detailed color blocker maps
  const colorBlockers = new Map<number, Set<number>>();
  const colorBlocked = new Map<number, Set<number>>();

  for (const [from, to] of cgDAG.edges) {
    const fromColor = cgDAG.nodes[from].color;
    const toColor = cgDAG.nodes[to].color;
    if (!colorBlocked.has(fromColor)) colorBlocked.set(fromColor, new Set());
    if (!colorBlockers.has(toColor)) colorBlockers.set(toColor, new Set());
    colorBlocked.get(fromColor)!.add(toColor);
    colorBlockers.get(toColor)!.add(fromColor);
  }

  // Entry colors: no blockers (all tiles clickable at start, no deps on other colors' tiles)
  const entryColors: number[] = [];
  for (const node of cgDAG.nodes) {
    if (!colorBlockers.has(node.color) || colorBlockers.get(node.color)!.size === 0) {
      // Check: are ALL tiles of this color clickable at start?
      const tiles = freeTiles.filter(t => suitMap.get(t.id) === node.color);
      const allClickable = tiles.every(t => t.dependencies.every(d => {
        return !freeTiles.some(ft => ft.id === d); // dep is not a free tile (const tile or non-existent)
      }));
      if (allClickable) entryColors.push(node.color);
    }
  }

  // Exit colors: block nothing
  const exitColors: number[] = [];
  for (const node of cgDAG.nodes) {
    if (!colorBlocked.has(node.color) || colorBlocked.get(node.color)!.size === 0) {
      exitColors.push(node.color);
    }
  }

  return {
    levelResId, replayKey, freeTiles, suitMap, allDeps,
    cgDAG, tDAG, colorBlockers, colorBlocked,
    entryColors, exitColors,
  };
}

// ═══════════════════════════════════════════════════
//  Deadlock patterns
// ═══════════════════════════════════════════════════

function huntDeadlocks(board: DeepBoard): DeadlockFinding[] {
  const findings: DeadlockFinding[] = [];

  // ── P1: Mutual dependency cycle ──
  findings.push(...findMutualCycles(board));

  // ── P2: Entry bottleneck with overflow ──
  findings.push(...findEntryBottleneck(board));

  // ── P3: Sink starvation ──
  findings.push(...findSinkStarvation(board));

  // ── P4: Bottleneck tiles ──
  findings.push(...findBottleneckTiles(board));

  return findings;
}

// ── P1: Mutual dependency cycle ──
function findMutualCycles(board: DeepBoard): DeadlockFinding[] {
  const findings: DeadlockFinding[] = [];
  const { cgDAG, colorBlockers, colorBlocked } = board;

  // Find bidirectional edges: A → B and B → A
  const bidir = new Set<string>();
  for (const [a, b] of cgDAG.edges) {
    const fromColor = cgDAG.nodes[a].color;
    const toColor = cgDAG.nodes[b].color;
    const reverse = cgDAG.edges.some(([a2, b2]) =>
      cgDAG.nodes[a2].color === toColor && cgDAG.nodes[b2].color === fromColor
    );
    if (reverse) {
      const key = [Math.min(fromColor, toColor), Math.max(fromColor, toColor)].join('|');
      if (!bidir.has(key)) {
        bidir.add(key);

        // Check: can either color be started without the other?
        const canStartFrom = board.entryColors.includes(fromColor);
        const canStartTo = board.entryColors.includes(toColor);

        if (!canStartFrom && !canStartTo) {
          // Neither can start — true deadlock
          findings.push({
            type: 'DEADLOCK_CYCLE',
            severity: 'FATAL',
            description: `Mutual blocking: color ${fromColor} ↔ ${toColor}. Neither can start without the other.`,
            colors: [fromColor, toColor],
            bottleneckTiles: [],
            canBreak: false,
            breakCondition: 'No entry point for either color — requires external tile to break cycle',
          });
        } else if (!canStartFrom || !canStartTo) {
          findings.push({
            type: 'DEADLOCK_CYCLE',
            severity: 'LIKELY_FATAL',
            description: `Partial mutual blocking: only one side can start.`,
            colors: [fromColor, toColor],
            bottleneckTiles: [],
            canBreak: true,
            breakCondition: `Must start from ${canStartFrom ? fromColor : toColor}`,
          });
        }
      }
    }
  }

  // Also check for cycles of length > 2
  // Simple: if there's NO entry color and NO exit color → entire DAG has no start or end point
  if (board.entryColors.length === 0 && board.exitColors.length === 0 && cgDAG.nodes.length > 2) {
    const allColors = cgDAG.nodes.map(n => n.color);
    findings.push({
      type: 'DEADLOCK_CYCLE',
      severity: 'FATAL',
      description: `Global deadlock: 0 entry colors + 0 exit colors among ${allColors.length} colors. No color can be first or last.`,
      colors: allColors,
      bottleneckTiles: [],
      canBreak: false,
      breakCondition: 'Requires at least one color to have no blockers OR block nothing',
    });
  }

  return findings;
}

// ── P2: Entry bottleneck ──
function findEntryBottleneck(board: DeepBoard): DeadlockFinding[] {
  const findings: DeadlockFinding[] = [];
  const { entryColors, freeTiles, suitMap, allDeps } = board;

  if (entryColors.length === 0) return findings; // No entry at all → covered by P1

  if (entryColors.length === 1) {
    const entryColor = entryColors[0];
    // Calculate: if we start with this color, what's the dock pressure?
    const tiles = freeTiles.filter(t => suitMap.get(t.id) === entryColor);
    // Each tile in this color, when clicked, goes to dock. Dependencies are auto-satisfied (it's entry).
    // The depSet of eliminating all triples of this color:
    const colorDepSet = new Set<number>();
    for (const t of tiles) {
      colorDepSet.add(t.id);
      const deps = allDeps.get(t.id);
      if (deps) for (const d of deps) colorDepSet.add(d);
    }

    const tileCount = tiles.length;
    const depSetSize = colorDepSet.size;
    const netPressure = depSetSize - tileCount; // new tiles that would enter dock

    if (netPressure > 7) {
      findings.push({
        type: 'ENTRY_OVERFLOW',
        severity: 'FATAL',
        description: `Single entry color ${entryColor}: ${tileCount} tiles, depSet ${depSetSize}, net dock pressure ${netPressure} > 7. Dock will overflow before any match.`,
        colors: [entryColor],
        bottleneckTiles: tiles.map(t => t.id),
        canBreak: false,
        breakCondition: `Need at least one more color with independent entry tiles to reduce pressure`,
      });
    }
  }

  // Check: among all colors, is there ANY path to start?
  if (entryColors.length === 0) {
    // No color's tiles are ALL clickable → need to check if ANY tile is clickable
    const clickableTiles = freeTiles.filter(t => {
      return t.dependencies.every(d => {
        const depTile = freeTiles.find(ft => ft.id === d);
        return !depTile; // dep is not a free tile
      });
    });

    if (clickableTiles.length === 0) {
      findings.push({
        type: 'ENTRY_OVERFLOW',
        severity: 'FATAL',
        description: 'No clickable tiles exist at start — every tile depends on at least one other free tile',
        colors: [],
        bottleneckTiles: [],
        canBreak: false,
        breakCondition: 'Impossible to start — all tiles are mutually blocked',
      });
    }
  }

  return findings;
}

// ── P3: Sink starvation ──
function findSinkStarvation(board: DeepBoard): DeadlockFinding[] {
  const findings: DeadlockFinding[] = [];
  const { exitColors, freeTiles, suitMap } = board;

  if (exitColors.length === 0 && board.cgDAG.nodes.length > 1) {
    findings.push({
      type: 'SINK_STARVATION',
      severity: 'LIKELY_FATAL',
      description: `No exit color: every color blocks at least one other. Final step has no guaranteed finishing move.`,
      colors: board.cgDAG.nodes.map(n => n.color),
      bottleneckTiles: [],
      canBreak: false,
      breakCondition: 'Need at least one color that blocks nothing (exit)',
    });
  }

  // Check exit colors: do they have enough tiles to form their own triples?
  if (exitColors.length === 1) {
    const exitColor = exitColors[0];
    const tiles = freeTiles.filter(t => suitMap.get(t.id) === exitColor);
    if (tiles.length % 3 !== 0) {
      findings.push({
        type: 'SINK_STARVATION',
        severity: 'FATAL',
        description: `Single exit color ${exitColor} has ${tiles.length} tiles (not divisible by 3) — impossible to eliminate all`,
        colors: [exitColor],
        bottleneckTiles: tiles.map(t => t.id),
        canBreak: false,
        breakCondition: 'Color tile count must be divisible by 3',
      });
    }
  }

  return findings;
}

// ── P4: Bottleneck tiles ──
function findBottleneckTiles(board: DeepBoard): DeadlockFinding[] {
  const findings: DeadlockFinding[] = [];
  const { freeTiles, suitMap, allDeps } = board;

  // Count: for each tile, how many OTHER tiles' dependencies include it?
  const blockedCount = new Map<number, number>();
  for (const t of freeTiles) {
    blockedCount.set(t.id, 0);
  }
  for (const t of freeTiles) {
    for (const depId of t.dependencies) {
      const cur = blockedCount.get(depId) ?? 0;
      blockedCount.set(depId, cur + 1);
    }
  }

  // Find tiles that block many others AND are deeply buried
  const bottlenecks: number[] = [];
  for (const [tid, count] of blockedCount) {
    if (count >= 5) {
      // Check: does this tile itself have many dependencies?
      const tile = freeTiles.find(t => t.id === tid);
      if (tile && tile.dependencies.length >= 3) {
        bottlenecks.push(tid);
      }
    }
  }

  if (bottlenecks.length > 0) {
    const colorSet = new Set<number>();
    for (const tid of bottlenecks) {
      colorSet.add(suitMap.get(tid) ?? 0);
    }

    findings.push({
      type: 'BOTTLENECK_TILE',
      severity: 'WARNING',
      description: `${bottlenecks.length} bottleneck tiles block 5+ others while being deeply buried themselves. Colors: [${[...colorSet].join(', ')}]`,
      colors: [...colorSet],
      bottleneckTiles: bottlenecks,
      canBreak: false,
      breakCondition: 'Bottleneck tiles must be freed before dependent tiles can be clicked',
    });
  }

  return findings;
}

main();
