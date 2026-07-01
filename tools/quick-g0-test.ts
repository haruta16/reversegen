#!/usr/bin/env npx tsx
import { loadTerrainFromFile, getAllTiles, computeDependencyDepth, LogLevel, setLogLevel } from '../src/index.js';
import { generateAndEvaluateOne } from '../src/batch-generator.js';
import { mulberry32 } from '../src/random-utils.js';

setLogLevel(LogLevel.Silent);

const LID = process.argv[2] || '100003';
const terrain = loadTerrainFromFile(`/Users/wenhaowang/WorkSpace/TileMatchShell/Tools/Config/Json/Levels/${LID}.json`);
const allTiles = getAllTiles(terrain);
const freeTiles = allTiles.filter(t => !t.isConst).length;
const maxCC = Math.floor(freeTiles / 3);
const depth = computeDependencyDepth(allTiles.filter(t => !t.isConst), new Map(allTiles.map(t => [t.id, t])));
const layers = Math.max(0, (depth.size > 0 ? Math.max(...depth.values()) : 1) - 1);

console.log(`terrain=${LID}  freeTiles=${freeTiles}  maxCC=${maxCC}  layers=${layers}`);
console.log('');

for (let cc = 8; cc <= Math.min(12, maxCC); cc++) {
  const grades: number[] = [];
  const passrates: number[] = [];
  const sim5s: number[] = [];
  for (let run = 0; run < 10; run++) {
    const seed = (Number(LID) * 1000 + cc * 10 + run) * 131;
    const rng = mulberry32(seed);
    const row = generateAndEvaluateOne(terrain, {
      closeRates: Array.from({ length: layers }, () => 1.0),
      colorCount: cc,
      spreadParam: 0.5 + rng() * 0.5,
      debtPersistenceWeight: 0,
    }, 0, '', run + 1, false, 100, seed);
    grades.push(row.grade);
    passrates.push(row.passrate);
    sim5s.push(row.sim5WinRate);
  }
  const g0 = grades.filter(g => g === 0).length;
  const g1 = grades.filter(g => g === 1).length;
  const avgP = passrates.reduce((a,b) => a + b, 0) / passrates.length;
  const avgS5 = sim5s.reduce((a,b) => a + b, 0) / sim5s.length;
  console.log(`cc=${cc}  G0=${g0}/10  G1=${g1}/10  grades=[${grades.join(',')}]`);
  console.log(`        passrate avg=${avgP.toFixed(4)}  sim5% avg=${avgS5.toFixed(4)}  range=[${Math.min(...sim5s).toFixed(3)},${Math.max(...sim5s).toFixed(3)}]`);
  console.log('');
}
