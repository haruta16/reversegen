import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeWinningPaths } from '../../src/solver/winning-path-analysis.js';

test('winning path analysis counts each normalized interval independently and ignores losses', () => {
  const analysis = analyzeWinningPaths([
    { win: true, picks: [1, 2, 3, 4, 5, 6, 7, 8] },
    { win: true, picks: [1, 2, 3, 4, 5, 6, 7, 8] },
    { win: true, picks: [9, 2, 3, 4, 5, 6, 0, 8] },
    { win: true, picks: [9, 2, 3, 4, 4, 6, 0, 8] },
    { win: false, picks: [7, 7, 7] },
  ]);

  assert.deepEqual(analysis, {
    runs: 5,
    wins: 4,
    losses: 1,
    uniqueWinningPaths: 3,
    intervals: [
      { startProgress: 0, endProgress: 25, uniqueSegments: 2 },
      { startProgress: 25, endProgress: 50, uniqueSegments: 1 },
      { startProgress: 50, endProgress: 75, uniqueSegments: 2 },
      { startProgress: 75, endProgress: 100, uniqueSegments: 2 },
    ],
  });
});

test('winning path analysis supports different winning path lengths', () => {
  const analysis = analyzeWinningPaths([
    { win: true, picks: [1, 2, 3] },
    { win: true, picks: [1, 2, 3, 4] },
  ], 4);

  assert.equal(analysis.runs, 4);
  assert.equal(analysis.wins, 2);
  assert.equal(analysis.losses, 2);
  assert.deepEqual(
    analysis.intervals.map(item => item.uniqueSegments),
    [1, 1, 1, 2],
  );
});

test('winning path analysis returns zero branches when there are no wins', () => {
  const analysis = analyzeWinningPaths([
    { win: false, picks: [1, 2] },
  ]);

  assert.equal(analysis.uniqueWinningPaths, 0);
  assert.deepEqual(analysis.intervals.map(item => item.uniqueSegments), [0, 0, 0, 0]);
});
