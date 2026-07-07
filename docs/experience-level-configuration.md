# 多体验关卡生成配置设计

本文基于现有 `generation_feature` 策略、`LayerClosure` 生成参数和批量 CSV 指标，给出第一版“不同体验”的量化方式与配置矩阵。机器可读配置见 `config/experience-level-profiles.json`。

## 1. 体验轴

当前可直接控制的体验轴有五类：

| 体验轴 | 生成参数 | 量化指标 | 体验方向 |
| --- | --- | --- | --- |
| 层闭合 | `generation.closure` / `closeRates` | `actualCloseRates` 去掉最后自动全闭合层后的均值 | 高闭合更顺滑，低闭合更容易累积跨层债务 |
| 花色密度 | `generation.color` | `colorCount / floor(freeTiles / 3)`，CSV 分析中可用 `totalTiles` 近似 | 花色越多，选择和等待越复杂 |
| 同色分散 | `generation.spread` | `spreadParam`、后续可补 `suitSpreadNorm` | 越高越分散，同色更难连续拿到 |
| 债务持续 | `generation.debt` | `debtPersistenceWeight`、`weightedDebtRetentionRate` | 越高旧债越容易跨层延续 |
| 配额形态 | `generation.color_allocation` | `balanced` / `single-heavy`、`colorTripletCounts` | 单主色会形成“主色牵引”，和普通低花色不是同一种体验 |

额外体验验收建议使用 Optimal 指标：

| 指标 | 计算 | 用途 |
| --- | --- | --- |
| `winStarvationPerTile` | `optimalStarvationOnWin / totalTiles` | 胜局断色密度，衡量最优可过时的卡槽等待感 |
| `lossRemainingRatio` | `optimalRemainingRatioOnLoss` | 失败发生早晚；高压样本也应限制过早死局 |
| `optimalWinRate` | `optimalWins / optimalRuns` | 防止 G4/G5 全是必死样本，也可筛选低压稳定可过样本 |

## 2. 闭合率分型

闭合率建议先按实际结果分四档，而不是只看输入配置：

| 类型 | `actualCloseMean` | 体验含义 | 适合用途 |
| --- | --- | --- | --- |
| 低闭合压迫 | `0.00-0.40` | 前中期很少即时闭合，债务积累明显 | G3-G5、高压实验 |
| 混合闭合 | `0.40-0.60` | 局部释放与跨层等待并存 | 中高难、节奏变化 |
| 标准闭合 | `0.60-0.78` | 有消除反馈，也保留一定债务 | 常规中档样本 |
| 高闭合宽松 | `0.78-1.00` | 前中期释放强 | G1-G3、顺滑体验 |

注意：`LayerClosure` 最后一层会自动全闭合，所以做体验判断时应优先看“非最后层均值”。如果直接把最后层也算进去，浅层地形会被系统性抬高。

## 3. 第一版体验配置

| Profile | 目标体验 | 关键参数 | 预期指标 |
| --- | --- | --- | --- |
| `relaxed_flow` 顺滑释放型 | 低压、连贯、少断色 | closure `0.75-1.0`，color `0.3-0.4`，spread/debt `0-0.33` | 高闭合、低断色、低失败剩余 |
| `balanced_choice` 均衡选择型 | 中等选择压力 | closure `0.55-0.82`，color `0.4-0.5`，spread/debt `0.33-0.66` | 标准闭合、中等断色 |
| `sustained_pressure` 持续压力型 | 多花色、分散、长期背债 | closure `0.35-0.72`，color `0.5-0.6`，spread/debt `0.66-1.0` | 中低闭合、高断色但不过早死 |
| `single_color_anchor` 主色牵引型 | 主色集中带来局部爽感和后段卡点 | color `0.3-0.4`，single-heavy `0.5`，spread/debt `0-0.33` | 高闭合下仍可能产出高档 |
| `delayed_pressure` 低闭合延迟压力型 | 专门补低闭合样本 | closure `0.05-0.45`，color `0.45-0.6`，debt `0.65-1.0` | 低闭合、高债务，必须限制过早死 |
| `front_relief_late_pressure` 前松后紧型 | 前期释放、后期收紧 | 当前只能用固定 `per_layer_list` 近似 | 需要进阶 `closure_curve` 才能跨地形稳定 |

当前已有 `different_exp_1/2_/3/4/5` 大体覆盖了顺滑、均衡、持续压力和主色牵引，但低闭合压迫与前松后紧还没有稳定覆盖。

## 4. 现有样本观察

对 `output/generation_feature/runs/different_exp_*/01_generation/batch.csv` 的现有数据做初步汇总：

| 策略 | 样本数 | 主要档位 | 平均实际闭合 | spread/debt 均值 | Optimal 断色/牌 | 观察 |
| --- | ---: | --- | ---: | --- | ---: | --- |
| `different_exp_1` | 79 | G1/G2 | 0.78 | 0.19 / 0.16 | 0.06 | 顺滑低压，几乎不产高档 |
| `different_exp_2_` | 87 | G1-G3 | 0.68 | 0.51 / 0.50 | 0.20 | 中等压力，开始出现 G3 |
| `different_exp_3` | 161 | G2-G4 | 0.66 | 0.83 / 0.83 | 0.28 | 持续压力明显增强 |
| `different_exp_4` | 732 | G1-G5 | 0.82 | 0.17 / 0.16 | 0.08 | 单主色能在高闭合下产 G5，需要单独建模 |
| `different_exp_5` | 135 | G1/G2 | 0.77 | 0.18 / 0.17 | 0.07 | 主色占比降低后又回到低压分布 |

结论：只用“闭合率高低”解释体验不够。`spread/debt` 控制持续压力，`single-heavy` 控制花色配额形态，二者都能显著改变档位和体感。

## 5. 全地形适配需要的进阶参数

现有执行器可以用 `random_range`、`range`、`random_range spread/debt` 做第一版跨地形适配，但如果要把“闭合率几种类型一起做”稳定覆盖所有地形，还需要以下进阶参数：

1. `closure_curve`

   用 `early_relief`、`linear`、`late_pressure`、`valley`、`spike` 描述曲线，再按地形 `depthCount` 自动展开。这样比固定 `per_layer_list` 更适合深度不同的地形。

2. `target_actual_close_tolerance`

   生成后用 `actualCloseRates` 回筛，例如目标低闭合要求非末层均值在 `0.0-0.45`。否则输入低闭合可能被地形容量、前两层保底或配额约束抬高。

3. `closure_band_by_grade`

   同一体验下按目标档位调整闭合率范围，例如 G1 使用高闭合，G5 使用低闭合，避免所有档位都在同一压力区域里硬搜。

4. `depth_sensitive_debt`

   浅层地形降低 `debt` 上限，深层地形允许更高持续债。低闭合 + 高债务对浅层地形很容易变成过早死局。

5. `actual_retention_band`

   用 `weightedDebtRetentionRate` 或债务持续长度回筛，让 `debtPersistenceWeight` 的意图真的落到实际牌面。

6. `color_ratio_by_triplet_count`

   按 `freeTiles / 3` 对花色比例做分段，小地形降低上限，大地形允许更高花色密度，避免小地形花色数过多或大地形体验太稀。

7. `quality_gates_by_profile`

   低压体验限制 `max_win_starvation_per_tile`；高压体验限制 `max_loss_remaining_ratio` 并要求非零 `optimalWinRate` 或 `sim1Wins`。

## 6. 建议执行顺序

1. 先用 `relaxed_flow`、`balanced_choice`、`sustained_pressure`、`single_color_anchor` 四类跑小规模全地形采样。
2. 用 `tools/analyze_experience_profiles.py` 汇总每类实际闭合、断色、失败剩余和档位覆盖。
3. 对低闭合缺口单独跑 `delayed_pressure`，并强制 Optimal 质量门槛。
4. 等 `closure_curve` 接入执行器后，再批量生产 `front_relief_late_pressure`。

示例：

```bash
python3 tools/analyze_experience_profiles.py \
  --inputs 'output/generation_feature/runs/different_exp_*/01_generation/batch.csv' \
  --output output/generation_feature/experience_profile_summary.json
```
