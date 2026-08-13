/**
 * 机制组合表示（"ReplayCode + 机制枚举：数量"）。
 *
 * 与 Unity 的 extraConfig（Dictionary<int, int>，extraEnum → 数量）同构：
 * 一关 = 现有 ReplayCode（花色分配）+ 机制枚举信息（enum:count 组合）。
 * ReplayCode 格式保持不变；机制信息作为并列字段随参数传递。
 *
 * 两个来源：
 *  1. 地形 tile 里写着的 extraEnum/extraParam（静态摆放，countTerrainExtras 汇总）
 *  2. 外部注入的机制配置（parseMechanicCounts 解析 "31:3,39:2"）
 */

import type { TerrainTile } from '../types/terrain.js';
import { mechanicInfo, isKnownMechanic, MECHANICS } from './registry.js';

/** 机制枚举 → 数量/参数 映射（与 Unity extraConfig 同构）。 */
export type MechanicCounts = Map<number, number>;

export interface MechanicSpecError {
  kind: 'unknown-enum' | 'negative-count' | 'count-mismatch' | 'format';
  message: string;
}

/**
 * 解析机制文本，如 "31:3,39:2" 或 "魔药:3,泡泡:2"。
 * 键可以是数值或注册表名称/中文名；未知键报错。返回 Map 保持插入顺序。
 */
export function parseMechanicCounts(text: string): MechanicCounts {
  const counts: MechanicCounts = new Map();
  const trimmed = text.trim();
  if (!trimmed) return counts;

  for (const piece of trimmed.split(',')) {
    const item = piece.trim();
    if (!item) throw new Error(`机制配置格式无效: "${text}"`);
    const sep = item.lastIndexOf(':');
    if (sep <= 0) throw new Error(`机制项缺少数量: "${item}"（应为 枚举:数量）`);
    const keyText = item.slice(0, sep).trim();
    const countText = item.slice(sep + 1).trim();
    if (!/^\d+$/.test(countText)) throw new Error(`机制数量必须是整数: "${countText}"`);
    const value = resolveMechanicValue(keyText);
    if (value === null) throw new Error(`未知机制: "${keyText}"`);
    counts.set(value, Number(countText));
  }
  return counts;
}

/** 把键文本解析为 ssExtraEnum 数值：优先数值，其次注册表名/中文名。 */
function resolveMechanicValue(keyText: string): number | null {
  if (/^-?\d+$/.test(keyText)) {
    const v = Number(keyText);
    return MECHANICS[v] !== undefined ? v : null;
  }
  for (const info of Object.values(MECHANICS)) {
    if (info.name === keyText || info.label === keyText) return info.value;
  }
  return null;
}

/** 序列化为规范文本（数值键，升序，可再解析）。 */
export function serializeMechanicCounts(counts: MechanicCounts): string {
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, v]) => `${k}:${v}`)
    .join(',');
}

/**
 * 汇总地形中每张 tile 写着的挂件数量（来源 1：静态摆放）。
 * Empty(0)/None(-1) 不计入。
 */
export function countTerrainExtras(tiles: TerrainTile[]): MechanicCounts {
  const counts: MechanicCounts = new Map();
  for (const tile of tiles) {
    const e = tile.extraEnum ?? 0;
    if (e === 0 || e === -1) continue;
    counts.set(e, (counts.get(e) ?? 0) + 1);
  }
  return counts;
}

/**
 * 校验注入机制配置与地形摆放的一致性。
 * - 未知枚举 / 负数量 → 错误
 * - tile-count 语义的机制：注入数量与地形摆放数量不一致 → 错误
 *   （泡泡 39 为 behavior-config 语义，不参与此校验）
 */
export function validateMechanicCounts(
  injected: MechanicCounts,
  terrainCounts?: MechanicCounts,
): MechanicSpecError[] {
  const errors: MechanicSpecError[] = [];
  for (const [value, count] of injected) {
    if (!isKnownMechanic(value)) {
      errors.push({ kind: 'unknown-enum', message: `未知机制枚举: ${value}` });
      continue;
    }
    if (!Number.isInteger(count) || count < 0) {
      errors.push({ kind: 'negative-count', message: `机制 ${value} 数量必须是非负整数: ${count}` });
      continue;
    }
    const info = mechanicInfo(value)!;
    if (info.countMeaning === 'tile-count' && terrainCounts) {
      const placed = terrainCounts.get(value) ?? 0;
      if (placed !== count) {
        errors.push({
          kind: 'count-mismatch',
          message: `机制 ${info.label}(${value}) 注入数量 ${count} 与地形摆放 ${placed} 不一致`,
        });
      }
    }
  }
  return errors;
}

/** 一关的完整表示：ReplayCode + 机制枚举组合（两者并列，ReplayCode 格式不变）。 */
export interface BoardSpec {
  /** 现有 v4 ReplayCode（花色分配） */
  replayCode: string;
  /** 机制枚举：数量（与 Unity extraConfig 同构） */
  mechanics: MechanicCounts;
}

/** 组合成单行可复制文本：code@31:3,39:2（无机制时就是 code 本身）。 */
export function formatBoardSpec(spec: BoardSpec): string {
  const text = serializeMechanicCounts(spec.mechanics);
  return text ? `${spec.replayCode}@${text}` : spec.replayCode;
}

/** 解析组合文本（formatBoardSpec 的逆操作）。 */
export function parseBoardSpec(text: string): BoardSpec {
  const at = text.lastIndexOf('@');
  if (at <= 0) return { replayCode: text.trim(), mechanics: new Map() };
  const replayCode = text.slice(0, at).trim();
  const mechanics = parseMechanicCounts(text.slice(at + 1));
  return { replayCode, mechanics };
}
