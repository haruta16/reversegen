# 机制对齐契约（Mechanics Alignment）

本文档是 reversegen 与 Unity TileMatch 客户端在**特殊机制（挂件）**上的对齐契约：
信息来源、确定性随机约定、各机制接入状态，以及已知风险与决策点。
任何机制相关的实现或修改都必须以本文档为准，并同步更新。

## 一、机制信息来源与一关组合表示

**两个来源（与 Unity 同构）：**

1. **地形 tile 里写着的**：关卡 JSON 每张 tile 的 `extraEnum` / `extraParam`
   （Unity `TileData` 同名字段）。reversegen 由 `terrain-loader` 解析，
   缺省视为 Empty(0)；`countTerrainExtras` 汇总数量。
2. **外部注入**：`extraEnum → 数量` 字典（Unity `TileMatchBattle.extraConfig`，
   来自 `roomLvData.ExtraConfig` 或 GM 注入 `gm_TM_extraConfig`）。
   reversegen 以 `parseMechanicCounts("31:3,39:2")` 解析，GUI"特殊机制"输入框注入。

**一关 = 现有 ReplayCode + 机制枚举组合**（ReplayCode 格式不变，机制信息并列传递）：
`formatBoardSpec` 组合为 `code@31:3,39:2`（无机制时就是 code 本身）。

**计数语义差异（重要）：** 大部分挂件的 extraConfig 数值是"挂该机制的 tile 数"；
但**泡泡(39) 的数值是行为参数**——每轮收集数（0 = 随机 2-3），不是 tile 数。
`validateMechanicCounts` 按 `countMeaning` 区分二者做一致性校验。

## 二、确定性随机契约

### 2.1 目标
同一棋盘状态 + 同一动作序列 → 两侧（Unity 客户端 / reversegen 跑关）产生**逐位相同**
的随机序列。这是重放验证、批量模拟与 golden 测试的前提。

### 2.2 种子公式（共享战场派生种子）

```
seed = levelId * 397 ^ levelResID
seed = seed  * 397 ^ Dock 当前牌数
seed = seed  * 397 ^ Desk 当前牌数
seed = seed  * 397 ^ 已应用步骤数
seed = seed  * 397 ^ 盐值
```

- 全部在 unchecked int32 语义下运算（C# `unchecked` 块 / JS `| 0` 截断）
- 397 是 Unity 既有惯例（`MagicBottleExtra.CreateShuffleRandomSeed` 同款混合常数）
- 已应用步骤数：Unity = `StepMgr.Steps.Count`；reversegen = `actionCount`（点击/复活/机制步骤）
- 两侧实现：Unity `ExtraDeterministicRandom.CreateSeed(battle, salt)`；
  reversegen `extraActionSeed(game, salt)`

### 2.3 盐值表（同一局面下区分不同调用点）

| 常量 | 值 | 用途 |
|------|----|------|
| `DANDELION_TARGETS` | 36 | 蒲公英扩散目标选择 |
| `BUBBLE_COLLECT_COUNT` | 39 | 泡泡随机收集数（再叠加轮次数） |
| `GIFTBOX_EFFECT` | 3700 | 礼盒效果加权滚动 |
| `GIFTBOX_APPLY_UNKNOWN` | 3701 | 礼盒施加问号的随机选牌 |
| `GIFTBOX_APPLY_FLIP` | 3702 | 礼盒施加翻转的随机选牌 |
| `GIFTBOX_APPLY_MAGIC_BOTTLE` | 3703 | 礼盒转化魔药的随机组数 |

两侧常量同名同值（Unity `ExtraDeterministicRandom.cs` 注释 / reversegen `MECHANIC_SEED_SALTS`）。

### 2.4 洗牌专用种子（棋盘状态派生）

`ShuffleAlgo` 位于独立库，拿不到 battle 上下文，因此种子只从 Desk/Dock 状态派生：

```
seed = 0x5A5A5A5A
for tile in Desk（按 ID 升序）:  seed = seed*397 ^ tile.ID; seed = seed*397 ^ 花色
for tile in Dock（按 ID 升序）:  同上
```

按 ID 升序是**对齐契约的一部分**：两侧内部列表顺序可能不同，但 ID 排序保证种子一致。
两侧实现：Unity `ShuffleAlgo.CreateShuffleSeed` / reversegen `shuffleBoardSeed`。

### 2.5 随机数发生器
- 两侧统一使用 **.NET System.Random 语义**：Unity 直接用 `System.Random(seed)`；
  reversegen 用逐位移植的 `DotNetRandom`（56 槽减法随机，`src/tile-explorer/random.ts`）
- 语义等价：`Next(min,max)` ≡ `Random.Range(min,max)` int 版；`NextDouble()` ≡ `Random.value`
- **消费顺序必须一致**：同一函数内按 Unity 原代码的调用顺序依次消费随机流
  （例如礼盒选牌：先 GetRandomCount 消费 1 次，再对每个候选取随机键）
- `OrderBy(Random.value)` 的语义 = 随机键 + **稳定排序**（LINQ 与 JS Array.sort 均为稳定排序）

### 2.6 时间/动画 → 逻辑时钟契约
- 泡泡 0.5s 冷却 = 1 次动作 tick；魔法清除后"绕过冷却直接指派" = 冷却置 0
- 动画等待（魔药/礼盒等 async 前摇）不影响逻辑结果：动画期间棋盘状态不变，
  立即计算与延迟计算等价

### 2.7 已知边界（记录在案）
- **Undo 不在此契约内**：Unity 撤回（StepMgr.RemoveStep）会改变 Steps.Count，
  导致后续种子与无撤回时间线不同。跑关按固定动作序列（无 undo）重放，不受影响。
  若未来要求"含 undo 逐位对齐"，需把种子中的步骤数项替换为棋盘状态派生进度。
- 泡泡种子叠加"轮次数"项，使其各轮收集数不同（Unity 原全局随机天然不同）。

## 三、各机制对齐状态表

| 枚举 | 名称 | 固定花色 | Unity 行为 | reversegen 状态 |
|------|------|---------|-----------|----------------|
| 0/-1 | Empty/None | — | 无 | ✅ 无挂件 |
| 1 | 冰封 | — | 客户端无行为实现（仅标记） | ✅ inert（如实标注） |
| 2/202/203 | 问号 | — | 收集揭示 isDone；UnknownMark 影响泡泡排序 | ✅ reveal |
| 3 | 锁链 | — | 客户端无行为实现 | ✅ inert |
| 4 | 黄金 | 1101 | 每步衰减（无跳过），收集事件 | ✅ decay |
| 5 | 金币 | 1201 | 纯固定花色标记 | ✅ fixed-marker |
| 6 | 倒计时日历 | 1102 | 每步衰减（跳过魔药步） | ✅ decay + decaySkip |
| 7/207 | 翻转 | — | 可见/收集 isDone | ✅ reveal |
| 8 | 复活节 | 1103 | 每步衰减（跳过魔药步） | ✅ decay + decaySkip |
| 31 | 魔药 | 1301 | 三消交错清除 6×3，白名单索敌 | ✅ magic-bottle（golden 对齐） |
| 32-35/40 | 兑换/怪物/岩石/翻转罐/小精灵 | — | 客户端无行为实现 | ✅ inert |
| 36 | 蒲公英 | 1402 | 三消扩散转化，白名单仅 None/Empty | ✅ dandelion（含种子对齐） |
| 37 | 礼盒 | 1601 | 三消加权 8 效果 | ✅ giftbox（全部效果 + 种子对齐） |
| 38 | 订单 | 外部提供 | 收集即 consumed | ⚠️ 行为已接入；花色来源见第四节 |
| 39 | 泡泡 | — | 轮次指派/吸取/Dock 魔法 | ✅ bubble（含 Unity 种子修复） |
| 51-53 | 大型地形 | — | BoardSpecial 棋盘级注入 | ❌ 未接入，见第四节 |

## 四、已知风险与决策点

### 4.1 订单(38)的花色来源
Unity 订单 tile 的花色由外部订单系统提供：`orderExtraPlay.GetOrderExraElementValue()`。
reversegen 没有该系统，**约定**：调用方以地形 `ConstElementValue` 或外部注入方式提供订单花色。
行为语义（收集即 consumed）已对齐；数据源是外部契约。

### 4.2 大型地形注入(51-53)未接入
Unity 侧它是棋盘级结构而非 tile 挂件：`BoardSpecialRuntimeSystem` 覆盖 2x2/3x3 多个 tile 位，
装载期注入（独立随机种子），被覆盖 tile 变为 `IsBoardSpecialObstacle` 且不参与花色分配。
reversegen 缺三层能力：
1. 棋盘模型：`BoardSpecialStructure`（位置/足迹/依赖）
2. `OfflineGame`：障碍语义 + 装载期注入（含独立派生种子对齐）
3. 生成侧：注入点选择 + 注入后可解性校验
目前注册表如实标注 inert，`extraParam` footprint 已解析保留，接入时数据现成。

### 4.3 其它记录
- 泡泡/蒲公英/礼盒/洗牌的确定性随机修复已提交 Unity 侧（`_InnerCode` 与 `_InnerTileMatchAlgo` 仓库），
  见提交信息"…（與 ReverseGen 跑關對齊）"
- 新增 `ExtraDeterministicRandom.cs` 未带 `.meta`：Unity 下次打开工程自动生成 GUID，不影响功能
- 帧级表现（动画/音效/TA 埋点）全部不在 reversegen 建模范围内，只对齐逻辑
