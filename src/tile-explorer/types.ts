import type { TerrainData } from '../types.js';
import type { DotNetRandomState } from './random.js';

export type TileExplorerStrategy =
  | 'default'
  | 'top_two_easy'
  | 'sliding_window'
  | 'limit_layer_random'
  | 'easy_hard_easy'
  | 'solvability_coefficient'
  | 'solvability_coefficient_v2'
  | 'solvability_coefficient_v3'
  | 'color_gradient';

export interface TileExplorerInput {
  terrain: TerrainData;
  strategy?: TileExplorerStrategy;
  difficulty?: number;
  typeCycle?: number[];
  tileTypeWeights?: number[];
  tileTypesCanUse?: number;
  /** 等权花色的便捷入口；精确复现时优先传 typeCycle 或 weights。 */
  colorCount?: number;
  sequenceSeed?: number;
  placementSeed?: number;
  placementRandomState?: DotNetRandomState;
  easyLayerCount?: number;
  levelHardTag?: number;
  limitFullFirst?: boolean;
  solvabilityLowerCoefficient?: number;
  solvabilityTopCoefficient?: number;
  fallbackExtraLayers?: number;
  solvabilityRandomMode?: boolean;
  colorGradientTypeGroups?: number[][];
}

export interface TileExplorerOutput {
  assignments: Map<number, number>;
  groups: Map<number, number>;
  viewLayers: number[][];
  typeCycle: number[];
  generatedGroupCount: number;
  strategy: TileExplorerStrategy;
  sequenceSeed: number;
  placementSeed: number;
  placementRandomStateAfter: DotNetRandomState;
}

export interface TileExplorerBoardOutput extends TileExplorerOutput {
  replayCode: string;
  levelHash: string;
}

export interface TileExplorerTile {
  id: number;
  physicalLayer: number;
  shuffleable: boolean;
  suit?: number;
  group?: number;
}
