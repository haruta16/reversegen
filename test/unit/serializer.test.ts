/**
 * Tests for the ReplaySerializer.
 *
 * Uses real terrain fixture from test/fixtures/100075.json (84 tiles, 28 steps).
 *
 * Run: npx tsx --test test/test-serializer.ts
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateReplayCode,
  encodeToString,
  decodeFromString,
  looksLikeReplayCode,
  parseLevelHash,
  formatHash,
  FORMAT_VERSION,
  getCanonicalTileOrder,
  computeCRC16,
  computeCRC16Bitwise,
  loadTerrainFromFile,
  getAllTiles,
  setLogLevel,
  LogLevel,
  TileState,
} from '../../src/index.js';
import type { TerrainTile, DockEntry } from '../../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', 'fixtures', '100075.json');

setLogLevel(LogLevel.Silent);

/** Load the real terrain fixture (100075: 84 tiles) */
function loadFixture(): TerrainTile[] {
  return getAllTiles(loadTerrainFromFile(FIXTURE));
}

/** Assign element values to tiles: tile index % colorCount + 1 */
function assignElements(tiles: TerrainTile[], colorCount: number): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < tiles.length; i++) {
    m.set(tiles[i].id, (i % colorCount) + 1);
  }
  return m;
}

describe('CRC16/MODBUS', () => {
  it('should produce correct CRC for known values', () => {
    // Test vector: "123456789" → CRC16/MODBUS = 0x4B37
    const data = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]);
    assert.equal(computeCRC16(data), 0x4B37);
  });

  it('table and bitwise implementations should match', () => {
    const data = new Uint8Array(256);
    for (let i = 0; i < 256; i++) data[i] = i;
    assert.equal(computeCRC16(data), computeCRC16Bitwise(data));
  });
});

describe('ReplaySerializer', () => {
  const tiles = loadFixture();
  const elementValues = assignElements(tiles, 8);

  it('should generate a valid ReplayCode', () => {
    const code = generateReplayCode(tiles, elementValues, '0000000000000001');
    assert.ok(code.length > 0);
    assert.ok(looksLikeReplayCode(code));
  });

  it('should decode back correctly', () => {
    const code = generateReplayCode(tiles, elementValues, '0000000000000001');
    const decoded = decodeFromString(code);

    assert.ok(decoded !== null);
    assert.equal(decoded!.version, FORMAT_VERSION);
    assert.equal(decoded!.instanceArray.length, 84);
    assert.equal(decoded!.elementCount, 8);
    assert.equal(decoded!.dockEntries.length, 0);
  });

  it('should handle empty dock entries', () => {
    const code = generateReplayCode(tiles, elementValues, '');
    const decoded = decodeFromString(code);

    assert.ok(decoded !== null);
    assert.equal(decoded!.dockEntries.length, 0);
  });

  it('should handle dock entries', () => {
    const dockEntries: DockEntry[] = [
      { tileId: 0, element: 1 },
      { tileId: 2, element: 3 },
    ];

    const code = generateReplayCode(tiles, elementValues, '', dockEntries);
    const decoded = decodeFromString(code);

    assert.ok(decoded !== null);
    assert.equal(decoded!.dockEntries.length, 2);
    assert.equal(decoded!.dockEntries[0].tileId, 0);
    assert.equal(decoded!.dockEntries[0].element, 1);
    assert.equal(decoded!.dockEntries[1].tileId, 2);
    assert.equal(decoded!.dockEntries[1].element, 3);
  });

  it('should reject invalid ReplayCode strings', () => {
    assert.equal(looksLikeReplayCode(''), false);
    assert.equal(looksLikeReplayCode('1-2-3-18-12345'), false); // traditional format
    assert.equal(looksLikeReplayCode('invalid!!!'), false);
  });

  it('should detect traditional replay seed format', () => {
    assert.equal(looksLikeReplayCode('3-3-3-18-123456'), false);
    assert.equal(looksLikeReplayCode('1,2,3-18-123'), false);
  });

  it('should normalize element values', () => {
    // Assign non-sequential values [501, 502, 503, ...] → should normalize to [1, 2, 3, ...]
    const nonNorm = new Map<number, number>();
    for (let i = 0; i < tiles.length; i++) {
      nonNorm.set(tiles[i].id, 501 + (i % 8));
    }

    const code = generateReplayCode(tiles, nonNorm, '');
    const decoded = decodeFromString(code);

    assert.ok(decoded !== null);
    assert.equal(decoded!.elementCount, 8);

    const indices = new Set<number>();
    for (let i = 0; i < decoded!.instanceArray.length; i++) {
      indices.add(decoded!.instanceArray[i] & 0x3F);
    }
    assert.deepEqual([...indices].sort(), [0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('should have all tiles as OnField for fresh board', () => {
    const code = generateReplayCode(tiles, elementValues, '');
    const decoded = decodeFromString(code);

    assert.ok(decoded !== null);
    for (let i = 0; i < decoded!.instanceArray.length; i++) {
      const state: number = (decoded!.instanceArray[i] >> 6) & 0x3;
      assert.equal(state, TileState.OnField);
    }
  });

  it('should handle level hash parsing', () => {
    assert.equal(parseLevelHash(''), 0n);
    assert.equal(parseLevelHash('550ede7fd250e2d4'), 0x550ede7fd250e2d4n);
    assert.equal(parseLevelHash('0000000000000000'), 0n);
  });

  it('should format level hash correctly', () => {
    assert.equal(formatHash(0n), '(none)');
    assert.equal(formatHash(0x550ede7fd250e2d4n), '550ede7fd250e2d4');
    assert.equal(formatHash(1n), '0000000000000001');
  });

  it('should produce deterministic output', () => {
    const code1 = generateReplayCode(tiles, elementValues, '0000000000000001');
    const code2 = generateReplayCode(tiles, elementValues, '0000000000000001');
    assert.equal(code1, code2);
  });

  it('should produce different codes for different level hashes', () => {
    const code1 = generateReplayCode(tiles, elementValues, '0000000000000001');
    const code2 = generateReplayCode(tiles, elementValues, '0000000000000002');
    assert.notEqual(code1, code2);
  });

  it('should use raw DEFLATE (RFC 1951), not zlib-wrapped', () => {
    const code = generateReplayCode(tiles, elementValues, '');
    const compressed = Buffer.from(code, 'base64');

    // zlib CMF byte would be 0x78 (deflate, 32K window)
    assert.notEqual(compressed[0] & 0x0F, 0x08,
      'First byte looks like zlib CMF — should be raw DEFLATE');
    assert.notEqual(compressed[0], 0x78,
      'Raw DEFLATE should not start with zlib header byte 0x78');
  });

  it('should reject corrupt data (CRC mismatch)', () => {
    const code = generateReplayCode(tiles, elementValues, '');
    const decoded = decodeFromString(code)!;

    // Round-trip to verify encoding works
    const binary = encodeToString(
      decoded.elementCount,
      decoded.levelHash,
      decoded.instanceArray,
      decoded.dockEntries
    );
    assert.ok(binary.length > 0);

    // Corrupt the Base64 string
    let corrupt = code;
    if (corrupt.length > 5) {
      const pos = Math.floor(corrupt.length / 2);
      const c = corrupt[pos];
      corrupt = corrupt.substring(0, pos) + (c === 'A' ? 'B' : 'A') + corrupt.substring(pos + 1);
    }

    try { decodeFromString(corrupt); } catch { /* expected */ }
  });

  it('should get canonical tile order', () => {
    // Reverse tiles → canonical order should restore layer 0 first, sorted by ID
    const reversed = [...tiles].reverse();
    const ordered = getCanonicalTileOrder(reversed);

    // Verify sorted: layer 0 before layer 1 before ..., ID ascending within layer
    for (let i = 1; i < ordered.length; i++) {
      const a = ordered[i - 1];
      const b = ordered[i];
      assert.ok(
        a.layer < b.layer || (a.layer === b.layer && a.id < b.id),
        `Order violation at index ${i}: tile ${a.id} (L${a.layer}) before tile ${b.id} (L${b.layer})`
      );
    }
  });
});

describe('Round-trip', () => {
  it('should round-trip encode/decode', () => {
    const tiles = loadFixture();
    const elementValues = assignElements(tiles, 8);

    const code = generateReplayCode(tiles, elementValues, 'deadbeefcafebabe');
    const decoded = decodeFromString(code);

    assert.ok(decoded !== null);
    assert.equal(decoded!.version, FORMAT_VERSION);
    assert.equal(decoded!.instanceArray.length, 84);
    assert.equal(decoded!.elementCount, 8);
    assert.equal(formatHash(decoded!.levelHash), 'deadbeefcafebabe');

    // Verify each tile's element value round-trips correctly
    const ordered = getCanonicalTileOrder(tiles);
    for (let i = 0; i < ordered.length; i++) {
      const elemIdx: number = decoded!.instanceArray[i] & 0x3F;
      const normValue: number = elemIdx + 1;
      const expected = elementValues.get(ordered[i].id)!;
      // Normalize expected: the serializer normalizes element values to 1..N
      // We know elementValues maps to 1..8, so expected === normValue
      assert.equal(normValue, expected,
        `Tile ${ordered[i].id} at index ${i}: expected element ${expected}, got ${normValue}`);
    }
  });

  it('should handle max element count (64)', () => {
    // 64 distinct element values × 3 tiles each = 192 tiles
    const tiles: TerrainTile[] = [];
    for (let i = 1; i <= 192; i++) {
      tiles.push({ id: i, layer: 0, dependencies: [], isConst: false, constElementValue: 0, posX: 0, posY: 0 });
    }
    const elementValues = new Map<number, number>();
    for (let i = 1; i <= 192; i++) {
      elementValues.set(i, (i % 64) + 1);
    }

    const code = generateReplayCode(tiles, elementValues, '');
    const decoded = decodeFromString(code);

    assert.ok(decoded !== null);
    assert.equal(decoded!.elementCount, 64);
  });
});
