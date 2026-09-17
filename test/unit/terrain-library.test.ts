import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  findTerrainInDirectoryByLevelId,
  listLevels,
} from '../../gui/lib/runtime.js';

test('uploaded terrain library lists content-addressed files and selects the newest revision', () => {
  const directory = mkdtempSync(join(tmpdir(), 'reversegen-terrain-library-'));
  try {
    const terrain = JSON.parse(readFileSync(resolve('test/fixtures/100075.json'), 'utf-8'));
    const olderPath = join(directory, 'manual-a1b2c3.json');
    const newerPath = join(directory, 'platform-100075-d4e5f6.json');
    writeFileSync(olderPath, JSON.stringify(terrain));
    const uppercaseIdentityTerrain = { ...terrain, LevelResId: terrain.levelResId };
    delete uppercaseIdentityTerrain.levelResId;
    writeFileSync(newerPath, JSON.stringify(uppercaseIdentityTerrain));
    utimesSync(olderPath, new Date(1_000), new Date(1_000));
    utimesSync(newerPath, new Date(2_000), new Date(2_000));

    assert.deepEqual(listLevels(directory, 'uploaded'), [{
      id: 100075,
      name: '100075',
      tiles: terrain.layers.reduce((total: number, layer: { tiles?: unknown[] }) => total + (layer.tiles?.length || 0), 0),
      source: 'uploaded',
    }]);
    assert.equal(basename(findTerrainInDirectoryByLevelId(directory, '100075') || ''), basename(newerPath));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
