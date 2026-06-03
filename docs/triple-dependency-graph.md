# Triple 依赖图：实现、结果与含义

## 1. 背景

ReverseGen 是一个牌局反向生成工具。输入地形 + Cost 数组 + 花色数，输出完整花色分配。

核心算法 **CostLadder** 每步要做一次决策：在 cost ≥ target 的候选 triple 中选一个消除。当有多个候选时，当前算法**盲选第一个**，选错会通过黑名单机制连锁影响后续步骤，产生偏差。

`docs/triple-relation.md` 提出了通过分析 triple 之间的静态关系来优化选择策略。本报告描述为研究这些关系而构建的可视化分析工具。

---

## 2. 核心概念

### 2.1 Triple

从地形自由牌中任选 3 张的组合。C(n,3) 个。100075 地形（84 自由牌）= **95,284 个 triple**。

### 2.2 depSet（依赖包）

一个 triple 要消除时，需要"翻出"的所有牌。包括：
- 三张牌自身
- 三张牌各自压在下面的所有牌（传递依赖闭包，BFS 沿 dependencies 链向下）

```
triple {10, 16, 23}：
  牌 10 压在牌 1, 2 上 → 牌 1 压在牌 3 上 → ...
  depSet = {10, 16, 23, 1, 2, 3, ...} 共 9 张牌
```

### 2.3 偏序关系（Partial Order）

```
B ≺ A  (B 应该在 A 之前消除)

定义：B.depSet ⊆ A.depSet  且  B 和 A 不共享牌

含义：消除 B 后释放的所有牌都在 A 的依赖中
     → B 消除对 A 有最大帮助
     → B 绝对应该在 A 之前消除
```

等价性证明：

```
B 的 3 张牌 ∈ A 的 depSet（"前提关系"的原始定义）
  → B 的牌在 A 的传递依赖闭包中
  → B 的所有依赖也在 A 的依赖中（依赖的依赖还是依赖）
  → B.depSet ⊆ A.depSet（偏序关系）
  ∴ "前提关系" ≡ "偏序关系"
```

因此不存在两种不同的关系，**偏序关系就是前提关系**。文档中分开定义是冗余的。真正的两个层次是：

| 层次 | 内容 |
|------|------|
| 偏序关系 | B.depSet ⊆ A.depSet（完整边集） |
| Hasse 图 | 偏序关系的传递归约（去除间接边）— 因计算量问题暂未实现 |

### 2.4 后继与前驱

- **successorCount（后继数）**：这个 triple 是多少其他 triple 的前驱。值越大 = 消除它影响越广。
- **predecessorCount（前驱数）**：有多少其他 triple 是这个 triple 的前驱。值越大 = 越"被帮助"。

### 2.5 两种分层定义

#### depSetSize 分位数（静态）

将 95,284 个 triple 按 depSetSize 从小到大排序，等分成 8 份（每份 ~11,910 个）。落入第 i 份的标 Li。

- L0：depSetSize 最小的 triple（~3）。基础 triple，底下没压牌
- L7：depSetSize 最大的 triple（~61）。依赖最深的 triple

**局限**：只反映"底下压了多少张牌"（tile 级别），不反映"要等多少个 triple 先消"（triple 级别）。

#### 依赖深度（结构）

```
L0：predecessorCount == 0  → 不需要等任何 triple 先消
Ln：max(所有前驱的依赖深度) + 1  → 最长需要等 n 步
```

100075 地形实际深度范围：**L0 ~ L6**，共 7 层（不是 hardcode 的 8 层）。

**优势**：直接回答"这个 triple 要等多少步才能消"。

两种定义的对比：

```
triple A：depSetSize=18 → 分位数 L3，但所有前驱在 L0 → 依赖深度 L1
triple B：depSetSize=12 → 分位数 L2，但前驱链深 4 步 → 依赖深度 L4
```

依赖深度更准确地反映 triple 在决策序列中的位置。

---

## 3. 100075 地形分析结果

### 3.1 宏观数据

| 指标 | 值 |
|------|-----|
| 自由牌 | 84 张（4 层） |
| Triple 总数 | 95,284 |
| 偏序边总数 | 436,241,398 |
| 平均 successorCount | 4,578 |
| 有后继的 triple | 54,740（57.4%） |
| 有前驱的 triple | 94,224（98.9%） |
| 孤立 triple | 0 |
| depSetSize 范围 | 3 ~ 61（平均 31.06） |
| 依赖深度范围 | 0 ~ 6 |

### 3.2 关键发现

**发现 1：图极密。** 平均每个 triple 是 4,578 个其他 triple 的前驱。最关键的 triple `{2,3,16}` 有 **73,840 个后继**——消除它影响 77.5% 的 triple。

**发现 2：所有 triple 都有关联。** 没有任何 triple 是孤立的。每个 triple 至少是某个其他 triple 的前驱或被某个前驱依赖。

**发现 3：深度层次分明。** 依赖深度从 0 到 6，层次清晰。最深 triple 需要等 6 层前驱依次消除才能轮到自己。

**发现 4：基础 triple 影响力巨大。** L0 的 triple（depSetSize=3，无前驱）有最大的 successorCount。这说明底层的关键 triple 被绝大多数上层 triple 依赖——如果算法错误地 ban 掉它们，后果是灾难性的。

### 3.3 对算法的启示

当前 CostLadder 的问题：当 cost==target 的候选有多个时盲选。

**改进方向**：
1. **优先选 L0 的 triple**（不依赖别人，先消无害）
2. **保护高 successorCount 的 triple**（ban 掉影响面太大）
3. **按依赖深度排序**：优先消浅层，后消深层
4. **避免同层互杀**：同一深度层的 triple 之间通常是独立的（无偏序关系），可以并行处理

---

## 4. 计算架构

### 4.1 Pass 1：计数（~45s）

```
对每个 triple A：
  从 A.depSetTiles 枚举 C(|depSet|,3) 个候选前驱
    → 排除含 A 自身 tile 的组合
    → 用 tripleKey 查 keyToIndex 确认候选是合法 triple
    → successorCounts[前驱]++
    → predecessorCounts[A]++

复杂度：95,284 × avg(C(12,3)) ≈ 20M 次候选检查
结果：Uint32Array successorCounts, predecessorCounts
      共发现 436M 条偏序边（只计数，不存储）
```

### 4.2 Pass 1.5：依赖深度（~15s）

```
按 depSetSize 升序排列所有 triple（保证前驱先处理）
对每个 triple：
  if predecessorCount == 0 → depth = 0
  else → 枚举 C(|depSet|,3) 找所有前驱
         → depth = max(前驱.depth) + 1

复杂度：同上 ~20M 次
结果：Uint16Array dependencyDepth（0 ~ 6）
```

### 4.3 Pass 2：建边（<1s）

```
取 top 6000 triple（按 successorCount + predecessorCount 降序）
仅枚举这些 triple 的 C(|depSet|,3) 前驱
  → 两端都在 topSet 中才存储边
  → 计算 overlap = |前驱.depSet ∩ 后继.depSet|（两指针归并，O(n+m)）

结果：AnalysisEdge[]（~几千条），存入缓存
```

### 4.4 缓存

```
首次：.reversegen-cache/triple-analysis-{terrainHash}.json (~35MB)
后续：读缓存，166ms
```

### 4.5 API 层

```
/api/analyze-triples：
  → filterGraphData 分层采样（每层取 perLayer 个最连接的节点）
  → 实时枚举每个显示节点的 C(depSet,3) 补全前驱边
  → 返回 graph.triples (~200个) + edges (完整) + allTriples (95k 紧凑格式)

/api/triple-detail：
  → 实时从 depSetTiles 枚举 C(n,3) 找全部前驱
  → 不依赖存储边集，保证完整
```

---

## 5. 可视化：怎么读

### 5.1 偏序 DAG（默认视图）

```
  L0  ●  ●  ●  ●        ← 蓝：基础 triple，无前驱，先消
        ↘  ↙   ↘
  L1    ●  ●  ●  ●       ← 等 1 步
          ↘  ↙
  L2      ●  ●  ●        ← 等 2 步
           ...
  L6        ●             ← 红：最深 triple，等 6 步
```

**节点属性**：
- **颜色**：蓝（浅层）→ 红（深层）。越蓝越该先消
- **大小**：successorCount。越大 = 影响越广
- **Y 轴位置**：层号（依赖深度或 depSetSize 分位数）
- **X 轴位置**：barycenter 排序（减少边交叉，无语义）

**交互**：
- **悬停**：高亮完整依赖链。蓝色上游（谁帮助它）+ 红色下游（它帮助谁），无关节点变灰
- **点击**：右侧检查器显示完整前驱/后继列表 + depSet 内容
- **拖拽**（仅力导向图）：自由探索节点关系

### 5.2 力导向图

同样的数据，D3 物理模拟布局。适合探索性浏览——拖一拖看节点如何抱团。

### 5.3 层定义切换

顶栏下拉框切换「depSet分位数」↔「依赖深度」。切换后 DAG 和力导向图的层划分立即更新，无需重新分析。

---

## 6. 局限与未来

1. **Hasse 图未实现**：偏序的传递归约（去除间接边）计算量太大（需 BFS-based 传递归约），暂未实现
2. **后驱边不完整**：后继（我帮助谁）仍依赖存储边集，未做实时枚举（需建反向索引）
3. **大图性能**：84 自由牌的分析需 ~60s。更大关卡会更慢，但可通过缓存摊薄
4. **偏序 = 前提**：文档中区分两种关系是冗余的，需修正 `docs/triple-relation.md`
