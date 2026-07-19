#!/usr/bin/env node
/**
 * CLI tool for ReverseGen board generation.
 *
 * Usage:
 *   npx tsx cli/generate.ts [options]
 *
 * Examples:
 *   # CostLadder (默认)
 *   npx tsx cli/generate.ts --terrain level.json --cost 3,3,2,2,2,1 --colors 8
 *
 *   # LayerClosure 算法
 *   npx tsx cli/generate.ts --terrain level.json --algorithm closure \
 *     --close-rates 0.3,0.6,0.8 --colors 8 --style uniform
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
  generateBoardLayerClosure,
  generateBoardTileExplorer,
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
    algorithm:     { type: 'string', short: 'a', default: 'cost-ladder' },
    cost:          { type: 'string', short: 'c' },
    colors:        { type: 'string', short: 'k' },
    hash:          { type: 'string' },
    // LayerClosure 算法专用参数
    'close-rates':  { type: 'string' },
        'dock':         { type: 'string', default: '7' },
    'spread':       { type: 'string', default: '0.5' },
    'debt-persistence': { type: 'string', default: '0' },
    // Tile Explorer 算法专用参数
    'te-strategy': { type: 'string', default: 'default' },
    difficulty: { type: 'string', default: '1' },
    'sequence-seed': { type: 'string', default: '0' },
    'placement-seed': { type: 'string', default: '0' },
    'type-cycle': { type: 'string' },
    'type-weights': { type: 'string' },
    'easy-layers': { type: 'string', default: '0' },
    'hard-tag': { type: 'string', default: '1' },
    'lower-coefficient': { type: 'string' },
    'top-coefficient': { type: 'string' },
    'fallback-extra-layers': { type: 'string' },
    'limit-full-first': { type: 'boolean' },
    'solvability-random-mode': { type: 'boolean' },
    'gradient-groups': { type: 'string' },
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
  -t, --terrain <path>     Path to terrain JSON file (Unity level format) (required)
  -a, --algorithm <name>   算法选择: cost-ladder (默认) | closure | tile-explorer
  -k, --colors <n>         花色数量
  --hash <hex>             Level hash override (16-char hex)
  -j, --json               Output results as JSON
  -q, --quiet              Output only the ReplayCode
  -v, --verbose            Verbose logging (debug level)
  -d, --decode <code>      Decode a ReplayCode and print its contents
  -h, --help               Show this help

  CostLadder 算法参数 (-a cost-ladder):
    -c, --cost <array>     Cost 数组 (e.g. "3,3,2,2,2,1")

  LayerClosure 算法参数 (-a closure):
    --close-rates <csv>   每层闭合率 (e.g. "0.3,0.6,0.8")
    --dock <n>            Dock容量 (默认: 7)
    --spread <n>          同色分布 [0-1] 0=紧密 0.5=随机 1=分散 (默认: 0.5)
    --debt-persistence <n> 债务持续权重 [0-1] 0=清旧债 1=延旧债 (默认: 0)

  Tile Explorer 算法参数 (-a tile-explorer):
    --te-strategy <name>   default / top_two_easy / sliding_window / limit_layer_random /
                           easy_hard_easy / solvability_coefficient[_v2|_v3] / color_gradient
    --difficulty <n>       物理层或回退层批量参数 (默认: 1)
    --sequence-seed <n>    花色循环 .NET Random 种子
    --placement-seed <n>   落位 .NET Random 种子
    --type-cycle <csv>     显式花色循环，优先于 --colors
    --type-weights <csv>   各花色权重
    --easy-layers <n>      Default 前置简单批次数
    --hard-tag <n>         难关标签，影响部分策略默认值
    --gradient-groups <j>  ColorGradient 花色分组 JSON，如 [[1,2],[3,4]]

EXAMPLES:
  # CostLadder (默认)
  npx tsx cli/generate.ts -t level.json -c 3,3,2,2,2,1 -k 8

  # LayerClosure
  npx tsx cli/generate.ts -t level.json -a closure \\
    --close-rates 0.3,0.5,0.8 -k 8 --style uniform

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
  const algorithm = values.algorithm ?? 'cost-ladder';

  // Load terrain (required for both algorithms)
  if (!values.terrain) {
    console.error('Error: --terrain <path> is required');
    console.error('Use --help for usage information');
    process.exit(1);
  }
  const terrain = loadTerrainFromFile(values.terrain);
  if (!values.quiet && !values.json) {
    printTerrainSummary(terrain);
  }

  if (algorithm === 'tile-explorer') {
    const colorCount = parseInt(values.colors ?? '5', 10);
    const difficulty = parseInt(values.difficulty ?? '1', 10);
    const sequenceSeed = parseInt(values['sequence-seed'] ?? '0', 10);
    const placementSeed = parseInt(values['placement-seed'] ?? '0', 10);
    const parseIntegerList = (raw: string | undefined, name: string): number[] | undefined => {
      if (!raw?.trim()) return undefined;
      const parsed = raw.split(',').map(value => Number(value.trim()));
      if (parsed.some(value => !Number.isInteger(value))) throw new Error(`${name} 必须是整数 CSV`);
      return parsed;
    };
    const gradientGroups = values['gradient-groups']
      ? JSON.parse(values['gradient-groups']) as number[][]
      : undefined;
    const numberOrUndefined = (raw: string | undefined): number | undefined => {
      if (raw == null || raw.trim() === '') return undefined;
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`无效数字: ${raw}`);
      return value;
    };
    const result = generateBoardTileExplorer({
      terrain,
      strategy: values['te-strategy'] as import('../src/index.js').TileExplorerStrategy,
      difficulty,
      colorCount,
      sequenceSeed,
      placementSeed,
      typeCycle: parseIntegerList(values['type-cycle'], '--type-cycle'),
      tileTypeWeights: parseIntegerList(values['type-weights'], '--type-weights'),
      easyLayerCount: parseInt(values['easy-layers'] ?? '0', 10),
      levelHardTag: parseInt(values['hard-tag'] ?? '1', 10),
      limitFullFirst: values['limit-full-first'],
      solvabilityLowerCoefficient: numberOrUndefined(values['lower-coefficient']),
      solvabilityTopCoefficient: numberOrUndefined(values['top-coefficient']),
      fallbackExtraLayers: numberOrUndefined(values['fallback-extra-layers']),
      solvabilityRandomMode: values['solvability-random-mode'],
      colorGradientTypeGroups: gradientGroups,
      levelHash: values.hash,
    });
    if (values.quiet) console.log(result.replayCode);
    else if (values.json) {
      console.log(JSON.stringify({
        algorithm: 'tile-explorer',
        replayCode: result.replayCode,
        levelHash: result.levelHash,
        strategy: result.strategy,
        assignments: Object.fromEntries(result.assignments),
        groups: Object.fromEntries(result.groups),
        viewLayers: result.viewLayers,
        typeCycle: result.typeCycle,
        generatedGroupCount: result.generatedGroupCount,
        sequenceSeed: result.sequenceSeed,
        placementSeed: result.placementSeed,
      }, null, 2));
    } else {
      console.log('\n── Tile Explorer Results ──');
      console.log(`  策略: ${result.strategy}`);
      console.log(`  逻辑层: ${result.viewLayers.length}`);
      console.log(`  三元组: ${result.generatedGroupCount}`);
      console.log(`  花色循环: [${result.typeCycle.join(',')}]`);
      console.log(`  Sequence/Placement seed: ${result.sequenceSeed} / ${result.placementSeed}`);
      console.log(`  Level hash: ${result.levelHash}`);
      console.log(`\n── ReplayCode ──\n  ${result.replayCode}`);
    }
  } else if (algorithm === 'closure') {
    // ═══ LayerClosure 算法 ═══
    const colorCount = parseInt(values.colors ?? '8', 10);
    if (isNaN(colorCount) || colorCount < 1 || colorCount > 99) {
      console.error('Error: --colors must be between 1 and 99');
      process.exit(1);
    }

    if (!values['close-rates']) {
      console.error('Error: --close-rates <csv> is required for closure algorithm');
      console.error('Example: --close-rates 0.3,0.5,0.8');
      process.exit(1);
    }
    const closeRates = values['close-rates'].split(',').map(s => {
      const n = parseFloat(s.trim());
      if (isNaN(n) || n < 0 || n > 1) {
        console.error(`Error: invalid close rate '${s}' (must be 0-1)`);
        process.exit(1);
      }
      return n;
    });

        const dock = parseInt(values['dock']!, 10) || 7;
    const spread = parseFloat(values['spread']!);
    const spreadParam = isNaN(spread) ? 0.5 : Math.max(0, Math.min(1, spread));
    const dpRaw = parseFloat(values['debt-persistence']!);
    const debtPersistenceWeight = isNaN(dpRaw) ? 0 : Math.max(0, Math.min(1, dpRaw));

    const result = generateBoardLayerClosure({
      terrain,
      closeRates,
      colorCount,
      dock,
      levelHash: values.hash,
      spreadParam,
      debtPersistenceWeight,
    });

    const m = result.metrics;

    if (values.quiet) {
      console.log(result.replayCode);
    } else if (values.json) {
      const assignmentsObj: Record<string, number> = {};
      for (const [k, v] of result.assignments) {
        assignmentsObj[String(k)] = v;
      }
      console.log(JSON.stringify({
        algorithm: 'closure',
        replayCode: result.replayCode,
        levelHash: result.levelHash,
        assignments: assignmentsObj,
        tripletCount: result.triplets.length,
        metrics: {
          depthCount: m.depthCount,
          totalTiles: m.totalTiles,
          tilesPerLayer: m.tilesPerLayer,
          debtByLayer: m.debtByLayer,
          expDebtByLayer: m.expDebtByLayer,
          peakDebt: m.peakDebt,
          peakExpDebt: m.peakExpDebt,
          oi: m.oi,
          consecutiveOI: m.consecutiveOI,
          colorCount: m.colorCount,
          actualCloseRates: m.actualCloseRates,
          averageOcclusion: m.averageOcclusion,
          allSuitsClosed: m.allSuitsClosed,
          isDoomed: m.isDoomed,
          suitSpread: m.suitSpread,
          suitSpreadNorm: m.suitSpreadNorm,
          configuredDebtPersistenceWeight: m.configuredDebtPersistenceWeight,
          retainedOldDebtTilesByLayer: m.retainedOldDebtTilesByLayer,
          totalRetainedOldDebtTiles: m.totalRetainedOldDebtTiles,
          debtDurationHistogram: m.debtDurationHistogram,
          debtRetentionRates: m.debtRetentionRates,
          weightedDebtRetentionRate: m.weightedDebtRetentionRate,
          colorUsageRates: m.colorUsageRates,
        },
      }, null, 2));
    } else {
      console.log(`\n── LayerClosure Results ──`);
      console.log(`  深度层数: ${m.depthCount}  方块: ${m.totalTiles}  花色: ${m.colorCount}`);
      console.log(`  各层方块: [${m.tilesPerLayer.join(', ')}]`);
      console.log(`  闭合率设定: [${closeRates.map(r => (r * 100).toFixed(0) + '%').join(', ')}]`);
      console.log(`  闭合率实际: [${m.actualCloseRates.map(r => (r * 100).toFixed(0) + '%').join(', ')}]`);
      console.log(`  逐层债务:   [${m.debtByLayer.join(', ')}]`);
      console.log(`  暴露债务:   [${m.expDebtByLayer.join(', ')}]`);
      console.log(`  峰值债务: ${m.peakDebt}  暴露峰值: ${m.peakExpDebt}`);
      console.log(`  OI: ${m.oi}  连续超载: ${m.consecutiveOI}层`);
      console.log(`  平均遮挡: ${m.averageOcclusion}  花色*3: ${m.allSuitsClosed ? '✓' : '✗'}`);
      console.log(`  必输判定: ${m.isDoomed ? '是' : '否'}`);
      console.log(`  花色离散率: ${(m.suitSpread * 100).toFixed(1)}%  归一离散率: ${(m.suitSpreadNorm * 100).toFixed(1)}%`);
      console.log(`  债务持续权重 p=${m.configuredDebtPersistenceWeight}  保留旧债tile: [${m.retainedOldDebtTilesByLayer.join(', ')}] 总计:${m.totalRetainedOldDebtTiles}`);
      console.log(`  债务持续长度直方图(持续k层各有几段): [${m.debtDurationHistogram.join(', ')}]`);
      console.log(`  Level hash: ${result.levelHash}`);

      console.log(`\n── ReplayCode ──`);
      console.log(`  ${result.replayCode}`);
      console.log(`  (length: ${result.replayCode.length} chars)`);

      // Element distribution
      const elemDist = new Map<number, number>();
      for (const [, ev] of result.assignments) {
        elemDist.set(ev, (elemDist.get(ev) ?? 0) + 1);
      }
      console.log(`\n── Element Distribution ──`);
      for (const [elem, count] of [...elemDist.entries()].sort((a, b) => a[0] - b[0])) {
        const bar = '█'.repeat(Math.round(count / m.totalTiles * 40));
        console.log(`  ${String(elem).padStart(4)}: ${String(count).padStart(3)} ${bar}`);
      }
    }
  } else {
    // ═══ CostLadder 算法 (默认) ═══
    const colorCount = parseInt(values.colors ?? '99', 10);
    if (isNaN(colorCount) || colorCount < 1 || colorCount > 99) {
      console.error('Error: --colors must be between 1 and 99');
      process.exit(1);
    }

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

    const result = generateBoard({
      terrain,
      costArray,
      colorCount,
      levelHash: values.hash,
    });

    if (values.quiet) {
      console.log(result.replayCode);
    } else if (values.json) {
      const assignmentsObj: Record<string, number> = {};
      for (const [k, v] of result.assignments) {
        assignmentsObj[String(k)] = v;
      }
      const constAssignmentsObj: Record<string, number> = {};
      for (const [k, v] of result.constAssignments) {
        constAssignmentsObj[String(k)] = v;
      }

      console.log(JSON.stringify({
        algorithm: 'cost-ladder',
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
      console.log(`\n── CostLadder Results ──`);
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
  }
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
