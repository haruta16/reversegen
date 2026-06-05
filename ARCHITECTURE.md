# ReverseGen · 架构说明

## 项目定位

从 Unity TileMatch 项目中剥离的独立牌局生成工具。核心命题：

> 给定地形（牌的空间布局 + 叠压依赖关系），为每张牌赋予花色，使得生成的牌局在**可解性、死亡点位置、决策分支数**等维度上可以被精确、确定性地控制。

**三代算法**:

| 版本 | 名称 | 输入 | 输出 | 状态 |
|------|------|------|------|------|
| V2 | ReverseGen CostLadder | 地形 + Cost数组 + 花色数 | ReplayCode | 生产可用, 贪心域受限 |
| V3 | Forward Construction | 地形 + solvable/deathStep | 花色分配 | 已废弃 |
| V4 | DFS-Free 结构锁定 | 地形 + solvable/deathStep | 花色分配 + ReplayCode | ★ 当前主力 |
| CSP | DAG-driven 死锁搜索 | 地形 | 花色分配 + 死亡步 | ★ 在研 |

**与 Unity 零依赖**，纯 TypeScript，CLI / Web GUI / API 三种方式。

---

## V4 算法原理

### 核心洞察

```
分支数 = |{色C : |freed ∩ tiles(C)| ≥ 3}|

这是可直接计算的结构属性，不需要 DFS 探索状态空间。
```

### 两阶段架构

**Phase 1: assignColors** — 消除计划驱动颜色分配
- SOLVABLE: 完整 triple 序列 → 每步一个色 → 序列 = 可解性证明
- DEATH: 计划到 K 步 + 剩余 tile 死锁分配 (packDeathColors)

**Phase 2: computeBranches** — 纯结构分支计算
- 每步扫描所有颜色，计数 `|freed ∩ color| ≥ 3`
- `deathStartColor` 标记确保死锁色组不计入分支

### 验证结果

| 指标 | 值 |
|------|-----|
| SOLVABLE | 95.6% (131/137) |
| DEATH | 受限于静态约束 |
| div3 合规 | 99.3% |
| DFS-free | ✅ 生成路径中无 DFS |

### 已知限制

DEATH 模式使用 `≤2 freed/色 + deathStartColor` 标签过滤。标签过滤在 `computeBranches` 中生效，但实际游戏(DFS)忽略标签 → 死亡不可靠。详见下文 CSP 方案。

---

## CSP 死锁搜索 (dag-death.ts)

### 问题

V4 的 DEATH 通过 `deathStartColor` 标签过滤实现——标签告诉 `computeBranches` "忽略这些色"。但 DFS 不知道标签 → 找到绕过路径 → 死亡失败。

### 方案

**在现有地形依赖图中搜索死锁子图**——不是标记某些色为"死亡"，而是通过结构性约束确保死亡色的 tiles 真的无法形成 triple。

### 核心约束

```
每色 ≤2 freed tile
freed tile 不阻塞同色的 blocked tile（blocking-aware）
B ≥ F/2（数学充要条件，≤2 freed per 3-tile 色组）
```

### 架构

```
searchDeath(terrain)
  ├─ 对候选 K 值 (0, 1/4, 1/2, 3/4, last) 逐一尝试
  │   ├─ tryDeathAt(K):
  │   │   ├─ Plan: 创建 K 个正常triple (max-release策略)
  │   │   ├─ 分类: 剩余tile → F(will-be-freed) + B(will-stay-blocked)
  │   │   ├─ CSP: 将 F+B 分组为 3-tile色组, ≤2 freed/色, blocking-aware
  │   │   └─ 验证: DFS确认死亡 (5s timeout)
  │   └─ 精细化: K±1, K±2
  └─ 返回最佳 deathStep + 完整色彩分配
```

### 验证结果 (137 地形)

| 指标 | 值 |
|------|-----|
| CSP 发现率 | 100% (137/137) |
| DFS 确认率 | 17.5% (24/137) |
| 未确认(假阳性) | 82.5% |

CSP 找到了所有地形的死亡步。DFS 确认 1/6。未确认的是 CSP 约束仍不够强——跨色释放链未被捕获。这是 CSP 可继续加强的方向。

---

## 消除计划 (elimination-plan.ts)

地形层的依赖可行性分析。不依赖花色分配，纯依赖图上的 triple 序列计算。

**2507 牌局批量分析:**
- 消除计划 vs DFS 一致性: 93.6%
- 48.6% 步骤有 500+ 候选 triple（地形级自由度极高）
- 4.0% 步骤只有 1 个候选

---

## Terrain 协同生成 (terrain-gen.ts)

当输入包含地形设计自由度时，死亡是构造性保证的。

**死锁环**: N 个色组形成互锁环 → DFS 100% 确认不可解。
- 3色环(9t): DFS win=false ✅
- 20色环(60t): DFS win=false ✅
- 混合(chain+ring): DFS win=false ✅

**局限**: 需要生成新地形，不适用于现有地形。实验性模块。

---

## 技术选型

| 考量 | 选择 | 原因 |
|------|------|------|
| 语言 | TypeScript | C#→TS 类型映射自然；Node.js `deflateRawSync` = RFC 1951 裸 DEFLATE，与 .NET `DeflateStream` 完全一致 |
| 运行时 | Node.js (tsx) | 热执行，无编译步骤；内置 zlib 模块 |
| 压缩格式 | Raw DEFLATE (RFC 1951) | .NET DeflateStream 产出裸 DEFLATE 不含 zlib 头，必须用 `deflateRawSync` 才能互操作 |
| 校验 | CRC16/MODBUS | 工业标准，与 .NET ComputeCRC16 逐位一致 |
| GUI | 纯 HTML + 内联 JS | 零框架依赖，`onclick` 属性绑定避免 addEventListener 初始化时序问题 |

---

## 模块结构

```
src/
├── types.ts                  L0  公共类型定义
├── logger.ts                 L0  分级日志
├── crc16.ts                  L0  CRC16/MODBUS
├── dependency-graph.ts       L1  BFS 传递依赖闭包
├── triple-builder.ts         L1  C(n,3) 枚举 + cost 计算
├── reverse-gen.ts            L2  ★ V2 CostLadder 算法
├── generate-v4.ts            L2  ★ V4 DFS-Free 结构锁定
├── dag-death.ts              L2  ★ CSP 死锁搜索 (DAG-driven)
├── verify-death.ts           L2  轻量死亡验证 (一步 lookahead)
├── greedy-sim.ts             L2  纯贪心模拟验证
├── replay-serializer.ts      L3  ★ v4 ReplayCode 编解码
├── terrain-loader.ts         L4  JSON 地形加载
├── terrain-gen.ts            L4  实验性 terrain 协同生成
├── index.ts                  L5  公共 API
├── solver/                   L3  游戏引擎 + DFS/贪心/随机求解器 (离线验证)
├── analysis/                 L3  分析工具链
│   ├── elimination-plan.ts  消除计划器 (V4 依赖)
│   ├── enhanced-dag.ts      增强DAG分析
│   ├── board-dag.ts         色组DAG + Triple DAG
│   ├── batch-v2.ts          2507牌局批量分析
│   ├── deadlock-hunter.ts   死锁模式检测
│   ├── aggregate.ts         聚合统计
│   └── rule-check.ts        结构规则验证
└── ...

cli/generate.ts               L6  CLI 工具
gui/server.ts                 L6  HTTP 服务器 (V2 + V4 API)
gui/index.html                L6  Web 前端
gui/analysis.html             L6  Triple 关系分析器

test/
├── verify-v4.ts               V4 137地形批量验证
├── search-death-all.ts        CSP 137地形批量搜索
├── dfs-verify-death.ts        DFS深度死亡验证
├── debug-csp.ts               CSP 直接调试
├── debug-death-root.ts        死亡根因分析
├── debug-100002.ts            单地形调试
└── quick-search.ts            快速CSP搜索
```

## 依赖图（单向无环）

```
                    types.ts
                   ↗    ↖
      dependency-graph   triple-builder
             ↗                ↗
         reverse-gen ←── greedy-sim
             ↓
      replay-serializer ←── crc16
             ↓
          index.ts ←── terrain-loader ←── logger
             ↓
      ┌──────┴──────┐
     CLI          GUI Server
```

**层级含义**：

| 层 | 模块 | 特性 |
|----|------|------|
| L0 | types, logger, crc16 | 纯数据/纯函数，无业务含义，可独立单测 |
| L1 | dependency-graph, triple-builder | 图算法，组合 L0，独立可测 |
| L2 | reverse-gen, greedy-sim | 业务算法，组合 L1 |
| L3 | replay-serializer | 输出层，依赖 L2 产出 + crc16 |
| L4 | terrain-loader | 输入层，文件 IO |
| L5 | index | 门面，组合 L2+L3+L4，唯一的公共 API 面 |
| L6 | CLI, GUI | 用户界面，只依赖 L5 |

---

## 数据流

```
JSON 文件 → terrain-loader → TerrainTile[]
                                  │
                    ┌─────────────┼─────────────┐
                    ▼             ▼             ▼
              getAllTiles()  computeAllDeps()  getConstTiles()
                    │             │
                    ▼             ▼
              freeTiles      Map<id, Set<dep>>
                    │             │
                    └──────┬──────┘
                           ▼
                    buildTriples() → Triple[]
                           │
                           ▼
                    runReverseGen()
                      │         │
                ┌─────┼─────┐   │
                ▼     ▼     ▼   ▼
          assignments costLog branchLog
                │
                ▼
          generateBoard()
           │          │
           ▼          ▼
    elementValues  orderedTiles
           │          │
           └────┬─────┘
                ▼
        generateReplayCode()
                │
                ▼
          ReplayCode (Base64)
```

每个箭头的输出只依赖输入，不依赖全局状态。管道式数据流使得每一段都可以独立测试和替换。

---

## 核心概念

### Tile（牌）
地形中的最小单元。关键属性：
- `id`: 唯一标识
- `layer`: 所在层级，0 = 最底层
- `dependencies`: 直接压在下面的牌的 ID 列表
- `isConst`: 是否固定花色（算法不分配）

### Triple（三牌组合）
从自由牌中任选 3 张组成的合法消除组合。关键属性：
- `tileIds`: 排序后的三张牌 ID
- `depSet`: 三张牌传递依赖闭包的并集 + 牌自身。**定义了消除这三张牌需要"释放"多少依赖**

### Cost（动态成本）
`cost = |depSet \ collectedIds|` — depSet 中尚未被收集的牌数量。

每一步选 triple 并消除后，其 depSet 中的所有牌被标记为"已收集"(collectedIds)。后续 triple 的 cost 会动态降低，因为它们依赖的牌可能已经被前几步释放了。

### Cost 数组（难度曲线）
每一步的目标 cost。cost 越大 = 这一步需要消除的依赖越多 = 玩家越难。

### 黑名单（BanSet）
cost ≤ 选中 triple 的候选全部封杀。防止"贪心矛盾"：如果允许选低 cost triple，后续就无法达到高 cost 目标。

### 池化（Pooling）
cost ≤ 3 且连续 ≥ 2 步时，合并为"池"——在同一快照下一次性选出互不占牌的多个 triple。消除"同伴互杀"问题。

### 抢救（Rescue）
候选耗光时，从黑名单尾部（最近被封的）向前找第一个可用的 triple。遵循时间局部性原则，最小化对前期的影响。

---

## ReplayCode v4 格式

```
┌─────────┬────┬──────────────┬───────────┬──────────────┬──────────┬──────────┬───────┐
│ version │ N  │ elementCount │ levelHash │ instanceArray│ dockCount│ dockEntries│ CRC16 │
│  1B(=4) │1B  │     1B       │  8B LE    │   N × 1B    │   1B     │ cnt × 2B  │ 2B LE │
└─────────┴────┴──────────────┴───────────┴──────────────┴──────────┴──────────┴───────┘
```

每 tile 1 字节：bit[7:6] = 状态(TileState)，bit[5:0] = 花色索引(0-63)。

管线：`二进制 → Raw Deflate(RFC 1951) → Base64`

---

## 测试策略

29 个测试分为三组：

**算法 (10 个)**：正常模式、约束验证、降级处理、边界条件、确定性

**序列化 (17 个)**：CRC 标准向量、Raw DEFLATE 格式、编解码往返、格式检测、Hash 解析

**往返 (2 个)**：编解码一致性、64 花色边界

---

## 与 Unity 的已知差异

C# 的 `List.Sort` 是不稳定排序，JavaScript 的 `Array.sort` 是稳定排序。同等 cost 的 triple 在排序后的相对顺序不同，导致算法在跨平台时可能选择不同的 triple。算法逻辑完全一致，差异仅来自排序实现细节。同一运行时内结果完全确定。

---

## 开发命令

```bash
npm install           # 安装依赖
npm test              # 全部 29 个测试
npm run test:algo     # 算法测试
npm run test:serializer  # 序列化测试
npm run gui           # 启动 Web GUI (http://localhost:3000)
npx tsx cli/generate.ts --help  # CLI 帮助
```
