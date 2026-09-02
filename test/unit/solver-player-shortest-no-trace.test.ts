import assert from 'node:assert/strict';
import test from 'node:test';
import { OfflineGame } from '../../src/solver/offline-game.js';
import { solvePlayerShortestBatch } from '../../src/solver/solver-player-shortest.js';
import { OfflineTile } from '../../src/solver/types.js';

test('shortest batch records real action counts when trace collection is disabled', () => {
  const game = new OfflineGame(
    Array.from({ length: 3 }, (_, index) => new OfflineTile({
      id: index + 1,
      layer: 0,
      dependencies: [],
      isConst: false,
      constElementValue: 0,
      posX: index * 10,
      posY: 0,
    }, 1)),
  );

  const result = solvePlayerShortestBatch(game, 2, 11, 2000, { collectTrace: false });

  assert.equal(result.wins, 2);
  assert.equal(result.avgStepsOnWin, 3);
  assert.equal(result.results, undefined);
});
