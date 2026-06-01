#!/usr/bin/env node
/**
 * CLI tool for ReverseGen board generation.
 *
 * Usage:
 *   npx tsx cli/generate.ts [options]
 *
 * Examples:
 *   # Generate from terrain JSON with cost array
 *   npx tsx cli/generate.ts --terrain level.json --cost 3,3,2,2,2,1 --colors 8
 *
 *   # JSON output for piping
 *   npx tsx cli/generate.ts --terrain level.json --cost 3,3,2 --colors 6 --json
 *
 *   # Quiet mode (just the ReplayCode)
 *   npx tsx cli/generate.ts --terrain level.json --cost 3,3,2 --colors 6 -q
 */

import { parseArgs } from 'node:util';
import {
  generateBoard,
  loadTerrainFromFile,
  printTerrainSummary,
  setLogLevel,
  LogLevel,
  looksLikeReplayCode,
  decodeFromString,
  formatHash,
} from '../src/index.js';

// ── CLI Argument Parsing ──

const { values } = parseArgs({
  options: {
    terrain:       { type: 'string', short: 't' },
    cost:          { type: 'string', short: 'c' },
    colors:        { type: 'string', short: 'k', default: '99' },
    hash:          { type: 'string' },
    json:          { type: 'boolean', short: 'j', default: false },
    quiet:         { type: 'boolean', short: 'q', default: false },
    verbose:       { type: 'boolean', short: 'v', default: false },
    decode:        { type: 'string', short: 'd' },
    help:          { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: false,
});

// ── Help ──

if (values.help) {
  console.log(`
ReverseGen Board Generator — Standalone CLI
═══════════════════════════════════════════

USAGE:
  npx tsx cli/generate.ts [OPTIONS]

OPTIONS:
  -t, --terrain <path>   Path to terrain JSON file (Unity level format) (required)
  -c, --cost <array>     Cost array, comma-separated (e.g. "3,3,2,2,2,1") (required)
  -k, --colors <n>       花色数量 (默认: 99)
  --hash <hex>           Level hash override (16-char hex)
  -j, --json             Output results as JSON
  -q, --quiet            Output only the ReplayCode
  -v, --verbose          Verbose logging (debug level)
  -d, --decode <code>    Decode a ReplayCode and print its contents
  -h, --help             Show this help

EXAMPLES:
  # Generate from terrain file with cost targets
  npx tsx cli/generate.ts -t level.json -c 3,3,2,2,2,1 -k 8

  # JSON output
  npx tsx cli/generate.ts -t level.json -c 3,3,2 -k 6 --json

  # Decode a ReplayCode
  npx tsx cli/generate.ts -d "eJx1kEs..."

  # Pipe ReplayCode to clipboard (macOS)
  npx tsx cli/generate.ts -t level.json -c 3,3,2 -k 6 -q | pbcopy
`);
  process.exit(0);
}

// ── Log Level ──

if (values.quiet) {
  setLogLevel(LogLevel.Silent);
} else if (values.verbose) {
  setLogLevel(LogLevel.Debug);
}

// ── Decode Mode ──

if (values.decode) {
  const code = values.decode;
  console.log(`Decoding ReplayCode: ${code.substring(0, 40)}...`);

  if (!looksLikeReplayCode(code)) {
    console.error('Error: Input does not look like a valid ReplayCode');
    process.exit(1);
  }

  const data = decodeFromString(code);
  if (!data) {
    console.error('Error: Failed to decode ReplayCode');
    process.exit(1);
  }

  console.log(`\n── ReplayCode Decoded ──`);
  console.log(`  Version:       ${data.version}`);
  console.log(`  Tile count:    ${data.instanceArray.length}`);
  console.log(`  Element count: ${data.elementCount}`);
  console.log(`  Level hash:    ${formatHash(data.levelHash)}`);
  console.log(`  Dock entries:  ${data.dockEntries.length}`);

  if (data.dockEntries.length > 0) {
    console.log(`  Dock:`);
    for (const entry of data.dockEntries) {
      console.log(`    tileId=${entry.tileId} element=${entry.element}`);
    }
  }

  // Show element distribution
  const elementCounts = new Map<number, number>();
  for (let i = 0; i < data.instanceArray.length; i++) {
    const elemIdx = data.instanceArray[i] & 0x3F;
    const ev = elemIdx + 1;
    elementCounts.set(ev, (elementCounts.get(ev) ?? 0) + 1);
  }

  console.log(`  Element distribution:`);
  for (const [elem, count] of [...elementCounts.entries()].sort((a, b) => a[0] - b[0])) {
    const bar = '█'.repeat(Math.round(count / data.instanceArray.length * 40));
    console.log(`    ${String(elem).padStart(2)}: ${String(count).padStart(4)} ${bar}`);
  }

  // Show first few instance bytes
  console.log(`  First 10 instance bytes:`);
  for (let i = 0; i < Math.min(10, data.instanceArray.length); i++) {
    const b = data.instanceArray[i];
    const state = (b >> 6) & 0x3;
    const elemIdx = b & 0x3F;
    console.log(`    [${i}]: state=${state} elemIdx=${elemIdx} elemValue=${elemIdx + 1}`);
  }

  process.exit(0);
}

// ── Generate Mode ──

try {
  const colorCount = parseInt(values.colors!, 10);
  if (isNaN(colorCount) || colorCount < 1 || colorCount > 99) {
    console.error('Error: --colors must be between 1 and 99');
    process.exit(1);
  }

  // Parse cost array (required)
  if (!values.cost) {
    console.error('Error: --cost <array> is required (e.g. --cost 3,3,2,2,2,1)');
    process.exit(1);
  }
  const costArray = values.cost.split(',').map(s => {
    const n = parseInt(s.trim(), 10);
    if (isNaN(n) || n < 1) {
      console.error(`Error: invalid cost value '${s}' in cost array`);
      process.exit(1);
    }
    return n;
  });

  // Load terrain
  if (!values.terrain) {
    console.error('Error: --terrain <path> is required');
    console.error('Use --help for usage information');
    process.exit(1);
  }
  const terrain = loadTerrainFromFile(values.terrain);
  if (!values.quiet && !values.json) {
    printTerrainSummary(terrain);
  }

  // Run generation
  const result = generateBoard({
    terrain,
    costArray,
    colorCount,
    levelHash: values.hash,
  });

  if (values.quiet) {
    // Output only the ReplayCode
    console.log(result.replayCode);
  } else if (values.json) {
    // JSON output
    // Convert Map to plain object for JSON serialization
    const assignmentsObj: Record<string, number> = {};
    for (const [k, v] of result.assignments) {
      assignmentsObj[String(k)] = v;
    }
    const constAssignmentsObj: Record<string, number> = {};
    for (const [k, v] of result.constAssignments) {
      constAssignmentsObj[String(k)] = v;
    }

    console.log(JSON.stringify({
      replayCode: result.replayCode,
      levelHash: result.levelHash,
      completed: result.completed,
      totalSteps: result.totalSteps,
      costLog: result.costLog,
      branchLog: result.branchLog,
      stepLog: result.stepLog,
      assignments: assignmentsObj,
      constAssignments: constAssignmentsObj,
      stats: result.stats,
      banSetSize: result.banSetSize,
      deviationCount: result.deviationCount,
      matchRate: result.matchRate,
    }, null, 2));
  } else {
    // Human-readable output
    console.log(`\n── Results ──`);
    console.log(`  Completed:   ${result.completed}`);
    console.log(`  Total steps: ${result.totalSteps}`);
    console.log(`  Color count: ${colorCount}`);
    console.log(`  Target cost: [${costArray.join(', ')}]`);
    console.log(`  Actual cost: [${result.costLog.join(', ')}]`);
    console.log(`  Branches:    [${result.branchLog.join(', ')}]`);
    console.log(`  Stats:       min=${result.stats.min} max=${result.stats.max} avg=${result.stats.avg.toFixed(1)}`);
    console.log(`  Blacklist:   ${result.banSetSize}`);
    console.log(`  Match rate:  ${result.matchRate.toFixed(0)}% (${result.deviationCount} deviations)`);
    console.log(`  Level hash:  ${result.levelHash}`);

    // ── 步骤详情表 ──
    if (result.stepLog && result.stepLog.length > 0) {
      console.log(`\n── 步骤详情 ──`);
      console.log(`  ${'步'.padEnd(4)} ${'ID'.padEnd(24)} ${'cost'.padEnd(5)} ${'sim'.padEnd(5)} ${'目标'.padEnd(5)} ${'候选'.padEnd(6)} ${'封杀'.padEnd(6)} ${'色'.padEnd(3)} ${'备注'}`);
      console.log(`  ${'─'.repeat(90)}`);
      for (const s of result.stepLog) {
        const ids = `[${s.tileIds.join(',')}]`.padEnd(22);
        const simStr = s.simCost !== undefined ? String(s.simCost).padEnd(5) : '-'.padEnd(5);
        const costStr = (s.target > 0 && s.cost !== s.target)
          ? String(s.cost) + '!'
          : String(s.cost);
        const note = s.rescued ? `⚠抢救(第${s.bannedAtStep}步拉黑)` : '';
        console.log(`  ${String(s.step).padEnd(4)} ${ids} ${costStr.padEnd(5)} ${simStr} ${String(s.target).padEnd(5)} ${String(s.candidateCount).padEnd(6)} ${String(s.bannedCount).padEnd(6)} ${String(s.colorIndex).padEnd(3)} ${note}`);
      }
    }

    console.log(`\n── ReplayCode ──`);
    console.log(`  ${result.replayCode}`);
    console.log(`  (length: ${result.replayCode.length} chars)`);

    // Element distribution
    const elemDist = new Map<number, number>();
    for (const [, ev] of result.assignments) {
      elemDist.set(ev, (elemDist.get(ev) ?? 0) + 1);
    }
    console.log(`\n── Element Distribution (free tiles) ──`);
    for (const [elem, count] of [...elemDist.entries()].sort((a, b) => a[0] - b[0])) {
      const bar = '█'.repeat(Math.round(count / result.totalSteps / 3 * 40));
      console.log(`  ${String(elem).padStart(2)}: ${String(count).padStart(4)} ${bar}`);
    }
  }
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
