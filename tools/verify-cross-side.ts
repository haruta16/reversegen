/**
 * 跨侧 golden 验证 CLI：
 *
 *   1) 对照模式：用 地形 + ReplayCode + 机制配置 + 动作序列 在 reversegen 重建追踪，
 *      与 Unity 客户端导出的追踪文件逐帧比对（docs/cross-side-golden.md 的 C# 导出器）。
 *   2) 自检模式：同一输入重建两次，验证 reversegen 自身的确定性。
 *
 * 用法：
 *   npx tsx tools/verify-cross-side.ts \
 *     --terrain level.json --replay <ReplayCode> \
 *     [--mechanics "31:3,39:2"] [--actions "1,4,7"|--actions-file ids.txt] \
 *     [--unity-trace unity-trace.json] [--mechanic-seed 7] \
 *     [--giftbox-open "1,2,4,5,6,9,10,11"] [--self-check]
 *
 * 退出码：0 = 逐位一致；1 = 存在分歧；2 = 参数/运行错误。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
  loadTerrainFromFile,
  getAllTiles,
  getCanonicalTileOrder,
  decodeFromString,
  buildReplayElementMap,
  mapReplayElementValue,
  parseMechanicCounts,
} from '../src/index.js';
import { createGame } from '../src/solver/index.js';
import {
  compareCrossSideTraces,
  recordCrossSideTrace,
  CROSS_SIDE_PROTOCOL,
  CROSS_SIDE_VERSION,
  type CrossSideMeta,
  type CrossSideTrace,
} from '../src/verification/cross-side-trace.js';

interface Args {
  terrain?: string;
  replay?: string;
  mechanics?: string;
  actions?: string;
  actionsFile?: string;
  unityTrace?: string;
  mechanicSeed?: number;
  giftboxOpen?: string;
  out?: string;
  selfCheck: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { selfCheck: false };
  const take = (i: number): string => {
    if (i + 1 >= argv.length) throw new Error(`缺少参数值: ${argv[i]}`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--terrain': args.terrain = take(i); i++; break;
      case '--replay': args.replay = take(i); i++; break;
      case '--mechanics': args.mechanics = take(i); i++; break;
      case '--actions': args.actions = take(i); i++; break;
      case '--actions-file': args.actionsFile = take(i); i++; break;
      case '--unity-trace': args.unityTrace = take(i); i++; break;
      case '--mechanic-seed': args.mechanicSeed = Number(take(i)); i++; break;
      case '--giftbox-open': args.giftboxOpen = take(i); i++; break;
      case '--out': args.out = take(i); i++; break;
      case '--self-check': args.selfCheck = true; break;
      case '--help': throw new Error('help');
      default: throw new Error(`未知参数: ${argv[i]}`);
    }
  }
  return args;
}

function parseActions(args: Args): number[] {
  const text = args.actions ?? (args.actionsFile ? readFileSync(args.actionsFile, 'utf-8') : '');
  return text.trim().split(/[\s,]+/).filter(Boolean).map(Number);
}

function buildTrace(args: Args, actions: number[]): CrossSideTrace {
  const terrain = loadTerrainFromFile(args.terrain!);
  const ordered = getCanonicalTileOrder(getAllTiles(terrain));
  const replayData = decodeFromString(args.replay!);
  if (!replayData) throw new Error('ReplayCode 解码失败');
  const elementMap = buildReplayElementMap(ordered, replayData.instanceArray, replayData.elementCount);
  const elementValues = new Map<number, number>();
  for (let i = 0; i < ordered.length && i < replayData.instanceArray.length; i++) {
    const normValue = (replayData.instanceArray[i] & 0x3f) + 1;
    elementValues.set(ordered[i].id, mapReplayElementValue(normValue, elementMap));
  }
  const mechanics = args.mechanics ? parseMechanicCounts(args.mechanics) : undefined;
  const giftboxOpen = args.giftboxOpen
    ? new Set(args.giftboxOpen.split(',').map(s => Number(s.trim())))
    : undefined;

  const game = createGame({
    terrainTiles: ordered,
    terrainStructures: terrain.terrainStructures,
    elementValues,
    levelResId: terrain.levelResId,
    replayCode: args.replay,
    mechanicConfig: mechanics,
    mechanicSeed: args.mechanicSeed,
    giftboxOpenEffects: giftboxOpen,
    boardBounds: terrain.LevelWidth && terrain.LevelHeight
      ? { width: terrain.LevelWidth, height: terrain.LevelHeight }
      : undefined,
  });

  const trace = recordCrossSideTrace(game, actions);
  const meta: CrossSideMeta = {
    levelResId: terrain.levelResId,
    replayCode: args.replay,
    mechanics: args.mechanics,
    giftboxOpenEffects: args.giftboxOpen ? args.giftboxOpen.split(',').map(Number) : undefined,
    boardBounds: terrain.LevelWidth && terrain.LevelHeight
      ? { width: terrain.LevelWidth, height: terrain.LevelHeight }
      : undefined,
    mechanicSeed: args.mechanicSeed,
  };
  trace.meta = meta;
  return trace;
}

const HELP = `跨侧 golden 验证
  --terrain <file>      Unity 地形 JSON
  --replay <code>       ReplayCode
  --mechanics <spec>    机制配置，如 "31:3,39:2"
  --actions <ids>       动作序列（逗号分隔），或 --actions-file
  --unity-trace <file>  Unity 导出的追踪（对照模式）
  --mechanic-seed <n>   显式机制种子
  --giftbox-open <csv>  礼盒开放效果（缺省全开）
  --out <file>          导出 reversegen 追踪 JSON（逐帧人工查看/存档）
  --self-check          自检模式（重建两次比对确定性）`;

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error && e.message === 'help' ? HELP : e);
    return e instanceof Error && e.message === 'help' ? 0 : 2;
  }

  try {
    const actions = parseActions(args);

    if (args.selfCheck) {
      if (!args.terrain || !args.replay) throw new Error('自检模式需要 --terrain 与 --replay');
      const a = buildTrace(args, actions);
      const b = buildTrace(args, actions);
      const diff = compareCrossSideTraces(a, b);
      console.log(`[self-check] ${diff.message}`);
      if (args.out) writeFileSync(args.out, `${JSON.stringify(b, null, 2)}\n`, 'utf-8');
      return diff.ok ? 0 : 1;
    }

    if (args.unityTrace) {
      if (!args.terrain || !args.replay) throw new Error('对照模式需要 --terrain 与 --replay');
      const unityTrace = JSON.parse(readFileSync(args.unityTrace, 'utf-8')) as CrossSideTrace;
      if (unityTrace.protocol !== CROSS_SIDE_PROTOCOL || unityTrace.version !== CROSS_SIDE_VERSION) {
        throw new Error(`Unity 追踪协议不匹配: ${unityTrace.protocol} v${unityTrace.version}`);
      }
      const localTrace = buildTrace(args, actions);
      const diff = compareCrossSideTraces(localTrace, unityTrace);
      console.log(`[cross-side] ${diff.message}`);
      if (args.out) writeFileSync(args.out, `${JSON.stringify(localTrace, null, 2)}\n`, 'utf-8');
      return diff.ok ? 0 : 1;
    }

    throw new Error('需要 --unity-trace（对照模式）或 --self-check（自检模式）');
  } catch (e) {
    console.error(`[cross-side] 错误: ${e instanceof Error ? e.message : e}`);
    return 2;
  }
}

process.exit(await main());
