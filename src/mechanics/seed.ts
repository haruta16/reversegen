/**
 * 机制派生种子 — 所有战场派生种子的统一实现与公共原语。
 *
 * 对齐契约（与 Unity 逐位一致）：
 * - mul397：C# unchecked int32 乘法（397 混合惯例）
 * - extraActionSeed：共享战场种子（ExtraDeterministicRandom.CreateSeed 同公式）
 * - magicBottleShuffleSeed：魔药索敌洗牌（MagicBottleExtra.CreateShuffleRandomSeed）
 * - shuffleBoardSeed：洗牌种子（ShuffleAlgo.CreateShuffleSeed）
 *
 * 基座统一为"地形资源身份"（levelResId），不再使用关卡实例 levelId——
 * 同资源多关卡不区分，满足"同地形 + replay + 机制 → 同结果"的纯函数要求。
 */

import type { OfflineGame } from '../solver/offline-game.js';

/** C# unchecked 的 int32 乘法（JS 数值乘法后按 int32 截断）。 */
export function mul397(value: number): number {
  return (value * 397) | 0;
}

/** 战场内容基座：地形资源身份（去掉关卡实例 levelId）。 */
export function battleBaseSeed(game: OfflineGame): number {
  return game.levelResId | 0;
}

/** 共享战场派生种子：基座 → ^dock数 → ^desk数 → ^步骤数 → ^盐（对齐 ExtraDeterministicRandom.CreateSeed）。 */
export function extraActionSeed(game: OfflineGame, salt: number): number {
  let seed = battleBaseSeed(game);
  seed = mul397(seed) ^ game.dockTiles.length;
  seed = mul397(seed) ^ game.deskTiles.length;
  seed = mul397(seed) ^ game.actionCount;
  seed = mul397(seed) ^ salt;
  return seed | 0;
}

/** 魔药索敌洗牌种子（对齐 MagicBottleExtra.CreateShuffleRandomSeed，无步骤项）。 */
export function magicBottleShuffleSeed(baseSeed: number, dockSlotCount: number, deskOnlyElementValues: number[]): number {
  let seed = baseSeed | 0;
  seed = mul397(seed) ^ dockSlotCount;
  for (const elementValue of deskOnlyElementValues) {
    seed = mul397(seed) ^ elementValue;
  }
  return seed | 0;
}

/** 洗牌种子：Desk/Dock 状态派生（ID 升序），对齐 ShuffleAlgo.CreateShuffleSeed。 */
export function shuffleBoardSeed(game: OfflineGame): number {
  let seed = 0x5a5a5a5a;
  for (const tile of [...game.deskTiles].sort((a, b) => a.id - b.id)) {
    seed = mul397(seed) ^ tile.id;
    seed = mul397(seed) ^ tile.elementValue;
  }
  for (const tile of [...game.dockTiles].sort((a, b) => a.id - b.id)) {
    seed = mul397(seed) ^ tile.id;
    seed = mul397(seed) ^ tile.elementValue;
  }
  return seed | 0;
}
