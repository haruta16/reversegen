import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeStrategy1 } from '../../src/grader.js';
import type { GradeStrategy1Config, SimResult, SimSnapshot } from '../../src/grader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', '..', 'config', 'grade-strategy-1.json');
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as GradeStrategy1Config;

function sim(winRate: number): SimResult {
  const runs = 100;
  const wins = Math.round(winRate * runs);
  return { winRate, wins, losses: runs - wins, runs, elapsedMs: 0 };
}

function snap(sim1: number, sim5: number, sim15: number): SimSnapshot {
  return { sim1: sim(sim1), sim5: sim(sim5), sim15: sim(sim15) };
}

describe('分档策略1', () => {
  it('uses sim15=65% to split the two easiest tiers', () => {
    assert.equal(gradeStrategy1(snap(0.95, 0.80, 0.65), config).grade, 0);
    assert.equal(gradeStrategy1(snap(0.95, 0.80, 0.649), config).grade, 1);
  });

  it('classifies the six configured tiers', () => {
    assert.equal(gradeStrategy1(snap(0.95, 0.80, 0.70), config).grade, 0);
    assert.equal(gradeStrategy1(snap(0.90, 0.80, 0.55), config).grade, 1);
    assert.equal(gradeStrategy1(snap(0.85, 0.55, 0.30), config).grade, 2);
    assert.equal(gradeStrategy1(snap(0.55, 0.25, 0.10), config).grade, 3);
    assert.equal(gradeStrategy1(snap(0.40, 0.12, 0.05), config).grade, 4);
    assert.equal(gradeStrategy1(snap(0.10, 0.05, 0.02), config).grade, 5);
  });

  it('resolves overlaps in favor of the harder tier', () => {
    // 同时命中档1与档2，harder-first 应返回档2。
    assert.equal(gradeStrategy1(snap(0.90, 0.65, 0.50), config).grade, 2);

    // 同时命中档3与档4，harder-first 应返回档4。
    assert.equal(gradeStrategy1(snap(0.40, 0.12, 0.05), config).grade, 4);

    // 同时命中档4与档5，harder-first 应返回档5。
    assert.equal(gradeStrategy1(snap(0.10, 0.05, 0.02), config).grade, 5);
  });

  it('handles decimal boundaries without floating-point drift', () => {
    // 0.91 - 0.31 在 JS 中可能表示为 0.6000000000000001。
    assert.equal(gradeStrategy1(snap(0.91, 0.69, 0.31), config).grade, 2);
  });

  it('returns an uncertified verdict when no tier matches', () => {
    const verdict = gradeStrategy1(snap(0.90, 0.40, 0.10), config);
    assert.equal(verdict.grade, -1);
    assert.equal(verdict.passed, false);
    assert.match(verdict.reason ?? '', /未命中分档策略1/);
  });
});
