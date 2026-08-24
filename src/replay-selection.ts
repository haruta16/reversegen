import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPLAY_SELECTION_HEADERS = [
  'levelResId',
  'ReplayKey',
  'ReplayCode',
  'grade',
  'passrate',
  'ElementCount',
  'DifficultyScore',
  'CompletionStatus',
  'ExpectConsume',
  'LevelTags',
  'ReplayTags',
  'highWinRate',
  'MiddleWinRate',
  'LowWinRate',
] as const;

/** Replay grades are serialized in the shared 1-byte, 0..99 resource range. */
export const MAX_REPLAY_GRADE = 99;

export interface ReplaySelectionRow {
  levelResId: number;
  ReplayKey: string;
  ReplayCode: string;
  grade: number | '';
  passrate: number;
  ElementCount: number;
  DifficultyScore: number;
  CompletionStatus: string;
  ExpectConsume: number;
  LevelTags: string;
  ReplayTags: string;
  highWinRate: number;
  MiddleWinRate: number;
  LowWinRate: number;
}

export interface ReplaySelectionInput {
  levelResId: number | string;
  ReplayCode: string;
  grade?: number | string | null;
  passrate?: number | string | null;
  ElementCount: number | string;
}

export interface ReplaySelectionPaths {
  csvPath: string;
  generatedDir: string;
}

export interface ReplaySelectionSummary {
  rowsRead: number;
  validRows: number;
  skippedBlankGrade: number;
  levelCount: number;
  skippedLines: number[];
}

export interface AppendReplaySelectionResult {
  duplicate: boolean;
  row: ReplaySelectionRow;
  totalRows: number;
}

export interface BuildReplaySelectionResult extends ReplaySelectionSummary {
  files: string[];
}

interface ParsedCsvRecord {
  cells: string[];
  lineNumber: number;
}

interface ValidatedSelection {
  rows: Array<{ row: ReplaySelectionRow; lineNumber: number }>;
  summary: ReplaySelectionSummary;
}

interface ReplayInfoJson {
  ReplayCode: string;
  ReplayKey: string;
  grade: number;
  passrate: number;
  ElementCount: number;
  DifficultyScore: number;
  CompletionStatus: string;
  ExpectConsume: number;
  highWinRate: number;
  MiddleWinRate: number;
  LowWinRate: number;
  ReplayTags: string;
}

interface ReplayFileJson {
  levelResId: number;
  StrategyGroup: 'B';
  LevelTags: string;
  replayInfoList: ReplayInfoJson[];
}

const LEGACY_REPLAY_SELECTION_HEADERS = REPLAY_SELECTION_HEADERS.filter(header => header !== 'passrate');

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function defaultReplaySelectionPaths(): ReplaySelectionPaths {
  return {
    csvPath: join(PROJECT_ROOT, 'replays', 'selection.csv'),
    generatedDir: join(PROJECT_ROOT, 'replays', 'generated'),
  };
}

function csvEscape(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text)
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

export function serializeReplaySelectionCsv(rows: ReplaySelectionRow[]): string {
  const lines = [REPLAY_SELECTION_HEADERS.join(',')];
  for (const row of rows) {
    lines.push(serializeReplaySelectionRow(row));
  }
  return `\uFEFF${lines.join('\n')}\n`;
}

/** Serialize one validated selection row for append-only generation runners. */
export function serializeReplaySelectionRow(row: ReplaySelectionRow): string {
  return REPLAY_SELECTION_HEADERS.map(header => csvEscape(row[header])).join(',');
}

function parseCsv(text: string): ParsedCsvRecord[] {
  const source = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const records: ParsedCsvRecord[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let recordLine = 1;
  let line = 1;

  const finishRecord = (): void => {
    cells.push(field);
    if (cells.some(cell => cell !== '')) records.push({ cells, lineNumber: recordLine });
    cells = [];
    field = '';
    recordLine = line + 1;
  };

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
        if (char === '\n') line++;
      }
      continue;
    }

    if (char === '"') {
      if (field.length !== 0) throw new Error(`CSV 第 ${line} 行引号位置无效`);
      inQuotes = true;
    } else if (char === ',') {
      cells.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      finishRecord();
      line++;
    } else {
      field += char;
    }
  }

  if (inQuotes) throw new Error(`CSV 第 ${recordLine} 行存在未闭合的引号`);
  if (field !== '' || cells.length > 0) finishRecord();
  return records;
}

function requireInteger(value: string | number, name: string, lineNumber: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const text = String(value).trim();
  const number = Number(text);
  if (text === '' || !Number.isInteger(number) || number < min || number > max) {
    throw new Error(`CSV 第 ${lineNumber} 行 ${name} 必须是 ${min}-${max} 的整数`);
  }
  return number;
}

function requireNumber(value: string | number, name: string, lineNumber: number): number {
  const text = String(value).trim();
  const number = Number(text);
  if (text === '' || !Number.isFinite(number)) {
    throw new Error(`CSV 第 ${lineNumber} 行 ${name} 必须是有效数字`);
  }
  return number;
}

function parseGrade(value: string | number | null | undefined, lineNumber: number): number | '' {
  if (value == null || String(value).trim() === '') return '';
  return requireInteger(value, 'grade', lineNumber, 0, MAX_REPLAY_GRADE);
}

function parsePassrate(value: string | number | null | undefined, lineNumber: number): number {
  if (value == null || String(value).trim() === '') return 0;
  const number = requireNumber(value, 'passrate', lineNumber);
  if (number < 0 || number > 1) throw new Error(`CSV 第 ${lineNumber} 行 passrate 必须是 0-1 的数字`);
  return number;
}

function rowFromCells(cells: string[], lineNumber: number): ReplaySelectionRow {
  const hasPassrate = cells.length === REPLAY_SELECTION_HEADERS.length;
  const headers = hasPassrate ? REPLAY_SELECTION_HEADERS : LEGACY_REPLAY_SELECTION_HEADERS;
  if (cells.length !== headers.length) {
    throw new Error(`CSV 第 ${lineNumber} 行应有 ${REPLAY_SELECTION_HEADERS.length} 列（兼容旧格式 ${LEGACY_REPLAY_SELECTION_HEADERS.length} 列），实际 ${cells.length} 列`);
  }
  const raw = Object.fromEntries(headers.map((header, index) => [header, cells[index]])) as Record<string, string>;
  if (!hasPassrate) raw.passrate = '0';
  const replayKey = raw.ReplayKey.trim();
  const replayCode = raw.ReplayCode.trim();
  const completionStatus = raw.CompletionStatus.trim();
  if (!replayKey) throw new Error(`CSV 第 ${lineNumber} 行 ReplayKey 不能为空`);
  if (!replayCode) throw new Error(`CSV 第 ${lineNumber} 行 ReplayCode 不能为空`);
  if (!completionStatus) throw new Error(`CSV 第 ${lineNumber} 行 CompletionStatus 不能为空`);

  return {
    levelResId: requireInteger(raw.levelResId, 'levelResId', lineNumber, 1),
    ReplayKey: replayKey,
    ReplayCode: replayCode,
    grade: parseGrade(raw.grade, lineNumber),
    passrate: parsePassrate(raw.passrate, lineNumber),
    ElementCount: requireInteger(raw.ElementCount, 'ElementCount', lineNumber, 1, 99),
    DifficultyScore: requireNumber(raw.DifficultyScore, 'DifficultyScore', lineNumber),
    CompletionStatus: completionStatus,
    ExpectConsume: requireNumber(raw.ExpectConsume, 'ExpectConsume', lineNumber),
    LevelTags: raw.LevelTags,
    ReplayTags: raw.ReplayTags,
    highWinRate: requireNumber(raw.highWinRate, 'highWinRate', lineNumber),
    MiddleWinRate: requireNumber(raw.MiddleWinRate, 'MiddleWinRate', lineNumber),
    LowWinRate: requireNumber(raw.LowWinRate, 'LowWinRate', lineNumber),
  };
}

function readAndValidateCsv(csvPath: string): ValidatedSelection {
  if (!existsSync(csvPath)) throw new Error(`候选 CSV 不存在: ${csvPath}`);
  const records = parseCsv(readFileSync(csvPath, 'utf8'));
  if (records.length === 0) throw new Error('候选 CSV 为空');
  const actualHeaders = records[0].cells;
  const isCurrentHeader = actualHeaders.length === REPLAY_SELECTION_HEADERS.length
    && actualHeaders.every((header, index) => header === REPLAY_SELECTION_HEADERS[index]);
  const isLegacyHeader = actualHeaders.length === LEGACY_REPLAY_SELECTION_HEADERS.length
    && actualHeaders.every((header, index) => header === LEGACY_REPLAY_SELECTION_HEADERS[index]);
  if (!isCurrentHeader && !isLegacyHeader) {
    throw new Error(`CSV 表头必须为: ${REPLAY_SELECTION_HEADERS.join(',')}（兼容旧表头: ${LEGACY_REPLAY_SELECTION_HEADERS.join(',')}）`);
  }

  const rows = records.slice(1).map(record => ({
    row: rowFromCells(record.cells, record.lineNumber),
    lineNumber: record.lineNumber,
  }));
  const seen = new Map<string, number>();
  for (const item of rows) {
    const key = `${item.row.levelResId}\u0000${item.row.ReplayCode}`;
    const firstLine = seen.get(key);
    if (firstLine != null) {
      throw new Error(`CSV 第 ${item.lineNumber} 行与第 ${firstLine} 行重复（levelResId + ReplayCode）`);
    }
    seen.set(key, item.lineNumber);
  }

  const skippedLines = rows.filter(item => item.row.grade === '').map(item => item.lineNumber);
  const validRows = rows.length - skippedLines.length;
  return {
    rows,
    summary: {
      rowsRead: rows.length,
      validRows,
      skippedBlankGrade: skippedLines.length,
      levelCount: new Set(rows.filter(item => item.row.grade !== '').map(item => item.row.levelResId)).size,
      skippedLines,
    },
  };
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tempPath, content, 'utf8');
    renameSync(tempPath, path);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

export function createReplaySelectionRow(input: ReplaySelectionInput): ReplaySelectionRow {
  const levelResId = requireInteger(input.levelResId, 'levelResId', 1, 1);
  const elementCount = requireInteger(input.ElementCount, 'ElementCount', 1, 1, 99);
  const replayCode = String(input.ReplayCode ?? '').trim();
  if (!replayCode) throw new Error('ReplayCode 不能为空');
  return {
    levelResId,
    ReplayKey: `1-2-3-${elementCount}-`,
    ReplayCode: replayCode,
    grade: parseGrade(input.grade, 1),
    passrate: parsePassrate(input.passrate, 1),
    ElementCount: elementCount,
    DifficultyScore: 0,
    CompletionStatus: 'Success',
    ExpectConsume: 0,
    LevelTags: '',
    ReplayTags: '',
    highWinRate: 0,
    MiddleWinRate: 0,
    LowWinRate: 0,
  };
}

export function appendReplaySelection(input: ReplaySelectionInput, csvPath = defaultReplaySelectionPaths().csvPath): AppendReplaySelectionResult {
  const row = createReplaySelectionRow(input);
  let rows: ReplaySelectionRow[] = [];
  if (existsSync(csvPath)) {
    rows = readAndValidateCsv(csvPath).rows.map(item => item.row);
  }
  const duplicate = rows.some(existing => existing.levelResId === row.levelResId && existing.ReplayCode === row.ReplayCode);
  if (!duplicate) {
    rows.push(row);
    atomicWrite(csvPath, serializeReplaySelectionCsv(rows));
  }
  return { duplicate, row, totalRows: rows.length };
}

export function checkReplaySelections(csvPath = defaultReplaySelectionPaths().csvPath): ReplaySelectionSummary {
  return readAndValidateCsv(csvPath).summary;
}

function toReplayFiles(validated: ValidatedSelection): Map<number, ReplayFileJson> {
  const files = new Map<number, ReplayFileJson>();
  for (const { row, lineNumber } of validated.rows) {
    if (row.grade === '') continue;
    let target = files.get(row.levelResId);
    if (!target) {
      target = {
        levelResId: row.levelResId,
        StrategyGroup: 'B',
        LevelTags: row.LevelTags,
        replayInfoList: [],
      };
      files.set(row.levelResId, target);
    } else if (target.LevelTags !== row.LevelTags) {
      throw new Error(`CSV 第 ${lineNumber} 行 LevelTags 与同关卡其他记录不一致`);
    }
    target.replayInfoList.push({
      ReplayCode: row.ReplayCode,
      ReplayKey: row.ReplayKey,
      grade: row.grade,
      passrate: row.passrate,
      ElementCount: row.ElementCount,
      DifficultyScore: row.DifficultyScore,
      CompletionStatus: row.CompletionStatus,
      ExpectConsume: row.ExpectConsume,
      highWinRate: row.highWinRate,
      MiddleWinRate: row.MiddleWinRate,
      LowWinRate: row.LowWinRate,
      ReplayTags: row.ReplayTags,
    });
  }
  return files;
}

export function buildReplaySelections(
  csvPath = defaultReplaySelectionPaths().csvPath,
  generatedDir = defaultReplaySelectionPaths().generatedDir,
): BuildReplaySelectionResult {
  const validated = readAndValidateCsv(csvPath);
  const files = toReplayFiles(validated);
  const parentDir = dirname(generatedDir);
  const stagingDir = join(parentDir, `.generated-${process.pid}-${Date.now()}`);
  mkdirSync(stagingDir, { recursive: true });

  try {
    for (const [levelResId, data] of files) {
      writeFileSync(join(stagingDir, `${levelResId}.json`), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    }

    mkdirSync(generatedDir, { recursive: true });
    for (const file of readdirSync(generatedDir)) {
      if (file.endsWith('.json')) unlinkSync(join(generatedDir, file));
    }
    for (const file of readdirSync(stagingDir)) {
      renameSync(join(stagingDir, file), join(generatedDir, file));
    }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }

  return {
    ...validated.summary,
    files: [...files.keys()].map(levelResId => join(generatedDir, `${levelResId}.json`)),
  };
}
