import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  computeDependencyDepth,
  getAllTiles,
  loadTerrainFromFile,
} from '../src/index.js';
import { generateAndEvaluateOne, type GenerationParams } from '../src/batch-generator.js';

const LEVELS_DIR = '/Users/wenhaowang/WorkSpace/TileMatchShell/Tools/Config/Json/Levels';
const BACKFILL_CSV = 'output/无尽补缺生成.csv';
const OUTPUT = 'output/g0低花色系数尝试验证.csv';
const RUNS = 200;
const SEED = 20260625;

function rng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function csvEscape(value: unknown): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text)
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

function parseCsv(text: string): Record<string, string>[] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  const finish = () => {
    cells.push(field);
    if (cells.some(cell => cell !== '')) records.push(cells);
    cells = [];
    field = '';
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      finish();
    } else {
      field += ch;
    }
  }
  if (field !== '' || cells.length > 0) finish();
  const headers = records[0] ?? [];
  return records.slice(1).map(record => Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ''])));
}

const targets = [...new Set(parseCsv(readFileSync(BACKFILL_CSV, 'utf8'))
  .filter(row => row.grade === '0')
  .map(row => row.levelResId)
  .filter(levelResId => levelResId !== '100001' && levelResId !== '100002'))]
  .sort((a, b) => Number(a) - Number(b));

const headers = [
  'levelResId',
  'terrainPath',
  'freeTiles',
  'totalTiles',
  'depthCount',
  'colorRatio',
  'colorCount',
  'closeRates',
  'spreadParam',
  'debtPersistenceWeight',
  'simRuns',
  'sim1Wins',
  'sim1Rate',
  'sim5Wins',
  'sim5Rate',
  'sim15Wins',
  'sim15Rate',
  'strategy2Passrate',
  'strategy2Grade',
  'strategy2Label',
  'ReplayKey',
  'ReplayCode',
  'actualCloseRates',
  'status',
  'error',
];

const lines = [headers.join(',')];

for (let i = 0; i < targets.length; i++) {
  const levelResId = targets[i];
  const terrainPath = `${LEVELS_DIR}/${levelResId}.json`;
  const terrain = loadTerrainFromFile(terrainPath);
  const allTiles = getAllTiles(terrain);
  const freeTiles = allTiles.filter(tile => !tile.isConst).length;
  const depthMap = computeDependencyDepth(allTiles.filter(tile => !tile.isConst), new Map(allTiles.map(tile => [tile.id, tile])));
  const depthCount = depthMap.size > 0 ? Math.max(...depthMap.values()) : 1;
  const random = rng(SEED + i * 101);
  const colorRatio = 0.4 + random() * 0.1;
  const colorCount = Math.max(1, Math.floor(colorRatio * Math.floor(freeTiles / 3)));
  const params: GenerationParams = {
    closeRates: Array.from({ length: Math.max(0, depthCount - 1) }, () => 1),
    colorCount,
    spreadParam: 0,
    debtPersistenceWeight: 0,
  };
  const result = generateAndEvaluateOne(
    terrain,
    params,
    i,
    terrainPath,
    1,
    false,
    RUNS,
    SEED + i * 1000,
  );
  const replayKey = `g0-low-color-${basename(terrainPath, '.json')}-1`;
  const values = [
    levelResId,
    terrainPath,
    freeTiles,
    allTiles.length,
    depthCount,
    colorRatio.toFixed(4),
    colorCount,
    params.closeRates.join('|'),
    params.spreadParam,
    params.debtPersistenceWeight,
    RUNS,
    result.sim1Wins,
    result.sim1WinRate,
    result.sim5Wins,
    result.sim5WinRate,
    result.sim15Wins,
    result.sim15WinRate,
    result.passrate,
    result.grade,
    result.label,
    replayKey,
    result.replayCode,
    result.actualCloseRates.join('|'),
    result.success ? 'Success' : 'Failed',
    result.error ?? '',
  ];
  lines.push(values.map(csvEscape).join(','));
  console.log(`progress ${i + 1}/${targets.length} level=${levelResId} ratio=${colorRatio.toFixed(4)} colors=${colorCount} pass=${result.passrate.toFixed(3)} grade=G${result.grade} status=${result.success ? 'ok' : result.error}`);
}

writeFileSync(OUTPUT, `\ufeff${lines.join('\n')}\n`, 'utf8');
console.log(`output=${OUTPUT}`);
