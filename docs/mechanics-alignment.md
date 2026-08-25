# 机制对齐契约（Mechanics Alignment）

本文档是 reversegen 与 Unity TileMatch 客户端在**特殊机制（挂件）**上的对齐契约：
信息来源、确定性随机约定、各机制接入状态，以及已知风险与决策点。
任何机制相关的实现或修改都必须以本文档为准，并同步更新。

> **新机制移植 / 对齐审计的执行规范见
> [`docs/mechanics-porting-playbook.md`](mechanics-porting-playbook.md)**——
> 五条铁律、移植检查清单（A-G）、验证规范与反模式红榜，全部来自泡泡状态机事故的教训。
> 动手写代码前先读它。

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

**计数语义（对齐 Unity）：** extraConfig 的数值是**分配请求**——装载时由机制分配器
（`TileExtraAssigner` 移植，见第五节）按策略/白名单把挂件落到非 const 牌上，不是校验对象：
- tile-count 类机制：数值 = 请求分配的挂件数（固定花色挂件自动向下取 3 的倍数）
- **泡泡(39)**：数值是行为参数——每轮收集数（0 = 随机 2-3），不走分配器，由 `MechanicEngine` 读取
- **202/207**：忽略数值（0/负数 = 自动数量），由分配策略自行决定
- **51-53 大型地形**：棋盘级注入（已接入，见 4.2）；`splitMechanicConfig` 负责拆出 39/51-53

## 二、确定性随机契约

### 2.1 目标
同一棋盘状态 + 同一动作序列 → 两侧（Unity 客户端 / reversegen 跑关）产生**逐位相同**
的随机序列。这是重放验证、批量模拟与 golden 测试的前提。

### 2.2 种子公式（共享战场派生种子）

```
seed = levelResID（地形资源身份）
seed = seed  * 397 ^ Dock 当前牌数
seed = seed  * 397 ^ Desk 当前牌数
seed = seed  * 397 ^ 已应用步骤数
seed = seed  * 397 ^ 盐值
```

- 全部在 unchecked int32 语义下运算（C# `unchecked` 块 / JS `| 0` 截断）
- **基座 = 地形资源 ID（levelResID），不使用关卡实例 levelId**——同资源多关卡不区分，
  满足"同地形 + replay + 机制 → 同结果"的纯函数要求（已从两侧删除 levelId 项）
- 397 是 Unity 既有惯例（`MagicBottleExtra.CreateShuffleRandomSeed` 同款混合常数）
- 已应用步骤数：Unity = `StepMgr.Steps.Count`；reversegen = `actionCount`（点击/复活/机制步骤）
- 两侧实现：Unity `ExtraDeterministicRandom.CreateSeed(battle, salt)`；
  reversegen `extraActionSeed(game, salt)`（统一收敛到 `src/mechanics/seed.ts`）

### 2.3 盐值表（同一局面下区分不同调用点）

| 常量 | 值 | 用途 |
|------|----|------|
| `DANDELION_TARGETS` | 36 | 蒲公英扩散目标选择 |
| `BUBBLE_COLLECT_COUNT` | 39 | 泡泡随机收集数（再叠加轮次数） |
| `GIFTBOX_EFFECT` | 3700 | 礼盒效果加权滚动 |
| `GIFTBOX_APPLY_UNKNOWN` | 3701 | 礼盒施加问号的随机选牌 |
| `GIFTBOX_APPLY_FLIP` | 3702 | 礼盒施加翻转的随机选牌 |
| `GIFTBOX_APPLY_MAGIC_BOTTLE` | 3703 | 礼盒转化魔药的随机组数 |

两侧常量同名同值（Unity `ExtraDeterministicRandom.Salts` / reversegen `MECHANIC_SEED_SALTS`）。

### 2.4 洗牌专用种子（棋盘状态派生）

`ShuffleAlgo` 位于独立库，拿不到 battle 上下文，因此种子只从 Desk/Dock 状态派生：

```
seed = 0x5A5A5A5A
for tile in Desk（按 ID 升序）:  seed = seed*397 ^ tile.ID; seed = seed*397 ^ 花色
for tile in Dock（按 ID 升序）:  同上
```

按 ID 升序是**对齐契约的一部分**：两侧内部列表顺序可能不同，但 ID 排序保证种子一致。
两侧实现：Unity `ShuffleAlgo.CreateShuffleSeed` / reversegen `shuffleBoardSeed`。
洗牌算法本体（`_internalShuffle2`）：来源二（Dock）优先、来源一（Desk）先收集前
`min(3, maxCount)` 张再做去重合并（重叠时少选而非顺延），依赖分组随机旋转与剩余包
Fisher-Yates 共享同一随机流——reversegen `shuffleBoard` 逐位一致。

### 2.5 随机数发生器
- 两侧统一使用 **.NET System.Random 语义**：Unity 直接用 `System.Random(seed)`；
  reversegen 用逐位移植的 `DotNetRandom`（56 槽减法随机，`src/tile-explorer/random.ts`）
- 语义等价：`Next(min,max)` ≡ `Random.Range(min,max)` int 版；`NextDouble()` ≡ `Random.value`
- **消费顺序必须一致**：同一函数内按 Unity 原代码的调用顺序依次消费随机流
  （例如礼盒选牌：先 GetRandomCount 消费 1 次，再对每个候选取随机键）
- `OrderBy(Random.value)` 的语义 = 随机键 + **稳定排序**（LINQ 与 JS Array.sort 均为稳定排序）

### 2.6 时间/动画 → 逻辑时钟契约
- 泡泡 0.5s 冷却 = 1 次动作 tick；魔法清除后"绕过冷却直接指派" = 冷却置 0
- **泡泡状态机（对齐 `TileMatchBubbleCollectMgr`）**：
  1. 开局帧（Playing 后、步1 前）Dock 空 → 指派 → 立即吸取入 Dock（`onAssigned` 回调不经 Dock 空门）；
  2. 角标牌**留在 Dock 等玩家配对消耗**（每色一张，互相不成组）——Dock 非空期间不再指派/吸取；
  3. 最后一张角标牌被玩家三消消耗 → Dock 定向魔法（逐花色 MagicStep）→ **同一链内立即**下一轮指派→吸取；
  4. 最多 3 轮；`CanAssignForRemainingTileCount`（target+1 < 剩余/3）不满足即不再指派。
- 随机收集数（39:0）按 Unity 每帧重试语义：抽到无法通过剩余牌数边界的值就继续抽下一条
  （Unity 每帧消耗一次 `Next(2,4)`），直到抽中能通过的值或最小数 2 也无法通过；
  玩家点击只会推迟、不会插入/删除随机流消耗，结果等价。
- 动画等待（魔药/礼盒等 async 前摇）不影响逻辑结果：动画期间棋盘状态不变，
  立即计算与延迟计算等价

### 2.7 已知边界（记录在案）
- **Undo 不在此契约内**：Unity 撤回（StepMgr.RemoveStep）会改变 Steps.Count，
  导致后续种子与无撤回时间线不同。跑关按固定动作序列（无 undo）重放，不受影响。
  若未来要求"含 undo 逐位对齐"，需把种子中的步骤数项替换为棋盘状态派生进度。
- **复活（Revive）不在契约内**：Unity 复活 = Undo 回退至 Dock ≤ 2 后洗牌；
  reversegen `OfflineGame.revive`（消 1 张 Dock + 2 张同色 Desk）是求解域的死亡恢复抽象，
  仅用于 DFS 的 minRevives 度量，不参与跑关重放。
- **求解状态键**：DFS 记忆化键包含 Dock 实际顺序与牌身份/挂件状态（matchedTiles[0] 决定机制触发）、
  槽位加成、机制指纹；`actionCount` 仅在存在蒲公英/礼盒（派生种子读步数）时进键，
  保证剪枝安全且不稀释无机制牌局的合并率。
- **死亡阈值跟随槽位上限**：`isDead`/`remainSlotCount` 使用 `maxSlotCount`
  （对齐 Unity `Dock.IsMax`，礼盒加槽后为 8）。
- 泡泡种子叠加"轮次数"项，使其各轮收集数不同（Unity 原全局随机天然不同）。
- **排序稳定性**：**分析器深度排序已改为全序**——`(Dock, 深度, ID)` 破平，Unity
  `_getAllMatchs` 与 reversegen `computeAnalyzerMatchGroups` 同步修改。此前
  `List<T>.Sort` 不稳定 + top-9 截断使深度并列时候选池不确定，是"同输入、首轮泡泡牌
  跨次不一致"的根因（已修复，见 §4.3 第 3 条 Unity diff）。其余不稳定排序
  （分配器随机键碰撞等）仍属极低概率边界，记录不修。
- **礼盒加权滚动遍历序**：Unity `SelectRandomEffect` 的累计阈值遍历依赖 .NET
  `Dictionary` 枚举序（当前实现遵循插入序、与 reversegen 固定数组序一致）；语言规范
  不保证该序，属 Unity 侧未来健壮性风险，reversegen 用固定权重数组序（更确定）。
- **浮点常数**：C# `float` 常量提升为 `double` 的比较（蒲公英 0.8f）已用 `Math.fround`
  逐位复现；分配器 30% 阈值（0.3f vs 0.3）经证明在任意实际牌数下无整数可分叉，保持原样。

### 2.8 装载与步骤时序（已对齐）
- **规范排序**：getCanonicalTileOrder 不做 ID 排序——规范序 = 层数组序 + 层内数组序
  （与 Unity ReplaySerializer.GetCanonicalTileOrder 一致）。输入必须是 getAllTiles(terrain)
  的层序扁平列表。此顺序同时决定 ReplayCode 的 tile 索引与分配器的随机消费顺序。
- **分配种子**：由 replayCode + 分配请求子集派生（FNV-1a，见 §5.2），两侧同公式——
  Unity 侧 FixedReplayCodeAlgorithm.ResolveAssignSeed 显式种子（GM/调试）优先、否则派生。
- **衰减时序**：收集步骤的衰减（OnStep）发生在 UpdateTilesState 之前，使用本步之前的
  旧可点击状态——本步刚被解除遮挡的牌当步不衰减（对齐 Unity CollectStep.AppendStep 时序）。
- **机制步骤计数**：`applyMechanicStep` 对齐 Unity「Apply 先于 AppendStep」——应用器执行时
  `actionCount` 不含本步（链式蒲公英/魔药同步读取一致），链式礼盒取 `actionCount+1`
  恰为本步 Append 后的计数（对齐礼盒动画后才取随机）。
  **只有 Unity 会 `AppendStep` 的步骤类型计入 Steps.Count**（泡泡吸取/魔法棒/魔药清除/洗牌；
  泡泡指派、蒲公英扩散、礼盒计划类效果不计数）——派生种子读取的 `actionCount`
  与 Unity `StepMgr.Steps.Count` 逐位一致。
- **衰减触发面**：仅 Unity 会 `AppendStep` 的步骤类型触发 OnStep 衰减——
  `MagicBottleStep`（魔药清除）/`MagicStep`（魔法棒）/`BubbleCollectStep`（泡泡吸取）/
  `ShuffleStep`（洗牌）；计划类效果（泡泡指派、蒲公英扩散、礼盒加槽/揭示/施加问号/翻转/魔药）
  无 AppendStep，不触发衰减。
- **泡泡吸取结算**：`bubble-collect` 入 Dock 后照常 `CheckDockMatch` 结算三消
  （含 OnTileMatch 链式触发），并对每张收集牌触发 OnTileCollect（对齐 BubbleCollectStep.Apply）。
- **Dock 定向魔法**（泡泡后续与礼盒 DockAllMagicWand 共用）：计划快照一次，按 Dock 花色序
  **逐花色执行 MagicStep**（进 Dock → 三消 → 链式触发），步骤计数逐花色对齐
  `ExecuteDockAllMagicWandCoreAsync`。
- **礼盒守卫与开关**：效果滚动前检查 Win 态（`battleState == Win` 提前返回，胜局不触发）；
  效果开关对齐 `s3Kit.GiftBoxExtra.IsEffectOpen`，经 `OfflineGameOptions.giftboxOpenEffects`
  传入（缺省全开）。装载期的 `IsGiftBoxExtraOpen` 整体移除礼盒配置由调用方在构造配置时体现。
- **翻转挂件揭示时机**：`FlipExtra.OnUpdateTileState` —— 牌**变为可点击**即 `isDone=true`
  （无需收集）；问号(2/202/203) 仍只在收集时揭示。reversegen 在 `updateTilesState` 末尾
  对可点击 Desk 牌同步执行（对齐每次 UpdateTilesState 的 OnUpdateTileState 派发）。
- **魔药清除收集钩子**：`MagicBottleStep` 对每张目标牌调用 `tile.OnTileCollect(tile)`
  （仅目标自身挂件：揭示/订单/衰减有效收集），不广播、不触发三消 OnTileMatch；
  reversegen `applyMagicBottleClear` 同口径（此前遗漏，已修复）。
- **特殊结构点击语义**：transfer 与可见 falling 牌走**正常依赖回路**（有剩余依赖即不可点击），
  只有隐藏 falling 牌整体隐藏不可点（对齐 Unity `UpdateTilesState`，此前 transfer 恒可点的分支已删除）。
- **洗牌衰减时序**：Unity `Shuffle()` 先 `UpdateTilesState` 后 `AppendStep` —— 衰减用洗牌后的
  实时可点击状态；其余 AppendStep 步骤仍用本步前旧快照（reversegen 对 `giftbox-shuffle` 不取快照）。
- **礼盒加槽**：对齐 `SetMaxSlotCount(8)` —— `dockSlotBonus` 直接置为 `8 - MAX_DOCK_SLOTS`，幂等。
- **大金币(55)**：`IsBoardSpecialObstacle` 一员（51/52/53/55），拆分配置时归入棋盘特殊物桶、
  不参与花色/挂件分配、花色恒为 0（对齐 Unity `SetElementValue` 拦截）。

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
| 38 | 订单 | 2181（缺省，运行时可配） | 收集即 consumed | ✅ order（固定花色已对齐 IsFixedElementValue 缺省值） |
| 39 | 泡泡 | — | 轮次指派/吸取（入 Dock 结算三消）/逐花色 Dock 魔法 | ✅ bubble（收集结算 + Dock 魔法链 + 种子全对齐） |
| 51-53 | 大型地形 | — | 装载期注入棋盘特殊物：覆盖遮挡、依赖全部离桌自动移除 | ✅ board-special（放置计划 + 注入 + 运行期语义已对齐，见 4.2） |

## 四、已知风险与决策点

### 4.1 订单(38)的花色来源
Unity 订单 tile 的花色由外部订单系统提供：`orderExtraPlay.GetOrderExraElementValue()`。
reversegen 没有该系统，**约定**：调用方以地形 `ConstElementValue` 或外部注入方式提供订单花色。
行为语义（收集即 consumed）已对齐；数据源是外部契约。

### 4.2 大型地形注入(51-53)已接入
`src/board-special/` 是 Unity `BoardSpecialInsertionSystem` / `BoardSpecialPlacementSystem` /
`BoardSpecialRuntimeSystem` 的移植：

- **模式解析**（对齐 `_resolveBoardSpecialMode`，53 > 52 > 51）与**注入种子**
  （对齐 `_resolveBoardSpecialRandomSeed`：显式 `mechanicSeed` > FNV-1a(replayCode) > levelResId，
  `GetStableSeed` 不截高位）。
- **坐标量纲**：普通牌 10×10、中心间距 10，`TileUnit = 10`（tile 宽度）、半格 = 5；
  棋盘边界（LevelWidth/Height）与 tile 坐标同量纲；依赖覆盖阈值为半格 5。
- **放置计划**逐位移植三种入口：`Build`（51，层数驱动、footprint 2/3 交替、Tower 避让与放宽回退）、
  `BuildPizza`（52，`Random(seed^0x52)` 插入层选择）、`BuildTicket`（53，首/末/中间层 3×2、不足整组取消）。
- **运行期**：结构非 Tile，不进 Desk/Dock/洗牌/分析；被覆盖牌不可点击（覆盖索引）；
  依赖（下层覆盖 ≥ 半格）全部离桌后自动移除（对齐 `ProcessUncovered`：`UpdateTilesState` 开头
  处理、`TrySwitchToWinState` 评估前再处理一次，不产生步骤计数）；
  analyzer 成本/礼盒转化组成本对结构依赖穿透、障碍牌不计数；障碍牌（elementValue 0，含 55 大金币）
  不参与花色分配、三消与 Tower 判定。
- **胜利条件**（对齐 victoryConditionMgr 组合语义）：`ConditionDefault` = **桌面清空**
  （`Desk.DeskTiles.Count == 0`——不检查 Dock，障碍牌同样阻塞胜利）；
  52/53 订单玩法 = `[ConditionDefault, ConditionChicken]` 任一满足即胜
  （全部结构移除 **或** 桌面清空），由 `createGame` 按模式自动装配；51 与普通关卡仅默认条件。
- **reversegen 不做层平移**：解码与分配都发生在注入之前，层号仅用于依赖/覆盖分层比较
  （依赖 = 原层 < 注入层；覆盖 = 原层 ≥ 注入层）。

未建模（记录在案）：52/53 的订单收集计数与顶部 UI（ChickenInjector 计数/披萨 6 片换算）属活动系统；
结构表现层（FadeOut 动画）不建模；地形 JSON 预置 51-53 障碍牌的 ReplayCode 解码
（生产流程在装载期注入，ReplayCode 不含特殊块）。

### 4.3 其它记录
- 泡泡/蒲公英/礼盒/洗牌的确定性随机修复已提交 Unity 侧（`_InnerCode` 与 `_InnerTileMatchAlgo` 仓库），
  见提交信息"…（與 ReverseGen 跑關對齊）"
- **Unity 侧第 3 个真实 diff（待用户提交）**：`TileMatchBattleAnalyzerMgr._getAllMatchs`
  深度排序补 ID 破平（`depthA.CompareTo(depthB)` → 并列时 `a.ID.CompareTo(b.ID)`），
  使 top-9 候选池与 C(9,3) 组集合逐次确定——修复"同输入首轮泡泡牌跨次不一致"。
  reversegen `computeAnalyzerMatchGroups` 已镜像同一规则。
- **Unity 侧第 4 个真实 diff（待用户提交）**：引入 `Tile.LogicalElementValue`（逻辑花色键）。
  真实花色值 `ElementValue`（→ 贴图）属表现层、允许跨次随机；固定 replay 装载时把
  ReplayCode 归一化花色写入 `LogicalElementValue`，所有逻辑（泡泡候选排序、魔药索敌
  分组与洗牌种子、洗牌种子折叠）改用逻辑键——**同一 ReplayCode 的逻辑牌局跨次逐位一致，
  表现贴图可随机**。reversegen 的 elementValue 本就是归一化键，无需改动。
  配套：洗牌重分配时逻辑键随花色包一起搬移（`_internalShuffle2` 包结构增加逻辑值）；
  快照 `TileSnapData` 持久化逻辑键（旧快照缺字段回退真实花色）。
- 新增 `ExtraDeterministicRandom.cs` 未带 `.meta`：Unity 下次打开工程自动生成 GUID，不影响功能
- 帧级表现（动画/音效/TA 埋点）全部不在 reversegen 建模范围内，只对齐逻辑

## 五、机制分配器对齐（TileExtraAssigner 移植）

reversegen `src/mechanics/assigner.ts` 是 Unity `_InnerTileMatchAlgo/RuleBasedAlgo/TileExtraAssigner.cs`
的确定性移植（`AssignExtrasWithColorConstraints`），由 `createGame` 在装载期调用
（对齐 Unity `FixedReplayCodeAlgorithm.ApplyExtraConfig`：先花色后挂件、只分非 const 牌、
Dock/消除状态在分配之后装载）。

### 5.1 管线

```
replayCode + 地形 + extraConfig + seed
  → createGame（elementValues 花色 → assignTileExtras 分配挂件 → 应用 Dock/消除 → OfflineGame）
  → 跑关器/求解器
```

- 泡泡(39) 与大型地形(51-53) 由 `splitMechanicConfig` 在调用方拆出（对齐 Unity LoadLevel）
- `validateMechanicCounts` 只校验未知枚举：数量是分配请求，不再要求与地形摆放一致

### 5.2 确定性随机

- `AssignerRandom` = **Xorshift128+**（SplitMix64 种子扩展），逐位对齐 Unity `DeterministicRandom.cs`
  （与机制引擎用的 .NET System.Random 语义 DotNetRandom 是两套独立随机流，各对齐各的）
- 缺省种子：`seed = FNV-1a 32bit(replayCode + "|" + 分配请求子集文本) & 0x7fffffff`
  （`deriveAssignSeed`，零协调）。**逐字符截断低 8 位**（对齐 Unity `ReplaySerializer.Fnv1a32`
  的 `(byte)c`——ASCII 下与码元异或相同，非 ASCII 也逐位一致）。
  **分配请求子集** = 机制配置经 `splitMechanicConfig` 拆出
  泡泡(39)/大型地形(51-53,55) 后的部分——与 Unity `FixedReplayCodeAlgorithm` 收到的 extraConfig 一致；
  Unity 侧 `ReplaySerializer.DeriveAssignSeed` 同公式派生（同输入 → 同挂件布局）。
  显式 `mechanicSeed`（Unity 侧特殊种子/GM）优先于派生。
  注：棋盘特殊物注入种子用另一套 FNV（`BoardSpecialInsertionSystem.GetStableSeed`，
  整码元异或、不截低 8 位、不截高位），两侧分别对齐。
- 随机消费顺序 = 输入 tile 列表顺序（LINQ/数组枚举顺序逐位一致）；与 Unity 对齐时
  输入 tile 需以 `getCanonicalTileOrder` 顺序（规范序 = 层数组序 + 层内数组序，见 §2.8）

### 5.3 分配规则（对齐 Unity ExtraConfig/WhitelistConfig）

| 枚举 | 策略 | order | 可让位 |
|------|------|-------|--------|
| 4 黄金 / 8 复活节 | LeastFrequentFirst | 0 | ✗ |
| 31 魔药 | MostFrequentFirst | 1 | ✗ |
| 36 蒲公英 | FifthLowestCostGroup（第 5 低成本三消组，不足 5 组取最高） | 1 | ✗ |
| 5 金币 | LeastFrequentFirst | 2 | ✗ |
| 37 礼盒 | MostFrequentFirst | 3 | ✗ |
| 2 问号 / 202 问号(间隔) | Random / EachLayerTwoBottomFirst（每层≤2，从底层起，自动数量） | 4 | ✓ |
| 7 翻转 / 207 翻转(层) | RandomNonClickable / RandomLayerLessTile（≥2 层随机 10% 层整层挂，自动数量，排除 Tower） | 5 | ✓ |

- 固定花色挂件：数量向下取 3 的倍数并改写 tile 花色（黄金 1101 / 复活节 1103 / 金币 1201 /
  魔药 1301 / 蒲公英 1402 / 礼盒 1601），与 `registry.fixedElementValue` 一致
- 白名单双向互斥：黄金/复活节只挂空牌；金币/魔药/蒲公英可搭问号/翻转；问号/翻转可搭金币
- 预置可让位挂件（问号/翻转）先驱逐腾位、后按白名单恢复，被排挤则丢弃（`evictedPreplaced`）
- 其余 tile-count 机制（冰封/锁链/兑换/怪物/岩石/翻转罐/订单/小精灵等）：默认 MostFrequentFirst、order 最大
- **Tower 判定（207 排除）对齐 IsTerrain**：初始 Dock 牌（originalPile==1，经
  `createGame` 的 `towerExcludedTileIds` 传入）与 51-53 棋盘特殊物（按 tile extraEnum 排除）
  不参与 Tower 链判定
- 校验为日志级（对齐 Unity ValidateFinalDistribution），不抛错

### 5.4 对齐验证

`test/unit/assigner.test.ts`：确定性（同种子同输入 → 逐位相同）、固定花色取整、
白名单互斥、驱逐/恢复、202/207 自动数量、蒲公英第五低成本组、createGame 装载集成。

`test/unit/mechanics-engine.test.ts`：魔药索敌 golden、泡泡全流程 golden（逐花色
MagicStep 链）、泡泡吸取 Dock 三消结算 + 收集钩子、礼盒 Win 态守卫、效果开关、
衰减仅随步骤类触发 + 旧可点击快照、clone 保留机制状态。
