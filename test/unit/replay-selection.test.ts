import { afterEach, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendReplaySelection,
  buildReplaySelections,
  checkReplaySelections,
  createReplaySelectionRow,
  serializeReplaySelectionCsv,
} from '../../src/replay-selection.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'reversegen-replays-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('Replay 候选 CSV', () => {
  it('首次保存创建表头、默认字段和精确 ReplayKey', () => {
    const dir = makeTempDir();
    const csvPath = join(dir, 'selection.csv');
    const result = appendReplaySelection({
      levelResId: 100075,
      ReplayCode: 'BASE64-CODE',
      grade: '',
      ElementCount: 17,
    }, csvPath);

    assert.equal(result.duplicate, false);
    assert.equal(result.row.ReplayKey, '1-2-3-17-');
    assert.equal(result.row.grade, '');
    assert.equal(result.row.passrate, 0);
    assert.equal(result.row.DifficultyScore, 0);
    assert.equal(result.row.ExpectConsume, 0);
    assert.equal(result.row.CompletionStatus, 'Success');
    assert.ok(existsSync(csvPath));
    assert.deepEqual(checkReplaySelections(csvPath), {
      rowsRead: 1,
      validRows: 0,
      skippedBlankGrade: 1,
      levelCount: 0,
      skippedLines: [2],
    });
  });

  it('正确转义并读取逗号、引号、中文和换行', () => {
    const dir = makeTempDir();
    const csvPath = join(dir, 'selection.csv');
    const row = createReplaySelectionRow({
      levelResId: 100075,
      ReplayCode: 'code,"quoted"',
      grade: 2,
      passrate: 0.491,
      ElementCount: 8,
    });
    row.LevelTags = '中文,标签';
    row.ReplayTags = '第一行\n"第二行"';
    writeFileSync(csvPath, serializeReplaySelectionCsv([row]), 'utf8');

    const result = buildReplaySelections(csvPath, join(dir, 'generated'));
    assert.equal(result.validRows, 1);
    const data = JSON.parse(readFileSync(result.files[0], 'utf8'));
    assert.equal(data.LevelTags, '中文,标签');
    assert.equal(data.replayInfoList[0].ReplayTags, '第一行\n"第二行"');
    assert.equal(data.replayInfoList[0].ReplayCode, 'code,"quoted"');
    assert.equal(data.replayInfoList[0].passrate, 0.491);
  });

  it('按 levelResId + ReplayCode 幂等判重', () => {
    const dir = makeTempDir();
    const csvPath = join(dir, 'selection.csv');
    const input = { levelResId: 100075, ReplayCode: 'same', grade: 1, ElementCount: 8 };
    appendReplaySelection(input, csvPath);
    const duplicate = appendReplaySelection(input, csvPath);

    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.totalRows, 1);
    assert.equal(checkReplaySelections(csvPath).rowsRead, 1);
  });

  it('拒绝 0-99 以外的非空 grade（对齐 MAX_REPLAY_GRADE=99 的 1 字节资源区间）', () => {
    assert.throws(
      () => createReplaySelectionRow({ levelResId: 1, ReplayCode: 'code', grade: 100, ElementCount: 8 }),
      /grade 必须是 0-99 的整数/,
    );
  });
});

describe('Replay JSON 构建', () => {
  it('跳过空 grade、按关卡分组并保持 CSV 顺序', () => {
    const dir = makeTempDir();
    const csvPath = join(dir, 'selection.csv');
    const generatedDir = join(dir, 'generated');
    const rows = [
      createReplaySelectionRow({ levelResId: 100075, ReplayCode: 'first', grade: 2, ElementCount: 17 }),
      createReplaySelectionRow({ levelResId: 100076, ReplayCode: 'skip', grade: '', ElementCount: 8 }),
      createReplaySelectionRow({ levelResId: 100075, ReplayCode: 'second', grade: 4, ElementCount: 9 }),
      createReplaySelectionRow({ levelResId: 100077, ReplayCode: 'third', grade: 0, ElementCount: 6 }),
    ];
    writeFileSync(csvPath, serializeReplaySelectionCsv(rows), 'utf8');

    const result = buildReplaySelections(csvPath, generatedDir);
    assert.equal(result.rowsRead, 4);
    assert.equal(result.validRows, 3);
    assert.equal(result.skippedBlankGrade, 1);
    assert.equal(result.levelCount, 2);
    assert.deepEqual(readdirSync(generatedDir).sort(), ['100075.json', '100077.json']);

    const data = JSON.parse(readFileSync(join(generatedDir, '100075.json'), 'utf8'));
    assert.deepEqual(Object.keys(data), ['levelResId', 'StrategyGroup', 'LevelTags', 'replayInfoList']);
    assert.equal(data.StrategyGroup, 'B');
    assert.deepEqual(data.replayInfoList.map((entry: { ReplayCode: string }) => entry.ReplayCode), ['first', 'second']);
    assert.deepEqual(Object.keys(data.replayInfoList[0]), [
      'ReplayCode', 'ReplayKey', 'grade', 'passrate', 'ElementCount', 'DifficultyScore',
      'CompletionStatus', 'ExpectConsume', 'highWinRate', 'MiddleWinRate',
      'LowWinRate', 'ReplayTags',
    ]);
    assert.equal(typeof data.replayInfoList[0].grade, 'number');
  });

  it('兼容没有 passrate 列的旧 CSV，导出 JSON 时默认 passrate=0', () => {
    const dir = makeTempDir();
    const csvPath = join(dir, 'selection.csv');
    const generatedDir = join(dir, 'generated');
    writeFileSync(csvPath, [
      'levelResId,ReplayKey,ReplayCode,grade,ElementCount,DifficultyScore,CompletionStatus,ExpectConsume,LevelTags,ReplayTags,highWinRate,MiddleWinRate,LowWinRate',
      '1,1-2-3-8-,code,1,8,0,Success,0,,,0,0,0',
      '',
    ].join('\n'), 'utf8');

    const result = buildReplaySelections(csvPath, generatedDir);
    const data = JSON.parse(readFileSync(result.files[0], 'utf8'));
    assert.equal(data.replayInfoList[0].passrate, 0);
  });

  it('全量重建删除旧 JSON，但保留其他文件', () => {
    const dir = makeTempDir();
    const csvPath = join(dir, 'selection.csv');
    const generatedDir = join(dir, 'generated');
    mkdirSync(generatedDir);
    writeFileSync(join(generatedDir, 'stale.json'), '{}');
    writeFileSync(join(generatedDir, '.gitkeep'), '');
    const row = createReplaySelectionRow({ levelResId: 1, ReplayCode: 'code', grade: 1, ElementCount: 8 });
    writeFileSync(csvPath, serializeReplaySelectionCsv([row]), 'utf8');

    buildReplaySelections(csvPath, generatedDir);
    assert.deepEqual(readdirSync(generatedDir).sort(), ['.gitkeep', '1.json']);
  });

  it('校验失败时保留已有生成结果并报告行号', () => {
    const dir = makeTempDir();
    const csvPath = join(dir, 'selection.csv');
    const generatedDir = join(dir, 'generated');
    mkdirSync(generatedDir);
    writeFileSync(join(generatedDir, 'old.json'), '{"old":true}\n');
    const row = createReplaySelectionRow({ levelResId: 1, ReplayCode: 'code', grade: 1, ElementCount: 8 });
    const invalidCsv = serializeReplaySelectionCsv([row]).replace(',1,0,8,', ',100,0,8,');
    writeFileSync(csvPath, invalidCsv, 'utf8');

    assert.throws(() => buildReplaySelections(csvPath, generatedDir), /第 2 行 grade 必须是 0-99 的整数/);
    assert.equal(readFileSync(join(generatedDir, 'old.json'), 'utf8'), '{"old":true}\n');
  });
});
