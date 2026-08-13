/**
 * ReplaySerializer — 牌局序列化器。
 * 将完整牌局状态编码为紧凑的 Base64 ReplayCode 字符串，并可完美还原。
 *
 * 管线: 二进制序列化 → Raw Deflate 压缩(RFC 1951) → Base64 编码
 *
 * v4 格式二进制布局:
 *   ┌─────────┬────┬──────────────┬───────────┬─────────────────────────────────┬──────────┬──────────────┬───────┐
 *   │ version │ N  │ elementCount │ levelHash │ instanceArray                   │ dockCount│ dockEntries  │ CRC16 │
 *   │  1B(=4) │1B  │     1B       │   8B LE   │ N × 1B (2bit状态|6bit花色索引)   │   1B     │ cnt × 2B     │ 2B LE │
 *   └─────────┴────┴──────────────┴───────────┴─────────────────────────────────┴──────────┴──────────────┴───────┘
 *
 * 设计目标:
 *   1. 紧凑长度：适合复制粘贴、IM 传输、配置表存储
 *   2. 自描述：含 levelHash 地形标识，解码时不需额外告知地形
 *   3. 完整还原：花色分配、Dock 状态、已消除牌全部可恢复
 *   4. 跨平台确定性：Raw Deflate + CRC16/MODBUS，与平台无关
 *
 * 格式版本演进:
 *   v1 (已废弃): 每 tile 直接存 6bit 花色值，仅支持 0-63 范围
 *   v2 (已废弃): palette 表存储实际花色值，每 tile 存 6bit 索引
 *   v3 (已废弃): 加入 levelResId 地形标识，但 ID 可能变动
 *   v4 (当前): 替换为 levelHash(uint64) — Hash 与地形内容绑定，配表迁移不影响校验
 *
 * 直接对应 C# 版 ReplaySerializer.cs。
 */

// 关键: 使用 raw deflate (RFC 1951)，不是 zlib 包装 (RFC 1950)。
// .NET DeflateStream 产出 raw DEFLATE。deflateRawSync 与之完全匹配。
// deflateSync 会额外添加 2 字节 zlib 头 + 4 字节 ADLER32 尾，.NET 无法解析。
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { computeCRC16 } from './crc16.js';
import { logger } from './logger.js';
import type { TerrainTile, DockEntry, ReplayData } from './types.js';
import { TileState } from './types.js';

// ── 常量 ──

/** 当前格式版本号 (v4) */
export const FORMAT_VERSION = 4;

/** 最大花色种类数（受 instanceArray 中 6bit 索引限制） */
export const MAX_ELEMENT_COUNT = 64;

/** Dock 最大槽位数（受游戏规则限制），定义见 constants.ts。 */
import { MAX_DOCK_SLOTS } from './constants.js';
export { MAX_DOCK_SLOTS };

// ── 公共 API ──

/**
 * 将牌局数据编码为 ReplayCode 字符串。
 * 管线: 二进制序列化 → Raw Deflate 压缩 → Base64 编码
 */
export function encodeToString(
  elementCount: number,
  levelHash: bigint,
  instanceArray: Uint8Array,
  dockEntries: DockEntry[]
): string {
  const binary = serializeToBinary(elementCount, levelHash, instanceArray, dockEntries);
  return compressAndEncode(binary);
}

/**
 * 从 ReplayCode 字符串解码牌局数据。
 * 反向管线: Base64 解码 → Raw Deflate 解压 → 二进制反序列化
 * 失败返回 null。
 */
export function decodeFromString(replayCode: string): ReplayData | null {
  if (!replayCode) {
    logger.warn('[ReplaySerializer] 输入为空，跳过解码');
    return null;
  }

  try {
    const binary = decodeAndDecompress(replayCode);
    return deserializeFromBinary(binary);
  } catch (e) {
    logger.error(`[ReplaySerializer] 解码失败: ${e}`);
    return null;
  }
}

/**
 * 从地形和花色分配生成 ReplayCode（新鲜牌局，无 Dock 内容）。
 * 这是新牌局序列化的主要入口。
 *
 * @param orderedTiles - 规范排序的牌列表（按层，同层按 ID）
 * @param elementValues - tileId → 实际花色值（含固定牌和已分配牌）
 * @param levelHash - 16 位小写十六进制地形哈希字符串（空 = 跳过校验）
 * @param dockEntries - Dock 槽位条目（新鲜牌局为空数组）
 */
export function generateReplayCode(
  orderedTiles: TerrainTile[],
  elementValues: Map<number, number>,
  levelHash: string = '',
  dockEntries: DockEntry[] = []
): string {
  const n = orderedTiles.length;

  // 解析地形哈希
  const hash = parseLevelHash(levelHash);

  // 收集所有不重复的花色值
  const distinctValues = new Set<number>();
  for (const tile of orderedTiles) {
    const val = elementValues.get(tile.id) ?? 0;
    if (val > 0) distinctValues.add(val);
  }
  for (const entry of dockEntries) {
    if (entry.element > 0) distinctValues.add(entry.element);
  }

  if (distinctValues.size > MAX_ELEMENT_COUNT) {
    logger.warn(
      `[ReplaySerializer] 花色种类(${distinctValues.size})超过上限(${MAX_ELEMENT_COUNT})，将截断`
    );
  }

  // 构建归一化映射: 实际花色值 → 归一化索引 (0..K-1)
  const sortedValues = [...distinctValues].sort((a, b) => a - b).slice(0, MAX_ELEMENT_COUNT);
  const valueToIndex = new Map<number, number>();
  for (let i = 0; i < sortedValues.length; i++) {
    valueToIndex.set(sortedValues[i], i);
  }

  const elementCount = sortedValues.length;
  logger.info(
    `[ReplaySerializer] 花色归一化: levelHash=${formatHash(hash)}, ${elementCount}种花色, 实际=[${sortedValues.join(',')}] → 归一化 1..${elementCount}`
  );

  // 编码 instanceArray: 每 tile 1 字节 (2bit 状态 | 6bit 花色索引)
  const instanceArray = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const tile = orderedTiles[i];
    const state = TileState.OnField; // 新鲜牌局全部在场上
    const actualValue = elementValues.get(tile.id) ?? 0;
    let elementIndex = 0;
    if (actualValue > 0) {
      elementIndex = valueToIndex.get(actualValue) ?? 0;
    }

    instanceArray[i] = ((state & 0x3) << 6) | (elementIndex & 0x3F);
  }

  // 编码输出
  const replayCode = encodeToString(elementCount, hash, instanceArray, dockEntries);
  logger.info(
    `[ReplaySerializer] 牌局序列化完成: levelHash=${formatHash(hash)}, ${n}张牌, ${elementCount}种归一化花色, ${dockEntries.length}个dock槽位, ReplayCode=${replayCode.length}字符`
  );

  return replayCode;
}

/**
 * 获取规范牌排序 —— 按层级从低到高，同层内按 ID 排序。
 * 这个顺序决定了序列化/反序列化时每张牌的索引，必须严格一致。
 */
export function getCanonicalTileOrder(tiles: TerrainTile[]): TerrainTile[] {
  // 按层分组
  const layerMap = new Map<number, TerrainTile[]>();
  for (const tile of tiles) {
    let layer = layerMap.get(tile.layer);
    if (!layer) {
      layer = [];
      layerMap.set(tile.layer, layer);
    }
    layer.push(tile);
  }

  // 层升序
  const sortedLayers = [...layerMap.keys()].sort((a, b) => a - b);

  // 逐层收集，同层按 ID 排序（保证确定性）
  const ordered: TerrainTile[] = [];
  for (const layerId of sortedLayers) {
    const layerTiles = layerMap.get(layerId)!;
    layerTiles.sort((a, b) => a.id - b.id);
    ordered.push(...layerTiles);
  }

  return ordered;
}

/**
 * 启发式判断输入字符串是否为 ReplayCode（v4 Base64 格式）。
 *
 * 区分逻辑:
 *   传统 replay seed: "3-3-3-18-123456" — 含 '-' 分隔符且首段为纯数字
 *   ReplayCode:       纯 Base64 字符串，不含 '-'，解码后长度 ≥ 8 字节
 */
export function looksLikeReplayCode(input: string): boolean {
  if (!input) return false;

  // 传统 replay seed 格式检测: "体验模式1-体验模式2-体验模式3-花色数-随机种子"
  if (input.includes('-')) {
    const firstPart = input.split('-')[0];
    if (/^\d+$/.test(firstPart)) {
      return false;
    }
  }

  // Base64 启发式: 解码后长度 ≥ 8 字节即为可疑 ReplayCode
  // 未压缩 v4 二进制最小 15B，raw DEFLATE 压缩后约 10-13B；取保守下限 8B
  try {
    const decoded = Buffer.from(input.trim(), 'base64');
    return decoded.length >= 8;
  } catch {
    return false;
  }
}

/**
 * 将 16 位小写十六进制字符串解析为 uint64。
 * 失败或空字符串返回 0n（0 = 跳过 hash 校验）。
 */
export function parseLevelHash(levelHashStr: string): bigint {
  if (!levelHashStr) return 0n;
  try {
    const v = BigInt(`0x${levelHashStr}`);
    if (v < 0n || v > 0xFFFFFFFFFFFFFFFFn) return 0n;
    return v;
  } catch {
    logger.warn(`[ReplaySerializer] 无法解析LevelHash '${levelHashStr}'为uint64，使用0(跳过校验)`);
    return 0n;
  }
}

/** levelHash 的展示形式: 16 位小写十六进制，0 显示为 "(none)" */
export function formatHash(levelHash: bigint): string {
  return levelHash === 0n ? '(none)' : levelHash.toString(16).padStart(16, '0');
}

// ── 二进制序列化 ──

/**
 * 将牌局数据序列化为原始二进制（未压缩）。
 */
export function serializeToBinary(
  elementCount: number,
  levelHash: bigint,
  instanceArray: Uint8Array,
  dockEntries: DockEntry[]
): Uint8Array {
  const n = instanceArray.length;
  const dockCount = dockEntries?.length ?? 0;

  if (elementCount === 0 || elementCount > MAX_ELEMENT_COUNT) {
    throw new Error(`花色种类(${elementCount})无效，允许范围: 1-${MAX_ELEMENT_COUNT}`);
  }
  if (dockCount > MAX_DOCK_SLOTS) {
    throw new Error(`Dock槽位数(${dockCount})超过上限(${MAX_DOCK_SLOTS})`);
  }

  // 总大小: version(1) + N(1) + elementCount(1) + levelHash(8) + instance(N) + dockCount(1) + dockEntries(2×dockCount) + CRC16(2)
  const dockBytes = dockCount * 2;
  const totalSize = 1 + 1 + 1 + 8 + n + 1 + dockBytes + 2;

  const buffer = new Uint8Array(totalSize);
  let offset = 0;

  buffer[offset++] = FORMAT_VERSION;
  buffer[offset++] = n;
  buffer[offset++] = elementCount;

  // levelHash uint64 little-endian
  for (let i = 0; i < 8; i++) {
    buffer[offset++] = Number((levelHash >> BigInt(8 * i)) & 0xFFn);
  }

  buffer.set(instanceArray, offset);
  offset += n;

  buffer[offset++] = dockCount;
  for (let i = 0; i < dockCount; i++) {
    buffer[offset++] = dockEntries[i].tileId;
    buffer[offset++] = dockEntries[i].element;
  }

  // CRC16 对校验和之前的所有数据计算
  const payloadLen = totalSize - 2;
  const crc = computeCRC16(buffer, 0, payloadLen);
  buffer[offset++] = crc & 0xFF;
  buffer[offset] = (crc >> 8) & 0xFF;

  logger.info(
    `[ReplaySerializer] 序列化: 牌数=${n}, 花色种类=${elementCount}, levelHash=${formatHash(levelHash)}, dock=${dockCount}, 二进制=${totalSize}B, CRC=0x${crc.toString(16).toUpperCase().padStart(4, '0')}`
  );

  return buffer;
}

/**
 * 从原始二进制反序列化为 ReplayData。
 * 执行严格校验: CRC16 完整性 → 版本号匹配 → 各字段范围校验。
 */
export function deserializeFromBinary(data: Uint8Array): ReplayData {
  if (data.length < 15) {
    throw new Error(`数据太短(${data.length}B)，v4格式至少需要15字节`);
  }

  // ── CRC16 完整性校验 ──
  const payloadLength = data.length - 2;
  const expectedCrc = data[payloadLength] | (data[payloadLength + 1] << 8);
  const actualCrc = computeCRC16(data, 0, payloadLength);
  if (expectedCrc !== actualCrc) {
    throw new Error(
      `CRC校验失败: 期望0x${expectedCrc.toString(16).toUpperCase()}, 实际0x${actualCrc.toString(16).toUpperCase()}。数据可能在传输过程中损坏。`
    );
  }

  let offset = 0;

  const version = data[offset++];
  if (version !== FORMAT_VERSION) {
    throw new Error(`不支持的格式版本: ${version} (当前支持: ${FORMAT_VERSION})`);
  }

  const n = data[offset++];
  if (n === 0) {
    throw new Error('牌数为0，无法还原牌局');
  }

  const elementCount = data[offset++];
  if (elementCount === 0 || elementCount > MAX_ELEMENT_COUNT) {
    throw new Error(`花色种类无效: ${elementCount} (允许范围: 1-${MAX_ELEMENT_COUNT})`);
  }

  // levelHash uint64 little-endian
  let levelHash = 0n;
  for (let i = 0; i < 8; i++) {
    levelHash |= BigInt(data[offset + i]) << BigInt(8 * i);
  }
  offset += 8;

  const instanceArray = data.slice(offset, offset + n);
  offset += n;

  const dockCount = data[offset++];
  if (dockCount > MAX_DOCK_SLOTS) {
    throw new Error(`Dock槽位数无效: ${dockCount} (最大: ${MAX_DOCK_SLOTS})`);
  }

  const dockEntries: DockEntry[] = [];
  for (let i = 0; i < dockCount; i++) {
    dockEntries.push({
      tileId: data[offset++],
      element: data[offset++],
    });
  }

  return { version, elementCount, levelHash, instanceArray, dockEntries };
}

// ── 压缩 / 解压 ──

function compressAndEncode(data: Uint8Array): string {
  const compressed = deflateRawSync(data);
  const base64 = Buffer.from(compressed).toString('base64');
  const ratio = ((1 - compressed.length / data.length) * 100).toFixed(1);
  logger.info(
    `[ReplaySerializer] 压缩编码: 原始${data.length}B → 压缩${compressed.length}B (${ratio}%) → Base64 ${base64.length}字符`
  );
  return base64;
}

function decodeAndDecompress(base64: string): Uint8Array {
  const compressed = Buffer.from(base64.trim(), 'base64');
  const decompressed = inflateRawSync(compressed);
  logger.info(
    `[ReplaySerializer] 解压解码: Base64 ${base64.length}字符 → 压缩${compressed.length}B → 解压${decompressed.length}B`
  );
  return new Uint8Array(decompressed);
}
