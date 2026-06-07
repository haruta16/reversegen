# ReverseGen · 架构说明

## 项目定位

从 Unity TileMatch 项目中剥离的独立牌局生成工具。核心命题：

> 给定地形（牌的空间布局 + 叠压依赖关系），为每张牌赋予花色，使得生成的牌局在**可解性、死亡点位置、决策分支数**等维度上可以被精确、确定性地控制。

**与 Unity 零依赖**，纯 TypeScript，CLI / Web GUI / API 三种方式。

当前唯一生成算法：**ReverseGen CostLadder**。未来可扩展多算法。

---

## 项目结构

```
src/                          # 核心库
├── types.ts                  # 公共类型定义
├── logger.ts                 # 分级日志
├── crc16.ts                  # CRC16/MODBUS
├── dependency-graph.ts       # BFS 传递依赖闭包
├── triple-builder.ts         # C(n,3) 枚举 + cost 计算
├── reverse-gen.ts            # ★ CostLadder 生成算法
├── greedy-sim.ts             # 纯贪心模拟验证
├── replay-serializer.ts      # ReplayCode 编解码
├── terrain-loader.ts         # 地形加载
├── cost-generator.ts         # Cost 数组随机生成器
├── index.ts                  # 公共 API
└── solver/                   # 游戏引擎 + 求解器
    ├── offline-game.ts       # 离线游戏状态机
    ├── solver-dfs.ts         # DFS 求解器
    ├── solver-greedy.ts      # 贪心求解器
    ├── solver-random.ts      # 随机批量求解器
    └── types.ts              # 求解器类型

tools/                        # 分析工具
├── dag/                      # DAG 分析
│   ├── board-dag.ts          # 色组 DAG + Triple DAG 构建
│   ├── enhanced-dag.ts       # 增强 DAG 特征提取
│   ├── triple-analyzer.ts    # Triple 关系分析器
│   ├── verify-death.ts       # 轻量死亡验证
│   └── deadlock-hunter.ts    # 死锁模式检测 (P1-P4)
└── planning/                 # 消除规划
    ├── elimination-plan.ts   # 纯逻辑消除计划
    ├── deep-plan-single.ts   # 单关深度分析
    └── deep-analyze.ts       # 深度分析引擎

cli/generate.ts               # CLI 工具
gui/                          # Web GUI
├── server.ts                 # HTTP 服务器
├── index.html                # 牌局生成器页面
└── analysis.html             # DAG 分析页面 (4 种图)
test/
├── unit/                     # 单元测试 (17 + 10 测例)
├── integration/              # 集成测试
└── fixtures/                 # 测试数据
```

### 依赖方向

```
tools/ ──→ src/
gui/   ──→ src/, tools/
cli/   ──→ src/
test/  ──→ src/
```

`src/` 不依赖 `tools/` 或 `gui/`。

---

## 核心算法：ReverseGen CostLadder

### 输入/输出

```
输入: 地形(tiles) + Cost目标数组 + 花色数量
输出: 每张牌的花色分配 → ReplayCode
```

### 流程

```
① 建依赖图     BFS 展开每张牌的传递依赖闭包
② 枚举 Triple  C(n,3) 所有三牌组合, 计算 depSet
③ 贪心选 Triple 每步选 cost ≥ target 的第一个候选
    ├─ 黑名单封杀  低 cost 候选全封, 保证难度曲线
    ├─ 池化        连续同 cost 步骤在同一快照下互选
    └─ 抢救        候选耗光时从黑名单尾部找回
④ 花色分配    选违规最少 + 负载均衡的花色
⑤ 模拟验证    贪心求解器验证牌局可玩
```

### 核心机制

| 机制 | 作用 |
|------|------|
| Cost = \|depSet \ collectedIds\| | 动态成本，模拟真实消除的"越消越容易" |
| 黑名单 | 防止贪心退化为每步选最便宜的 |
| r-chain 约束 (Σcᵢ = 3N) | 数学合法性保证 |

---

## ReplayCode 格式

```
┌─────────┬────┬──────────────┬───────────┬──────────────┬──────────┬──────────┬───────┐
│ version │ N  │ elementCount │ levelHash │ instanceArray│ dockCount│ dockEntries│ CRC16 │
│  1B(=4) │1B  │     1B       │  8B LE    │   N × 1B    │   1B     │ cnt × 2B  │ 2B LE │
└─────────┴────┴──────────────┴───────────┴──────────────┴──────────┴──────────┴───────┘

每 tile 1 字节: bit[7:6] = TileState, bit[5:0] = 花色索引 (0-63)
管线: 二进制 → Raw Deflate (RFC 1951) → Base64
```

---

## 分析页面 — 四种 DAG 图

分析页面 (`analysis.html`) 提供四种图来分析地形和牌局结构。所有图都基于**地形依赖图**，区别在于分析粒度和是否需要花色数据。

### 统一数据源：replayCode

加载 ReplayCode 后，所有依赖花色的分析（色组 DAG、Triple DAG、同花色偏序）都从 replayCode 的 `levelHash` 自动解析对应地形，不受输入框中的地形 ID 影响。replayCode 是唯一真相源。

### 四种图的对比

| | 偏序 DAG | 力导向 | 色组 DAG | Triple DAG |
|---|---|---|---|---|
| **数据** | 地形级 triple 偏序关系 | 同左 | 牌局色组阻塞关系 | 牌局同色 triple 依赖 |
| **输入** | 只需地形 | 同左 | 地形 + ReplayCode | 地形 + ReplayCode |
| **节点** | 一个 triple（任意 3 牌组合） | 同左 | 一个花色组 | 一个同色 triple |
| **边** | B ≺ A: B 的 depSet ⊆ A 的 depSet | 同左 | A → B: A 色的牌压在 B 色的牌上 | A → B: A 必须在 B 前消除 |
| **画法** | Sugiyama 分层 (上→下) | D3 力导向 (物理模拟) | 分层圆图 | 分层点图 |
| **用途** | 看清 triple 之间的必然先后顺序 | 自由探索 triple 关系网 | 看清花色之间的宏观阻塞结构 | 看清每一步有哪些可消的 triple |

### 1. 偏序 DAG（Sugiyama 分层图）

**是什么**：从纯地形枚举所有可能的 3 牌组合（C(n,3)），分析 triple 之间的偏序关系。

**偏序关系 B ≺ A**：当 B 的 depSet 是 A 的 depSet 的子集时，B 绝对应该在 A 之前消除（消 B 对消 A 的帮助最大）。

**节点** = 一个 triple，圆圈大小 = 后继 triple 数量（影响面多大）。

**分层** = 按 depSet 大小分位或依赖深度。

**适用场景**：空地形分析。不需要 ReplayCode，看清地形的自由度和瓶颈在哪。

### 2. 力导向图

**和偏序 DAG 是同一份数据**，只是用 D3 力导向布局来画。节点可拖拽，适合自由探索 triple 之间的关联网络。

### 3. 色组 DAG

**是什么**：加载 ReplayCode 后，把同花色的牌归为一组，分析色组之间的阻塞关系。

**节点** = 一种花色，圆圈大小 = 该花色有多少张牌。

**边 A → B** = A 色的某些牌物理上压在 B 色的某些牌上面 → 必须先消 A 才能露出 B。

**分层** = 拓扑层（入度为 0 的色组在顶层）。

**适用场景**：看清牌局的宏观结构——哪些花色是入口、哪些是瓶颈、依赖链有多深。如果一个花色出现在很多层的阻塞链中，它就是关键色。

### 4. Triple DAG（同色 Board DAG）

**是什么**：加载 ReplayCode 后，在每个花色内部枚举所有可能的 triple（C(k,3)），分析同色 triple 之间的依赖关系。

**节点** = 一个同色 triple，点大小 = depSet 大小。

**边 A → B** = A 的 depSet ⊆ B 的 depSet → A 必须在 B 前消除。

**分层** = 按最长前驱链的拓扑层。

**适用场景**：深入分析具体牌局的消除路径——每一步有哪些候选 triple、它们的先后顺序。

### 工作流

```
空地形分析:
  加载地形 → 「偏序 DAG」「力导向」→ 看 triple 关系和自由度

牌局分析:
  粘贴 ReplayCode → 加载牌局 →
    「偏序 DAG」「力导向」→ 同花色 triple 偏序
    「色组 DAG」         → 花色间阻塞结构
    「Triple DAG」       → 同色 triple 消除顺序
```

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

---

## 核心概念

### Tile（牌）
- `id`: 唯一标识
- `layer`: 所在层级（0 = 最底层）
- `dependencies`: 直接压在下面的牌 ID 列表
- `isConst`: 是否固定花色

### Triple（三牌组合）
从自由牌中任选 3 张。`depSet` = 三张牌 + 传递依赖闭包。

### Cost（动态成本）
`cost = |depSet \ collectedIds|` — 消除这个 triple 需要连带释放多少张牌。

### Cost 数组（难度曲线）
每一步的目标 cost。cost 越大 = 这一步越难。

### 黑名单
cost ≤ 选中 triple 的候选全部封杀，防止贪心退化为每步选最便宜的。

### 池化
连续同 cost 步骤在同一快照下互选，避免"同伴互杀"。

### 抢救
候选耗光时从黑名单尾部找回，遵循时间局部性原则。

---

## 技术选型

| 考量 | 选择 | 原因 |
|------|------|------|
| 语言 | TypeScript | C#→TS 类型映射自然 |
| 运行时 | Node.js (tsx) | 热执行，无编译步骤 |
| 压缩 | Raw DEFLATE (RFC 1951) | 与 .NET DeflateStream 一致 |
| 校验 | CRC16/MODBUS | 工业标准 |
| GUI | 纯 HTML + D3.js | 零框架依赖 |

---

## 开发命令

```bash
npm install           # 安装依赖
npm test              # 全部 29 个测试
npm run gui           # 启动 Web GUI (http://localhost:3000)
npx tsx cli/generate.ts --help  # CLI 帮助
```
