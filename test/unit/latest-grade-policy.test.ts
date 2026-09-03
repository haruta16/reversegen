import assert from 'node:assert/strict';
import test from 'node:test';
import { gradeLatestReplayPolicy } from '../../src/strategy/latest-grade-policy.js';

test('latest policy assigns G11 from optimal and sim1, then applies the shared remaining filter', () => {
  const g11Candidate = gradeLatestReplayPolicy(0.20, 0.05, 0.31);
  assert.equal(g11Candidate.grade, 11);
  assert.equal(g11Candidate.passed, false);

  const accepted = gradeLatestReplayPolicy(0.20, 0.05, 0.2499);
  assert.equal(accepted.grade, 11);
  assert.equal(accepted.passed, true);
  assert.equal(gradeLatestReplayPolicy(0.21, 0.05, 0.30).grade, 8);
  assert.equal(gradeLatestReplayPolicy(0.20, 0.06, 0.30).grade, 8);
});

test('latest policy requires G5-G11 to have remaining ratio below 25%', () => {
  const accepted = gradeLatestReplayPolicy(0.50, 0.40, 0.2499);
  assert.equal(accepted.grade, 5);
  assert.equal(accepted.passed, true);

  const rejected = gradeLatestReplayPolicy(0.50, 0.40, 0.25);
  assert.equal(rejected.grade, 5);
  assert.equal(rejected.passed, false);
  assert.match(rejected.reason ?? '', /G5-G11.*<25%/);

  assert.equal(gradeLatestReplayPolicy(0.60, 0.60, 0.90).grade, 4);
  assert.equal(gradeLatestReplayPolicy(0.60, 0.60, 0.90).passed, true);
});

test('latest policy accepts an adjustable shared remaining-ratio limit', () => {
  assert.equal(gradeLatestReplayPolicy(0.50, 0.40, 0.30, 0.31).passed, true);
  const rejected = gradeLatestReplayPolicy(0.50, 0.40, 0.30, 0.30);
  assert.equal(rejected.passed, false);
  assert.equal(rejected.remainingRatioLimit, 0.30);
  assert.match(rejected.reason ?? '', /<30%/);
  assert.throws(() => gradeLatestReplayPolicy(0.50, 0.40, 0.20, 0));
});
