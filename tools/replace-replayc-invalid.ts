#!/usr/bin/env npx tsx
/**
 * replace-replayc-invalid.ts
 *
 * 用重跑产出的新 ReplayCode 替换 Replay_C 里的违规 code：
 *   1. 剔除所有"花色 tile 数 %3 ≠ 0"的旧 code；
 *   2. 合入本次重跑(records.jsonl)对应关卡的新 code；
 *   3. 保持原文件结构：levelResId / StrategyGroup / LevelTags / replayInfoList，
 *      条目字段 ReplayCode/ReplayKey/grade/passrate/ElementCount/DifficultyScore/CompletionStatus，
 *      紧凑 JSON + CRLF 结尾（与原文件一致）。
 *   4. 断言核心入参一致：新 code 的 color_count(ElementCount)、grade 与
 *      原文件违规 code 的 ReplayKey 花色数 / grade 相同；内嵌 LevelHash 与地形一致。
 *
 * 用法: npx tsx tools/replace-replayc-invalid.ts
 *   (读取 config/regen-replayc-input.json 的 levels 与 output/runs/regen_replayc/records.jsonl)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeFromString, setLogLevel, LogLevel } from '../src/index.js';

setLogLevel(LogLevel.Silent);

const CONFIG_ROOT = '/mnt/e/workspace/tilematch/TileMatchShell/Tools/Config/Json';
const REPLAY_C_ROOT = join(CONFIG_ROOT, 'Replay_C');
const INPUT_PATH = 'config/regen-replayc-input.json';
const RECORDS_PATH = 'output/runs/regen_replayc/records.jsonl';

interface ReplayEntry {
  ReplayCode: string;
  ReplayKey: string;
  grade: number;
  passrate: number | string;
  ElementCount: number;
  DifficultyScore: number;
  CompletionStatus: string;
}

function flowerCountsInvalid(code: string): boolean {
  const d = decodeFromString(code);
  if (!d) return true;
  const per = new Map<number, number>();
  for (const b of d.instanceArray) per.set(b & 0x3f, (per.get(b & 0x3f) ?? 0) + 1);
  return [...per.values()].some(v => v % 3 !== 0);
}

function extractColorCountFromKey(key: string): number {
  return Number(String(key ?? '').split('-')[3]) || 0;
}

function findTerrainHash(terrainId: number | string): string {
  for (const sub of ['Levels', 'LevelsTE']) {
    const p = join(CONFIG_ROOT, sub, `${terrainId}.json`);
    if (existsSync(p)) return String(JSON.parse(readFileSync(p, 'utf8')).LevelHash ?? '').toLowerCase();
  }
  return '';
}

function main(): void {
  const input = JSON.parse(readFileSync(INPUT_PATH, 'utf8'));
  const records = readFileSync(RECORDS_PATH, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));

  const byLevel = new Map<number, typeof records>();
  for (const r of records) {
    const arr = byLevel.get(r.output_level_id) ?? [];
    arr.push(r);
    byLevel.set(r.output_level_id, arr);
  }

  // 预校验：每个关卡 records 数 == target，且新 code 全合法
  for (const level of input.levels) {
    const recs = byLevel.get(level.output_level_id) ?? [];
    const target = level.variants.reduce((a: number, v: { target_count?: number }) => a + (v.target_count ?? 0), 0);
    if (recs.length !== target) throw new Error(`关卡 ${level.output_level_id}: records ${recs.length} != target ${target}`);
    for (const r of recs) {
      if (flowerCountsInvalid(r.replay_code)) throw new Error(`关卡 ${level.output_level_id} 存在新 code 仍违规`);
    }
  }

  let totalDropped = 0, totalAdded = 0;
  for (const level of input.levels) {
    const file = join(REPLAY_C_ROOT, `${level.output_level_id}.json`);
    if (!existsSync(file)) { console.log(`[skip] 文件不存在: ${file}`); continue; }
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const entries: ReplayEntry[] = data.replayInfoList;
    const before = entries.length;

    // 1) 拆分违规 / 保留
    const droppedEntries = entries.filter(e => flowerCountsInvalid(e.ReplayCode));
    const kept = entries.filter(e => !flowerCountsInvalid(e.ReplayCode));
    const dropped = droppedEntries.length;

    // 2) 原文件违规 code 的核心入参（断言基准）
    const originalColors = new Set(droppedEntries.map(e => extractColorCountFromKey(e.ReplayKey)));
    const originalGrades = new Set(droppedEntries.map(e => Number(e.grade)));

    // 3) 合入新 code
    const existingCodes = new Set(kept.map(e => e.ReplayCode));
    const terrainHash = findTerrainHash(level.terrain_id);
    const added: ReplayEntry[] = [];
    for (const r of byLevel.get(level.output_level_id) ?? []) {
      if (existingCodes.has(r.replay_code)) continue;
      const entry: ReplayEntry = {
        ReplayCode: r.replay_code,
        ReplayKey: r.replay_key,
        grade: r.grade,
        passrate: 0,
        ElementCount: r.element_count,
        DifficultyScore: 0,
        CompletionStatus: 'Success',
      };
      // 4) 断言核心入参一致
      const color = extractColorCountFromKey(entry.ReplayKey);
      if (color !== entry.ElementCount) throw new Error(`${level.output_level_id}: ReplayKey花色 ${color} != ElementCount ${entry.ElementCount}`);
      if (originalColors.size && !originalColors.has(color)) throw new Error(`${level.output_level_id}: 新花色 ${color} 与原 ${[...originalColors]} 不一致`);
      if (originalGrades.size && !originalGrades.has(entry.grade)) throw new Error(`${level.output_level_id}: 新 grade ${entry.grade} 与原 ${[...originalGrades]} 不一致`);
      if (terrainHash && terrainHash !== r.level_hash) throw new Error(`${level.output_level_id}: LevelHash ${r.level_hash} vs 地形 ${terrainHash}`);

      existingCodes.add(r.replay_code);
      added.push(entry);
    }

    data.replayInfoList = [...kept, ...added];
    // 与原文件一致：紧凑 JSON + CRLF 结尾
    writeFileSync(file, `${JSON.stringify(data)}\r\n`, { encoding: 'utf8' });
    totalDropped += dropped;
    totalAdded += added.length;
    console.log(`${level.output_level_id}: before=${before} dropped=${dropped} keptGood=${kept.length} added=${added.length} after=${data.replayInfoList.length}`);
  }

  console.log(`\n完成: 剔除违规 ${totalDropped} 条, 合入新 code ${totalAdded} 条`);
}

main();
