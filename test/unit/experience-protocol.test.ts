import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  EXPERIENCE_MESSAGES,
  PROTOCOL_VERSION,
  createExperienceBridge,
  normalizeLoadTerrainMessage,
  resolveParentOrigin,
} from '../../gui/reversegen-experience-v2.js';
import type { BridgeWindow, ExperienceBridgeHost, HostTerrainLoad } from '../../gui/reversegen-experience-v2.js';

const flushMessages = () => new Promise<void>(resolve => setImmediate(resolve));
const waitFor = async (predicate: () => boolean, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待协议消息超时');
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
};

function createHarness() {
  const posted: Array<{ message: Record<string, unknown>; targetOrigin: string }> = [];
  const listeners = new Set<(event: MessageEvent) => void>();
  const parent = {
    postMessage(message: unknown, targetOrigin: string) {
      posted.push({ message: message as Record<string, unknown>, targetOrigin });
    },
  };
  const windowRef = {
    parent,
    addEventListener(_type: 'message', listener: (event: MessageEvent) => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: 'message', listener: (event: MessageEvent) => void) {
      listeners.delete(listener);
    },
  } as unknown as BridgeWindow;
  const dispatch = (data: unknown, origin = 'https://manager.example', source: unknown = parent) => {
    for (const listener of listeners) {
      listener({ data, origin, source } as MessageEvent);
    }
  };
  return { dispatch, listeners, parent, posted, windowRef };
}

describe('ReverseGen management iframe protocol v2', () => {
  it('normalizes only exact terrain messages with immutable identity', () => {
    const message = normalizeLoadTerrainMessage({
      type: EXPERIENCE_MESSAGES.loadTerrain,
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'terrain-42',
      terrain: { levelResId: 42, LevelHash: 'ABCDEF' },
      levelIdentity: { levelId: 42, source: 'official', revision: 'commit-7', hash: 'ABCDEF' },
    });

    assert.equal(message.requestId, 'terrain-42');
    assert.deepEqual(message.levelIdentity, {
      levelId: 42,
      source: 'official',
      revision: 'commit-7',
      hash: 'abcdef',
    });
    assert.match(message.terrainJson, /"levelResId":42/);
    assert.throws(() => normalizeLoadTerrainMessage({
      type: EXPERIENCE_MESSAGES.loadTerrain,
      protocolVersion: 1,
      requestId: 'old',
      terrain: {},
      levelIdentity: { source: 'official', revision: 'r1', hash: 'a' },
    }), /不支持 protocolVersion/);
    assert.equal(resolveParentOrigin('https://manager.example/levels/42'), 'https://manager.example');
  });

  it('uses an exact parent origin, acknowledges the actual hash, and ignores forged messages', async () => {
    const harness = createHarness();
    const loaded: HostTerrainLoad[] = [];
    const host: ExperienceBridgeHost = {
      async getRuntimeConfig() { return { appVersion: '2.4.1' }; },
      async loadTerrain(input) {
        loaded.push(input);
        return {
          actualHash: 'aabbccdd00112233',
          validation: {
            ok: true,
            checks: { levelHashMatches: true },
            warnings: [],
            errors: [],
          },
        };
      },
      async loadLegacyLevel() { return { ok: true, actualHash: 'legacy-hash' }; },
    };
    let sequence = 0;
    const bridge = createExperienceBridge({
      windowRef: harness.windowRef,
      documentRef: { referrer: 'https://manager.example/levels/42/experience' },
      host,
      createRequestId: prefix => `${prefix}-${++sequence}`,
      cryptoRef: webcrypto as unknown as Crypto,
    });
    await bridge.ready;

    const ready = harness.posted.find(entry => entry.message.type === EXPERIENCE_MESSAGES.ready);
    assert.equal(ready?.targetOrigin, 'https://manager.example');
    assert.equal(ready?.message.protocolVersion, 2);
    assert.equal(ready?.message.appVersion, '2.4.1');
    assert.equal((ready?.message.capabilities as Record<string, boolean>).exactTerrainJson, true);
    assert.match(String(ready?.message.requestId), /^ready-/);

    harness.dispatch({ type: EXPERIENCE_MESSAGES.ping, requestId: 'probe-1' });
    await waitFor(() => harness.posted.filter(entry => entry.message.type === EXPERIENCE_MESSAGES.ready).length === 2);
    const repeatedReady = harness.posted.filter(entry => entry.message.type === EXPERIENCE_MESSAGES.ready)[1];
    assert.equal(repeatedReady?.message.requestId, 'probe-1');

    const loadMessage = {
      type: EXPERIENCE_MESSAGES.loadTerrain,
      protocolVersion: 2,
      requestId: 'load-exact-42',
      terrain: { levelResId: 42, LevelHash: 'aabbccdd00112233', layers: [] },
      levelIdentity: {
        levelId: 42,
        source: 'official',
        revision: 'git-abcdef',
        hash: 'aabbccdd00112233',
      },
    };
    harness.dispatch(loadMessage, 'https://evil.example');
    harness.dispatch(loadMessage, 'https://manager.example', {});
    await flushMessages();
    assert.equal(loaded.length, 0);

    harness.dispatch(loadMessage);
    await waitFor(() => loaded.length === 1 && harness.posted.some(
      entry => entry.message.type === EXPERIENCE_MESSAGES.terrainLoaded,
    ));
    assert.equal(loaded.length, 1);
    assert.deepEqual(loaded[0].terrain, loadMessage.terrain);
    assert.equal(loaded[0].levelIdentity.revision, 'git-abcdef');
    assert.match(loaded[0].contentHash, /^[a-f0-9]{64}$/);

    const ack = harness.posted.find(entry => entry.message.type === EXPERIENCE_MESSAGES.terrainLoaded);
    assert.equal(ack?.message.requestId, 'load-exact-42');
    assert.equal(ack?.message.protocolVersion, 2);
    assert.equal(ack?.message.ok, true);
    assert.equal(ack?.message.actualHash, 'aabbccdd00112233');
    assert.match(String(ack?.message.contentHash), /^[a-f0-9]{64}$/);

    bridge.dispose();
    assert.equal(harness.listeners.size, 0);
  });

  it('publishes candidate and dirty messages with request IDs and keeps legacy load-level', async () => {
    const harness = createHarness();
    const legacyIds: unknown[] = [];
    const host: ExperienceBridgeHost = {
      async getRuntimeConfig() { return { appVersion: '2.0.0' }; },
      async loadTerrain() { return { actualHash: '', validation: { ok: true } }; },
      async loadLegacyLevel(levelId) {
        legacyIds.push(levelId);
        return { ok: true, actualHash: '0011' };
      },
    };
    let sequence = 0;
    const bridge = createExperienceBridge({
      windowRef: harness.windowRef,
      documentRef: { referrer: 'https://manager.example/' },
      host,
      createRequestId: prefix => `${prefix}-${++sequence}`,
      cryptoRef: webcrypto as unknown as Crypto,
    });
    await bridge.ready;
    harness.posted.length = 0;

    assert.equal(bridge.publishLevelSelection({ levelId: 42, levelHash: 'AABBCCDD' }, 'selected-42'), true);
    const selected = harness.posted.find(entry => entry.message.type === EXPERIENCE_MESSAGES.levelSelected);
    assert.equal(selected?.message.requestId, 'selected-42');
    assert.equal(selected?.message.levelId, 42);
    assert.equal(selected?.message.levelHash, 'aabbccdd');
    assert.throws(() => bridge.publishLevelSelection({ levelId: 0, levelHash: '' }), /正整数/);

    await bridge.publishCandidate({
      replayCode: 'v4-candidate',
      generator: { name: 'closure' },
      parameterSummary: { serialized: '50,100:8:7:50:0:0:50:42' },
      metrics: { peakDebt: 4 },
    }, 'candidate-request-1');
    const candidate = harness.posted.find(entry => entry.message.type === EXPERIENCE_MESSAGES.candidate);
    const candidatePayload = candidate?.message.candidate as Record<string, unknown>;
    assert.equal(candidate?.message.protocolVersion, 2);
    assert.equal(candidate?.message.requestId, 'candidate-request-1');
    assert.equal((candidatePayload.generator as Record<string, unknown>).version, '2.0.0');
    assert.match(String((candidatePayload.parameterSummary as Record<string, unknown>).hash), /^[a-f0-9]{64}$/);
    const dirty = harness.posted.find(entry => entry.message.type === EXPERIENCE_MESSAGES.dirtyState);
    assert.equal(dirty?.message.dirty, true);
    assert.equal(dirty?.message.requestId, 'candidate-request-1');

    harness.dispatch({ type: EXPERIENCE_MESSAGES.legacyLoadLevel, levelId: 42 });
    await waitFor(() => legacyIds.length === 1 && harness.posted.some(
      entry => entry.message.type === EXPERIENCE_MESSAGES.legacyLoadLevelResult,
    ));
    assert.deepEqual(legacyIds, [42]);
    const legacyAck = harness.posted.find(entry => entry.message.type === EXPERIENCE_MESSAGES.legacyLoadLevelResult);
    assert.equal(legacyAck?.message.levelId, 42);
    assert.equal(legacyAck?.message.ok, true);
    assert.equal(legacyAck?.message.legacy, true);
    assert.equal(legacyAck?.message.protocolVersion, 2);
    assert.match(String(legacyAck?.message.requestId), /^legacy-load-/);
  });
});
