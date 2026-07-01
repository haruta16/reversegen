# 测试资源产出 SOP

本文记录无尽关/主线测试资源从生成、校准到配置导出的稳定流程。

## 0. Feature 化管理

生成关卡牌局现在按 feature 管理，不再只靠散落的临时命令和文件名追溯。

后台管理入口：

```bash
/Users/wenhaowang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  tools/manage_generation_feature.py init
```

初始化后会生成：

- `output/generation_feature/strategies/`：策略 JSON 主目录，每个策略一个 JSON。
- `output/generation_feature/strategy.schema.json`：策略字段约束说明。
- `output/generation_feature/strategies.csv`：策略 JSON 的可读索引导出，不作为主数据手改。
- `output/generation_feature/runs.jsonl`：每次运行的追加式主记录。
- `output/generation_feature/runs.csv`：运行记录的可读索引导出。
- `output/generation_feature/runs/<run_id>/`：每次运行的独立文件夹。

可视化入口为 `/generation-strategies.html`。页面支持新建、复制、编辑、权威校验和 JSON 导出；
更新已有策略会自动递增版本，并将不可变快照保存到
`output/generation_feature/strategy_history/<strategy_id>/`。历史查询以这些快照和 run 内的
`strategy_snapshot.json` 为准。

每个 run 文件夹固定分层：

- `01_generation/`：牌局生成结果，例如 batch CSV、补缺 CSV。
- `02_analysis/`：校准工具、构建报告、补缺计划等分析产物。
- `03_config/`：配置 JSON、replay JSON 等可投放产物。
- `logs/`：执行日志、状态 JSON。
- `strategy_snapshot.json`：本次运行使用的策略快照。
- `run_config.json`：本次运行的完整命令、参数和产物路径。
- `command.sh`：可重复执行的命令。

查看策略：

```bash
/Users/wenhaowang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  tools/manage_generation_feature.py list-strategies
```

校验单个策略：

```bash
/Users/wenhaowang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  tools/manage_generation_feature.py validate \
  --strategy output/generation_feature/strategies/base_random_s2_v1.json
```

创建一次运行记录，不立即执行：

```bash
/Users/wenhaowang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  tools/manage_generation_feature.py plan \
  --strategy base_random_s2_v1 \
  --run-id test_100075_100074 \
  --notes "测试100075/100074基础随机策略"
```

创建并执行：

```bash
/Users/wenhaowang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  tools/manage_generation_feature.py plan \
  --strategy base_random_s2_v1 \
  --run-id test_100075_100074 \
  --execute
```

当前默认样例策略：

- `base_random_s2_v1`：基础批量生产，随机闭合率、随机分布/债务，策略2分档。
- `low_grade_backfill_v1`：低难补缺样例，G0/G1/G2 缺档补样，闭合率/花色/分布/债务参数可调。
- `endless_sim_refresh_current_v1`：封装正式校准工具的无尽池 10000 组模拟刷新。
- `endless_sim_refresh_no_backfill_v1`：封装无补缺校准工具的无尽池 10000 组模拟刷新。

策略 JSON 用参数域描述“怎么生产牌局”，而不是枚举某个历史脚本。关键字段包括：

- `meta`：策略 ID、名称、版本、目的、状态、说明。
- `scope`：地形来源、关卡区间、包含/排除关卡、输入 CSV、模板工作簿。
- `target`：目标难度、每档目标数、补缺/探测策略、回退策略。
- `generation`：闭合率、花色数、同色分布、债务参数，支持随机、范围、固定点等模式。
- `evaluation`：分档策略、模拟次数、阈值版本。
- `search`：尝试次数、模板次数、并发数、shuffle、resume。
- `outputs`：每地形/难度截断数，以及是否产 CSV、replay、校准表、配置。
- `adapter`：把抽象策略映射到当前可执行脚本，例如 `run-batch-generation` 或 `backfill-missing-grades`。

后续新增策略时，优先复制一份策略 JSON 修改参数，再用 `validate` 和 `plan` 生成 run 目录，避免产物无法追溯。

旧的无尽池模拟刷新也已纳入 feature 管理：

```bash
/Users/wenhaowang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  tools/manage_generation_feature.py plan \
  --strategy endless_sim_refresh_current_v1 \
  --run-id legacy_endless_sim_current \
  --execute
```

这类 run 不会覆盖源工作簿，模拟后的工作簿副本和 JSON 报告会写入
`output/generation_feature/runs/<run_id>/02_analysis/`。

## 1. 输入资产

长期保留这些输入，其他中间文件优先视为可重建：

- `output/原始数据.csv`：早期在线牌局/胜率基础数据，不含完整机器人打点。
- `output/失误率扫描_精选打点/原始数据.csv`：当前 Strategy2 + Optimal 线上回放的精选数据，含
  `mistake_0.01/0.05/0.15`、Optimal 指标和真实在线胜率。
- `output/100003～100071_100073+_合并去少_含补缺_每档最多10.csv`：第一次有效产出，策略2全量扫描版。
- `output/100003～100071_100073+_合并去少_含补缺_每档最多10_G5替换.csv`：第二次有效产出，G5 `sim1Wins>0` 替换版。
- `output/strategy_runs/20260630_至少8局当前校准/`：第三次有效产出，Optimal 筛选与补档后的当前正式包。
- `output/100003～100071_100073+_合并去少_无补缺_每档最多10.csv`：G5 重刷策略的历史输入快照，仅作为复现依赖。
- `output/无尽关地形限制.xlsx`：无尽地形池限制来源。

当前有效产出的行数、哈希、版本差异和来源闭包统一记录在 `output/有效产出清单.json`；人读摘要见
`output/有效产出总结.md`。使用 `python3 tools/audit_effective_outputs.py --check` 可重新核对。

## 2. 校准工具表

当前采用的核心工作簿由策略运行清单定位：
`output/strategy_runs/20260630_至少8局当前校准/manifest.json`。不要仅凭根目录下旧工作簿名判断正式版本。

关键页签：

- `地形G0-G5分布`：全量牌局覆盖统计。
- `无尽关难度覆盖`：无尽地形池可用难度。
- `主线关难度覆盖`：主线前 80 关对应 editorId 的可用难度。
- `前80关在线胜率`：在线胜率、近似难度、主线显示标识校准。
- `无尽难度集`：无尽 Zone 的 grade sequence 设计。
- `无尽池模拟10000组`：按当前无尽池和难度集模拟地形选中频率。

注意：`前80关在线胜率` 是分析/控制页。它的 `难度标签` 只同步到
`DisplayGradeRules.StageLevels`；`StageOverride.StageValidLength` 同步为当前主线有效长度。
除非明确要求，不要用它覆盖 `StageOverride.Stages[].GradeSequence`。具体在线关卡 sequence
由单独 Excel 表维护。

### 校准变体构建工具

使用 `tools/build_calibration_variant.py` 从任意牌局 CSV 生成一套固定版式的校准工具变体。
该工具支持 `--min-per-level-grade` 最低启用数量和 `--cap` 最大保留数量，并刷新全量覆盖、
主线覆盖、无尽覆盖、前80备注和无尽池模拟页。`--cap 0` 表示达到最低门槛后保留全部牌局。

从任意输入构建校准变体的通用示例：

```bash
/Users/wenhaowang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  tools/build_calibration_variant.py \
  --variant-name 示例策略 \
  --source-csv output/输入牌局.csv \
  --template-workbook output/无尽关校准工具.xlsx \
  --output-csv output/示例策略_每档最多10.csv \
  --output-workbook output/示例策略_校准工具.xlsx \
  --report output/示例策略_校准构建报告.json \
  --cap 10
```

### 修改难度集后的模拟刷新

如果只修改 `无尽难度集` 页签，不需要重建整本工作簿，直接刷新模拟页：

```bash
/Users/wenhaowang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  tools/refresh_endless_simulation.py \
  --workbook output/无尽关校准工具.xlsx \
  --report output/无尽关校准工具_模拟刷新报告.json
```

无补缺版：

```bash
/Users/wenhaowang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  tools/refresh_endless_simulation.py \
  --workbook output/无尽关校准工具_无补缺.xlsx \
  --report output/无尽关校准工具_无补缺_模拟刷新报告.json
```

当前模拟是固定随机种子 `20260625` 的 10000 组抽样模拟。由于包含随机抽组、地形冷却、
缺候选回退等逻辑，不建议用纯 Excel 公式实现全自动刷新；后续如果需要 Excel 内一键刷新，
应改为宏或外部按钮触发该脚本。

页签颜色约定：

- 绿色：可编辑/控制页签，例如 `无尽难度集`、`前80关在线胜率`、`地形标签建议`。
- 蓝色：数据源或统计输出页签，例如 `地形G0-G5分布`、`难度汇总`、`主线关难度覆盖`、`无尽关难度覆盖`。
- 橙色：模拟输出页签，例如 `无尽池模拟10000组`。

### 胜率参数与档位扩展

`无尽难度集` 页签里维护了 `难度 -> 单次通过率` 的输入区。修改 G0-G5 对应胜率后，
该页签中的期望次数、5关总期望和折算通过率会通过公式自动更新。

这个胜率输入只影响“难度集体验估算”，不会改变已有牌局被标记为哪个 G 档。牌局分档仍由
生成/评估流程和 CSV 中的 `grade` 字段决定。

当前工具链默认支持固定六档：

- G0
- G1
- G2
- G3
- G4
- G5

支持的操作：

- 修改 G0-G5 的单次通过率：支持，直接改 `无尽难度集` 页签。
- 修改 G0-G5 的 GradeSequence：支持，改 `无尽难度集` 后运行 `tools/refresh_endless_simulation.py`。
- 生成不同数据口径的校准工具：支持，运行 `tools/build_calibration_variant.py`。

暂不完整支持的操作：

- 扩展到 G6/G7 或更多档位。
- 修改分档规则后自动重算历史牌局。

如需扩展 G6/G7，需要同步修改：

1. 工作簿所有 G0-G5 覆盖列，扩展为 G0-G7。
2. `tools/build_calibration_variant.py` 的 `GRADES` 范围。
3. `tools/refresh_endless_simulation.py` 依赖的模拟逻辑。
4. 牌局 CSV 和 replay JSON 的 grade 校验范围。
5. 配置 `LevelPool` / `Zones` 的线上解析约定。
6. 策略2或其它分档器的输出档位定义。

## 3. 牌局生成与补缺

### 前置批量生产

批量生产有两个入口：

1. 页面端：`gui/batch-generate.html`
2. 后台脚本：`tools/run-batch-generation.ts`

页面端启动：

```bash
npm run gui -- --port 3000
```

浏览器打开：

```text
http://localhost:3000/batch-generate.html
```

页面端会调用 `gui/server.ts` 的 `/api/batch-generate/start`，核心生成逻辑来自
`src/batch-generator.ts` 的 `runBatchGeneration`。生成 CSV 临时写在系统 tmp 目录，
通过页面下载；任务结束后服务端会在约 30 分钟后清理临时 CSV。

生成参数、机器人评价参数、策略管理和验收条件的完整说明见 `docs/level-generation-strategy-feature.md`。

后台脚本示例：

```bash
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
```

常用可调参数：

- `terrainIds` / `--levels`：参与生成的地形 ID。
- `closeRates` / `--close-rates`：层闭合率。`random` 时按层累积牌数随机目标 triplet 数；
  也可以固定为逗号分隔值，例如 `0.3,0.6,0.8`。
- `colorCountRatio` / `--color-ratio`：随机花色数系数，公式是
  `floor(ratio * floor(freeTiles / 3))`。
- `colorCount` / `--color-count`：固定花色数。设置为 `random` 时使用 `color-ratio`。
- `spreadParam` / `--spread`：同色分布，`0` 偏紧密，`1` 偏分散，`random` 为 0..1 随机。
- `debtPersistenceWeight` / `--debt`：债务持续权重，`0` 偏清旧债，`1` 偏延旧债，`random` 为 0..1 随机。
- `simRuns` / `--sim-runs`：每个候选牌局的模拟次数。
- `targetPerTier` / `--target-per-tier`：每个难度档目标收集条数。
- `maxAttempts` / `--max-attempts`：单地形最大尝试次数。
- `concurrency` / `--concurrency`：同时跑的地形数量。

批量生产流程：

1. 每个地形先用极限困难参数探测最高档位。
2. 再按统一参数随机/固定生成候选牌局。
3. 用策略2模拟结果打 `grade`。
4. 每个档位收集到 `targetPerTier` 条或达到 `maxAttempts` 后停止。
5. 输出带 `ReplayCode`、`grade`、`passrate`、`sim1/sim5/sim15`、实际闭合率和生成参数的 CSV。

后台脚本现在覆盖“基础批量生产”。补缺版 `tools/backfill-missing-grades.ts` 已经具备独立运行能力，
但它的输入和目标是“缺档补齐”，不是完整批量生产；后续可以适配成同一套 CLI 参数风格，
当前先保持不改。

1. 批量生成基础牌局，去除每个地形的探测行。
2. 合并基础结果，按每个地形/难度最多 10 条做截断。
3. 对缺失低档进行补缺：
   - G0：规则补缺，使用全闭合率、0.6 色系数、紧密分布、债务 0，不跑策略2模拟。
   - G1/G2：保留花色系数方向，随机闭合/分布/债务后用策略2验收。
4. 对高难样本做质量复查。当前已发现无补缺底板中大量 G5 的 `sim1Wins=0`，这类样本更接近
   “模拟必死”而不是“高难但有机会”。对应策略为
   `output/generation_feature/strategies/g5_sim1_positive_refill_v1.json`：
   - 输入无补缺 capped CSV。
   - 只处理已有 G5 支持的地形。
   - 每地形补到 10 条 G5。
   - 验收要求策略2分档仍为 G5，且 `sim1Wins >= 1`。
5. 对主线 sequence 缺口，优先将缺 G1 的具体关卡行平替到 G0；若目标 G0 不存在，再用 G0 规则补齐。
6. 构建采用资源包；当前正式结果由 `output/strategy_runs/20260630_至少8局当前校准/manifest.json` 定位。

策略框架执行示例：

```bash
/Users/wenhaowang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  tools/manage_generation_feature.py plan \
  --strategy g5_sim1_positive_refill_v1 \
  --run-id g5_sim1_positive_refill_YYYYMMDD

bash output/generation_feature/runs/g5_sim1_positive_refill_YYYYMMDD/command.sh
```

每次策略运行必须保留 `runs/<run_id>/run_config.json`、`strategy_snapshot.json` 和 `command.sh`。
这些文件用于解释该批牌局为什么存在、用什么参数生成、是否带额外验收规则。

## 4. 配置导出

当前采用配置由资源包 manifest 指向：
`output/strategy_runs/20260630_至少8局当前校准/04_config/关卡配置B_0630.json`。

导出规则：

- `LevelPool` 来自 `无尽关难度覆盖`。
- `Zones` 来自 `无尽难度集`。
- `StageOverride.StageValidLength` 保留底板值，目前为 `80`；当前正式配置的 `Stages` 留空，
  不由校准工具覆盖主线 GradeSequence。
- 当前最终导出保留配置底板中的 `DisplayGradeRules`；修改校准表的 `难度标签` 不会自动覆盖它，
  只有明确执行对应显示标识导出工具时才更新。
- `DisplayGradeRules.EndlessTailDigits` 保留尾号规则，当前 4 为难关、9 为超难关。

## 5. Replay 导出

当前最终 replay 源是
`output/strategy_runs/20260630_至少8局当前校准/03_replay/selection.csv`，最终 JSON 在同目录
`generated/`。

导出约束：

- `ReplayTags` 必须清空。
- `ReplayKey` 统一为 `1-2-3-{ElementCount}-`。
- JSON 由以下命令生成：

  ```bash
  node --import tsx cli/replay-selection.ts build \
    --csv output/strategy_runs/20260630_至少8局当前校准/03_replay/selection.csv \
    --out output/strategy_runs/20260630_至少8局当前校准/03_replay/generated
  ```

## 6. 已遇到的问题

- G0 定义混淆：规则补缺 G0 不等同于策略2真实 G0。抽样验证中多数规则 G0 会被策略2识别为 G1/G2。
- G5 质量混淆：只看策略2档位时，G5 中可能包含大量 `sim1Wins=0` 的样本。无尽关若直接使用，
  第五关会偏向“近似必死”。需要用策略验收条件，例如 `min_sim1_wins=1`，重刷可过 G5 样本。
- 同一 editorId 会在多个主线关复用，sequence 修正必须按具体关卡行处理，不能按 editorId 全局替换。
- `LevelTags` 是关卡级字段；牌局参数不能写在这里，否则同一关多牌局会导致 replay JSON 构建失败。
- `ReplayTags` 参数信息会污染线上资源，最终导出必须清空。
- `100001`、`100002` 不在当前牌局池内，当前主线校准中标为无需处理。
- 当前 `LevelPool` 相比源 `endlessStage_3.xlsx` 删除了 `100002` 和 `100004`。

## 7. 潜在风险

- 如果后续把规则 G0 当成真实 G0 使用，无尽低难体验会被高估。
- 如果在线胜率页被误当作 sequence 覆盖源，会覆盖真实主线配置。
- 如果重新 build replay 前没有先规范 selection，`ReplayKey` 和 `ReplayTags` 可能回退到批量生成格式。
- 如果删除中间数据时未保留补缺源 CSV，将难以解释最终 G0/G1/G2 的来源。
- 如果策略 JSON 被改后没有保留 run 快照，历史牌局会失去可追溯性；因此正式生成必须从
  `manage_generation_feature.py plan` 产出的 run 目录执行。
