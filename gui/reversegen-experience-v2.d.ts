export const PROTOCOL_VERSION: 2;

export const EXPERIENCE_MESSAGES: Readonly<{
  ping: 'reversegen:ping';
  ready: 'reversegen:ready';
  loadTerrain: 'reversegen:load-terrain';
  terrainLoaded: 'reversegen:terrain-loaded';
  dirtyState: 'reversegen:dirty-state';
  candidate: 'reversegen:candidate';
  levelSelected: 'reversegen:level-selected';
  legacyLoadLevel: 'reversegen:load-level';
  legacyLoadLevelResult: 'reversegen:load-level-result';
}>;

export const EXPERIENCE_CAPABILITIES: Readonly<Record<string, boolean>>;

export interface LevelIdentity {
  levelId: number | null;
  source: string;
  revision: string;
  hash: string;
}

export interface HostTerrainLoad {
  terrain: unknown;
  terrainJson: string;
  levelIdentity: LevelIdentity;
  contentHash: string;
}

export interface ExperienceBridgeHost {
  getRuntimeConfig?: () => Promise<{ appVersion?: string; version?: string }>;
  loadTerrain: (input: HostTerrainLoad) => Promise<{
    actualHash?: string;
    validation?: {
      ok: boolean;
      checks?: Record<string, boolean | null>;
      warnings?: string[];
      errors?: string[];
    };
  }>;
  loadLegacyLevel: (levelId: unknown) => Promise<boolean | { ok: boolean; actualHash?: string }>;
}

export interface BridgeWindow {
  parent: { postMessage: (message: unknown, targetOrigin: string) => void };
  addEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void;
  removeEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void;
}

export function resolveParentOrigin(referrer: unknown): string;
export function normalizeLevelIdentity(value: unknown): Readonly<LevelIdentity>;
export function normalizeLoadTerrainMessage(value: unknown): {
  requestId: string;
  levelIdentity: Readonly<LevelIdentity>;
  terrain: unknown;
  terrainJson: string;
};
export function sha256Hex(value: unknown, cryptoRef?: Crypto): Promise<string>;

export function createExperienceBridge(options: {
  windowRef: BridgeWindow;
  documentRef: { referrer: string };
  host: ExperienceBridgeHost;
  parentOrigin?: string;
  createRequestId?: (prefix: string) => string;
  cryptoRef?: Crypto;
}): {
  parentOrigin: string;
  ready: Promise<void>;
  post: (type: string, requestId: string, payload?: Record<string, unknown>) => boolean;
  setDirty: (dirty: boolean, reason?: string, requestId?: string) => boolean;
  publishCandidate: (candidate: Record<string, unknown>, requestId?: string) => Promise<boolean>;
  publishLevelSelection: (selection: { levelId: number; levelHash: string }, requestId?: string) => boolean;
  dispose: () => void;
};

declare global {
  interface Window {
    reverseGenExperienceHost?: ExperienceBridgeHost;
    reverseGenExperienceBridge?: ReturnType<typeof createExperienceBridge>;
  }
}
