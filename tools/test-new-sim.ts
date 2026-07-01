#!/usr/bin/env npx tsx
import { generateAndEvaluateOne } from '../src/batch-generator-new.js';
import { loadTerrainFromFile, LogLevel, setLogLevel } from '../src/index.js';

setLogLevel(LogLevel.Silent);
const terrain = loadTerrainFromFile('/Users/wenhaowang/WorkSpace/TileMatchShell/Tools/Config/Json/Levels/100006.json');

const row = generateAndEvaluateOne(terrain, {
  closeRates: [1.0, 1.0],
  colorCount: 8,
  spreadParam: 0.75,
  debtPersistenceWeight: 0,
}, 0, '/tmp/test.json', 1, false, 10, 100);

console.log('grade:', row.grade, 'passrate:', row.passrate.toFixed(4));
console.log('avgRemainingOnFail:', row.avgRemainingOnFail);
console.log('avgForcedPickCount:', row.avgForcedPickCount);
console.log('avgColorStarvationCount:', row.avgColorStarvationCount.toFixed(4));
console.log('SUCCESS');
