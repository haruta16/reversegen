/**
 * V4 全地形批量验证 — 134 terrains (skip 100001).
 *
 * 每个地形测试:
 *   SOLVABLE × 1
 *   DEATH@0  × 1
 *   DEATH@K  × 3 (K=1/4, 1/2, 3/4)
 *   DEATH@last × 1
 *
 * 全部 DFS-free，纯结构验证。
 */

import { readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateV4, type GenV4Output } from '../src/generate-v4.js';
import { loadTerrainFromFile, getAllTiles } from '../src/terrain-loader.js';
import { setLogLevel, LogLevel } from '../src/logger.js';
setLogLevel(LogLevel.Error);

const LEVELS_DIR = join(
  'E:/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels'
);

interface TestResult {
  levelResId: number;
  freeTiles: number;
  totalSteps: number;
  tests: {
    name: string;
    ok: boolean;
    div3: boolean;
    branchOk: boolean;
    branchLogLen: number;
    error?: string;
  }[];
}

function runAll(): void {
  const files = readdirSync(LEVELS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => parseInt(f.replace('.json', ''), 10))
    .filter(id => id !== 100001)
    .sort((a, b) => a - b);

  console.log(`Validating ${files.length} terrains...\n`);
  const results: TestResult[] = [];
  let totalTests = 0, passedTests = 0;

  for (const tid of files) {
    const terrainPath = join(LEVELS_DIR, `${tid}.json`);
    if (!existsSync(terrainPath)) continue;

    // Load terrain once
    let terrain: any;
    try { terrain = loadTerrainFromFile(terrainPath); } catch { continue; }
    const tiles = getAllTiles(terrain);
    const freeTiles = (tiles as any[]).filter((t: any) => !t.isConst).length;
    const totalSteps = Math.floor(freeTiles / 3);
    if (totalSteps === 0) continue;

    const tr: TestResult = { levelResId: tid, freeTiles, totalSteps, tests: [] };

    // ── SOLVABLE ──
    try {
      const r = generateV4({ terrain, solvable: true });
      tr.tests.push({ name: 'SOLVABLE', ok: r.ok, div3: r.colorSizes.every((x: number) => x%3===0), branchOk: r.branchLog.every((b: number) => b>=1), branchLogLen: r.branchLog.length });
      totalTests++; if (r.ok) passedTests++;
    } catch (e: any) {
      tr.tests.push({ name: 'SOLVABLE', ok: false, div3: false, branchOk: false, branchLogLen: 0, error: e.message?.slice(0,60) });
      totalTests++;
    }

    // ── DEATH steps ──
    const deathSteps = [0, Math.floor(totalSteps/4), Math.floor(totalSteps/2), Math.floor(totalSteps*3/4), totalSteps-1]
      .filter((ds: number) => ds >= 0 && ds < totalSteps)
      .filter((v: number, i: number, a: number[]) => a.indexOf(v) === i);

    for (const ds of deathSteps) {
      try {
        const r = generateV4({ terrain, solvable: false, deathStep: ds });
        const preOk = r.branchLog.slice(0, ds).every((b: number) => b >= 1);
        const deathOk = r.branchLog[ds] === 0;
        const label = ds === 0 ? 'D@0' : ds === totalSteps-1 ? 'D@last' : `D@${ds}`;
        tr.tests.push({ name: label, ok: r.ok, div3: r.colorSizes.every((x: number) => x%3===0), branchOk: preOk && deathOk, branchLogLen: r.branchLog.length });
        totalTests++; if (r.ok) passedTests++;
      } catch (e: any) {
        tr.tests.push({ name: `D@${ds}`, ok: false, div3: false, branchOk: false, branchLogLen: 0, error: e.message?.slice(0,60) });
        totalTests++;
      }
    }

    results.push(tr);

    // Progress
    if (results.length % 20 === 0) {
      console.log(`  ${results.length}/${files.length} terrains, ${passedTests}/${totalTests} tests passed`);
    }
  }

  // ── Report ──
  const solvableResults = results.flatMap(r => r.tests.filter(t => t.name === 'SOLVABLE'));
  const deathResults = results.flatMap(r => r.tests.filter(t => t.name.startsWith('D@')));

  const solPassed = solvableResults.filter(t => t.ok).length;
  const deathPassed = deathResults.filter(t => t.ok).length;
  const div3Passed = results.flatMap(r => r.tests).filter(t => t.div3).length;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  V4 VALIDATION REPORT — ${files.length} terrains`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Total tests:           ${totalTests}`);
  console.log(`  Passed:                ${passedTests} (${(passedTests*100/totalTests).toFixed(1)}%)`);
  console.log(`  SOLVABLE passed:       ${solPassed}/${solvableResults.length} (${(solPassed*100/solvableResults.length).toFixed(1)}%)`);
  console.log(`  DEATH passed:          ${deathPassed}/${deathResults.length} (${(deathPassed*100/deathResults.length).toFixed(1)}%)`);
  console.log(`  div3 compliant:        ${div3Passed}/${totalTests} (${(div3Passed*100/totalTests).toFixed(1)}%)`);

  // Failures
  const failures = results.flatMap(r =>
    r.tests.filter(t => !t.ok).map(t => ({ tid: r.levelResId, ...t }))
  );
  if (failures.length > 0) {
    console.log(`\n  Failures (${failures.length}):`);
    for (const f of failures.slice(0, 30)) {
      console.log(`    ${f.tid} ${f.name}: ${f.error ?? 'branch/death mismatch'}`);
    }
    if (failures.length > 30) console.log(`    ... and ${failures.length - 30} more`);
  }

  // Detail: per-terrain
  console.log(`\n  Per-terrain summary (first 10 + any with failures):`);
  let shown = 0;
  for (const r of results) {
    const failCount = r.tests.filter(t => !t.ok).length;
    if (shown < 10 || failCount > 0) {
      const fails = r.tests.filter(t => !t.ok).map(t => t.name).join(',');
      console.log(`    ${r.levelResId} (${r.freeTiles}t ${r.totalSteps}st): ${r.tests.length-failCount}/${r.tests.length} passed${failCount>0?' ⚠ '+fails:''}`);
      shown++;
    }
  }

  // Write JSON
  const outPath = join(process.cwd(), '.reversegen-cache', 'v4-validation.json');
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n  Full results: ${outPath}`);
}

runAll();
