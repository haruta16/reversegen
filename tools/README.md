# tools 工作台说明

这个目录主要放关卡难度、模拟胜率、静态结构指标和生成器复现实验用的脚本。它们不是一套稳定 CLI，更多是研究/验证工具箱：有些脚本会改写 `output/` 下的 CSV，有些依赖本机历史数据路径，有些计算量很大。

建议之后先看这份说明，再决定跑哪个脚本。

## 运行前检查

- TypeScript 脚本通常用：

  ```bash
  npx tsx tools/脚本名.ts
  ```

- Python 分析脚本通常用：

  ```bash
  python3 tools/脚本名.py
  ```

- 项目依赖见根目录 `package.json`，本机需要能运行 `tsx`。
- 很多脚本默认读写 `output/`，并假设存在历史数据，例如：
  - `output/sim_results.csv`
  - `output/失误率扫描/原始数据.csv`
  - `output/sim_mistake_sweep.csv`
- 部分脚本会寻找本机地形目录：
  - `../TileMatchShell/Tools/Config/Json/Levels`
  - `/Users/wenhaowang/WorkSpace/levels_json/...`
  - 少数旧脚本仍写死 `/Users/haruta16/...`

## 批量策略 v2（新生产唯一入口）

新批量生成不再使用 `output/generation_feature/strategies/*.json`。策略、执行引擎、
生成器、模拟策略、分档和筛选统一由仓库内的 v2 策略定义：

- 正式策略：`strategies/current_calibration/strategy.v2.json`
- JSON Schema：`config/strategy-v2.schema.json`
- 唯一执行入口：`tools/run-strategy.ts`
- Rust 策略模拟器：`rust/strategy-sim/`
- 完整说明：`docs/strategy-pipeline-v2.md`

```bash
npm run strategy:rust:build
npm run strategy:validate
npm run strategy:plan
npm run strategy:run
```

最小实跑：

```bash
npm run strategy:run -- \
  --levels 100075 \
  --max-attempts 1 \
  --concurrency 1 \
  --output-dir output/runs/current_calibration/smoke_100075_1_attempt
```

默认运行目录是被 Git 忽略的 `output/runs/<strategy_id>/<run_id>/`。每次运行产出
`manifest.json`、`plan.json`、`strategy.snapshot.json`、`records.jsonl`、
`accepted.jsonl`、`status.json` 和 `timing.log.jsonl`。CSV、工作簿、replay selection
都应从 JSONL 再投影，不再作为策略内部协议。

网页的“批量产关”会把页面参数编译为临时 strategy v2，再调用同一执行入口。
“产出策略”页保留表单编辑体验，但保存的可执行文件直接是
`strategies/<strategy_id>/strategy.v2.json`。主页的单局生成、分析和验证链路不走批量策略。

## 历史生产与研究工具（不接入新策略）

以下命令保留用于复现历史 CSV、工作簿和分析结果，不作为新批量生产入口。旧策略 JSON
无需迁移到 v2，也不要与 `tools/run-strategy.ts` 混用。

牌局生成与机器人评价参数的长期说明见 `docs/level-generation-strategy-feature.md`。这里保留常用命令和工具索引。

| 脚本 | 作用 | 典型输入 | 主要输出/影响 |
| --- | --- | --- | --- |
| `manage_generation_feature.py` | 生成牌局 feature 管理入口；维护策略 JSON、运行 JSONL 和每次运行文件夹 | `output/generation_feature/strategies/*.json` | `output/generation_feature/runs/<run_id>/`、`runs.jsonl`、索引 CSV |
| `run-batch-generation.ts` | 历史 CSV 批量入口；不再被网页批量产关调用 | 地形 ID、生成参数、模拟参数 | 历史格式 CSV |
| `build_calibration_variant.py` | 从任意牌局 CSV 构建固定版式的校准工具变体；支持每地形/难度最低门槛与可选上限，并刷新覆盖、前80备注和无尽池模拟 | 任意最终牌局 CSV | 校准 CSV、`output/*校准工具*.xlsx`、构建报告 JSON |
| `build_minimum_resource_package.py` | 合并多个牌局来源，按最低数量启用整档并保留该档全部牌局，一次产出校准工具、replay JSON、LevelPool/Zones 配置和运行清单 | 原始筛选 CSV、补档 CSV | `output/strategy_runs/<run>/` 完整资源包 |
| `export_endless_config_from_workbook.py` | 从校准工具导出 `LevelPool`、`Zones`，其余配置字段保持底板不变 | 校准工作簿、配置底板 | 新配置 JSON、构建报告 |
| `refresh_endless_simulation.py` | 修改 `无尽难度集` 后，只刷新 `无尽池模拟10000组` 页签 | `output/无尽关校准工具.xlsx` 或 `output/无尽关校准工具_无补缺.xlsx` | 原地更新工作簿模拟页，输出模拟报告 JSON |
| `backfill-missing-grades.ts` | 按目标档位补缺；G0 使用规则补缺，G1-G5 使用策略2验收搜索 | capped/基础牌局 CSV | 补缺 CSV、补缺计划、状态 JSON |
| `apply_mainline_g0_sequence_update.py` | 将主线 G0 补全和特定前80 sequence 修正合入正式数据口径 | 最终 capped CSV、主线 G0 补全 CSV、校准工具 | 更新最终 CSV、校准工具、replay selection |
| `verify-g0-strategy2-sample.ts` | 抽样验证规则补缺 G0 在策略2下实际落档 | 历史补缺 CSV（按 `--input` 指定） | 可重建的抽样报告，不长期保留 |
| `try-g0-low-color-sample.ts` | 尝试低花色系数生成真实策略2 G0 样本 | 历史补缺 CSV（按 `--input` 指定） | 可重建的低花色实验报告，不长期保留 |

常用命令：

```bash
# 初始化生成牌局 feature 管理表
/Users/wenhaowang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  tools/manage_generation_feature.py init

# 只刷新 Schema，不覆盖现有策略 JSON
python3 tools/manage_generation_feature.py init --overwrite-schema

# 校验策略 JSON
/Users/wenhaowang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  tools/manage_generation_feature.py validate \
  --strategy output/generation_feature/strategies/base_random_s2_v1.json

# 创建一次可追溯运行记录，不立即执行
/Users/wenhaowang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  tools/manage_generation_feature.py plan \
  --strategy base_random_s2_v1 \
  --run-id test_100075_100074 \
  --notes "测试100075/100074基础随机策略"

# 封装并执行一次旧无尽池模拟刷新，产物落到 run/02_analysis
/Users/wenhaowang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  tools/manage_generation_feature.py plan \
  --strategy endless_sim_refresh_current_v1 \
  --run-id legacy_endless_sim_current \
  --execute

# 页面端批量生产
npm run gui -- --port 3000
# 打开 http://localhost:3000/batch-generate.html

# 后台批量生产
npx tsx tools/run-batch-generation.ts \
  --levels 100075,100074 \
  --output output/批量生成.csv \
  --color-ratio 0.6 \
  --close-rates random \
  --spread random \
  --debt random \
  --sim-runs 200 \
  --target-per-tier 10 \
  --max-attempts 500 \
  --concurrency 5

# 从任意输入构建固定版式的校准变体
/Users/wenhaowang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  tools/build_calibration_variant.py \
  --variant-name 示例策略 \
  --source-csv output/输入牌局.csv \
  --template-workbook output/无尽关校准工具.xlsx \
  --output-csv output/示例策略_每档最多10.csv \
  --output-workbook output/示例策略_校准工具.xlsx \
  --report output/示例策略_校准构建报告.json \
  --cap 10

# 核对当前保留的原始线上数据和三次有效产出
python3 tools/audit_effective_outputs.py --check

# 修改无尽难度集后刷新模拟
/Users/wenhaowang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  tools/refresh_endless_simulation.py \
  --workbook output/无尽关校准工具.xlsx \
  --report output/无尽关校准工具_模拟刷新报告.json

# 合并当前有效牌局；每档至少 8 局才启用，达到后保留该档全部牌局
python3 tools/build_minimum_resource_package.py \
  --source output/replay导出_G5替换/selection_Optimal体验筛选_v1.csv \
  --source output/generation_feature/runs/optimal_experience_backfill_20260629/01_generation/backfill.csv \
  --min-count 8

# 将当前 Strategy2 + 指定策略的 Optimal 评价配置回放到精选在线数据
node --import tsx tools/append-strategy2-grades.ts \
  --input output/失误率扫描_精选打点/原始数据.csv \
  --output output/失误率扫描_精选打点_策略2分档.csv

python3 tools/analyze_optimal_experience_online.py \
  --input output/失误率扫描_精选打点_策略2分档.csv \
  --strategy output/generation_feature/strategies/optimal_experience_backfill_v1.json \
  --output output/Optimal体验筛选_线上验证

# 生成 G5 可过样本重刷策略运行目录
/Users/wenhaowang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  tools/manage_generation_feature.py plan \
  --strategy g5_sim1_positive_refill_v1 \
  --run-id g5_sim1_positive_refill_YYYYMMDD

# 执行该 run 目录下的命令
bash output/generation_feature/runs/g5_sim1_positive_refill_YYYYMMDD/command.sh
```

当前工作簿约定：

- `无尽难度集` 页签里的 G0-G5 单次通过率可以直接修改，会影响期望次数公式。
- 修改 GradeSequence 后，需要运行 `refresh_endless_simulation.py` 刷新模拟页。
- 工具链当前默认 G0-G5 六档；扩展 G6/G7 需要同步改工作簿列、工具脚本、CSV/JSON 校验和线上配置约定。

批量生产参数约定：

- `close-rates=random`：每层按累积牌数随机目标 triplet 数；前 2 层在物理可行时累计 target 至少为 1 组；固定值用逗号分隔。
- `color-ratio`：随机花色数系数，公式为 `floor(ratio * floor(freeTiles / 3))`。
- `spread`：同色分布，`0` 紧密、`1` 分散。
- `debt`：债务持续权重，`0` 清旧债、`1` 延旧债。
- `sim-runs`：候选牌局评估模拟次数。
- `target-per-tier`：每档目标收集条数。
- `max-attempts`：每个地形最大尝试次数。
- `concurrency`：同时跑的地形数量。

补缺脚本 `backfill-missing-grades.ts` 可以后续适配成与 `run-batch-generation.ts`
一致的 CLI 风格；当前先保留独立补缺语义。

### 生成策略管理

`output/generation_feature/` 是轻量策略管理目录：

- `strategies/*.json`：策略主数据，描述生成目标、参数域、评估和验收条件。
- `strategy.schema.json`：策略校验规则。
- `runs/<run_id>/`：每次运行的快照目录，包含 `run_config.json`、`strategy_snapshot.json`、
  `command.sh`、`01_generation/`、`02_analysis/`、`03_config/`、`logs/`。
- `runs.jsonl` / `runs.csv`：运行索引。

策略 JSON 里的 `evaluation.acceptance` 可以继续细分验收口径。目前支持：

- `min_sim1_wins`
- `min_sim5_wins`
- `min_sim15_wins`
- `min_passrate`
- `optimal`：按档位配置 Optimal 胜率、胜局断色率和败局剩余比例区间

这些字段会由 `manage_generation_feature.py plan` 翻译成 `backfill-missing-grades.ts` 的
`--accept-min-*` 参数。补缺计划统计时，旧 CSV 中不满足验收条件的牌局不会计入已满足数量；
搜索写出时，新牌局也必须同时满足目标 `grade` 和验收条件。

Optimal 验收的紧凑配置如下。胜率和剩余比例使用 `0-1`，断色率使用
`胜局平均断色次数 / 地形总牌数`：

```json
{
  "optimal": {
    "runs": 100,
    "grade_constraints": {
      "3": {
        "min_win_rate": 0.8,
        "min_win_starvation_per_tile": 0.16,
        "max_win_starvation_per_tile": 0.34
      },
      "5": {
        "min_win_rate_exclusive": 0,
        "max_win_rate_exclusive": 0.8,
        "max_loss_remaining_ratio": 0.4
      }
    }
  }
}
```

补缺执行器支持 `generation.color.mode=range`，并会在每次尝试时从 `min/max`
重新抽取花色系数。`search.reuse_template_params=false` 表示命中后仍继续随机参数；
`search.attempts_per_level` 表示每个目标档位提供给该地形的基础尝试预算，多个档位的
预算会合并使用。例如一个地形缺 3 个档位且值为 100，则该地形最多搜索 300 次。
每个地形只启动一个任务，候选落入任一未补满档位并通过该档 Optimal 验收后都会保留。

内置的 `optimal_experience_backfill_v1` 使用策略2初分档、Optimal 二次验收，
并按原补缺规则从地形最高档向下补齐有效库存。

`optimal_template_discovery_adaptive_v1` 用于先找每个“地形×档位”的首条可复用参数模板：

- `target_from_output_only=true`：历史输入只决定应有档位，只有生成输出计入模板目标。
- `adaptive_search=true`：保留每档最接近目标的参数池，按策略2 passrate 和 Optimal 失败原因调难/调简单。
- `adaptive_explore_rate=0.2`：20% 尝试仍完全随机，避免趋势搜索卡在局部区域。
- 花色数每次变异 `±1`；分布/债务默认步长 `0.08`；闭合率按累计整数闭合组 `±1` 后反算。
- `adaptive_min_samples=3`：每档至少积累3个随机结果后才开始趋势变异，降低早期噪声误导。
- `optimal_first=true`：先用一组 Optimal 指标匹配所有待补档位，至少命中一个档位区间后才运行策略2三组机器人。

当前内置策略里，`g5_sim1_positive_refill_v1` 用于重刷 G5：

- 输入：`output/100003～100071_100073+_合并去少_无补缺_每档最多10.csv`
- 目标：已有 G5 支持的地形，每个地形补到 10 条有效 G5。
- 验收：策略2分档为 G5，且 `sim1Wins >= 1`。
- 用途：替换/补齐当前底板中大量 `sim1Wins=0` 的 G5，避免 G5 近似“模拟必死”。

## 研究/验证工具入口

这些是历史上最值得理解和复用的研究脚本。

| 脚本 | 作用 | 典型输入 | 主要输出/影响 |
| --- | --- | --- | --- |
| `batch-sim-all.ts` | 对 replay 批量跑机器人策略和失误率扫描 | `output/sim_results.csv` | `output/` 或 `output/<name>/` 下的原始模拟数据、checkpoint |
| `append-optimal-metrics.ts` | 只跑 Optimal 机器人，将胜率、强制选择、断色和失败进度追加在 selection 原列后；支持并发、限量测试和断点续跑 | replay selection CSV | `selection_optimal.csv`、progress JSONL、checkpoint |
| `evaluate-sim-grade-estimator.ts` | 使用 `sim1/sim5/sim15` 做六档胜率估计，也就是“评估策略2”的核心离线验证 | `output/失误率扫描/原始数据.csv` | `output/全量难度估计结果.csv`、分布 CSV、报告 MD |
| `fit_optimal_online_estimator.py` | 按地形分组交叉验证，对比策略2、sim重新拟合、Optimal参数模型及联合模型 | 带线上胜率和Optimal打点的扫描 CSV | 模型对比、逐牌局预测、模型参数和分档分布 |
| `filter_optimal_experience_selection.py` | 按当前L1-L5 Optimal体验区间筛选标准 selection；保留14列转换格式并输出原因报告 | `selection_optimal.csv` | Optimal体验筛选 selection、JSON报告 |
| `analyze_optimal_experience_online.py` | 将同一Optimal体验筛选规则回放到历史在线样本，验证各档真实线上胜率变化 | 策略2分档后的在线扫描 CSV | 档位前后统计、十档分布、逐牌局结果 |
| `analyze-layer-progress-features.ts` | 追加逐层闭合率、花色使用率、债务数量、债务保留率等静态指标，并做分档增量评估 | `output/失误率扫描/原始数据.csv` | 原地更新 CSV，输出预测对比 CSV/JSON |
| `analyze_layer_metric_significance.py` | 对逐层/债务类指标做相关性、分组显著性、简易预测贡献分析 | 已经带逐层指标的 CSV | `output/逐层指标显著性分析.*` |
| `compare-closure-generation.ts` | 选线上必输关，比较原关和“同地形/同花色数/同闭合率”生成结果的差异 | `output/sim_results.csv` | `output/闭合率复现必输牌局_*` |
| `enrich-bottom3-completion.ts` | 计算“每个颜色依赖深度最深三张”的完成成本，属于之前讨论过的静态特征 | `output/失误率扫描/原始数据.csv` | 原地更新 CSV，输出底部三张分析结果 |

## 按任务分类

### 1. 批量模拟与机器人策略

#### `batch-sim-all.ts`

多策略批量模拟工具。会跑普通 player、risky、costcap、random、greedy，以及 `mistakeRate=0.01..0.15` 的失误机器人扫描。

常用命令：

```bash
npx tsx tools/batch-sim-all.ts --quick
npx tsx tools/batch-sim-all.ts --mistake-only --output 失误率扫描
npx tsx tools/batch-sim-all.ts --resume --output 失误率扫描
npx tsx tools/batch-sim-all.ts --strategy player --limit 10
```

注意：

- 默认会比较重。
- `--resume` 依赖对应输出目录下的 checkpoint。
- 默认输入是 `output/sim_results.csv`。

#### `batch-sim.ts`

旧版批量模拟。路径仍写死 `/Users/haruta16/...`，除非先改路径，否则不建议直接跑。

#### `test-slot-reserve.ts`

实验“保留卡槽/失误率”策略的脚本。适合研究机器人行为，不是当前主流程。

#### `timing-test.ts`

旧的性能 benchmark，依赖 `output/replaykey_code_map.json` 和旧硬编码路径。现在主要当历史参考。

### 2. 胜率估计与分档分析

#### `evaluate-sim-grade-estimator.ts`

当前“评估策略2”的离线验证入口。核心公式：

```ts
passrate = clamp(0.30 * sim1 + 0.10 * sim5 + 0.60 * sim15 + 0.08, 0, 1)
```

然后按在线胜率目标区间映射六档：

- `90-100%`：0
- `60-90%`：1
- `40-60%`：2
- `20-40%`：3
- `10-20%`：4
- `0-10%`：5

这个脚本适合回答：“只看 sim1/5/15，能不能更稳定预测线上胜率分档？”

#### `analyze-mistake-sweep.ts`

对完整失误率扫描做统计、校准查表和报告。适合看不同 `mistakeRate` 与线上胜率的整体关系。

常用命令：

```bash
npx tsx tools/analyze-mistake-sweep.ts --input 失误率扫描
```

#### `search-grade-combo.ts`

搜索可解释的 sim 组合规则。输入默认 `output/sim_mistake_sweep.csv`，也可以传自定义 CSV：

```bash
npx tsx tools/search-grade-combo.ts output/sim_mistake_sweep.csv
```

#### `search-grade-strategy-6.ts`

搜索低覆盖但高置信的六档规则。更像“找确定性标签边界”，不是全覆盖估计器。

#### `analyze-correlation.ts`

旧的模拟胜率与线上胜率相关性分析，默认读 `output/sim_results.csv`。

### 3. 静态牌局特征补充

#### `analyze-layer-progress-features.ts`

目前最重要的静态结构特征脚本之一。会从 replayCode 和地形静态解析：

- 逐层闭合率
- 逐层花色使用率
- 花色平均启用层
- 逐层债务 tile 数
- 逐层债务保留率
- 加权债务保留率

注意：它会原地更新 `output/失误率扫描/原始数据.csv`，属于会改数据的脚本。

#### `analyze_layer_metric_significance.py`

用于看上面这些静态指标是否与线上胜率显著相关。适合回答：“债务保留、花色使用率、持续长度，哪个更值得作为生成控制参数或评估指标？”

#### `analyze-suit-spread.ts`

为失误率扫描原始数据补充花色离散度，并输出趋势分析。会原地更新 CSV。

#### `enrich-bottom3-completion.ts`

计算“每个颜色依赖深度最深三张牌”的完成成本：

- 每个颜色选依赖深度最深的三张。
- 完成牌数 = 这三张自身 + 它们的传递依赖闭包并集。

这个指标解释性强，但之前验证增量有限。保留它主要是为了复现旧分析。

#### `analyze-color-tile-difficulty.ts`

分析花色数、tile 数、每花色 tile 数与难度的关系。依赖 `output/全量难度估计结果.csv`。

### 4. 闭合率/债务生成复现实验

#### `compare-closure-generation.ts`

用于比较线上必输牌局和当前 LayerClosure 生成器的差距。它会：

1. 从 `output/sim_results.csv` 里选线上胜率为 0 的关。
2. 抽取原始牌局的闭合率、花色使用率、债务持续/债务面积等结构。
3. 用相同地形、相同花色数、相同闭合率重新生成若干样本。
4. 对比新旧牌局的结构差异。

这个脚本特别适合验证：“闭合率够不够？是否还缺债务持续、花色启用时间之类控制？”

### 5. DAG / 逻辑结构分析

这些脚本更偏研究和诊断，可能重、可能依赖 cache，不建议日常随手跑。

#### `dag/board-dag.ts`

板级 DAG 特征库。它不是主要 CLI，而是给其它分析脚本调用，用于从实际花色分配构建 triple DAG / color DAG 特征。

#### `dag/triple-analyzer.ts`

对地形层面的 triple 关系做静态分析，会枚举大量 triple 并写 cache。适合研究地形结构瓶颈，但计算较重。

#### `dag/enhanced-dag.ts`

增强 DAG 分析，编码可点/阻塞、独占/共享阻塞、色内结构、Gate 等更细结构。研究价值高，但不是当前主流程。

#### `dag/deadlock-hunter.ts`

从 cache 里找未解牌局，尝试归因死锁机制，例如环、入口瓶颈、sink starvation 等。依赖 `.reversegen-cache/board-results-v2`。

#### `dag/verify-death.ts`

轻量死亡验证库：从某个死亡状态出发，只检查是否还能形成下一个 triple。不是独立主入口。

#### `dag-features-compare.ts`

比较被高估的困难关、正确困难关和普通关的 DAG 特征。默认读 `output/失误率扫描/原始数据.csv` 和 `output/sim_results.csv`。

### 6. 消除计划 / 可解路径研究

#### `planning/elimination-plan.ts`

消除计划器库。目标是用逻辑前提和释放结果构造可解性证明，而不是只靠模拟。

#### `planning/deep-analyze.ts`

对选定牌局做完整路径空间 DFS，并和 DAG 特征对齐。非常重，适合小样本深挖。

#### `planning/deep-plan-single.ts`

单关详细消除计划诊断，会逐步分析候选 triple、释放结果、死亡点。含历史路径探测逻辑，跑之前先确认数据目录。

### 7. 单关/Replay 诊断

#### `diag-replay.ts`

旧单关诊断脚本，依赖 `output/replaykey_code_map.json` 和硬编码 replay key。现在如果要分析某一关，通常临时写更小的脚本会更干净。

## 会改写数据的脚本

跑这些脚本前最好先确认 git 状态或备份 CSV：

- `analyze-layer-progress-features.ts`
- `analyze-suit-spread.ts`
- `enrich-bottom3-completion.ts`

它们会给 `output/失误率扫描/原始数据.csv` 追加列或更新列。

## 计算可能很重的脚本

这些脚本适合加 `--quick`、`--limit`，或先在小样本上跑：

- `batch-sim-all.ts`
- `dag/triple-analyzer.ts`
- `dag/enhanced-dag.ts`
- `planning/deep-analyze.ts`

## 历史/路径风险较高的脚本

这些脚本里有旧机器路径、旧数据格式或较强 cache 假设：

- `batch-sim.ts`
- `timing-test.ts`
- `diag-replay.ts`
- `planning/deep-plan-single.ts`
- 部分 DAG 深挖脚本

使用前建议先读顶部常量，把路径改成当前机器的数据目录。

## 当前难度研究的推荐流程

如果目标是继续研究“为什么某些关看起来前期轻松、后期点哪里都要四五步，导致线上必输”，推荐顺序是：

1. 用 `batch-sim-all.ts` 生成或更新 `sim1..sim15`。
2. 用 `evaluate-sim-grade-estimator.ts` 得到策略2 passrate 和六档估计。
3. 用 `analyze-layer-progress-features.ts` 给同一批数据补逐层闭合率、花色使用率、债务数量、债务保留率。
4. 用 `analyze_layer_metric_significance.py` 看哪些静态指标真正和线上胜率相关。
5. 用 `compare-closure-generation.ts` 检查当前生成器能否复现线上必输关结构。

这个流程里，“闭合率”更像控制每层债务数量；“债务保留/持续长度”和“花色启用时间”更像解释为什么相同闭合率下后期压力完全不同。
