import type { TerrainData } from '../types.js';

export type ZenMatchStrategy = 4 | 5;

export interface ZenMatchInput {
  terrain: TerrainData;
  uniqueCount: number;
  seed: number;
  strategy?: ZenMatchStrategy;
}

export interface ZenMatchOutput {
  /** Free Shell tile ID -> element value. Fixed tiles keep their terrain value. */
  assignments: Map<number, number>;
  /** Free Shell tile ID -> queue type before fixed/generated type concatenation. */
  abstractAssignments: Map<number, number>;
  /** Tiles selected for the strategy's top-match prefix. */
  topMatchTileIds: number[];
  requestedUniqueCount: number;
  actualColorCount: number;
  seed: number;
  strategy: ZenMatchStrategy;
}

export interface ZenMatchBoardOutput extends ZenMatchOutput {
  replayCode: string;
  levelHash: string;
}
