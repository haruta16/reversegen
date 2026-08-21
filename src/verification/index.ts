/**
 * 跨侧 golden 验证 — 公开出口。
 * cross-side-trace：追踪格式 / 录制器 / 比对器；
 * trace-builder：从 地形+ReplayCode+机制+动作序列 重建追踪（CLI 与 GUI 共用）。
 */
export {
  recordCrossSideTrace,
  compareCrossSideTraces,
  CROSS_SIDE_PROTOCOL,
  CROSS_SIDE_VERSION,
} from './cross-side-trace.js';
export type {
  CrossSideMeta,
  CrossSideFrame,
  CrossSideTrace,
  CrossSideDiff,
  TraceTileState,
} from './cross-side-trace.js';
export { buildTraceFromInputs } from './trace-builder.js';
export type { TraceBuildInput } from './trace-builder.js';
