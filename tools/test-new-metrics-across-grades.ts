#!/usr/bin/env npx tsx
import { generateAndEvaluateOne } from '../src/batch-generator-new.js';
import { loadTerrainFromFile, LogLevel, setLogLevel } from '../src/index.js';
setLogLevel(LogLevel.Silent);

// 从初始CSV里挑各档位代表性牌局，每个测一次（simRuns=50）
const samples = [
  { label: 'G0·easy',   lid: '100018', cc: 7,  cr: [0.88], spread: 0.5, debt: 0 },
  { label: 'G1·simple',  lid: '100006', cc: 8,  cr: [0.50], spread: 0.5, debt: 0 },
  { label: 'G2·mid',     lid: '100005', cc: 13, cr: [0.50], spread: 0.5, debt: 0 },
  { label: 'G3·midhard', lid: '100006', cc: 8,  cr: [0.20], spread: 0.5, debt: 0 },
  { label: 'G5·hard',    lid: '100007', cc: 13, cr: [0.20], spread: 0.5, debt: 0 },
];

console.log('label           grade passrate  remainFail forcedPk suitSpread');
console.log('─'.repeat(70));

for (const s of samples) {
  const terrain = loadTerrainFromFile(`/Users/wenhaowang/WorkSpace/TileMatchShell/Tools/Config/Json/Levels/${s.lid}.json`);
  const row = generateAndEvaluateOne(terrain, {
    closeRates: s.cr,
    colorCount: s.cc,
    spreadParam: s.spread,
    debtPersistenceWeight: s.debt,
  }, 0, '', 1, false, 50, 200);

  console.log(
    `${s.label.padEnd(15)} ${String(row.grade).padEnd(5)} ${row.passrate.toFixed(3).padEnd(8)} ${row.avgRemainingOnFail.toFixed(1).padEnd(10)} ${row.avgForcedPickCount.toFixed(1).padEnd(9)} ${row.suitSpreadNorm.toFixed(3)}`
  );
}
