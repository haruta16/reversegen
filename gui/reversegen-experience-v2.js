export const PROTOCOL_VERSION = 2;

export const EXPERIENCE_MESSAGES = Object.freeze({
  ping: 'reversegen:ping',
  ready: 'reversegen:ready',
  loadTerrain: 'reversegen:load-terrain',
  terrainLoaded: 'reversegen:terrain-loaded',
  dirtyState: 'reversegen:dirty-state',
  candidate: 'reversegen:candidate',
  levelSelected: 'reversegen:level-selected',
  legacyLoadLevel: 'reversegen:load-level',
  legacyLoadLevelResult: 'reversegen:load-level-result',
});

export const EXPERIENCE_CAPABILITIES = Object.freeze({
  repeatableReady: true,
  exactTerrainJson: true,
  levelIdentity: true,
  terrainLoadedAck: true,
  dirtyState: true,
  candidate: true,
  standaloneLevelSelection: true,
  legacyLoadLevel: true,
});

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function requestId(value) {
  const normalized = String(value || '').trim();
  if (!REQUEST_ID_PATTERN.test(normalized)) {
    throw new Error('requestId 必须是 1-128 位字母、数字、点、下划线、冒号或连字符');
  }
  return normalized;
}

export function resolveParentOrigin(referrer) {
  const normalized = String(referrer || '').trim();
  if (!normalized) return '';
  try {
    return new URL(normalized).origin;
  } catch {
    return '';
  }
}

export function normalizeLevelIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('levelIdentity 必须是对象');
  }
  const source = String(value.source || '').trim();
  const revision = String(value.revision || '').trim();
  const hash = String(value.hash || '').trim().toLowerCase();
  if (!source) throw new Error('levelIdentity.source 不能为空');
  if (!revision) throw new Error('levelIdentity.revision 不能为空');
  if (!hash) throw new Error('levelIdentity.hash 不能为空');

  const rawLevelId = value.levelId;
  const levelId = rawLevelId == null || rawLevelId === '' ? null : Number(rawLevelId);
  if (levelId != null && (!Number.isSafeInteger(levelId) || levelId <= 0)) {
    throw new Error('levelIdentity.levelId 必须是正整数');
  }

  return Object.freeze({ levelId, source, revision, hash });
}

export function normalizeLoadTerrainMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('消息必须是对象');
  }
  if (value.type !== EXPERIENCE_MESSAGES.loadTerrain) {
    throw new Error(`消息类型必须是 ${EXPERIENCE_MESSAGES.loadTerrain}`);
  }
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`不支持 protocolVersion=${String(value.protocolVersion)}，当前仅支持 ${PROTOCOL_VERSION}`);
  }
  const normalizedRequestId = requestId(value.requestId);
  const identity = normalizeLevelIdentity(value.levelIdentity);
  if (
    typeof value.terrain !== 'string'
    && (!value.terrain || typeof value.terrain !== 'object' || Array.isArray(value.terrain))
  ) {
    throw new Error('terrain 必须是精确的地形 JSON 对象或 JSON 字符串');
  }
  const terrainJson = typeof value.terrain === 'string'
    ? value.terrain
    : JSON.stringify(value.terrain);
  if (!terrainJson.trim()) throw new Error('terrain 不能为空');
  return { requestId: normalizedRequestId, levelIdentity: identity, terrain: value.terrain, terrainJson };
}

export async function sha256Hex(value, cryptoRef = globalThis.crypto) {
  if (!cryptoRef?.subtle) return '';
  const bytes = new TextEncoder().encode(String(value));
  const digest = await cryptoRef.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function defaultRequestIdFactory(prefix) {
  const randomPart = globalThis.crypto?.randomUUID?.()
    || Math.random().toString(36).slice(2);
  return `${prefix}-${Date.now()}-${randomPart}`;
}

/**
 * Install the management-platform iframe bridge.
 *
 * `host.loadTerrain` receives the exact terrain JSON plus immutable identity.
 * The bridge never resolves a v2 terrain from a local level ID. `loadLegacyLevel`
 * is kept solely for the v1 `reversegen:load-level` compatibility path.
 */
export function createExperienceBridge(options) {
  const windowRef = options.windowRef;
  const documentRef = options.documentRef;
  const host = options.host;
  const parentWindow = windowRef.parent;
  const parentOrigin = options.parentOrigin || resolveParentOrigin(documentRef.referrer);
  const createRequestId = options.createRequestId || defaultRequestIdFactory;
  let disposed = false;
  let currentDirty = null;
  let appVersion = 'unknown';

  const post = (type, outboundRequestId, payload = {}) => {
    if (disposed || !parentOrigin || parentWindow === windowRef) return false;
    parentWindow.postMessage({
      type,
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId(outboundRequestId),
      ...payload,
    }, parentOrigin);
    return true;
  };

  const postReady = (outboundRequestId = createRequestId('ready')) => post(
    EXPERIENCE_MESSAGES.ready,
    outboundRequestId,
    { appVersion, capabilities: EXPERIENCE_CAPABILITIES },
  );

  const setDirty = (dirty, reason = 'state-changed', outboundRequestId = createRequestId('dirty')) => {
    const normalized = Boolean(dirty);
    if (currentDirty === normalized) return false;
    currentDirty = normalized;
    return post(EXPERIENCE_MESSAGES.dirtyState, outboundRequestId, {
      dirty: normalized,
      reason: String(reason || 'state-changed'),
    });
  };

  const publishCandidate = async (candidate, outboundRequestId = createRequestId('candidate')) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('candidate 必须是对象');
    }
    const replayCode = String(candidate.replayCode || '').trim();
    if (!replayCode) throw new Error('candidate.replayCode 不能为空');
    const generatorName = String(candidate.generator?.name || '').trim();
    if (!generatorName) throw new Error('candidate.generator.name 不能为空');
    const parameterSummary = candidate.parameterSummary && typeof candidate.parameterSummary === 'object'
      ? { ...candidate.parameterSummary }
      : {};
    const serializedParameters = String(parameterSummary.serialized || '');
    if (!parameterSummary.hash && serializedParameters) {
      parameterSummary.hash = await sha256Hex(serializedParameters, options.cryptoRef);
    }
    const normalizedCandidate = {
      ...candidate,
      replayCode,
      generator: {
        name: generatorName,
        version: String(candidate.generator?.version || appVersion),
      },
      parameterSummary,
      metrics: candidate.metrics && typeof candidate.metrics === 'object' ? candidate.metrics : {},
    };
    const sent = post(EXPERIENCE_MESSAGES.candidate, outboundRequestId, { candidate: normalizedCandidate });
    setDirty(true, 'candidate-generated', outboundRequestId);
    return sent;
  };

  const publishLevelSelection = (selection, outboundRequestId = createRequestId('level-selected')) => {
    const levelId = Number(selection?.levelId);
    const levelHash = String(selection?.levelHash || '').trim().toLowerCase();
    if (!Number.isSafeInteger(levelId) || levelId <= 0) {
      throw new Error('selection.levelId 必须是正整数');
    }
    if (!levelHash || levelHash === '(none)') {
      throw new Error('selection.levelHash 不能为空');
    }
    return post(EXPERIENCE_MESSAGES.levelSelected, outboundRequestId, { levelId, levelHash });
  };

  const onMessage = async (event) => {
    if (
      disposed
      || !parentOrigin
      || event.source !== parentWindow
      || event.origin !== parentOrigin
    ) return;

    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === EXPERIENCE_MESSAGES.ping) {
      const pingRequestId = REQUEST_ID_PATTERN.test(String(data.requestId || '').trim())
        ? String(data.requestId).trim()
        : createRequestId('ready');
      postReady(pingRequestId);
      return;
    }

    if (data.type === EXPERIENCE_MESSAGES.loadTerrain) {
      let normalized;
      const replyRequestId = REQUEST_ID_PATTERN.test(String(data.requestId || '').trim())
        ? String(data.requestId).trim()
        : createRequestId('terrain-error');
      try {
        normalized = normalizeLoadTerrainMessage(data);
        const contentHash = await sha256Hex(normalized.terrainJson, options.cryptoRef);
        const result = await host.loadTerrain({
          terrain: normalized.terrain,
          terrainJson: normalized.terrainJson,
          levelIdentity: normalized.levelIdentity,
          contentHash,
        });
        const validation = result?.validation || { ok: true, checks: {}, warnings: [], errors: [] };
        post(EXPERIENCE_MESSAGES.terrainLoaded, normalized.requestId, {
          ok: validation.ok !== false,
          levelIdentity: normalized.levelIdentity,
          actualHash: String(result?.actualHash || '').toLowerCase(),
          contentHash,
          validation,
        });
        if (validation.ok !== false) {
          setDirty(false, 'terrain-loaded', normalized.requestId);
        }
      } catch (error) {
        post(EXPERIENCE_MESSAGES.terrainLoaded, replyRequestId, {
          ok: false,
          levelIdentity: normalized?.levelIdentity || null,
          actualHash: '',
          contentHash: '',
          validation: {
            ok: false,
            checks: {},
            warnings: [],
            errors: [errorText(error)],
          },
          error: errorText(error),
        });
      }
      return;
    }

    if (data.type === EXPERIENCE_MESSAGES.legacyLoadLevel) {
      const legacyRequestId = REQUEST_ID_PATTERN.test(String(data.requestId || '').trim())
        ? String(data.requestId).trim()
        : createRequestId('legacy-load');
      try {
        const result = await host.loadLegacyLevel(data.levelId);
        const ok = Boolean(result?.ok ?? result);
        post(EXPERIENCE_MESSAGES.legacyLoadLevelResult, legacyRequestId, {
          levelId: Number(data.levelId) || null,
          ok,
          actualHash: String(result?.actualHash || '').toLowerCase(),
          legacy: true,
        });
        if (ok) setDirty(false, 'legacy-terrain-loaded', legacyRequestId);
      } catch (error) {
        post(EXPERIENCE_MESSAGES.legacyLoadLevelResult, legacyRequestId, {
          levelId: Number(data.levelId) || null,
          ok: false,
          error: errorText(error),
          legacy: true,
        });
      }
    }
  };

  windowRef.addEventListener('message', onMessage);
  const ready = Promise.resolve()
    .then(() => host.getRuntimeConfig?.())
    .then((config) => {
      appVersion = String(config?.appVersion || config?.version || 'unknown');
      postReady();
      setDirty(false, 'initialized');
    })
    .catch(() => {
      postReady();
      setDirty(false, 'initialized');
    });

  return {
    parentOrigin,
    ready,
    post,
    setDirty,
    publishCandidate,
    publishLevelSelection,
    dispose() {
      disposed = true;
      windowRef.removeEventListener('message', onMessage);
    },
  };
}

if (
  typeof window !== 'undefined'
  && window.parent !== window
  && window.reverseGenExperienceHost
) {
  window.reverseGenExperienceBridge = createExperienceBridge({
    windowRef: window,
    documentRef: document,
    host: window.reverseGenExperienceHost,
    cryptoRef: window.crypto,
  });
}
