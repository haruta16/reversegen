import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { decodeFromString, getCanonicalTileOrder } from '../src/replay-serializer.js';
import { getAllTiles, loadTerrainFromFile } from '../src/terrain-loader.js';
import { solvePlayerMistakeBatch } from '../src/solver/index.js';
import { OfflineGame } from '../src/solver/offline-game.js';
import { OfflineTile } from '../src/solver/types.js';
import { gradeStrategy2 } from '../src/grader.js';
import type { SimSnapshot } from '../src/grader.js';

const INPUT = 'output/无尽补缺生成.csv';
const OUTPUT = 'output/g0策略2抽样验证.csv';
const SAMPLE_SIZE = 100;
const RUNS = 200;
const SEED = 20260625;

interface CsvRow {
  [key: string]: string;
}

function parseCsv(text: string): CsvRow[] {
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

function csvEscape(value: unknown): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text)
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function sample<T>(items: T[], count: number, seed: number): T[] {
  const rng = mulberry32(seed);
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.min(count, arr.length));
}

function buildGameFromReplay(row: CsvRow): OfflineGame {
  const replayData = decodeFromString(row.ReplayCode);
  if (!replayData) throw new Error('ReplayCode 解码失败');
  const terrain = loadTerrainFromFile(row.terrainPath);
  const ordered = getCanonicalTileOrder(getAllTiles(terrain));
  const offlineTiles: OfflineTile[] = [];
  for (let i = 0; i < ordered.length && i < replayData.instanceArray.length; i++) {
    const tile = ordered[i];
    const b = replayData.instanceArray[i];
    offlineTiles.push(new OfflineTile({
      id: tile.id,
      layer: tile.layer,
      dependencies: tile.dependencies,
      isConst: tile.isConst,
      constElementValue: tile.constElementValue,
      posX: tile.posX,
      posY: tile.posY,
    }, (b & 0x3f) + 1));
  }
  return new OfflineGame(offlineTiles);
}

function rate(game: OfflineGame, mistakeRate: number, seed: number) {
  const result = solvePlayerMistakeBatch(game, RUNS, seed, { mistakeRate });
  return {
    winRate: result.winRate,
    wins: result.wins,
    losses: result.losses,
    elapsedMs: Math.round(result.elapsedMs),
  };
}

const rows = parseCsv(readFileSync(INPUT, 'utf8'));
const g0Rows = rows.filter(row => row.grade === '0');
const picked = sample(g0Rows, SAMPLE_SIZE, SEED);

const outputHeaders = [
  'sampleIndex',
  'levelResId',
  'ReplayKey',
  'ElementCount',
  'terrainFile',
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
  'sourceGrade',
  'ReplayCode',
];

const out: Record<string, unknown>[] = [];
for (let i = 0; i < picked.length; i++) {
  const row = picked[i];
  const game = buildGameFromReplay(row);
  const baseSeed = SEED + i * 9973;
  const s1 = rate(game, 0.01, baseSeed + 1);
  const s5 = rate(game, 0.05, baseSeed + 2);
  const s15 = rate(game, 0.15, baseSeed + 3);
  const snap: SimSnapshot = {
    sim1: { ...s1, runs: RUNS },
    sim5: { ...s5, runs: RUNS },
    sim15: { ...s15, runs: RUNS },
  };
  const verdict = gradeStrategy2(snap);
  out.push({
    sampleIndex: i + 1,
    levelResId: row.levelResId,
    ReplayKey: row.ReplayKey,
    ElementCount: row.ElementCount,
    terrainFile: basename(row.terrainPath),
    simRuns: RUNS,
    sim1Wins: s1.wins,
    sim1Rate: s1.winRate,
    sim5Wins: s5.wins,
    sim5Rate: s5.winRate,
    sim15Wins: s15.wins,
    sim15Rate: s15.winRate,
    strategy2Passrate: verdict.passrate,
    strategy2Grade: verdict.grade,
    strategy2Label: verdict.label,
    sourceGrade: row.grade,
    ReplayCode: row.ReplayCode,
  });
  console.log(`progress ${i + 1}/${picked.length} level=${row.levelResId} pass=${verdict.passrate.toFixed(3)} G${verdict.grade}`);
}

writeFileSync(
  OUTPUT,
  `\ufeff${outputHeaders.join(',')}\n${out.map(row => outputHeaders.map(header => csvEscape(row[header])).join(',')).join('\n')}\n`,
  'utf8',
);

const counts = new Map<number, number>();
for (const row of out) counts.set(Number(row.strategy2Grade), (counts.get(Number(row.strategy2Grade)) ?? 0) + 1);
console.log(`done output=${OUTPUT}`);
console.log(`sample=${out.length} runs=${RUNS}`);
console.log(`gradeCounts=${JSON.stringify(Object.fromEntries([...counts.entries()].sort((a, b) => a[0] - b[0])))}`);
