# 牌局生成与机器人评价参数设计说明

本文档定义 ReverseGen 中“牌局生成策略”和“机器人评价策略”的整体参数语言。它面向策划、关卡设计和工具维护者，用来说明牌局如何生成、生成结果如何评价、每个参数会影响什么，以及产物如何追溯。

当前阶段以人工设计策略为主。策划可以针对不同实验分别编写策略变体，不要求所有评价方法共享同一条分档公式。系统现阶段只接入已经支持的字段和执行器；完整的评价 Profile 解析、可视化编辑和自动执行将在后续接入。

策略配置使用 JSON 保存。JSON 只作为机器可读配置，不使用 `//` 或 `/* */` 注释；中文说明写在 `meta.name`、`meta.purpose`、`meta.notes`，或写在本 MD、run 目录的 manifest 中。

## 0. 文件入口与事实来源

| 内容 | 项目文件 | 作用 |
| --- | --- | --- |
| 策划参数总说明 | `docs/level-generation-strategy-feature.md` | 解释生成、分档、评价、搜索和输出参数 |
| 端到端产出 SOP | `docs/test-resource-production-sop.md` | 从输入牌局到校准表、replay 和配置的操作顺序 |
| 机器字段约束 | `output/generation_feature/strategy.schema.json` | JSON Schema；修改管理器后用 `tools/manage_generation_feature.py init --overwrite-schema` 刷新 |
| 页面能力目录 | `config/generation-feature-catalog.json` | 声明任务方式、可见参数模块、可用生成器及各 mode 的输入字段 |
| 策略主数据 | `output/generation_feature/strategies/*.json` | 每个可运行策略的参数和评价约束 |
| Feature 管理器 | `tools/manage_generation_feature.py` | 校验策略、生成 run 快照和命令、维护索引 |
| 可视化策略工作台 | `gui/generation-strategies.html` | 新建、复制、编辑、校验、导出和查询历史策略 |
| 当前分档实现 | `src/grader.ts` | Strategy2 公式、G0-G5 阈值和标签的运行时事实来源 |
| 当前补缺执行器 | `tools/backfill-missing-grades.ts` | 生成候选、Strategy2 分档、Optimal 验收和搜索 |
| 线上回放验证 | `tools/append-strategy2-grades.ts`、`tools/analyze_optimal_experience_online.py` | 将当前分档和指定策略中的 Optimal 约束回放到精选在线数据 |
| 当前采用资源包 | `output/strategy_runs/20260630_至少8局当前校准/manifest.json` | 最终校准表、replay、配置及输入快照索引 |
| 历史有效产出清单 | `output/有效产出清单.json` | 原始线上数据与三次采用产出的行数、哈希和来源关系 |
| 有效产出审计 | `tools/audit_effective_outputs.py` | 复算三版差异并检查采用文件是否缺失 |

发生冲突时，运行时代码和 run 内的 `strategy_snapshot.json` 决定“当时实际执行了什么”；
Schema 和本文档用于创建新策略。不要根据旧报告或文件名反推当前参数。

配置职责严格分三层：

1. `generation`：怎样造牌，不决定最终档位。
2. `evaluation.grade_strategy`：怎样把机器人结果映射为 G 档；当前 `strategy2` 的公式在 `src/grader.ts`。
3. `evaluation.acceptance`：分档完成后是否接收该牌局；Optimal 是体验筛选，不是第二套档位。

## 1. 设计目标

整体参数设计要解决以下问题：

- 用统一格式描述“生成哪些地形、使用什么生成参数、用哪些机器人评价、如何分档和验收”。
- 支持不同生成目的：基础批量生产、缺档补齐、指定难度重刷、无尽池模拟、配置导出。
- 支持不同评价方法：公式映射、规则集合、单指标阈值表，以及未来的拟合模型。
- 每次运行自动保留策略快照、执行命令、输出文件和状态日志。
- 后续分析时能回答：这批牌局从哪里来、为什么这么生成、使用什么机器人和规则得出当时的评价结果。

本设计不负责自动替策划决定策略。系统负责保存、校验、执行和追溯；策略目标、参数范围、机器人组合、分档规则和验收条件由人工确定。

## 2. 策略生命周期

一次策略从配置到产物的流程如下：

1. 策划或工具维护者人工设计生成参数和评价参数。
2. 为不同实验目的建立独立策略或策略变体，不覆盖仍需追溯的旧版本。
3. 对当前系统已经支持的字段使用 `validate` 校验字段和枚举值。
4. 保存策略时自动刷新 `runs/<strategy_id>/` 运行目录；命令行也可用同名 `run-id` 手动刷新。
5. 检查 `strategy_snapshot.json` 和 `command.sh` 是否符合预期。
6. 执行 `command.sh`。
7. 查看 `logs/` 中的状态和进度，并人工确认评价结果。
8. 将 `01_generation/`、`02_analysis/`、`03_config/` 中的产物用于后续校准、配置或 replay 导出。

每个策略只维护一个同名运行目录。保存新版本会覆盖其中的运行配置、策略快照和命令，
策略版本历史由 `strategy_history/` 负责，不再按版本复制运行目录。

## 3. 目录约定

```text
output/generation_feature/
  strategy.schema.json          # 策略字段校验规则
  strategies.csv                # 策略索引，便于快速查看
  runs.csv                      # 运行索引，便于快速查看
  runs.jsonl                    # 追加式运行记录
  strategies/
    <strategy_id>.json          # 策略主数据
  strategy_history/
    <strategy_id>/
      v<version>_<time>.json    # 页面保存生成的不可变版本快照
  runs/
    <strategy_id>/
      run_config.json           # 本次运行配置
      strategy_snapshot.json    # 本次运行使用的策略快照
      command.sh                # 可执行命令
      01_generation/            # 生成出的牌局 CSV
      02_analysis/              # 计划表、统计表、校准分析
      03_config/                # 配置导出产物
      logs/                     # 状态、进度、日志
```

前端入口为 `/generation-strategies.html`。页面保存时由 `gui/server.ts` 调用同一套
`validate_strategy()` 权威校验；更新已有策略会自动递增 `meta.version`，并在
`strategy_history/` 中保存修改前基线和新版本，同时刷新同名运行目录。页面导出的 JSON 与命令行 Feature 使用同一结构，
不维护第二套配置格式。页面字段旁的 `?` 和右侧“字段说明”由集中字段字典生成，包含实际意义、
填写格式、示例和枚举选项影响；新增参数时需要同步补充该字段字典。

页面采用三层声明式控制，避免把每个历史策略写成一套独立表单：

1. `workflows`（任务方式）决定显示 `scope`、`target`、`generation`、`evaluation`、`search`、`outputs` 中的哪些模块和字段。
2. `generators`（生成器）决定本任务可选的牌面生成方法，以及该方法使用闭合率、花色、分布、债务中的哪些参数组。
3. `policyModes`（参数模式）决定一个参数组显示固定值、上下限、比例、浮动或列表中的哪些输入项。

这三层定义集中在 `config/generation-feature-catalog.json`。新增现有 Tile 生成流程的任务变体时，优先扩展目录和执行适配器，不要复制页面；目录只负责界面能力和参数适用性，`strategy.schema.json` 仍负责机器字段合法性，执行器代码仍是实际行为的事实来源。当前未接入的新型牌局生成方法不做预设，等输入、输出和执行语义明确后再增加 generator 和 adapter。

## 4. 策略 JSON 总体结构

```json
{
  "meta": {},
  "scope": {},
  "target": {},
  "generation": {},
  "evaluation": {},
  "search": {},
  "outputs": {},
  "adapter": {}
}
```

各域职责：

| 域 | 策划含义 |
| --- | --- |
| `meta` | 这是什么策略，为什么存在，当前是否可用 |
| `scope` | 这次要处理哪些地形、使用哪份源数据 |
| `target` | 希望得到哪些难度档、每档多少条、如何补缺 |
| `generation` | 牌局生成参数，会直接影响牌局体验 |
| `evaluation` | 使用哪些机器人采样、如何计算指标、如何分档，以及额外质量验收条件 |
| `search` | 搜索强度和执行方式 |
| `outputs` | 输出哪些产物、每档是否截断 |
| `adapter` | 该策略交给哪个工具执行 |

## 5. `meta` 策略信息

示例：

```json
{
  "meta": {
    "strategy_id": "base_random_s2_v1",
    "name": "基础随机策略2批量生成",
    "version": 1,
    "purpose": "为指定地形批量生成 G0-G5 的候选牌局",
    "status": "active",
    "notes": "用于基础采样，不包含额外质量验收"
  }
}
```

参数说明：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `strategy_id` | string | 策略唯一 ID，用于命令引用和文件命名 |
| `name` | string | 中文名称，给人读 |
| `version` | integer | 策略版本，从 1 开始递增 |
| `purpose` | string | 策略目的，说明它解决什么设计问题 |
| `status` | enum | `active` 可用，`draft` 草稿，`deprecated` 废弃，`archived` 归档 |
| `notes` | string | 中文备注，记录边界、风险或使用建议 |

设计建议：

- `strategy_id` 不要复用旧含义。
- 策略行为变更较大时升 `version`，不要只改 `notes`。
- `purpose` 要从关卡设计目的出发，例如“补齐低难保底样本”或“重刷高难但可过样本”。

## 6. `scope` 地形与数据范围

示例：

```json
{
  "scope": {
    "terrain_source": "csv_existing_grade_support",
    "level_range": "100003-100180",
    "include_levels": [],
    "exclude_levels": [100001, 100002, 100004],
    "levels_dir": "../TileMatchShell/Tools/Config/Json/Levels",
    "source_csv": "output/100003～100071_100073+_合并去少_无补缺_每档最多10.csv",
    "workbook": "output/无尽关校准工具_无补缺.xlsx",
    "template_workbook": "output/无尽关校准工具.xlsx"
  }
}
```

参数说明：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `terrain_source` | string | 地形来源口径，例如 `level_json`、`calibration_workbook`、`csv_existing_grade_support` |
| `level_range` | string | 连续地形范围，如 `100003-100180` |
| `include_levels` | array | 显式包含的地形 ID；为空时由其他字段决定 |
| `exclude_levels` | array | 排除地形 ID，常用于异常地形或不进入池子的地形 |
| `levels_dir` | string | 地形 JSON 目录 |
| `source_csv` | string | 已有牌局 CSV，用于补缺、重刷或分析 |
| `workbook` | string | 校准工具表路径，用于模拟、覆盖统计 |
| `template_workbook` | string | 构建新工具表时使用的模板 |

设计影响：

- `include_levels` 越窄，产物越容易验证，但覆盖不足。
- `exclude_levels` 应明确写入策略，避免异常地形反复混入。
- `source_csv` 决定了“已有数据”口径。无补缺、有补缺、最终 capped CSV 不能混用。

## 7. `target` 目标难度与补齐规则

示例：

```json
{
  "target": {
    "grades": [0, 1, 2, 3, 4, 5],
    "target_count_per_grade": 10,
    "fill_policy": "missing_only",
    "fallback_policy": "downward_only",
    "min_existing_count": 1
  }
}
```

参数说明：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `grades` | integer[] | 本策略要生成或检查的目标难度档 |
| `target_count_per_grade` | integer | 每个地形、每个目标档希望保留多少条牌局 |
| `fill_policy` | enum | 生成策略：`all` 全量生成，`missing_only` 按最高档向下补到目标数，`replace_filtered` 只替换原始档位中被验收条件剔除的数量，`probe_only` 只探测，`cap_only` 只截断，`none` 不生成 |
| `fallback_policy` | enum | 目标缺失时的回退方式：`downward_only` 向低难找，`lowest_available` 最低可用，`allow_any` 任意，`none` 不回退 |
| `min_existing_count` | integer | 判断某个地形“支持某难度”的最低已有条数 |

设计影响：

- `target_count_per_grade=10` 是当前常用资源量，便于每档有一定随机性。
- 低难保底通常使用 `missing_only`，避免重复生成已经充足的地形。
- 重刷质量问题时，也可以使用 `missing_only`，但配合 `evaluation.acceptance` 让不合格旧数据不计数。
- `fallback_policy` 会影响无尽关保底体验。若配置为向低难回退，需要确认低难牌局确实存在。

`generation.placement_mode` 决定颜色落位算法：

- `layer-closure`：使用闭合率、同色分布和债务持续权重塑造牌面。
- `random-color`：只按花色范围构建每色数量为3倍数的颜色袋，再完全随机落位。该模式忽略闭合率、同色分布和债务输入，输出 `LevelTags=random`，但仍保留实际闭合率和机器人校验结果。

## 8. `generation` 生成参数

`generation` 是策划最常改的区域，决定牌局结构和体验。它包含四类参数：

```json
{
  "generation": {
    "closure": {},
    "color": {},
    "spread": {},
    "debt": {}
  }
}
```

### 8.1 `closure` 层闭合率

闭合率控制每个依赖深度推进到某一层时，累计已经完成的 triplet 数。

通俗理解：

- 闭合率高：前中期更容易凑出消除，牌局更松。
- 闭合率低：更多花色债务留到后面，牌局更紧、更容易卡槽。

支持模式：

| mode | 示例 | 说明 |
| --- | --- | --- |
| `random` | `{ "mode": "random" }` | 执行层按整数 target 随机 |
| `random_range` | `{ "mode": "random_range", "min": 0.8, "max": 1.0 }` | 每层闭合率在范围内随机 |
| `fixed_points` | `{ "mode": "fixed_points", "points": [0.3, 0.6, 0.8] }` | 固定闭合率点 |
| `full_layer_max` | `{ "mode": "full_layer_max" }` | 每层尽量使用最高闭合，常用于规则 G0 |
| `per_layer_list` | `{ "mode": "per_layer_list", "values": [0.2, 0.4, 0.7] }` | 明确指定每层列表 |

当前执行约定：

- `mode=random` 时，执行层按累计整数 target 随机。
- 在补缺/重刷执行器中，`mode=random_range` 且范围覆盖 `0～1` 时，也按项目内随机逻辑执行，
  即复用 `randomizeCloseRatesFromTiles()`，而不是每层直接随机百分比。
- 前 2 层在物理可行时，累计 target 至少为 1 组。
- 如果累计牌数不足 3 张，不会强制闭合。
- 窄范围的 `random_range` 会按直接百分比范围执行，适合明确限制闭合率上下界。
- 显式固定值不自动套用这个前 2 层规则，除非对应执行器实现。

策划建议：

- 想找低难样本：提高闭合率，例如 `0.8-1.0`。
- 想找高难样本：降低闭合率，例如 `0.0-0.45`。
- 想稳定复现某类体验：用固定点或固定列表。
- 想大规模探索：用 `random`。

### 8.2 `color` 花色数

花色数控制一个牌局里有多少种颜色。

通俗理解：

- 花色少：同色更容易聚集，通常更容易。
- 花色多：选择更多、债务更多，通常更难。
- 但花色太少可能导致结构单调，花色太多可能导致几乎不可控。

支持模式：

| mode | 示例 | 说明 |
| --- | --- | --- |
| `ratio` | `{ "mode": "ratio", "ratio": 0.6 }` | 按自由牌数比例计算花色 |
| `ratio_jitter` | `{ "mode": "ratio_jitter", "ratio": 0.6, "jitter": 2 }` | 在比例结果基础上上下浮动 |
| `fixed_count` | `{ "mode": "fixed_count", "value": 14 }` | 固定花色数 |
| `range` | `{ "mode": "range", "min": 10, "max": 16 }` | 在范围内随机花色数 |

当前比例公式：

```text
colorCount = floor(ratio * floor(freeTiles / 3))
```

策划建议：

- 当前常用基础值是 `ratio=0.6`。
- 搜索低难 G0/G1 时可以尝试降低花色系数。
- 搜索高难 G4/G5 时通常保持或提高花色数，但需要配合 `sim1Wins` 等验收避免必死样本。
- `jitter` 适合补缺搜索，能避免长期卡在某个固定花色数上。

### 8.3 `spread` 同色分布

同色分布控制同一花色的牌更倾向集中还是分散。

通俗理解：

- 数值低：同色更紧密，更容易连续拿到。
- 数值高：同色更分散，更容易形成跨层债务和等待。

支持模式：

| mode | 示例 | 说明 |
| --- | --- | --- |
| `fixed` | `{ "mode": "fixed", "value": 0.5 }` | 固定分布参数 |
| `random` | `{ "mode": "random" }` | 0 到 1 随机 |
| `random_range` | `{ "mode": "random_range", "min": 0.65, "max": 1.0 }` | 在范围内随机 |

策划建议：

- 低难补缺可用 `0.0-0.35`。
- 中档可用 `0.35-0.75`。
- 高难可用 `0.65-1.0`。
- 如果只调闭合率仍找不到目标档，可以再调 spread。

### 8.4 `debt` 债务持续权重

债务持续权重控制旧债务是否被延续到后续层。

通俗理解：

- 数值低：旧债务更快被清掉，牌局压力释放更早。
- 数值高：旧债务持续存在，玩家更容易长期背负卡槽压力。

支持模式：

| mode | 示例 | 说明 |
| --- | --- | --- |
| `fixed` | `{ "mode": "fixed", "value": 0.0 }` | 固定债务权重 |
| `random` | `{ "mode": "random" }` | 0 到 1 随机 |
| `random_range` | `{ "mode": "random_range", "min": 0.55, "max": 1.0 }` | 在范围内随机 |

策划建议：

- 低难：建议偏低，例如 `0.0-0.35`。
- 中难：可以使用 `0.25-0.75`。
- 高难：可以使用 `0.55-1.0`。
- 债务持续权重会放大闭合率较低时的难度，调参时不要只看单个参数。

## 9. `evaluation` 机器人评价与质量验收

评价策略描述“怎样测”和“怎样解释测量结果”，不描述牌局如何生成。生成策略可以引用一个评价策略，也可以在人工实验阶段直接内嵌本次评价参数。

评价策略分为四层：

| 参数域 | 说明 |
| --- | --- |
| `simulations` | 使用哪些机器人、机器人参数、每种机器人运行多少次 |
| `derived_metrics` | 根据原始模拟结果计算稳定性等衍生指标 |
| `classifier` | 将模拟指标映射为 grade，允许不同类型的分档方法 |
| `acceptance` | 在分档之外，本次生成结果还必须满足的质量条件 |

### 9.1 机器人模拟参数

```json
{
  "simulations": {
    "sim1": {
      "bot": "safe_random_mistake",
      "parameters": { "mistake_rate": 0.01 },
      "runs": 200
    },
    "sim5": {
      "bot": "safe_random_mistake",
      "parameters": { "mistake_rate": 0.05 },
      "runs": 200
    },
    "sim15": {
      "bot": "safe_random_mistake",
      "parameters": { "mistake_rate": 0.15 },
      "runs": 200
    }
  }
}
```

每个模拟项至少应说明：机器人实现或行为类型、行为参数、运行次数。未来机器人增加选牌权重、随机种子、复活规则或卡槽规则时，应继续放在 `parameters` 中，不要把这些行为藏在策略名称里。

### 9.2 衍生指标

```json
{
  "derived_metrics": {
    "stability": {
      "type": "formula",
      "expression": "max(0, sim1.win_rate - sim15.win_rate)"
    }
  }
}
```

衍生指标只能使用本次评价已经产出的原始指标。它用于减少分档规则重复，不应反向改变机器人模拟结果。

### 9.3 分档器 `classifier`

`grade_formula` 不是通用字段。只有公式型策略需要表达式；策略1这类方法使用规则集合。统一入口为 `classifier.type`。

| `classifier.type` | 适用方法 |
| --- | --- |
| `weighted_formula` | 多个模拟指标加权得到估计通过率，再按阈值分档，例如策略2 |
| `rule_set` | 每档配置一组条件，全部满足时命中，例如策略1 |
| `threshold_table` | 按单个指标的连续区间分档 |
| `model` | 使用后续拟合得到的模型文件或模型版本 |

策略2的结构示例：

```json
{
  "classifier": {
    "type": "weighted_formula",
    "output_metric": "estimated_passrate",
    "expression": "clamp(0.30*sim1.win_rate + 0.10*sim5.win_rate + 0.60*sim15.win_rate + 0.08, 0, 1)",
    "grade_thresholds": [
      { "grade": 0, "min": 0.90 },
      { "grade": 1, "min": 0.60 },
      { "grade": 2, "min": 0.40 },
      { "grade": 3, "min": 0.20 },
      { "grade": 4, "min": 0.10 },
      { "grade": 5, "min": 0.00 }
    ]
  }
}
```

策略1的结构示例：

```json
{
  "classifier": {
    "type": "rule_set",
    "priority": "harder-first",
    "tiers": [
      {
        "grade": 5,
        "conditions": [
          { "metric": "sim5.win_rate", "operator": "lte", "value": 0.05 },
          { "metric": "sim1.win_rate", "operator": "lte", "value": 0.10 }
        ]
      }
    ],
    "unmatched": { "grade": -1, "status": "unclassified" }
  }
}
```

同一种策略允许存在多个人工变体。只要机器人参数、运行次数、公式、规则、阈值或优先级发生变化，就应创建新版本或新 Profile，不能仅沿用“策略1”“策略2”这种没有版本的信息。

### 9.4 额外验收条件

```json
{
  "acceptance": {
    "all": [
      { "metric": "grade", "operator": "eq", "value": 5 },
      { "metric": "sim1.win_rate", "operator": "gt", "value": 0 }
    ]
  }
}
```

`classifier` 回答牌局属于哪个档位，`acceptance` 回答本次任务是否接收该牌局。二者必须分开。例如 G5 可过样本策略先要求分档结果为 G5，再排除 `sim1` 通过率为 0 的样本。

### 9.5 当前系统兼容格式

目前生成工具实际接入的是以下紧凑格式：

```json
{
  "evaluation": {
    "grade_strategy": "strategy2",
    "sim_runs": 200,
    "threshold_profile": "current",
    "acceptance": {
      "min_sim1_wins": 1
    }
  }
}
```

生成执行器支持按档位设置相互独立的 Optimal 验收条件。任何字段留空都表示不限制该指标：

```json
{
  "evaluation": {
    "grade_strategy": "strategy2",
    "sim_runs": 100,
    "threshold_profile": "current",
    "acceptance": {
      "optimal": {
        "runs": 100,
        "grade_constraints": {
          "1": {
            "min_win_rate": 0.95,
            "min_win_starvation_per_tile": 0,
            "max_win_starvation_per_tile": 0.16
          },
          "4": {
            "max_win_rate_exclusive": 0.8,
            "min_win_starvation_per_tile": 0.25,
            "max_loss_remaining_ratio": 0.4
          }
        }
      }
    }
  }
}
```

执行顺序由 `search.optimal_first` 决定：

- `false` 或未配置：先跑 Strategy2；只有命中待补档位后才跑该档 Optimal 验收，计算成本较低。
- `true`：先跑一次 Optimal，并检查它可能满足的待补档约束；至少满足一个档位后再跑 Strategy2。
  最终仍要求 Strategy2 实际档位与该档 Optimal 约束同时匹配。适合 Strategy2 模拟较贵、Optimal
  可以提前淘汰大量候选的任务。

当前 Strategy2 运行时公式：

```text
estimated_passrate = clamp(0.30*sim1 + 0.10*sim5 + 0.60*sim15 + 0.08, 0, 1)
G0 >= 0.90, G1 >= 0.60, G2 >= 0.40, G3 >= 0.20, G4 >= 0.10, G5 < 0.10
```

Optimal 约束字段：

| 字段 | 单位与含义 |
| --- | --- |
| `min_win_rate` | 0-1；Optimal 最低胜率；留空不限制 |
| `max_win_rate_exclusive` | 0-1；Optimal 胜率上限；留空不限制 |
| `min_win_starvation_per_tile` / `max_win_starvation_per_tile` | `胜局平均断色次数 / tile总数`，0-1 |
| `max_loss_remaining_ratio` | `1 - 败局平均已走步数 / tile总数` 的上限，0-1 |

旧策略中的 `min_win_rate_exclusive` 仍可由执行器读取，但新页面统一保存为 `min_win_rate`。

线上回放必须读取策略 JSON 中的 `evaluation.acceptance.optimal`，不要另抄一份阈值。当前工具：

```bash
node --import tsx tools/append-strategy2-grades.ts \
  --input output/失误率扫描_精选打点/原始数据.csv \
  --output output/失误率扫描_精选打点_策略2分档.csv

python3 tools/analyze_optimal_experience_online.py \
  --input output/失误率扫描_精选打点_策略2分档.csv \
  --strategy output/generation_feature/strategies/optimal_experience_backfill_v1.json \
  --output output/Optimal体验筛选_线上验证
```

它与整体设计的对应关系如下：

| 当前字段 | 整体设计 |
| --- | --- |
| `grade_strategy` | `classifier` 的人工配置名称 |
| `sim_runs` | 各 `simulations.*.runs` 的统一简写 |
| `threshold_profile` | `classifier` 的版本或 Profile 引用 |
| `min_sim1_wins` 等 | `acceptance` 条件简写 |

`run-batch-generation` 已支持目标 Grade、闭合率范围、花色比例范围与浮动、分布范围、债务范围、
SIM 最低胜局、最低 passrate 和按 Grade 配置的 Optimal 验收。新增字段时仍需同步更新执行适配器，
不能只让页面和 JSON 接受字段。

`threshold_profile="current"` 目前只是兼容别名，不会自动冻结公式。正式产出必须依赖 run 内的
`strategy_snapshot.json` 和代码版本追溯；当 Strategy2 公式或阈值再次变化时，应改成明确版本名，
例如 `strategy2_v2`，不要继续复用 `current` 解释不同算法。

设计建议：

- 只要求 `grade` 可能不够，尤其是 G5 可能出现大量 `sim1Wins=0`。
- 评价结果必须记录机器人参数和运行次数，否则同名指标不可比较。
- `runs` 越高结果越稳定，但生成速度越慢。
- 分档规则与额外验收条件分开，资源合并和替换规则则属于后续发布流程。

## 10. `search` 搜索与执行强度

示例：

```json
{
  "search": {
    "attempts_per_level": 500,
    "max_attempts_per_missing": 500,
    "template_attempts": 200,
    "concurrency": 5,
    "shuffle": true,
    "resume": true
  }
}
```

参数说明：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `attempts_per_level` | integer | 每个目标档位的基础尝试预算；同一地形的多个目标档位共享合并后的总预算 |
| `target_from_output_only` | boolean | 输入只用于判断应有档位，仅生成输出计入目标数量，适合发现带完整参数的模板 |
| `adaptive_search` | boolean | 启用按目标难度趋势变异的参数搜索 |
| `adaptive_explore_rate` | number | 自适应模式下完全随机探索的比例，建议保留 `0.2` |
| `adaptive_pool_size` | integer | 每档保留的近目标参数数量 |
| `adaptive_min_samples` | integer | 开始趋势变异前至少积累的随机样本数 |
| `adaptive_continuous_step` | number | 分布和债务每次趋势变异的基础步长 |
| `optimal_first` | boolean | 先执行 Optimal 区间预筛，至少匹配一个待补档后再运行策略2 |
| `max_attempts_per_missing` | integer | 每个缺失目标的尝试上限 |
| `template_attempts` | integer | 寻找首个可用参数模板的尝试上限 |
| `reuse_template_params` | boolean | 是否复用成功参数。与 `resume=true` 一起使用时，会先从已有输出 CSV 读取同地形、同 Grade 的完整历史参数池，并随机选取模板重生成；没有历史模板时再随机寻找 |
| `concurrency` | integer | 并发执行数量 |
| `shuffle` | boolean | 是否打乱任务顺序 |
| `resume` | boolean | 是否从已有输出继续 |

设计建议：

- 大范围补缺时建议 `shuffle=true`，避免长期卡在某个难地形。
- 电脑负载不确定时，先用 `concurrency=3-5`。
- 长时间任务建议 `resume=true`，中断后可继续。
- 如果某档长期搜不到，不一定是尝试次数不够，可能是目标档在当前参数空间下不可达。

## 11. `outputs` 产物需求

示例：

```json
{
  "outputs": {
    "min_per_level_grade": 0,
    "cap_per_level_grade": 10,
    "write_csv": true,
    "write_replay_json": false,
    "write_calibration_xlsx": true,
    "write_config_json": false
  }
}
```

参数说明：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `min_per_level_grade` | integer | 某地形/档位达到该数量才整体启用；0 表示不设最低门槛 |
| `cap_per_level_grade` | integer | 每地形每档最多保留多少条 |
| `write_csv` | boolean | 是否输出牌局 CSV |
| `write_replay_json` | boolean | 是否导出 replay JSON |
| `write_calibration_xlsx` | boolean | 是否生成或更新校准工具 |
| `write_config_json` | boolean | 是否生成线上配置 JSON |

设计建议：

- `cap_per_level_grade=0` 表示不设上限。当前“至少8局”资源口径使用
  `min_per_level_grade=8`、`cap_per_level_grade=0`，达到门槛后保留该档全部牌局。
- 中间搜索阶段通常只写 CSV。
- 进入配置验证阶段再写校准工具和配置 JSON。
- replay JSON 应在最终 selection 清洗后导出，避免把调参字段带到线上资源。

## 12. `adapter` 执行器

示例：

```json
{
  "adapter": {
    "executor": "backfill-missing-grades",
    "mode": "plan_command"
  }
}
```

参数说明：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `executor` | enum | 具体执行器 |
| `mode` | enum | `plan_command` 只生成命令，`execute_command` 允许计划后执行 |

当前执行器：

| executor | 用途 |
| --- | --- |
| `run-batch-generation` | 基础批量生成 |
| `backfill-missing-grades` | 按缺失档位补齐或重刷 |
| `search-missing-grade-samples` | 寻找缺失档位样本 |
| `build-calibration-variant` | 构建校准工具变体 |
| `refresh-endless-simulation` | 刷新无尽池模拟 |

设计建议：

- 策划配置不应关心脚本细节，但要选择正确执行器。
- 如果某个需求无法用现有执行器表达，应先扩展执行器或 adapter 映射，再创建策略。

## 13. 通用策略模板

### 基础批量生成

```json
{
  "meta": {
    "strategy_id": "example_base_batch_v1",
    "name": "示例基础批量生成",
    "version": 1,
    "purpose": "为指定地形生成 G0-G5 候选牌局",
    "status": "draft",
    "notes": ""
  },
  "scope": {
    "terrain_source": "level_json",
    "include_levels": [100075],
    "exclude_levels": [],
    "levels_dir": "../TileMatchShell/Tools/Config/Json/Levels"
  },
  "target": {
    "grades": [0, 1, 2, 3, 4, 5],
    "target_count_per_grade": 10,
    "fill_policy": "all",
    "fallback_policy": "none"
  },
  "generation": {
    "closure": { "mode": "random" },
    "color": { "mode": "ratio", "ratio": 0.6 },
    "spread": { "mode": "random" },
    "debt": { "mode": "random" }
  },
  "evaluation": {
    "grade_strategy": "strategy2",
    "sim_runs": 200,
    "threshold_profile": "current"
  },
  "search": {
    "attempts_per_level": 500,
    "template_attempts": 100,
    "concurrency": 5,
    "shuffle": true,
    "resume": false
  },
  "outputs": {
    "cap_per_level_grade": 10,
    "write_csv": true,
    "write_replay_json": false,
    "write_calibration_xlsx": false,
    "write_config_json": false
  },
  "adapter": {
    "executor": "run-batch-generation",
    "mode": "plan_command"
  }
}
```

### 指定质量补缺或重刷

```json
{
  "target": {
    "grades": [5],
    "target_count_per_grade": 10,
    "fill_policy": "missing_only",
    "fallback_policy": "none",
    "min_existing_count": 1
  },
  "evaluation": {
    "grade_strategy": "strategy2",
    "sim_runs": 200,
    "threshold_profile": "current",
    "acceptance": {
      "min_sim1_wins": 1
    }
  }
}
```

这个模板表示：旧数据中不满足 `sim1Wins >= 1` 的行不算已有数量，新搜索结果也必须满足该条件。

## 14. 常用命令

初始化或刷新索引：

```bash
cd /Users/wenhaowang/WorkSpace/reversegen

/Users/wenhaowang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  tools/manage_generation_feature.py init
```

查看策略：

```bash
/Users/wenhaowang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  tools/manage_generation_feature.py list-strategies
```

校验策略：

```bash
/Users/wenhaowang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  tools/manage_generation_feature.py validate \
  --strategy <strategy_id>
```

生成 run 目录：

```bash
/Users/wenhaowang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  tools/manage_generation_feature.py plan \
  --strategy <strategy_id> \
  --run-id <run_id>
```

执行 run：

```bash
bash output/generation_feature/runs/<run_id>/command.sh
```

查看状态：

```bash
cat output/generation_feature/runs/<run_id>/logs/backfill_status.json
```

## 15. 策划调参参考

| 目标 | 建议方向 |
| --- | --- |
| 更简单 | 提高闭合率、降低花色数、降低 spread、降低 debt |
| 更难 | 降低闭合率、提高花色数、提高 spread、提高 debt |
| 更稳定 | 固定闭合率和花色数，减少随机范围 |
| 更多探索 | 使用随机范围，加大尝试次数和 shuffle |
| 避免必死高难 | 保持目标 G5，同时加 `min_sim1_wins=1` |
| 补低难保底 | 提高闭合率，降低花色数，必要时用规则 G0，但要标明口径 |

## 16. 风险与约束

- 标准 JSON 不能写注释语法。
- 当前完整评价结构是参数设计规范，现有执行器尚未全部接入。
- 评价策略由人工设计，系统不会自动判断哪一种公式或规则最适合业务目标。
- 同名评价策略可能有多个变体，必须记录版本、机器人参数和运行次数。
- 策略 JSON 修改后，旧 run 不会自动更新。
- 正式生成必须从 run 目录执行，避免产物不可追溯。
- 只看 `grade` 不一定能代表体验质量，需要结合 `sim1/sim5/sim15` 或 passrate 验收。
- G0 规则补缺不是策略2真实 G0，不能直接代表线上自然低难。
- 高并发会提高 CPU 占用，不一定线性提升速度。
- 大量补缺时，如果某档长期搜不到，应考虑调整参数空间，而不是只增加尝试次数。

## 17. 当前内置策略参考

当前项目中已有策略可以作为例子，但它们不是本文档的重点：

- `base_random_s2_v1`：基础随机批量生成。
- `low_grade_backfill_v1`：低难度补缺。
- `g5_sim1_positive_refill_v1`：G5 可过样本重刷。
- `optimal_experience_backfill_v1`：Strategy2 分档 + Optimal 体验筛选补全。
- `optimal_random_color_backfill_v1`：纯随机颜色落位的 Optimal 补全实验。
- `optimal_similar_template_backfill_v1`：按历史相似参数重生成。
- `optimal_template_discovery_adaptive_v1`：自适应发现可用参数模板。
- `endless_sim_refresh_current_v1`：当前无尽池模拟刷新。
- `endless_sim_refresh_no_backfill_v1`：无补缺无尽池模拟刷新。
