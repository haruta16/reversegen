#!/usr/bin/env npx tsx
import { generateAndEvaluateOne } from '../src/batch-generator-new.js';
import { loadTerrainFromFile, LogLevel, setLogLevel } from '../src/index.js';
setLogLevel(LogLevel.Silent);

for (const lid of ['100003', '100006']) {
  const terrain = loadTerrainFromFile(`/Users/wenhaowang/WorkSpace/TileMatchShell/Tools/Config/Json/Levels/${lid}.json`);
  for (const cc of [8, 12, 16]) {
    const row = generateAndEvaluateOne(terrain, {
      closeRates: [1.0, 1.0],
      colorCount: cc,
      spreadParam: 0.75,
      debtPersistenceWeight: 0,
    }, 0, '', 1, false, 20, 100);
    console.log(`${lid} cc=${cc>9?'': ' '}${cc}  grade=${row.grade}  passrate=${row.passrate.toFixed(3)}  remainFail=${row.avgRemainingOnFail.toFixed(1)}  forcedPick=${row.avgForcedPickCount.toFixed(1)}  suitSpread=${row.suitSpreadNorm.toFixed(3)}`);
  }
  console.log('');
}
