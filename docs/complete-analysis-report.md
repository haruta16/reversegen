# 关卡系统迭代：完整分析报告

## 一、前置回顾

### 1.1 项目目标

为 tile 消除游戏设计新一代替换算法，实现对牌局的**精确逻辑化控制**：可解性、死亡点位置、博弈点、自由度——全部可设计，全部可验证。

ReverseGen（基于贪心 cost 匹配）无法满足需求，因为贪心路径 ≠ 真实最优路径。

### 1.2 项目历程

| 阶段 | 内容 | 产出 |
|------|------|------|
| 前期 | ReverseGen 算法设计与实现 | 贪心框架下可控制 cost 链，但控制域仅限于贪心世界 |
| 转折 | 发现 DFS/随机策略轻松通过贪心无法通过的关卡 | 确认贪心 ≠ 真实路径，ReverseGen 前提不成立 |
| Phase A | 构建 triple 依赖图（地形级 DAG，95k 节点 436M 边） | 偏序关系 B ≺ A 的纯逻辑刻画 |
| Phase B | 移植 C# 求解器到 TS，批量分析 2507 个线上牌局 | 发现 cgEdgeCount 是最强区分信号 |
| Phase C | 构建牌局级 color DAG + triple DAG，分析 30 个代表性牌局 | 发现 VeryLow cgEdgeCount 牌局有天文数解 |
| Phase D | 深度分析 74 个不可解牌局 | 发现 Type A（后死）/ Type B（立死）两类 |

---

## 二、基建交付

### 2.1 求解器框架（`src/solver/`）

| 模块 | 功能 |
|------|------|
| `offline-game.ts` | 真实游戏规则引擎：Collect → CheckDockMatch → UpdateTilesState，使用动态 RuntimeDependencies |
| `solver-dfs.ts` | DFS 求解器，状态记忆化 + 死路剪枝，动作排序 |
| `solver-greedy.ts` | 贪心求解器，模拟 ReverseGen 假设的策略 |
| `solver-random.ts` | 随机蒙特卡洛，测量解空间宽度 |

### 2.2 DAG 分析框架（`src/analysis/`）

| 模块 | 功能 |
|------|------|
| `board-dag.ts` | 色组级 DAG（color→color 阻塞关系）+ triple 级 DAG（depSet 偏序关系） |
| `batch-runner.ts` | 批量分析引擎，含缓存 |
| `batch-v2.ts` | v2 批量分析，均匀采样 + 完整 DAG 特征 + 持久化（2507 文件） |
| `aggregate.ts` | 聚合分析，特征对比 + 规则候选搜索 |
| `deadlock-hunter.ts` | 死锁模式检测（DEADLOCK_CYCLE / ENTRY_OVERFLOW / SINK_STARVATION） |
| `rule-check.ts` | 结构规则大规模验证 |

### 2.3 数据资产

| 数据 | 规模 | 位置 |
|------|------|------|
| 缓存牌局分析 | 2507 个 | `.reversegen-cache/board-results-v2/` |
| 聚合报告 | 1 个 | `.reversegen-cache/aggregate-report-v2.json` |
| 规则验证报告 | 1 个 | `.reversegen-cache/rule-check.json` |

---

## 三、核心发现

### 3.1 宏观统计（2507 个线上牌局）

| 指标 | 值 |
|------|-----|
| DFS 可解 | 2282 (97.4%) |
| DFS 不可解 | 74 (2.6%) |
| 贪心可解 | 196 (8.4%) |
| 贪心失败、DFS 成功 | 2086 (89.0%) |
| 随机胜率 0% | 2337 (99.7%) |

**结论**：Reversegen 的前提（贪心 = 最优）在 89% 的牌局中不成立。绝大多数线上牌局是极窄的"谜题"（0% 随机胜率）。

### 3.2 确定性规则（已验证）

**规则 1：cgEdgeCount < 30 → 100% 可解**
- 43/43 牌局 DFS 可解，0 假阳性
- 这些牌局有天文数解（10^28+）

**规则 2：colorCount < 8 → 100% 可解**
- 52/52 牌局 DFS 可解

### 3.3 不可解牌局分析（74 个）

分为两类：

#### Type B：立死型（46/74，62%）

**症状**：开局没有任何花色有 ≥3 张可点击 tile。

**机制**：
- 每色可点 tile 数 ≤ 2，分散在多个花色
- 不可点 tile 的依赖链形成"屏障"——所有屏障 tile 属于 0-clickable 色组
- 初始点击无法让任何色凑够 3 张，也无法解锁屏障色组
- dock 中积压不同色 tile → dock 满 → 死

**示例**（Level 100006）：
```
5 个色各有 1 张可点 → dock 5 张不同色 → 无法消
剩余 37 张全被 7 个 0-clickable 色组阻塞
屏障色组互锁 → 无突破口
```

#### Type A：后死型（28/74，38%）

**症状**：开局至少一色有 3+ 可点 tile，可完成第一个 triple。

**未解问题**：完成第一步后为什么还会死？死在哪一步？

### 3.4 统计信号（非确定性）

| 特征 | 贪心失败 avg | 贪心成功 avg | 比值 |
|------|-------------|-------------|------|
| cgEdgeCount | 90.4 | 49.9 | 1.81x |
| colorCount | 14.5 | 9.9 | 1.46x |

| 特征 | 不可解 avg | 可解 avg（同 cgEdge 范围） |
|------|-----------|--------------------------|
| tdagTripleCount | 277 | 479 | 0.58x |

**解读**：不可解牌局的依赖约束更"浓缩"——同样多的边压在更少的 triple 上。

### 3.5 死锁模式检测

| 模式 | 不可解命中 | 可解假阳性 | 确定性？ |
|------|-----------|-----------|---------|
| DEADLOCK_CYCLE（色组互锁） | 74/74 (100%) | 10/10 (100%) | ✗ 完全不可靠 |
| ENTRY_OVERFLOW | 0/74 | — | 无样本 |
| SINK_STARVATION | 41/74 | 未测 | 未知 |
| BOTTLENECK_TILE | 22/74 | 未测 | 警告级 |

**结论**：色组级别的分析太粗糙。色组 A ↔ B 的互锁边在 tile 级别可能不是真正的死锁，因为每个色组内部只有部分 tile 参与互锁。

---

## 四、当前进展与局限

### 已有成果

1. ✅ 完整的求解器框架（DFS/贪心/随机）
2. ✅ 2507 个牌局的批量分析 + 持久化
3. ✅ 色组级 DAG + triple 级 DAG 构建与特征提取
4. ✅ 两个确定性规则（cgEdgeCount < 30 / colorCount < 8 → 可解）
5. ✅ 不可解牌局分类（Type A 后死 / Type B 立死）

### 当前局限

1. **Type A（后死型）机制未解**：第一个 triple 之后为何死锁？
2. **缺少 tile 级别的死锁分析**：色组级别互锁假阳性太高
3. **缺少"死亡位置"的控制理论**：无法精确设计"在第 K 步死亡"
4. **缺少"决策点/自由度"的原子化分析**：多少条分支、各通向哪里

---

## 五、下一步方向

### 5.1 Type A 深度分析

对 28 个后死型牌局逐一分析：
- 第一步 triple 是哪几个色？
- 消除后释放了哪些 tile？
- 为什么释放后仍然无解？
- 死锁形成在色组依赖图的哪一层？

### 5.2 tile 级死锁建模

构建 tile 级依赖图（不聚合为色组），寻找：
- **最小死锁子图**：最小的 tile 集合，其内部依赖形成闭环且无法从外部打破
- **死锁传播链**：初始 clickable 耗尽后，依赖链路上的屏障如何一步步锁死所有可能

### 5.3 死亡位置控制

基于 tile 级分析，定义：给定一个消除序列的前 K 步，什么条件下第 K+1 步必然无合法移动？

### 5.4 决策点/自由度分析

基于 triple DAG，计算：
- 每个拓扑层的并行 triple 数 = 该步可选分支数
- 删去某个 triple 后 DAG 拓扑序数量的变化 = 该 triple 的"选择权重"

---

## 六、文件清单

| 文件 | 用途 |
|------|------|
| `docs/project-journey.md` | 项目经历与需求描述 |
| `docs/phase-a-analysis-report.md` | Phase A 分析报告 |
| `docs/triple-relation.md` | Triple 关系理论 |
| `docs/triple-dependency-graph.md` | Triple 依赖图实现分析 |
| `docs/complete-analysis-report.md` | 本报告 |
| `src/solver/*.ts` | 求解器框架 |
| `src/analysis/*.ts` | DAG 构建 + 批量分析 + 规则验证 + 死锁检测 |
| `test/smoke-test.ts` | 单牌局管线验证 |
| `test/verify-dfs.ts` | DFS 正确性验证 |
| `test/full-batch.ts` | 完整批量分析 |
| `test/deep-one-board.ts` | 单牌局深度分析 |
| `test/scan-unsolved.ts` | 不可解牌局特征扫描 |
