# ReverseGen · 架构说明

## 项目定位

从 Unity TileMatch 项目中剥离的独立牌局生成工具。

**两代算法**:
- **V2 (ReverseGen)**: CostLadder 算法 — 输入「地形 + Cost 数组 + 花色数」，输出「完整牌局花色分配 + ReplayCode」。通过贪心反向生成控制 cost 链。
- **V4 (DFS-Free 结构锁定)**: 新一代算法 — 输入「地形 + 可解/死亡步」，输出「DFS-free 可验证的花色分配」。通过消除计划 + 死锁色组实现精确控制。

**与 Unity 零依赖**，纯 TypeScript，可命令行、浏览器、代码 API 三种方式使用。

---

## V4 算法原理

### 核心洞察

```
分支数 = |{色C : |freed ∩ tiles(C)| ≥ 3}|

这是可直接计算的结构属性，不需要 DFS 探索状态空间。
```

**牌局的每一步有多少个可选分支**，等于「拥有 ≥3 张可点 tile 的花色数量」。这个数量可以从 `tile → 颜色` 的分配中纯结构地计算出来——不需要搜索、不需要模拟玩家的选择、不需要状态空间探索。

### 构造性证明

| 命题 | 构造方式 | 证明 |
|------|---------|------|
| 牌局可解 | 消除计划构建完整 triple 序列 → 每步一个色 | 序列本身 = 可解性证明 |
| 第 K 步死亡 | 计划到 K 步 + 剩余 tile ≤2 freed/色 | branch=0 可直接计算 |
| 每步 N 个分支 | 通过花色分配控制每色 freed tile 数 | 直接计数 |

### 两阶段架构

**Phase 1: assignColors**
- SOLVABLE: 消除计划驱动。逐轮从 freed tile 中选 3 张不互锁的 tile → 同色 → 消除 → 释放下一批。序列完整 = 可解。
- DEATH: 消除计划到 deathStep + 剩余 tile 死锁分配。`packDeathColors` 确保每色 ≤2 "will-be-freed" tile → branch 归零。

**Phase 2: computeBranches**
- 纯结构计算：每步扫描所有颜色，计数 `|freed ∩ color| ≥ 3` 的颜色数
- `deathStartColor` 标记确保死锁色组永不被计数为可用
- 确定性策略（最小颜色号优先）→ 不产生任何不确定性

### 批量验证结果（137 地形）

| 指标 | 通过率 |
|------|--------|
| 总测试 (822) | 97.6% |
| SOLVABLE | 95.6% |
| DEATH | 98.0% |
| div3 合规 | 99.3% |

全部 DFS-free，纯结构计算。

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
├── greedy-sim.ts             L2  纯贪心模拟验证
├── replay-serializer.ts      L3  ★ v4 ReplayCode 编解码
├── terrain-loader.ts         L4  JSON 地形加载
├── index.ts                  L5  公共 API
├── solver/                   L3  游戏引擎 + DFS/贪心/随机求解器 (离线验证)
├── analysis/                 L3  分析工具链
│   ├── elimination-plan.ts  消除计划器 (V4 依赖)
│   ├── enhanced-dag.ts      增强DAG分析
│   ├── board-dag.ts         色组DAG + Triple DAG
│   ├── batch-v2.ts          2507牌局批量分析
│   └── ...
└── ...

cli/generate.ts               L6  CLI 工具
gui/server.ts                 L6  HTTP 服务器
gui/index.html                L6  Web 前端

test/
├── verify-v4.ts               V4 全地形批量验证 (137 terrain)
└── ...
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
