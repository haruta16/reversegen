#!/usr/bin/env npx tsx

/** 对比线上必输牌局与“同地形/同花色数/同闭合率”LayerClosure生成结果。 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadTerrainFromFile, getAllTiles } from '../src/terrain-loader.js';
import { decodeFromString, getCanonicalTileOrder } from '../src/replay-serializer.js';
import { computeDependencyDepth, computeCloseRatesFromAssignments, computeLayerProgressMetrics, runLayerClosureGen } from '../src/layer-closure-gen.js';
import { setLogLevel, LogLevel } from '../src/logger.js';
import type { TerrainData, TerrainTile } from '../src/types.js';

setLogLevel(LogLevel.Silent);

const RESULT_JSON = resolve('output/闭合率复现必输牌局_分析.json');
const RESULT_CSV = resolve('output/闭合率复现必输牌局_对比.csv');
const TERRAIN_DIRS = [
  resolve('../TileMatchShell/Tools/Config/Json/Levels'),
  '/Users/wenhaowang/WorkSpace/levels_json/正式关卡',
  '/Users/wenhaowang/WorkSpace/levels_json/关卡备份',
  '/Users/wenhaowang/WorkSpace/levels_json/关卡调整',
];

interface InputRow { key: string; terrainId: string; starts: number; online: number; replayCode: string; }
interface Profile {
  close: number[]; usage: number[]; debtTiles: number[]; retention: number[];
  debtDurationMean: number; debtDurationMax: number; debtArea: number;
}

function terrainPath(id: string): string {
  for (const dir of TERRAIN_DIRS) { const path = `${dir}/${id}.json`; if (existsSync(path)) return path; }
  throw new Error(`找不到地形 ${id}`);
}

function sourceRows(): InputRow[] {
  const rows = readFileSync('output/sim_results.csv', 'utf8').trim().split(/\r?\n/).slice(1).map(line => {
    const p = line.replace(/"/g, '').split(',');
    return { key: p[0], terrainId: p[1], starts: Number(p[2]), online: Number(p[4]), replayCode: p[5] };
  }).filter(row => row.online === 0).sort((a, b) => b.starts - a.starts);
  const selected: InputRow[] = [], terrains = new Set<string>();
  for (const row of rows) {
    if (terrains.has(row.terrainId) || !existsSync(terrainPath(row.terrainId))) continue;
    selected.push(row); terrains.add(row.terrainId);
    if (selected.length === 4) break;
  }
  return selected;
}

function context(terrain: TerrainData) {
  const allTiles = getAllTiles(terrain), freeTiles = allTiles.filter(tile => !tile.isConst);
  const tileMap = new Map(allTiles.map(tile => [tile.id, tile]));
  const depthMap = computeDependencyDepth(freeTiles, tileMap);
  const maxDepth = Math.max(...depthMap.values());
  const depthLayers = Array.from({ length: maxDepth }, (_, i) => freeTiles.filter(tile => depthMap.get(tile.id) === i + 1));
  return { allTiles, freeTiles, ordered: getCanonicalTileOrder(allTiles), depthLayers };
}

function decodeAssignments(replayCode: string, ordered: TerrainTile[]): Map<number, number> {
  const replay = decodeFromString(replayCode); if (!replay) throw new Error('ReplayCode解码失败');
  const assignments = new Map<number, number>();
  for (let i = 0; i < ordered.length && i < replay.instanceArray.length; i++) {
    if (!ordered[i].isConst) assignments.set(ordered[i].id, (replay.instanceArray[i] & 0x3f) + 1);
  }
  return assignments;
}

function debtDuration(assignments: Map<number, number>, layers: TerrainTile[][]) {
  const queues = new Map<number, number[]>(), durations = new Map<number, number>();
  let debtArea = 0;
  for (const layer of layers) {
    for (const tile of layer) {
      const color = assignments.get(tile.id); if (color === undefined) continue;
      const queue = queues.get(color) ?? []; queue.push(tile.id); queues.set(color, queue);
    }
    for (const queue of queues.values()) while (queue.length >= 3) queue.splice(0, 3);
    for (const queue of queues.values()) for (const id of queue) durations.set(id, (durations.get(id) ?? 0) + 1);
    debtArea += [...queues.values()].reduce((s, queue) => s + queue.length, 0);
  }
  const values = [...durations.values()];
  return { mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0,
    max: Math.max(...values, 0), area: debtArea };
}

function profile(assignments: Map<number, number>, layers: TerrainTile[][]): Profile {
  const progress = computeLayerProgressMetrics(assignments, layers), duration = debtDuration(assignments, layers);
  return { close: computeCloseRatesFromAssignments(assignments, layers), usage: progress.colorUsageRates,
    debtTiles: progress.debtTileCountsByLayer, retention: progress.debtRetentionRates,
    debtDurationMean: duration.mean, debtDurationMax: duration.max, debtArea: duration.area };
}

function mae(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length); return n ? a.slice(0, n).reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / n : 0;
}

function main() {
  const results = [];
  for (const row of sourceRows()) {
    const terrain = loadTerrainFromFile(terrainPath(row.terrainId)), ctx = context(terrain);
    const sourceAssignments = decodeAssignments(row.replayCode, ctx.ordered), source = profile(sourceAssignments, ctx.depthLayers);
    const colorCount = new Set(sourceAssignments.values()).size;
    const generatedProfiles: Profile[] = [];
    for (let i = 0; i < 5; i++) {
      const generated = runLayerClosureGen({ terrain, colorCount, dock: 7, closeRates: source.close.slice(0, -1), spreadParam: 0.5 });
      generatedProfiles.push(profile(generated.assignments, ctx.depthLayers));
    }
    const generated = generatedProfiles[0];
    const invariantProfiles = new Set(generatedProfiles.map(p => JSON.stringify({close:p.close,usage:p.usage,debt:p.debtTiles,retention:p.retention}))).size;
    results.push({ replayKey: row.key, terrainId: row.terrainId, starts: row.starts, online: row.online,
      tiles: ctx.freeTiles.length, depthCount: ctx.depthLayers.length, colorCount,
      source, generated, differences: { closeMae: mae(source.close, generated.close), usageMae: mae(source.usage, generated.usage),
        retentionMae: mae(source.retention, generated.retention), debtAreaDelta: generated.debtArea - source.debtArea,
        debtDurationMeanDelta: generated.debtDurationMean - source.debtDurationMean },
      generatedProfileVariantsAcross5Runs: invariantProfiles });
  }
  const aggregate = {
    closeMae: results.reduce((s, r) => s + r.differences.closeMae, 0) / results.length,
    usageMae: results.reduce((s, r) => s + r.differences.usageMae, 0) / results.length,
    retentionMae: results.reduce((s, r) => s + r.differences.retentionMae, 0) / results.length,
    sourceDebtArea: results.reduce((s, r) => s + r.source.debtArea, 0) / results.length,
    generatedDebtArea: results.reduce((s, r) => s + r.generated.debtArea, 0) / results.length,
    sourceDebtDurationMean: results.reduce((s, r) => s + r.source.debtDurationMean, 0) / results.length,
    generatedDebtDurationMean: results.reduce((s, r) => s + r.generated.debtDurationMean, 0) / results.length,
  };
  const output = { definition: { debtArea: '逐层债务tile数之和', debtDuration: 'tile作为层末债务连续存在的层端点数' }, aggregate, results };
  writeFileSync(RESULT_JSON, JSON.stringify(output, null, 2) + '\n', 'utf8');
  const header = ['牌局','地形','开局数','牌数','层数','花色数','来源闭合率','生成闭合率','来源花色使用率','生成花色使用率','来源债务Tile','生成债务Tile','来源保留率','生成保留率','来源债务面积','生成债务面积','来源平均债务时长','生成平均债务时长'];
  const fmt = (a: number[]) => a.map(x => x.toFixed(4)).join('|');
  const lines = results.map(r => [r.replayKey,r.terrainId,r.starts,r.tiles,r.depthCount,r.colorCount,fmt(r.source.close),fmt(r.generated.close),fmt(r.source.usage),fmt(r.generated.usage),r.source.debtTiles.join('|'),r.generated.debtTiles.join('|'),fmt(r.source.retention),fmt(r.generated.retention),r.source.debtArea,r.generated.debtArea,r.source.debtDurationMean.toFixed(4),r.generated.debtDurationMean.toFixed(4)].join(','));
  writeFileSync(RESULT_CSV, [header.join(','), ...lines].join('\n') + '\n', 'utf8');
  console.log(JSON.stringify(output, null, 2));
}

main();
