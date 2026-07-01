/**
 * Player Simulation Solver — 模拟人类玩家的决策过程。
 *
 * 策略:
 *   1. 分析所有可见三连候选组（MatchGroup），计算每组的 cost（依赖路径大小）
 *   2. 从 cost ≤ 剩余槽位 的安全组中随机选一个
 *   3. 如果所有可见组都会导致死亡（cost > remainSlots），
 *      则点击能揭露最多被遮挡牌的可点击牌（最高 unlockGain）
 *
 * 跑 N 次（不同种子）统计模拟玩家胜率。
 */

import { OfflineGame } from './offline-game.js';
import { OfflineTile, PileType, TileFlag } from './types.js';
import { mulberry32 } from '../random-utils.js';

// ── 内部类型 ──

/** 一个三连消除候选组 */
export interface MatchGroup {
  /** 花色值 */
  color: number;
  /** 三张匹配牌 */
  tiles: OfflineTile[];
  /** 消除这三张需要的依赖路径大小（= 需收集的牌数） */
  totalCost: number;
  /** 依赖路径上的牌 ID 集合（含 match tiles 自身） */
  path: Set<number>;
}

/** 单次模拟结果 */
export interface PlayerSimResult {
  win: boolean;
  failReason: string | null;
  picks: number[];
  stepCount: number;
  seed: number;
  /** 失败时桌面剩余牌数（胜局=0） */
  remainingTilesOnFail: number;
  /** safeGroups=0 导致强制解锁点击的次数 */
  forcedRandomPickCount: number;
  /** dock+clickable 中没有任何颜色 ≥2 张的局面次数（花色饥饿） */
  colorStarvationCount: number;
}

/** 批量模拟结果 */
export interface PlayerSimBatchResult {
  wins: number;
  losses: number;
  winRate: number;
  results: PlayerSimResult[];
  /** 赢局：平均 forced pick 次数 */
  forcedPickOnWin: number;
  /** 赢局：平均花色饥饿次数 */
  starvationOnWin: number;
  /** 输局：平均步数（=点击tile数） */
  stepsOnLoss: number;
  /** 输局：平均 forced pick 次数 */
  forcedPickOnLoss: number;
  /** 输局：平均花色饥饿次数 */
  starvationOnLoss: number;
  elapsedMs: number;
}

// ═══════════════════════════════════════════════════════════
//  MatchGroup 分析（移植自 C# OfflineAnalyzer）
// ═══════════════════════════════════════════════════════════

/**
 * 收集一张牌的所有递归 RuntimeDependencies。
 */
function collectRecursiveDeps(
  tile: OfflineTile,
  game: OfflineGame,
  deps: Set<number>,
): void {
  for (const depId of tile.runtimeDependencies) {
    if (deps.add(depId)) {
      const dep = game.allTiles.get(depId);
      if (dep) collectRecursiveDeps(dep, game, deps);
    }
  }
}

/**
 * 计算一个三连匹配组的依赖路径和 cost。
 * 路径 = 所有 desk tile 自身 + 它们的递归 RuntimeDependencies。
 * Dock tile 不贡献依赖（已经在手上了）。
 */
function calculatePath(
  matchTiles: OfflineTile[],
  game: OfflineGame,
): { path: Set<number>; totalCost: number } {
  const deps = new Set<number>();
  for (const tile of matchTiles) {
    if (tile.pileType === PileType.Dock) continue;
    collectRecursiveDeps(tile, game, deps);
    deps.add(tile.id);
  }
  return { path: deps, totalCost: deps.size };
}

/**
 * 判断三张牌是否都"可见"（玩家能看到花色）。
 *
 * 不可见判定（来自 OfflineGame 每步更新的 Invisible 标记）：
 *   1. 已销毁或已弃牌 → 不可见
 *   2. 被另一张牌覆盖 ≥90% 面积（PerfectCovered）
 *   3. 所有运行时依赖的投影并集完全覆盖本牌（IsProjectionFullyCovered）
 */
function isAllVisible(tiles: OfflineTile[]): boolean {
  for (const t of tiles) {
    if (!t) return false;
    if (t.hasFlag(TileFlag.Destroyed)) return false;
    if (t.hasFlag(TileFlag.Invisible)) return false;
  }
  return true;
}

/**
 * 为当前游戏状态计算所有可见的三连匹配组。
 * 按 TotalCost 升序排列。
 */
export function computeVisibleMatchGroups(game: OfflineGame): MatchGroup[] {
  // 按花色分组：收集所有非销毁、非弃牌的 tile
  const byColor = new Map<number, OfflineTile[]>();
  for (const tile of game.allTiles.values()) {
    if ((tile.flags & TileFlag.Destroyed) !== 0) continue;
    if (tile.pileType === PileType.Discard) continue;
    if (tile.elementValue <= 0) continue;

    const list = byColor.get(tile.elementValue);
    if (list) list.push(tile);
    else byColor.set(tile.elementValue, [tile]);
  }

  const allGroups: MatchGroup[] = [];

  for (const [color, tiles] of byColor) {
    if (tiles.length < 3) continue;

    // 排序: Dock 优先，然后按 RuntimeDependencies 数目升序
    // 最多取前 9 张（C(9,3)=84，性能可控）
    const sorted = tiles
      .sort((a, b) => {
        const aDock = a.pileType === PileType.Dock ? 0 : 1;
        const bDock = b.pileType === PileType.Dock ? 0 : 1;
        if (aDock !== bDock) return aDock - bDock;
        return a.runtimeDependencies.size - b.runtimeDependencies.size;
      })
      .slice(0, 9);

    // 枚举所有 C(n,3) 组合
    for (let i = 0; i < sorted.length - 2; i++) {
      for (let j = i + 1; j < sorted.length - 1; j++) {
        for (let k = j + 1; k < sorted.length; k++) {
          const matchTiles = [sorted[i], sorted[j], sorted[k]];

          // 只看可见的
          if (!isAllVisible(matchTiles)) continue;

          const { path, totalCost } = calculatePath(matchTiles, game);
          allGroups.push({ color, tiles: matchTiles, totalCost, path });
        }
      }
    }
  }

  // 按 cost 升序
  allGroups.sort((a, b) => a.totalCost - b.totalCost);

  return allGroups;
}

/**
 * 从匹配组的依赖路径中选一张可点击的牌。
 * 按路径顺序（BFS 收集顺序）找第一个 clickable 的。
 */
export function pickClickableFromPath(
  group: MatchGroup,
  game: OfflineGame,
): OfflineTile | null {
  if (!group.path || group.path.size === 0) return null;

  // 按 tiles 的顺序（sorted 顺序）遍历路径中 clickable 的
  for (const tile of group.tiles) {
    if (tile.isClickable && tile.pileType === PileType.Desk) {
      return tile;
    }
  }

  // 如果 match tiles 没有 clickable 的（理论上有），遍历 path
  for (const id of group.path) {
    const t = game.allTiles.get(id);
    if (t && t.isClickable && t.pileType === PileType.Desk) {
      return t;
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════
//  决策点：选最能揭露牌面的 tile
// ═══════════════════════════════════════════════════════════

/**
 * 在所有可点击牌中，选 unlockGain 最高的。
 * 即：点了这张牌后，能让最多被遮挡的牌解除依赖。
 * 平局时随机选。
 */
export function pickMostRevealingTile(
  game: OfflineGame,
  rng: () => number,
): OfflineTile | null {
  const clickable = game.deskTiles.filter(t => t.isClickable);
  if (clickable.length === 0) return null;

  // 计算每张牌的 unlockGain
  const scored = clickable.map(t => ({
    tile: t,
    gain: game.countUnlockGain(t.id),
  }));

  // 找最大 gain
  let maxGain = -1;
  for (const s of scored) {
    if (s.gain > maxGain) maxGain = s.gain;
  }

  const best = scored.filter(s => s.gain === maxGain);
  return best[Math.floor(rng() * best.length)].tile;
}

// ═══════════════════════════════════════════════════════════
//  玩家策略：选一张牌
// ═══════════════════════════════════════════════════════════

/**
 * 玩家策略选牌。
 *
 * 1. 找所有可见三连组，过滤 cost ≤ dockRemain 的安全组
 * 2. 有安全组 → 随机选一个 → 在它的路径中取一张可点击的牌
 * 3. 无安全组 → 选解锁收益最高的可点击牌
 */
function selectTile(game: OfflineGame, rng: () => number): OfflineTile | null {
  const visibleGroups = computeVisibleMatchGroups(game);
  const dockRemain = game.remainSlotCount;

  // 过滤安全组（cost ≤ 剩余槽位）
  const safeGroups = visibleGroups.filter(g => g.totalCost <= dockRemain);

  if (safeGroups.length > 0) {
    // 从安全组中随机选一个
    const chosen = safeGroups[Math.floor(rng() * safeGroups.length)];
    const tile = pickClickableFromPath(chosen, game);
    if (tile) return tile;
    // fallback: 如果路径里没找到 clickable（理论上不应发生），
    // 尝试从所有安全组找
    for (const g of safeGroups) {
      const t = pickClickableFromPath(g, game);
      if (t) return t;
    }
  }

  // 决策点：没有安全组，选最能揭露的
  return pickMostRevealingTile(game, rng);
}

// ═══════════════════════════════════════════════════════════
//  公开 API
// ═══════════════════════════════════════════════════════════

/**
 * 单次玩家模拟。
 *
 * @param game - 初始游戏状态
 * @param seed - 随机种子
 * @param maxSteps - 最大步数限制（默认 2000）
 */
export function solvePlayer(
  game: OfflineGame,
  seed: number = 0,
  maxSteps: number = 2000,
): PlayerSimResult {
  const g = game.clone();
  const picks: number[] = [];
  const rng = mulberry32(seed);
  let forcedRandomPickCount = 0;
  let colorStarvationCount = 0;

  for (let step = 0; step < maxSteps; step++) {
    if (g.isWin) break;
    if (g.isDead) {
      return {
        win: false,
        failReason: `Dock full at step ${step}`,
        picks,
        stepCount: picks.length,
        seed,
        remainingTilesOnFail: g.deskTiles.length,
        forcedRandomPickCount,
        colorStarvationCount,
      };
    }

    // color starvation: dock+clickable 中是否有颜色 ≥2 张
    const cb = new Map<number, number>();
    for (const [c, n] of g.getDockCounts()) cb.set(c, n);
    for (const t of g.deskTiles) {
      if (t.isClickable && t.elementValue > 0) {
        cb.set(t.elementValue, (cb.get(t.elementValue) ?? 0) + 1);
      }
    }
    let hasColorPair = false;
    for (const n of cb.values()) { if (n >= 3) { hasColorPair = true; break; } }
    if (!hasColorPair) colorStarvationCount++;

    // detect forced-random-pick: safeGroups=0 走 fallback
    const visibleGroups = computeVisibleMatchGroups(g);
    const dockRemain = g.remainSlotCount;
    const safeGroups = visibleGroups.filter(mg => mg.totalCost <= dockRemain);

    const tile = selectTile(g, rng);
    if (!tile) {
      return {
        win: false,
        failReason: `No clickable tiles at step ${step}`,
        picks,
        stepCount: picks.length,
        seed,
        remainingTilesOnFail: g.deskTiles.length,
        forcedRandomPickCount,
        colorStarvationCount,
      };
    }

    if (safeGroups.length === 0) forcedRandomPickCount++;

    g.collect(tile);
    picks.push(tile.id);
  }

  return {
    win: g.isWin,
    failReason: g.isWin
      ? null
      : g.isDead
        ? 'Dock full'
        : `Max steps (${maxSteps}) reached`,
    picks,
    stepCount: picks.length,
    seed,
    remainingTilesOnFail: g.isWin ? 0 : g.deskTiles.length,
    forcedRandomPickCount,
    colorStarvationCount,
  };
}

/**
 * 批量玩家模拟。
 *
 * @param game - 初始游戏状态
 * @param runs - 模拟次数（默认 100）
 * @param baseSeed - 起始随机种子
 * @param maxSteps - 每局最大步数
 */
export function solvePlayerBatch(
  game: OfflineGame,
  runs: number = 100,
  baseSeed: number = 0,
  maxSteps: number = 2000,
): PlayerSimBatchResult {
  const startTime = performance.now();
  let wins = 0;
  let losses = 0;
  const results: PlayerSimResult[] = [];
  let totalWinSteps = 0;
  let totalLossSteps = 0;
  let totalForcedOnWin = 0;
  let totalStarveOnWin = 0;
  let totalForcedOnLoss = 0;
  let totalStarveOnLoss = 0;

  for (let i = 0; i < runs; i++) {
    const result = solvePlayer(game, baseSeed + i, maxSteps);
    results.push(result);
    if (result.win) {
      wins++;
      totalForcedOnWin += result.forcedRandomPickCount;
      totalStarveOnWin += result.colorStarvationCount;
    } else {
      losses++;
      totalLossSteps += result.stepCount;
      totalForcedOnLoss += result.forcedRandomPickCount;
      totalStarveOnLoss += result.colorStarvationCount;
    }
  }

  return {
    wins,
    losses,
    winRate: runs > 0 ? wins / runs : 0,
    results,
    forcedPickOnWin: wins > 0 ? totalForcedOnWin / wins : 0,
    starvationOnWin: wins > 0 ? totalStarveOnWin / wins : 0,
    stepsOnLoss: losses > 0 ? totalLossSteps / losses : 0,
    forcedPickOnLoss: losses > 0 ? totalForcedOnLoss / losses : 0,
    starvationOnLoss: losses > 0 ? totalStarveOnLoss / losses : 0,
    elapsedMs: performance.now() - startTime,
  };
}
