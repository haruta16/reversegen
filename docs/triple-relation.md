# Triple 关系分析与选择策略

## 1. 问题定义

### 1.1 算法目标

> **每一步的 cost 等于 target**，而非"接近"target。偏差是选择过程中的副产物，不应是设计目标。

当前算法的 CostLadder 贪心框架能够完成大部分步骤的精确匹配，但一部分步骤会偏离 target，根源在于：

### 1.2 根因分析

```
步骤 i，存在 n 个 cost == target 的候选 triple
         ↓
当前策略：按无语义排列顺序选取第一个
         ↓
黑名单封杀所有 cost ≤ 选中 triple 的候选
         ↓
被封杀的某些 triple 恰好是未来步骤达成 target 的必要前提
         ↓
后续步骤候选不足 → 降级选次优或抢救 → 偏差产生
```

**本质**：局部贪心缺乏对 triple 选择后果的前瞻。选哪个 triple 不仅影响当前步，还通过黑名单机制影响后续所有步的可行解空间。

### 1.3 形式化

设步骤序列 $S = [s_1, s_2, ..., s_N]$，target 数组 $T = [t_1, t_2, ..., t_N]$。

对每个步骤 $s_i$：
- 候选集 $C_i = \{c \mid cost(c) \ge t_i, c \notin used_{<i}, c \notin ban_{<i}\}$
- 选中 $c^* \in C_i$ 且 $cost(c^*) \ge t_i$
- $ban_i = ban_{i-1} \cup \{c \in C_i \mid cost(c) \le cost(c^*)\}$

**偏差条件**：若 $c^*$ 的 ban 操作封杀了某 $c_k \in C_i$，而 $c_k$ 是 $s_j$（$j > i$）达成 $t_j$ 的唯一候选，则 $s_j$ 必然偏离。

---

## 2. Triple 之间的静态关系

所有关系均可预计算，不依赖运行时状态。

### 2.1 前提关系（Prerequisite）

```
定义：B → A  ⟺  B.tileIds ⊆ A.depSet 且 !overlaps(A, B)

含义：消除 B 会收集 B.depSet 中的 tile
     → 这些 tile 必定包含在 A.depSet 中
     → A.cost 降低

量化：B 对 A 的贡献量 = |B.depSet ∩ A.depSet| / |A.depSet|
方向：B → A（B 是 A 的前提，B 先消除有利于 A 达成较低的 cost）
```

这是最核心的关系。当前算法完全不知道这个关系——它不知道选了某个 triple 后，会被封杀的候选里有多少是未来 target 的前提。

**示例**：

```
地形：A(牌1,2,3) 压在牌(4,5,6)上，B(牌7,8,9) 压在牌(2,5,10)上

A.depSet = {1,2,3,4,5,6}
B.depSet = {7,8,9,2,5,10}

前提关系：
  - 如果存在 triple X = {4,5,6}（全部来自 A 的底层依赖）
    → X 是 A 的前提：消除 X 会释放 4,5,6 → A 不再有依赖 → A.cost 降到 3
```

### 2.2 偏序关系（Partial Order）

从前提关系推导出的更强约束：

```
A ≺ B  ⟺  A.depSet ⊆ B.depSet 且 !overlaps(A, B)
```

**含义**：A 在偏序上"先于"B。因为 A 的 depSet 完全包含在 B 的 depSet 里：
- 先消 A → 自动释放 B 的部分依赖 → B 受益
- 先消 B → 对 A 无帮助 → A 吃亏

**性质**：
- 自反性：不成立（overlaps 互斥）
- 传递性：若 A ≺ B 且 B ≺ C，则 A ≺ C（depSet ⊆ 是可传递的）
- 反对称性：不可能同时 A ≺ B 且 B ≺ A（否则 depSet 相等且不共享 tile，但 depSet 相等意味着包含相同 tile 自身，矛盾）

**用途**：这个偏序告诉我们是**确定的先后关系**，不是"A 比 B 好几分"，而是"A 应该在 B 之前"。可以直接用作决策的硬约束或单一排序条件。

### 2.3 被威胁关系（Threat）

```
定义：threat(A → B)  ⟺  选 A 后会 ban 掉 B

判断条件（静态可判定）：
  选 A 后新的 collectedIds' = collectedIds ∪ A.depSet
  B 的新 cost = |B.depSet| - |collectedIds' ∩ B.depSet|
  = |B.depSet| - |collectedIds ∩ B.depSet| - |A.depSet ∩ B.depSet|
  = cost_current(B) - |A.depSet ∩ B.depSet|

  如果 cost_current(B) - |A.depSet ∩ B.depSet| ≤ cost_current(A)：B 会被 ban

关键静态量：|A.depSet ∩ B.depSet|（A 的消除对 B 的 cost 降低量）
```

### 2.4 包含关系（Containment）

```
定义：A 包含 B  ⟺  B.depSet ⊆ A.depSet 且 !overlaps(A, B)

含义：A 是 B 的"上位替代"
  - 消除 A 释放的依赖 ⊇ 消除 B 释放的依赖
  - 如果 B 必须被 ban，只要 A 还存活，不影响后续能力
```

注意：包含关系就是 2.2 的偏序 B ≺ A（B 应该在 A 之前）。A 包含 B → A 是更"上层"的 triple → 应该后面再消。

### 2.5 协同关系（Complementarity）

```
定义：complement(A, B)  ⟺  |A.depSet ∩ B.depSet| ≈ 0 且 !overlaps(A, B)

含义：A 和 B 的 depSet 几乎无交集
  → 消了 A 对 B 几乎无帮助
  → 消了 B 对 A 几乎无帮助
  → 两者是独立的

用途：池化场景中，应优先选择协同度高的 pair（避免"同伴互杀"）
```

### 2.6 瓶颈 tile（Bottleneck）

```
定义：出现在大量 triple 的 depSet 中的 tile

量化：对每个 tile，计算包含它在 depSet 中的 triple 数量
用途：消除覆盖瓶颈 tile 的 triple 是"关键步骤"，会解锁大量候选
```

---

## 3. 预计算数据结构

以下数据均在算法开始前一次性计算，运行时仅查表。

### 3.1 前提图（Prerequisite Graph）

```
PrereqMap: Map<TripleKey, Set<TripleKey>>
  key    = Triple A
  value  = 所有 B 满足 B.tileIds ⊆ A.depSet 且 !overlaps(A, B)
         = 消除 B 会降低 A 的 cost 的所有 triple
```

规模：N 自由牌 = 84，总 triple 约 C(84,3) ≈ 95k，单个 triple 的 depSet 中 triple 数量约 C(|depSet|, 3)，平均 |depSet| 可能在 6-15，即 C(6,3)=20 到 C(15,3)=455。

### 3.2 偏序邻接表（Partial Order Adjacency）

```
Predecessors[T]  = { X | X ≺ T }     // T 的前驱：应该在 T 之前被消除的 triple
Successors[T]    = { X | T ≺ X }     // T 的后继：应该在 T 之后被消除的 triple
Maximal[T]       = 是否有 X 使得 T ≺ X  // T 是否为偏序极大元
Minimal[T]       = 是否有 X 使得 X ≺ T  // T 是否为偏序极小元
```

### 3.3 depSet 交集矩阵（Overlap Matrix）

```
Overlap[A][B] = |A.depSet ∩ B.depSet|

稀疏存储：大多数 triple 对 overlap = 0
用途：O(1) 查表判断"选 A 后 B 的 cost 降低多少"
```

### 3.4 目标可达性索引（Target Reachability Index）

```
ReachableForTarget[c]: Set<TripleKey>
  所有 max_cost(T) ≥ c 的 triple 集合

max_cost(T) = |T.depSet| — T 的静态最大 cost（collectedIds 为空时）
```

运行时判断：某 target t 是否有可行候选 → ReachableForTarget[t] 中是否还有未被占用的 triple。

---

## 4. 选择策略方案

### 方案 A：保守改进 — 偏序安全检查 + 硬排序

**思想**：保持现有贪心框架，仅在候选选择环节引入偏序图决策。

#### 决策流程（纯条件链，非加权）

```
步骤 i，target = t

Step 1 — 安全检查（硬约束）
  对每个候选 C（cost(C) == t）：
    模拟 ban C 后的 banSet'
    对每个未来 target t_j（j > i）：
      检查 ReachableForTarget[t_j] 中是否有任何存活候选
      如果某个 t_j 的候选全部被 ban → C 为"危险候选" → 排除

  如果所有候选都被排除：
    → 放宽：保留 cost(C) ≥ t 的候选，回到 Step 1（允许超 target）
    → 如果仍全部排除：触发抢救

Step 2 — 偏序排序（单一条件）
  剩余候选按「Successors 数量」降序排列（Successors 越多 = 越多 triple 以此为前提）
  如果有平局：按 depSet.size 降序
  如果仍平局：保持稳定序

Step 3 — 选择
  取排序后第一个候选
```

**复杂度**：
- Step 1 的模拟 ban 在运行时，但只需对 cost==target 的候选做（通常 ≤ 几十个），每个模拟是 O(|ReachableForTarget[t_j]|) 的集合操作
- 安全检查可优化为增量判定（不是逐个模拟，而是检查被 ban 的 triple 是否"覆盖"了某个 target 的全部候选）

**侵入性**：仅修改 `executePool` 中的选择逻辑，不改变算法其余部分。

### 方案 B：激进重构 — 偏序拓扑构造

**思想**：放弃逐步贪心，利用偏序图直接构造满足 target 约束的完整消除序列。

#### 算法草图

```
1. 对每个 target 值 t，构建候选池：
     Pool[t] = { T | max_cost(T) ≥ t }

2. 从偏序图提取拓扑层：
     L_k = 所有入度为 k 的 triple（偏序上的"层"）

3. 回溯搜索：
     从偏序极小元（入度 = 0）开始，逐层分配 triple 到步骤
     每一步的约束：
       - 分配的 triple.cost == target（当 collectedIds 累积到当前状态）
       - 分配的 triple 之间的偏序约束不冲突
       - 同一步内分配的 triple 互不占牌

4. 失败时回溯到上一个选择点
```

**优点**：
- 如果能找到解，就是精确解（每一步 cost == target）
- 偏序约束提供了天然的剪枝能力

**缺点**：
- 搜索空间仍然很大，需要更多优化（如约束传播、启发式剪枝）
- 与现有算法架构完全不同，重写量较大
- 复杂度从 O(N) 变为指数级（但可剪枝）

---

## 5. 实施路线

### 5.1 第一阶段：验证前提图的有效性

1. 实现 `prereq-graph.ts`：预计算 TripeKey → Set<TripleKey> 的前提图
2. 在 `executePool` 中，当多个 cost==target 候选时，选择 **Successors 数量最大**的（不做安全检查）
3. 运行 benchmark，对比匹配率

**预期**：匹配率有可测量的提升，因为"选 Successors 多的"意味着释放更多后续依赖。

### 5.2 第二阶段：安全检查

1. 实现目标可达性索引
2. 在决策中加入危险候选排除
3. 对比匹配率

**预期**：进一步减少偏差，因为排除了会封杀未来唯一正解的候选。

### 5.3 第三阶段（可选）：探索方案 B

前提是前两阶段仍有不可接受的偏差率。
