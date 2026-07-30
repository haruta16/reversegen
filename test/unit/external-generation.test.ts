import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  decodeGenerationParameterString,
  generateReplayFromExternalInput,
} from '../../src/external-generation.js';
import { decodeFromString, LogLevel, setLogLevel } from '../../src/index.js';

setLogLevel(LogLevel.Silent);

const terrainJson = readFileSync(join(process.cwd(), 'test', 'fixtures', '100075.json'), 'utf8');
const terrainObject = JSON.parse(terrainJson) as Record<string, unknown>;
const closureParameterString = '50,71,80,85,90,95,98,100:8:7:50:0:0:50:100075';

describe('external Replay generation API core', () => {
  it('decodes the current positional LayerClosure copy format', () => {
    const params = decodeGenerationParameterString(closureParameterString);
    assert.equal(params.algorithm, 'closure');
    assert.equal(params.levelId, '100075');
    assert.equal(params.colorCount, '8');
    assert.equal(params.dock, '7');
    assert.equal(params.spreadParam, '0.5');
    assert.equal(params.debtPersistenceWeight, '0');
    assert.equal(params.colorAllocationMode, 'balanced');
    assert.equal(params.colorAllocationMaxRatio, '0.5');
    assert.equal(params.closeRates, '0.5,0.71,0.8,0.85,0.9,0.95,0.98,1');
  });

  it('decodes the current positional CostLadder copy format', () => {
    assert.deepEqual(
      decodeGenerationParameterString('1,2,3:8:1.2:100075'),
      {
        algorithm: 'cost-ladder',
        levelId: '100075',
        colorCount: '8',
        costArray: '1,2,3',
        targetStd: '1.2',
      },
    );
  });

  it('decodes the current RGP1 copy format', () => {
    const snapshot = {
      algorithm: 'tile-explorer',
      levelId: '100075',
      colorCount: '8',
      teStrategy: 'default',
      difficulty: '2',
      sequenceSeed: '3',
      placementSeed: '4',
    };
    const parameterString = `RGP1.${Buffer.from(JSON.stringify(snapshot)).toString('base64url')}`;
    assert.deepEqual(decodeGenerationParameterString(parameterString), snapshot);
  });

  it('generates a decodable ReplayCode from copied parameters and a level JSON object', () => {
    const result = generateReplayFromExternalInput({
      parameterString: closureParameterString,
      terrain: terrainObject,
    });
    const replay = decodeFromString(result.replayCode);
    assert.equal(result.algorithm, 'closure');
    assert.equal(result.levelResId, 100075);
    assert.equal(result.elementCount, 8);
    assert.equal(replay?.instanceArray.length, 84);
    assert.equal(replay?.elementCount, 8);
  });

  it('decodes the current positional Zen Match copy format', () => {
    assert.deepEqual(
      decodeGenerationParameterString('Zen:5:4:0:100075'),
      {
        algorithm: 'zen-match',
        levelId: '100075',
        colorCount: '5',
        zenStrategy: '4',
        seed: '0',
      },
    );
  });

  it('keeps legacy Zen Match RGP1 parameters readable', () => {
    const snapshot = {
      algorithm: 'zen-match' as const,
      levelId: '100075',
      colorCount: '5',
      zenStrategy: '4',
      seed: '0',
    };
    const parameterString = `RGP1.${Buffer.from(JSON.stringify(snapshot)).toString('base64url')}`;
    assert.deepEqual(decodeGenerationParameterString(parameterString), snapshot);
  });

  it('generates Zen Match ReplayCode from a positional parameter string', () => {
    const parameterString = 'Zen:5:5:12345:100075';
    const result = generateReplayFromExternalInput({
      parameterString,
      terrain: terrainObject,
    });
    const replay = decodeFromString(result.replayCode);
    assert.equal(result.algorithm, 'zen-match');
    assert.equal(result.elementCount, 5);
    assert.equal(replay?.instanceArray.length, 84);
    assert.equal(replay?.elementCount, 5);
  });

  it('rejects a parameter string for a different level file', () => {
    assert.throws(
      () => generateReplayFromExternalInput({
        parameterString: closureParameterString.replace(/100075$/, '600001'),
        terrain: terrainJson,
      }),
      /参数串关卡 600001 与关卡文件 100075 不一致/,
    );
  });
});
