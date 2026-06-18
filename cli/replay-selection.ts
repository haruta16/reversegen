#!/usr/bin/env npx tsx

import {
  buildReplaySelections,
  checkReplaySelections,
  defaultReplaySelectionPaths,
} from '../src/replay-selection.js';

function valueAfter(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function printSummary(label: string, summary: ReturnType<typeof checkReplaySelections>): void {
  console.log(`${label}: 读取 ${summary.rowsRead} 行，有效 ${summary.validRows} 行，空 grade 跳过 ${summary.skippedBlankGrade} 行，关卡 ${summary.levelCount} 个`);
  if (summary.skippedLines.length > 0) {
    console.log(`空 grade 行号: ${summary.skippedLines.join(', ')}`);
  }
}

const command = process.argv[2];
const defaults = defaultReplaySelectionPaths();
const csvPath = valueAfter('--csv') ?? defaults.csvPath;
const generatedDir = valueAfter('--out') ?? defaults.generatedDir;

try {
  if (command === 'check') {
    printSummary('校验通过', checkReplaySelections(csvPath));
  } else if (command === 'build') {
    const result = buildReplaySelections(csvPath, generatedDir);
    printSummary('构建完成', result);
    console.log(`已生成 ${result.files.length} 个 JSON: ${generatedDir}`);
  } else {
    console.error('用法: npx tsx cli/replay-selection.ts <check|build> [--csv path] [--out dir]');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
