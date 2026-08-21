# 机制移植对齐手册（Mechanics Porting Playbook）

> 本文档沉淀泡泡状态机对齐事故的根因教训与可执行规范，目标是**保证未来任何新机制的
> 移植从第一天起就与 Unity 逐位一致**，而不是事后审计返工。
>
> 事故回顾：泡泡(39) 曾"完全不对齐"——3 轮指派/吸取/魔法挤在同一步爆完、角标牌不等
> 玩家配对。根因不是某个函数写错，而是**移植了步骤清单、没移植状态机拓扑**。
> 本文所有规则都来自那次事故与随后的全机制深度审计（见 `mechanics-alignment.md` 与提交历史）。

---

## 一、五条铁律（每次移植/审计前先过一遍）

1. **先画状态机图，再写代码。** 对任何异步/帧驱动管理器（泡泡、礼盒、魔药、蒲公英），
   先画出：状态集合 × 转移条件 × "谁在等谁"。Unity 的 `OnUpdate` 分支、函数开头的
   早退守卫、async continuation 里的前置检查，都是状态机的一部分，不是可有可无的细节。

2. **静止态的定义必须包含"等玩家"。** Unity 管理器最常见的静止态不是"没有步骤可做"，
   而是**被玩家状态门控**（Dock 非空、角标牌还活着、输入锁）。若把静止态建模成
   "tick 到没有步骤为止"，守卫一错，整个生命周期就会在两次玩家动作之间被错误地压缩成一串 burst。

3. **Golden 必须来自 Unity 真迹，不是来自实现。** 单侧 golden（reversegen 对 reversegen）
   只能证明自洽，永远证明不了对齐。实现错了 → golden 固化错误 → 全绿掩埋错误。
   每次改基线先问一句：**这是 Unity 真的会这么干，还是只是实现这么干？**

4. **每个发现都要回到 Unity 源码逐行验证（file:line）。** 本次审计中子代理出现过
   误报（把 `bindTile != matchedTiles[0]` 守卫漏读）与纠错（纠正了我自己加错的蒲公英
   Win 守卫）。任何结论，必须能引用 Unity 具体行号、并解释"状态在那一刻是什么"。

5. **步骤计数只跟 `AppendStep` 走。** Unity 只有五类机制步骤被 `StepMgr.AppendStep`
   （魔药清除/魔法棒/泡泡吸取/洗牌 + 玩家 CollectStep）——只有它们计入 `Steps.Count`
   （= reversegen `actionCount`）、触发衰减 OnStep。计划类效果（泡泡指派、蒲公英扩散、
   礼盒加槽/揭示/施加）不计数、不衰减、不打断种子推导。

---

## 二、移植检查清单（Checklist）

新机制移植完成 = 下面每一项都核对过并留了证据：

### A. 状态机与守卫
- [ ] 列出 Unity 管理器**全部**早退路径：`OnUpdate` 各分支、函数头 `if (...) return`、
      async 前置检查、`IsBusy`/`IsInputLocked` 门控——逐一映射到 reversegen。
- [ ] 确认每个门控读的是**哪个时刻**的状态（见 C），并在代码注释里写死。
- [ ] 确认"等玩家"条件被正确表达（如泡泡 `HasLiveActiveBubbleTile` 包含 Dock 里的牌，
      而不是只看 Desk）。

### B. 随机数（最容易逐位漂移的部分）
- [ ] 种子公式**按调用点**记录，不统一成"一个公共种子"：每个 Unity 调用点读的
      `levelResID*397^dock^desk^Steps^salt` 各项在**该时刻**的值不同（步数 ±1、
      Dock 是否含匹配 3 张……）。
- [ ] 消费顺序逐行对齐，**含短路**：`A || draw()`、`x == null ? noDraw : draw()`
      这类短路会改变后续所有随机流的对齐。
- [ ] `float` 常量用 `Math.fround`（如 0.8f）；`int` 运算用 `| 0`/`Math.imul`
      （unchecked int32 语义）。
- [ ] FNV 区分两套：分配种子 `ReplaySerializer.Fnv1a32`（逐字符截低 8 位）与
      棋盘特殊物 `GetStableSeed`（整码元异或、不截高位）。

### C. 快照 vs 实时状态（每个读取点单独判断）
- [ ] 旧 Analyzer 快照：魔药/蒲公英读的是**本次 collect 之前**的分析结果
      （reversegen `capturePreMoveContext` / `preMoveGroups`）。
- [ ] Dock 计数：蒲公英的种子里 Dock 数**含本次匹配的 3 张**（matched 尚未移出）；
      泡泡选择器的成本读的是当前 Dock。
- [ ] 步数：蒲公英/魔药读 `actionCount`（AppendStep 前）；礼盒读 `actionCount + 1`
      （效果滚动在 AppendStep 之后）。
- [ ] 点击性：衰减 OnStep 用**本步前**旧快照（唯一例外：洗牌用洗牌后的实时状态，
      Unity 先 `UpdateTilesState` 再 `AppendStep`）。
- [ ] 事件派发语义：`battle.OnTileCollect(tile)`（广播，逐个挂件自守卫）vs
      `tile.OnTileCollect(tile)`（仅自身，如魔药清除的目标牌）。

### D. Win 守卫：先判断"棋盘变更是否异步门控"
- [ ] 若棋盘变更是**同步无条件**执行（蒲公英 `PreparePendingTargets` 在 OnMatch 里
      直接 `SetElementValue+AddExtra+UpdateTilesState`，Win 检查只跳过视觉）→
      **不加** Win 守卫。
- [ ] 若效果滚动/执行在**动画后的异步回调**里且 Unity 有 `battleState==Win` 检查
      （礼盒）→ **加** `game.isWin` 守卫。
- [ ] 两个机制同名守卫语义可能相反（蒲公英 vs 礼盒），不要照抄模板。

### E. 时序与顺序（collect 的规范顺序）
```
Unity Collect:
  Apply: RemoveTile → AppendTile → CheckDockMatch → OnTileMatch(逐张) → Destroy → RemoveTiles → OnTileCollect
  AppendStep → OnStepApply（衰减，旧点击快照）→ OnTileCollectApplied → ResolveOutcomeAfterOperation
  → TrySwitchToWinState（先 processUncoveredBoardSpecialTiles 再评估胜利条件）→ UpdateTilesState
```
- [ ] reversegen `collect()` 的每一步都要能对上号（当前实现已对齐，改动前先对照本文）。
- [ ] `UpdateTilesState` 内部顺序：开头处理棋盘特殊物自动移除（依赖离桌即移除，
      覆盖解锁在同一轮刷新生效）；末尾处理翻转挂件 clickable 即揭示。

### F. 胜利与死亡
- [ ] 默认胜利 = **桌面物理清空**（`Desk.DeskTiles.Count == 0`）：不检查 Dock、
      障碍牌阻塞胜利。
- [ ] 52/53 订单 = `[ConditionDefault, ConditionChicken]` **OR** 组合
      （结构全移除 或 桌面清空）。
- [ ] 死亡 = `Dock.IsMax()`（7 + 礼盒加槽至 8），与胜利判定同操作内检查。

### G. 装载期（分配器/棋盘特殊物）
- [ ] 障碍物集合 = 51/52/53/55：不参与花色分配、`elementValue` 恒 0。
- [ ] 分配顺序 = 枚举升序，同枚举按输入 tile 序消费随机；30% 阈值有短路不消耗随机。
- [ ] 种子链：显式 `mechanicSeed` > FNV-1a(replayCode) > levelResId（空白 replayCode 视为缺失）。

---

## 三、验证规范（Definition of Done）

1. **跨侧真迹**：Unity 用 `docs/cross-side-golden.md` 的导出器导出一局 trace 提交为
   fixture（`test/fixtures/cross-side/`），单测 `compareCrossSideTraces(record(...), fixture)`。
   **没有 Unity 真迹的机制不算对齐**。
2. **端到端交错场景**：至少一条测试让"玩家动作 × 机制门控"真实交错
   （如泡泡角标牌在 Dock 里跨多步等玩家配对），禁止只用 `applyMechanicStep`
   直调单步绕过状态机。
3. **基线变化三问**：改任何 golden 前问——(a) Unity 源码哪一行支持这个新基线？
   (b) 此刻读的状态在 Unity 里是什么时刻的？(c) 有没有守卫/短路被忽略？
4. **回归锁定**：每个修复配一个最小回归测试，测试注释写明 Unity 的 file:line 依据
   （本项目现有测试即按此风格）。
5. **文档同步**：`docs/mechanics-alignment.md` 的 §二/§三 状态表与契约随修复更新。

---

## 四、Unity ↔ reversegen 文件对照表（审计入口）

| 职责 | Unity（`Assets/Scripts/_InnerCode/...`） | reversegen |
|---|---|---|
| 泡泡管理器 | `Client/TileMatch/GamePlay/Scene/BattleMgrs/TileMatchBubbleCollectMgr.cs` | `src/mechanics/engine.ts`（tick/assign/dockMagic）+ `step-appliers.ts` |
| 魔药 | `Core/Extra/MagicBottleExtra.cs` + `Core/Step/MagicBottleStep.cs` | `engine.ts`（索敌）+ `step-appliers.ts` |
| 礼盒 | `Core/Extra/GiftBoxExtra.cs` + `Core/Extra/GiftBox/*.cs` | `extras.ts`（滚动/选牌/计划）+ `engine.ts` + `step-appliers.ts` |
| 蒲公英 | `Core/Extra/DandelionExtra.cs` + `Dandelion/*.cs` | `extras.ts`（选目标）+ `engine.ts` + `step-appliers.ts` |
| 衰减/揭示/订单 | `Core/Extra/{Golden,AdventCalendar,Easter,Unknown,Flip,Order,Coin,Ice}Extra.cs` | `extras.ts`（decay/reveal/collect 钩子）+ `registry.ts` |
| 步骤类型 | `Core/Step/{Collect,Magic,MagicBottle,BubbleCollect,Shuffle,Undo}Step.cs` | `step-appliers.ts`（`STEP_APPLIERS`/`DECAY_STEP_TYPES`） |
| Dock/三消 | `Core/Dock/Dock.cs` + `Defines/Rule.cs`（CheckDockMatch） | `offline-game.ts`（`sortDockTiles`/`checkDockMatch`） |
| 洗牌 | `_InnerTileMatchAlgo/.../ShuffleAlgo.cs` | `extras.ts`（`shuffleBoard`）+ `seed.ts`（`shuffleBoardSeed`） |
| 主循环/状态刷新/胜利 | `Scene/TileMatchBattle.cs`（Collect/UpdateTilesState/TrySwitchToWinState）+ `BattleMgrs/TileMatchVictoryConditionMgr.cs` + `VictoryConditions/*.cs` | `offline-game.ts`（`collect`/`updateTilesState`/`isWin`/`isDead`）+ `board-special/victory.ts` |
| 棋盘特殊物 | `Core/BoardSpecial/BoardSpecialInsertionSystem.cs` + `Core/Tiles/Tile.cs`（LargeTerrainTileUtils） | `src/board-special/*.ts` |
| 特殊地形结构 | `Core/TerrainStructure/TileMatchTerrainStructureSystem.cs` | `offline-game.ts`（falling/transfer 处理） |
| 分配器 | `_InnerTileMatchAlgo/FixedReplayCodeAlgo/{TileExtraAssigner,FixedReplayCodeAlgorithm,ReplaySerializer,DeterministicRandom}.cs` | `src/mechanics/assigner.ts` + `spec.ts` |
| 派生种子 | `Core/Extra/Define/ExtraDeterministicRandom.cs` | `src/mechanics/seed.ts` |

---

## 五、已知边界（记录不修——Unity 侧自身不确定或无法从动作序列还原）

1. **动画窗口帧时序**：魔药/礼盒在动画后读取棋盘，玩家在窗口内点击会改变其目标牌；
   reversegen 采用"效果先于下一次点击"的确定性模型。跨侧 fixture 用静止导出规避。
2. **`List<T>.Sort` 不稳定并列**：analyzer 同深度 top-9、礼盒转化组 (cost,minId)
   并列时 Unity 自身不确定；reversegen 用稳定排序（更确定），可接受。
3. **.NET Dictionary 枚举序**：礼盒加权滚动累计遍历依赖字典枚举序（当前插入序，
   两侧一致）；语言规范不保证，属 Unity 侧未来风险。
4. **泡泡 CanAssign 边际窗口**：剩余牌数 10-12 时 Unity 每帧重抽收集数，抽取次数
   依赖帧时机；结果（收集数=2、目标牌）与 reversegen 的"抽到可通过为止"等价。

---

## 六、反模式红榜（出现过的问题，禁止再犯）

- ❌ 注释写"对齐 Unity XXX"但没有 Unity 行号证据——注释会形成自证循环。
- ❌ 用 `applyMechanicStep` 直调单步当作"机制测试"——绕过了状态机，拓扑错了一测便过。
- ❌ 把 golden 从实现输出反推回来——实现错，golden 跟着错，越测越牢。
- ❌ 把"动画/冷却时间"线性化为"每步 1 tick"而不检查门控——时间不是状态机，
  门控才是。
- ❌ 函数级点对点审计代替拓扑审计——每个函数都对，连起来的时间线可能全错
  （泡泡就是：选择器/种子/魔法链全对，守卫错一个词，全盘皆错）。
- ❌ 照抄其它机制的守卫模板（蒲公英 vs 礼盒的 Win 守卫语义相反）。
