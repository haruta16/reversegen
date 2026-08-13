/**
 * ReverseGen 核心类型聚合入口。
 *
 * 各领域类型按域拆分到 types/ 目录，本文件统一 re-export，
 * 保持既有 `import ... from './types.js'` 导入路径全部兼容：
 *   types/terrain.ts        地形 / 关卡领域
 *   types/triple.ts         Triple 领域 + 键工具函数
 *   types/board.ts          牌局领域（算法输入输出 + ReplayCode）
 *   types/layer-closure.ts  LayerClosure 算法领域
 */

// ── 地形 / 关卡 ──
export type {
  TerrainTile,
  TerrainLayer,
  TransferTerrainStructure,
  FallingTerrainStructure,
  TerrainStructure,
  TerrainData,
} from './types/terrain.js';

// ── 算法内部类型 ──
export type { Triple, TripleKey, ScheduleEntry } from './types/triple.js';

// ── 工具函数 ──
export { tripleKey, parseTripleKey, sortTriple } from './types/triple.js';

// ── 算法输入 / 输出 ──
export type {
  ReverseGenInput,
  StepRecord,
  ReverseGenOutput,
  CostStats,
} from './types/board.js';

// ── ReplayCode 类型 ──
export { TileState } from './types/board.js';
export type { DockEntry, ReplayData } from './types/board.js';

// ── LayerClosure（层闭合）花色分配算法 ──
export type {
  ColorAllocationMode,
  LayerClosureInput,
  DebtMetrics,
  LayerClosureOutput,
} from './types/layer-closure.js';
