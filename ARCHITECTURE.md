# ReverseGen · 架构说明

## 项目定位

从 Unity TileMatch 项目剥离的独立牌局生成工具：给定地形（牌的空间布局 + 叠压依赖），
生成花色分配与机制（挂件）配置，输出可直接复制的 ReplayCode。
纯 TypeScript（零 Unity 依赖），CLI / Web GUI / API 三种方式。

核心命题有二：

1. **生成**：可解性、死亡点、决策分支等维度可被精确控制（ReverseGen / LayerClosure / TileExplorer / ZenMatch / strategy-v2）。
2. **复刻**：同一地形 + 同一 ReplayCode + 同一机制配置，在 reversegen 跑关与 Unity 客户端
   中产生**逐位一致**的机制行为（种子、索敌、消除序列）——见
   [docs/mechanics-alignment.md](./docs/mechanics-alignment.md)。

---

## 架构分层与依赖方向

```
gui/     ──→ src/, tools/       Web 界面（server.ts + 按域 API 模块 + HTML 页面）
cli/     ──→ src/               命令行工具
tools/   ──→ src/               分析/批量/统计脚本
rust/    strategy-sim           玩家模拟的 Rust 高性能端口（PROTOCOL.md 对齐协议）
src/     （不依赖以上任何层）
```

`src/` 内部按域组织，域间依赖单向：

```
strategy  ──→ solver ──→ mechanics
   │            │            │
   └────────────┴──→ types / constants / replay-serializer / terrain-loader
```

---

## 核心域导览

### 1. mechanics/ — 机制规则引擎（与 Unity 逐位对齐）

| 模块 | 职责 |
|------|------|
| `registry.ts` | 挂件注册表：25 个 ssExtraEnum 数值、行为分类、白名单、常量、种子盐值表、礼盒权重表 |
| `spec.ts` | 一关表示 `ReplayCode@31:3,39:2`（机制信息并列、不侵入 ReplayCode 格式）；地形挂件汇总与配置拆分 |
| `seed.ts` | 派生种子统一实现：`mul397`（unchecked int32）、共享战场种子（levelResID^dock^desk^步数^盐）、魔药洗牌种子、洗牌种子 |
| `assigner.ts` | 装载期机制分配器（对齐 TileExtraAssigner）：Xorshift128+ 随机、order 表、白名单互斥、驱逐/恢复、Tower 判定 |
| `engine.ts` | `MechanicEngine`：三消行为分发（MATCH_BEHAVIORS）、泡泡状态机（tick/指派/吸取/Dock 定向魔法） |
| `extras.ts` | 其余挂件行为：衰减/揭示/订单钩子、蒲公英扩散、礼盒效果、魔法棒、洗牌 |
| `step-appliers.ts` | 机制步骤应用策略表（STEP_APPLIERS）+ 衰减触发面（DECAY_STEP_TYPES） |

**扩展契约**：新增机制 = registry 登记一行 + 行为函数登记一行，状态机主体零改动。

**步骤计数契约**（对齐 Unity StepMgr）：`applyMechanicStep` 中 **Apply 先于 AppendStep**——
应用器执行时 `actionCount` 不含本步；链式礼盒取 `actionCount+1` 恰为 Append 后计数；
衰减 OnStep 仅随 Unity 会 AppendStep 的四类步骤（魔药清除/魔法棒/泡泡吸取/洗牌）触发，
且使用本步开始前的旧可点击快照；状态刷新统一在本步末尾。

### 2. solver/ — 游戏引擎与求解器

- `offline-game.ts`：`OfflineGame` 状态机——collect → Dock 归组 → 三消 → 重算依赖/可见性；
  机制操作面（moveToDock/eliminate/resolveDockMatch/addDockSlot）供步骤应用器复用；
  `clone()` 完整保留 `actionCount`/`dockSlotBonus`/机制状态；
  `buildStateKey()` 捕获 Desk 集合、**Dock 实际顺序与牌身份/挂件状态**、槽位加成、机制指纹，
  并在存在蒲公英/礼盒时纳入 `actionCount`（派生种子读步数）——保证 DFS 记忆化不剪错枝。
- `solver-player.ts`：统一玩家引擎（MatchGroup 分析/成本/可见性/选牌），各画像变体
  （mistake/risky/shortest/costcap）只写策略增量。
- `solver-dfs.ts` / `solver-greedy.ts` / `solver-random.ts` / `solver-death-checkpoint.ts`：求解与死亡点度量。
  注意 `revive()` 是求解域抽象（Unity 复活 = Undo 回退 + 洗牌，不在重放契约内）。

### 3. strategy/ — 批量生产策略 v2

`definition`（v2 schema 校验）→ `generator`（候选生成）→ `pipeline`（阶段化：生成→过滤→模拟→评级）
→ `simulation`（胜率模拟协议）→ `web-adapter`（GUI/HTTP 桥接）。
策略定义是数据（`config/strategy-v2.schema.json` 校验），不是代码。

### 4. 生成器域（历史算法，按 strategy-v2 编排调用）

`reverse-gen.ts`（CostLadder）、`layer-closure/`（配额/矩阵/贴色）、`tile-explorer/`、
`zen-match/`。注意：CostLadder 的"贪心路径 = 最优路径"前提已被 DFS 反证，
可解性与真实难度统一用 `src/solver/` 验证。

### 5. 序列化与数据

- `replay-serializer.ts`：ReplayCode v4（version/N/elementCount/levelHash uint64 LE/instanceArray/
  dockEntries/CRC16-MODBUS，Raw DEFLATE + Base64）。规范序 = 层数组序 + 层内数组序（不做 ID 排序）。
- `terrain-loader.ts`：Unity level JSON → 最小地形模型（含 extraEnum/extraParam、levelResId）。
- `board-special/`：大型地形（51-53）——放置计划（`placement.ts`：Build/BuildPizza/BuildTicket 移植）、
  装载注入（`inject.ts`：模式/种子/依赖/覆盖）与运行期语义（覆盖遮挡 + 依赖离桌自动移除）。
- `verification/cross-side-trace.ts`：跨侧 golden 追踪（录制 + 逐帧比对；Unity 导出器与操作手册见
  `docs/cross-side-golden.md`）。
- `batch-generator.ts`：批量生产主引擎；`batch-generator-new.ts` 为实验迁移版（仅 test-new-* 工具引用，收敛中）。

---

## 确定性随机体系（三套，各对齐各的）

| 随机源 | 实现 | 用途 | Unity 对齐对象 |
|--------|------|------|----------------|
| `DotNetRandom` | `tile-explorer/random.ts`（56 槽减法，逐位移植） | 机制引擎、洗牌、礼盒 | `System.Random` |
| `AssignerRandom` | Xorshift128+ / SplitMix64 | 装载期挂件分配 | `DeterministicRandom.cs` |
| 派生种子公式 | `seed.ts`（FNV-1a + `*397 ^` 混合链） | 战场派生种子 / 分配种子 | `ExtraDeterministicRandom` / `ReplaySerializer.DeriveAssignSeed` |

---

## 装载管线（createGame，顺序对齐 Unity FixedReplayCodeAlgorithm）

```
replayCode + 地形 + extraConfig
  → 解码 elementValues（const 钉回固定花色）
  → splitMechanicConfig（泡泡 39 / 大型地形 51-53 拆出）
  → assignTileExtras（分配请求子集，FNV-1a 派生种子，Tower 排除初始 Dock 牌）
  → initialDock / eliminatedTileIds 装载
  → OfflineGame（MechanicEngine 接收泡泡配置与礼盒开关）
```

---

## ReplayCode 格式（v4）

```
┌─────────┬────┬──────────────┬───────────┬──────────────┬──────────┬──────────┬───────┐
│ version │ N  │ elementCount │ levelHash │ instanceArray│ dockCount│ dockEntries│ CRC16 │
│  1B(=4) │1B  │     1B       │  8B LE    │   N × 1B    │   1B     │ cnt × 2B  │ 2B LE │
└─────────┴────┴──────────────┴───────────┴──────────────┴──────────┴──────────┴───────┘
每 tile 1 字节: bit[7:6] = TileState, bit[5:0] = 归一化花色索引 (0-63)
管线: 二进制 → Raw Deflate (RFC 1951) → Base64
```

---

## 测试策略

- `test/unit/`：逐域单测，机制域使用**逐位 golden**（同种子同输入 → 同输出）；
- `test/integration/`：端到端 smoke；
- 对齐权威契约：[docs/mechanics-alignment.md](./docs/mechanics-alignment.md)。

---

## 已知边界（摘要，详见对齐契约 §2.7/§四）

- Undo / 复活（Revive）不在重放契约内；
- .NET `List.Sort`（不稳定）vs JS `Array.sort`（稳定）在同 key 精确并列时可能产生不同顺序（极低概率）；
- 帧级表现（动画/音效/TA 埋点）不建模，只对齐逻辑。

---

## 开发命令

```bash
npm test                        # 全部 143 个测试
npx tsc --noEmit                # 类型检查
npx tsx cli/generate.ts --help  # CLI 帮助
npm run gui                     # Web GUI
```
