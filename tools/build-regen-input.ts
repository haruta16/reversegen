#!/usr/bin/env npx tsx
/**
 * build-regen-input.ts
 *
 * 从现存"违规 Replay"文件自动生成 tileExplorer 生产输入(production input)，
 * 用于用修复后的生成器重新生成非法 ReplayCode。
 *
 * 可恢复的入参（从现有 Replay 文件/code 中提取）：
 *   - output_level_id / terrain   ← 文件 levelResId + Levels/LevelsTE 地形，并核对内嵌 LevelHash
 *   - difficulty（grade）          ← 违规 code 的 grade 字段（生产 runner 中 grade=difficulty）
 *   - color_count                  ← ReplayKey 第 4 段 "1-2-3-<colorCount>-" 与解码 elementCount 双重校验
 * 不可恢复（需另行选择）：
 *   - tile_type_weights            ← 缺省均匀权重 [1,1,...]（与 stage5 配置一致）
 *   - sequence_seed / placement_seed / root_seed ← ReplayKey 第 5 段为空，无法回推，用新 root_seed 派生
 *
 * 用法:
 *   npx tsx tools/build-regen-input.ts \
 *     --root ../TileMatchShell/Tools/Config/Json \
 *     --dir Replay_C \
 *     --out config/regen-replayc-input.json \
 *     --root-seed 20260827 \
 *     --target 30
 *
 * 说明:
 *   - 只处理"整盘 = 关卡总牌数"的完整 Replay（tileExplorer 生产产出）。
 *   - 局部快照类（如 Replays_D/1200230、1200725，n 远小于关卡总牌数）会被列出但跳过。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decodeFromString, loadTerrainFromFile, setLogLevel, LogLevel } from '../src/index.js';

setLogLevel(LogLevel.Silent);

interface Options {
  root: string;
  dirs: string[];
  out: string;
  rootSeed: number;
  target: number;
  maxAttempts: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    root: resolve('../TileMatchShell/Tools/Config/Json'),
    dirs: ['Replay_C'],
    out: resolve('config/regen-replayc-input.json'),
    rootSeed: 20260827,
    target: 30,
    maxAttempts: 120,
  };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    if (argv[i] === '--root') options.root = resolve(next() ?? '');
    else if (argv[i] === '--dir') options.dirs = (next() ?? 'Replay_C').split(',');
    else if (argv[i] === '--out') options.out = resolve(next() ?? '');
    else if (argv[i] === '--root-seed') options.rootSeed = Number(next());
    else if (argv[i] === '--target') options.target = Number(next());
    else if (argv[i] === '--max-attempts') options.maxAttempts = Number(next());
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(`Usage: npx tsx tools/build-regen-input.ts [--root <dir>] [--dir Replay_C,Replay_All] [--out <path>] [--root-seed N] [--target N] [--max-attempts N]`);
      process.exit(0);
    } else throw new Error(`Unknown option: ${argv[i]}`);
  }
  return options;
}

/** 在 Levels/ 与 LevelsTE/ 中按 levelResId 查找地形文件 */
function findTerrain(root: string, levelResId: number | string): { path: string; levelHash: string } | null {
  for (const sub of ['Levels', 'LevelsTE']) {
    const p = join(root, sub, `${levelResId}.json`);
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      return { path: p, levelHash: String(j.LevelHash ?? '') };
    }
  }
  return null;
}

/** 从 ReplayCode 提取嵌入的 levelHash(hex) 与元素计数 */
function decodeSummary(code: string): { hash: string; n: number; elementCount: number; perElement: Map<number, number> } | null {
  const decoded = decodeFromString(code);
  if (!decoded) return null;
  const perElement = new Map<number, number>();
  for (const b of decoded.instanceArray) {
    const e = b & 0x3f;
    perElement.set(e, (perElement.get(e) ?? 0) + 1);
  }
  return {
    hash: decoded.levelHash.toString(16).padStart(16, '0'),
    n: decoded.instanceArray.length,
    elementCount: decoded.elementCount,
    perElement,
  };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  interface VariantKey { difficulty: number; colorCount: number }
  interface LevelRecord {
    outputLevelId: number;
    terrainPath: string;
    terrainHash: string;
    variants: Map<string, { difficulty: number; colorCount: number; badCount: number; sampleCode: string }>;
    totalBad: number;
  }
  const byLevel = new Map<number, LevelRecord>();
  const skippedPartial: string[] = [];

  for (const dir of options.dirs) {
    const dirPath = join(options.root, dir);
    if (!existsSync(dirPath)) { console.warn(`[skip] 目录不存在: ${dirPath}`); continue; }
    for (const file of readdirSync(dirPath).filter(f => f.endsWith('.json')).sort()) {
      const filePath = join(dirPath, file);
      let json;
      try { json = JSON.parse(readFileSync(filePath, 'utf8')); } catch { continue; }
      const list = json.replayInfoList;
      if (!Array.isArray(list)) continue;

      for (const row of list) {
        if (typeof row?.ReplayCode !== 'string') continue;
        const summary = decodeSummary(row.ReplayCode);
        if (!summary) continue;
        const hasViolation = [...summary.perElement.values()].some(v => v % 3 !== 0);
        if (!hasViolation) continue;

        const levelResId = Number(row.levelResId ?? json.levelResId ?? file.replace(/\.json$/, ''));
        const terrain = findTerrain(options.root, levelResId);
        if (!terrain) { skippedPartial.push(`${dir}/${file} (找不到地形 ${levelResId})`); continue; }
        if (terrain.levelHash && terrain.levelHash !== summary.hash) {
          skippedPartial.push(`${dir}/${file} (LevelHash 不匹配: code=${summary.hash} vs terrain=${terrain.levelHash})`);
          continue;
        }
        const totalTiles = loadTerrainFromFile(terrain.path).layers.reduce((a, l) => a + l.tiles.length, 0);
        if (summary.n !== totalTiles) {
          // 局部快照（如 Replays_D）：非整盘，跳过 tileExplorer 重生成
          skippedPartial.push(`${dir}/${file} (局部快照 n=${summary.n} vs 关卡 ${totalTiles})`);
          continue;
        }

        const record = byLevel.get(levelResId) ?? (() => {
          const r: LevelRecord = { outputLevelId: levelResId, terrainPath: terrain.path, terrainHash: terrain.levelHash, variants: new Map(), totalBad: 0 };
          byLevel.set(levelResId, r);
          return r;
        })();

        // difficulty 取违规 code 的 grade；colorCount 用 ReplayKey 第4段 + 解码 elementCount 双重校验
        const keyParts = String(row.ReplayKey ?? '').split('-');
        const keyColor = Number(keyParts[3]);
        const difficulty = Number(row.grade) || 2;
        const colorCount = Number.isInteger(keyColor) && keyColor > 0 ? keyColor : summary.elementCount;
        const variantKey = `${difficulty}:${colorCount}`;
        const existing = record.variants.get(variantKey);
        if (existing) existing.badCount++;
        else record.variants.set(variantKey, { difficulty, colorCount, badCount: 1, sampleCode: row.ReplayCode });
        record.totalBad++;
      }
    }
  }

  if (byLevel.size === 0) {
    console.log('未发现完整 Replay 违规（或全部为局部快照/地形缺失）。');
    if (skippedPartial.length) console.log('被跳过的条目:\n' + skippedPartial.map(s => '  ' + s).join('\n'));
    return;
  }

  const levels = [...byLevel.values()].sort((a, b) => a.outputLevelId - b.outputLevelId).map(record => ({
    output_level_id: record.outputLevelId,
    terrain_id: record.outputLevelId,
    terrain_path: record.terrainPath,
    variants: [...record.variants.values()]
      .sort((a, b) => a.difficulty - b.difficulty || a.colorCount - b.colorCount)
      .map(v => ({
        difficulty: v.difficulty,
        color_count: v.colorCount,
        tile_type_weights: Array.from({ length: v.colorCount }, () => 1),
        target_count: options.target,
        bad_count_found: v.badCount,
        sample_replay_code: v.sampleCode,
      })),
  }));

  const input = {
    schema_version: 1,
    production_id: `regen_replayc_fixed_${new Date().toISOString().slice(0, 10)}`,
    strategy: 'default',
    levels_dir: options.root,
    root_seed: options.rootSeed,
    target_count_per_variant: options.target,
    max_attempts_per_task: options.maxAttempts,
    levels,
  };

  writeFileSync(options.out, JSON.stringify(input, null, 2));
  const totalVariants = levels.reduce((a, l) => a + l.variants.length, 0);
  console.log(`已生成重生成输入: ${options.out}`);
  console.log(`  关卡数: ${byLevel.size}  变体(difficulty×colorCount)数: ${totalVariants}  违规总数: ${[...byLevel.values()].reduce((a, r) => a + r.totalBad, 0)}`);
  for (const record of [...byLevel.values()].sort((a, b) => a.outputLevelId - b.outputLevelId)) {
    const vs = [...record.variants.values()].map(v => `d${v.difficulty}×c${v.colorCount}(bad ${v.badCount})`).join(', ');
    console.log(`  ${record.outputLevelId}: ${vs}`);
  }
  if (skippedPartial.length) {
    console.log(`\n以下条目为局部快照/地形不匹配，未纳入（需单独确认来源）:`);
    for (const s of skippedPartial) console.log('  ' + s);
  }
}

main();
