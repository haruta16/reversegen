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
import { isKnownMechanic, MECHANICS } from './registry.js';

/** 机制枚举 → 数量/参数 映射（与 Unity extraConfig 同构）。 */
export type MechanicCounts = Map<number, number>;

export interface MechanicSpecError {
  kind: 'unknown-enum';
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
 * 校验注入机制配置（对齐 Unity：extraConfig 是"分配请求"，数量语义交由分配器解释）。
 * 仅校验未知枚举；负数量/与地形摆放不一致不再报错——202/207 支持自动数量（0/负数），
 * 其余机制数量 <= 0 时自然选不到任何 tile（与 Unity ParseConfig 行为一致）。
 */
export function validateMechanicCounts(injected: MechanicCounts): MechanicSpecError[] {
  const errors: MechanicSpecError[] = [];
  for (const [value] of injected) {
    if (!isKnownMechanic(value)) {
      errors.push({ kind: 'unknown-enum', message: `未知机制枚举: ${value}` });
    }
  }
  return errors;
}

/**
 * 拆分机制配置（对齐 Unity LoadLevel 的拆出逻辑）：
 * - bubble(39)：行为参数（每轮收集数），交给 MechanicEngine，不走分配器
 * - boardSpecial(51-53)：大型地形，棋盘级注入，reversegen 未接入
 * - assignable：其余 tile-count 机制，作为分配请求交给机制分配器
 */
export function splitMechanicConfig(config: MechanicCounts): {
  bubble: MechanicCounts;
  assignable: MechanicCounts;
  boardSpecial: MechanicCounts;
} {
  const bubble = new Map<number, number>();
  const assignable = new Map<number, number>();
  const boardSpecial = new Map<number, number>();
  for (const [value, count] of config) {
    if (value === 39) bubble.set(value, count);
    else if (value === 51 || value === 52 || value === 53) boardSpecial.set(value, count);
    else assignable.set(value, count);
  }
  return { bubble, assignable, boardSpecial };
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
