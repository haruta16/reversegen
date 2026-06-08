# 玩家模拟求解器优化方案

> 目标: 将 MAE 从 ~40% 降至 ~10-15%，使模拟胜率接近真实玩家

---

## 1. 问题诊断

### 当前求解器的三个核心优势（也是问题所在）

| # | 优势 | 为什么真实玩家做不到 | 对偏差的贡献 |
|---|------|---------------------|------------|
| 1 | **穷举所有可见三连组** | 人类注意力有限，同一时间只能注意到 2-5 个明显组合 | ⭐⭐⭐ 最大 |
| 2 | **精确计算 unlockGain** | 人类无法精确判断「点哪张牌能揭露最多被挡牌」 | ⭐⭐⭐ 最大 |
| 3 | **零失误决策** | 人类会策略摇摆、误判 cost、忽略隐藏组合 | ⭐⭐ |
| 4 | **无 tunnel vision** | 人类一旦收集了同色 2 张牌，会执着于凑齐第三张 | ⭐ |
| 5 | **完美 cost 估算** | 人类凭直觉估计依赖链长度，经常低估 | ⭐ |

### 偏差热力图

```
在线胜率 →
  0%     30%     50%     70%    100%
  ├────────┼───────┼───────┼──────┤
  │  +49.6% │+43.7% │+33.7% │+21.0%│+9.8%
  │ ████████│███████│█████  │███   │█
  │ 极难    │困难   │中等   │较易  │极易
```

越难的关卡，模拟器优势越大 — 因为难关中「找出最优路径」的价值最高。

---

## 2. 优化方案：技能参数化玩家模型

### 2.1 核心思路

引入一个 **`skill ∈ [0, 1]`** 参数（默认 0.5-0.6 对应中等玩家），控制模拟器的**注意力、感知精度、决策质量**三个维度。

```
skill = 0.0  →  纯随机点牌（胜率→0%）
skill = 0.5  →  中等玩家（目标 MAE ~10-15%）
skill = 1.0  →  当前模拟器（最优上界）
```

### 2.2 三个维度的具体修改

#### 维度 1: 注意力限制 `attentionSpan`

**当前**: 穷举所有 C(n,3) 可见三连组

**修改后**: 只考虑 top-N 个最「显眼」的组
```
attentionSpan = floor(2 + skill * 8)   // skill=0.5 → 6个组
```

排序规则（模拟人类注意力的优先级）：
1. 🥇 **消三连**: dock 已有 2 张同色 → 最高优先
2. 🥈 **凑对子**: dock 已有 1 张同色 → 次优先
3. 🥉 **低 cost**: 依赖链短的组更容易被注意到
4. 🏅 **近期揭露**: 刚变成可见的 tile 所在组更显眼

**预估效果**: 偏差 -15~20%

#### 维度 2: 感知噪声 `perceptionNoise`

**当前**: 所有决策基于精确计算

**修改后**: 在每个决策点注入噪声

```typescript
// 2a. 组合遗漏 — 有一定概率完全忽略一个可见组
const missRate = (1 - skill) * 0.3;  // skill=0.5 → 15% 遗漏率

// 2b. Cost 估计误差 — 人类经常低估依赖链长度
const costError = Math.round((rng() - 0.3) * (1 - skill) * 4);  
// skill=0.5 → 偏差在 [-1.2, +2.8] 范围
const perceivedCost = group.totalCost + costError;

// 2c. unlockGain 估计误差 — 加入噪声，模拟人类无法精确定位
const perceivedGain = actualGain + (rng() - 0.5) * (1 - skill) * 10;
```

**预估效果**: 偏差 -5~10%

#### 维度 3: 决策偏差 `decisionBias`

**当前**: 完全理性，无策略偏好

**修改后**: 引入人类常见的认知偏差

```typescript
// 3a. Tunnel vision — 收集了同色 ≥2 张后，偏向完成它
if (dockCountOfSameColor >= 2 && rng() < 0.6 - skill * 0.3) {
  // skill=0.5 → 45% 概率陷入 tunnel vision
  // 优先选该颜色的组，即使 cost 稍高
}

// 3b. 贪心偏差 — 偏好「马上能消」的组
// 即使有其他更低 cost 的组，也倾向选能立刻凑满三连的
if (hasImmediateTriple && rng() < 0.7 - skill * 0.4) {
  // 有时放弃更优的长期策略
}

// 3c. 回避复杂路径 — 当 cost 相近时，人类会选「看起来简单」的
// 即依赖链更浅、更线性的路径
```

**预估效果**: 偏差 -5~8%

### 2.3 综合效果估算

| skill | 注意力 | 感知 | 决策 | 预估 simWR | 预估 MAE |
|-------|--------|------|------|-----------|---------|
| 1.0 (当前) | 无限制 | 精确 | 理性 | 82.2% | 40.0% |
| 0.7 (高手) | top-7 | 低噪 | 微偏 | ~65-70% | ~25% |
| **0.5 (中等)** | **top-6** | **中噪** | **中偏** | **~50-55%** | **~10-15%** |
| 0.3 (新手) | top-4 | 高噪 | 强偏 | ~35-40% | ~25% |
| 0.0 (随机) | — | — | — | ~5-10% | ~35% |

---

## 3. 推荐实现路径

### Phase 1: 最小可行修改（预计 1-2 小时）

只改注意力限制，这是**影响最大、实现最简单**的修改：

```typescript
// solver-player.ts 修改点

function computeVisibleMatchGroups(
  game: OfflineGame, 
  attentionSpan: number = 6,  // 新增参数
): MatchGroup[] {
  const allGroups = computeAllVisibleMatchGroups(game); // 现有逻辑
  
  // 按人类显眼度排序
  const dockCounts = game.getDockCounts();
  allGroups.sort((a, b) => {
    const aDock = dockCounts.get(a.color) ?? 0;
    const bDock = dockCounts.get(b.color) ?? 0;
    // 优先 dock 中已有同色的组
    if (aDock !== bDock) return bDock - aDock;
    // 次优先低 cost
    return a.totalCost - b.totalCost;
  });
  
  return allGroups.slice(0, attentionSpan);
}
```

### Phase 2: 加入感知噪声（预计 1 小时）

```typescript
function selectTileWithNoise(
  game: OfflineGame, 
  rng: () => number,
  skill: number,
): OfflineTile | null {
  const visibleGroups = computeVisibleMatchGroups(game, attentionSpan(skill));
  const dockRemain = game.remainSlotCount;
  
  // 感知噪声: 有一定概率遗漏组
  const missRate = (1 - skill) * 0.3;
  const perceived = visibleGroups.filter(() => rng() > missRate);
  
  // Cost 估计误差
  const safeGroups = perceived.filter(g => {
    const noise = Math.round((rng() - 0.3) * (1 - skill) * 4);
    return g.totalCost + noise <= dockRemain;
  });
  
  if (safeGroups.length > 0) {
    // Tunnel vision check
    const dockCounts = game.getDockCounts();
    for (const g of safeGroups) {
      if ((dockCounts.get(g.color) ?? 0) >= 2 && rng() < 0.45) {
        return pickClickableFromPath(g, game);
      }
    }
    const chosen = safeGroups[Math.floor(rng() * safeGroups.length)];
    return pickClickableFromPath(chosen, game);
  }
  
  // Fallback: 加噪 unlockGain
  return pickMostRevealingTileWithNoise(game, rng, skill);
}
```

### Phase 3: 参数标定（通过回归）

用已有 2742 条数据做参数拟合：

```python
# 伪代码: 找到使 MAE 最小的 skill 值
best_skill = argmin_{s ∈ [0,1]} MAE(onlineWR, simWR(s))
```

或者更精细：按 tile 数、难度分层训练不同的 skill 参数。

### Phase 4 (可选): 学习型模型

如果 Phase 1-3 的 MAE 仍不理想（>15%），可以考虑：
- 为每个地形大小/难度段单独拟合 skill
- 引入非线性的 skill 映射（如 sigmoid 加权）
- 用在线数据中的「操作路径」数据来学习真实玩家的策略分布

---

## 4. 预期效果对比

```
                   当前           Phase 1       Phase 1+2     Phase 1+2+3
                   ─────         ───────       ─────────     ───────────
Pearson r          0.53          0.55-0.60     0.60-0.65     0.65-0.70
R²                 0.28          0.30-0.36     0.36-0.42     0.42-0.49
MAE                40.0%         25-30%        15-20%        10-15%
偏差                +39.6%        +15-20%       +5-10%        ±5%
|差|≤10% 占比      7.5%          20-30%        40-50%        50-65%
```

---

## 5. 为什么不做「纯数据驱动」

有人可能提议直接做 `simWR → onlineWR` 的回归映射（如多项式拟合或 ML 模型），但这有几个问题：

1. **过拟合风险**：2742 条数据中，同一 tile 数的 replaykey 可能只有几十个
2. **缺乏可解释性**：映射模型是黑盒，无法解释「为什么这个关卡难」
3. **泛化能力差**：新地形、新花色配置可能导致映射失效
4. **失去设计价值**：关卡策划需要的是「为什么这个布局难」，而不是「预测胜率是多少」

**技能参数化模型的优势**：
- 每个参数有明确的认知心理学含义
- 可以单独调整某个维度（如「让玩家更贪心」）
- 可以生成不同技能水平的预测（新手/中等/高手）
- 可以反推：「要让人均胜率达到 60%，需要降低多少 attentionSpan」

---

## 6. 实现接口设计

```typescript
// 新的公开 API
export interface CalibratedPlayerConfig {
  skill: number;           // 0-1, 默认 0.5
  attentionSpan?: number;  // 手动覆盖（不随 skill 计算）
  missRate?: number;       // 手动覆盖感知遗漏率
  greediness?: number;     // 手动覆盖贪心偏差
  tunnelVision?: number;   // 手动覆盖 tunnel vision 强度
  costNoise?: number;      // 手动覆盖 cost 估计噪声
}

export function solveCalibratedPlayer(
  game: OfflineGame,
  seed: number,
  config: CalibratedPlayerConfig = { skill: 0.5 },
): PlayerSimResult;

export function solveCalibratedPlayerBatch(
  game: OfflineGame,
  runs: number,
  config: CalibratedPlayerConfig = { skill: 0.5 },
): PlayerSimBatchResult;
```
