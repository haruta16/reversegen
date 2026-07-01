#!/usr/bin/env python3
"""Audit the adopted online baseline and three effective generation outputs."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output"

PATHS = {
    "online_raw": OUTPUT / "原始数据.csv",
    "online_enriched": OUTPUT / "失误率扫描_精选打点" / "原始数据.csv",
    "strategy2_generation": OUTPUT / "100003～100071_100073+_合并去少_含补缺_每档最多10.csv",
    "strategy2_selection": OUTPUT / "replay导出" / "selection.csv",
    "sim1_generation": OUTPUT / "100003～100071_100073+_合并去少_含补缺_每档最多10_G5替换.csv",
    "sim1_selection": OUTPUT / "replay导出_G5替换" / "selection.csv",
    "sim1_optimal_metrics": OUTPUT / "replay导出_G5替换" / "selection_optimal.csv",
    "optimal_filtered_base": OUTPUT / "replay导出_G5替换" / "selection_Optimal体验筛选_v1.csv",
    "sim1_backfill": OUTPUT / "generation_feature" / "runs" / "g5_sim1_positive_refill_project_random_20260626" / "01_generation" / "backfill.csv",
    "optimal_backfill": OUTPUT / "generation_feature" / "runs" / "optimal_experience_backfill_20260629" / "01_generation" / "backfill.csv",
    "optimal_final_selection": OUTPUT / "strategy_runs" / "20260630_至少8局当前校准" / "03_replay" / "selection.csv",
    "optimal_final_workbook": OUTPUT / "strategy_runs" / "20260630_至少8局当前校准" / "02_analysis" / "无尽关校准工具_每档至少8局_最终.xlsx",
    "optimal_final_config": OUTPUT / "strategy_runs" / "20260630_至少8局当前校准" / "04_config" / "关卡配置B_0630.json",
}

DEPENDENCIES = {
    "no_backfill_source": OUTPUT / "100003～100071_100073+_合并去少_无补缺_每档最多10.csv",
    "calibration_template": OUTPUT / "无尽关校准工具.xlsx",
    "no_backfill_workbook": OUTPUT / "无尽关校准工具_无补缺.xlsx",
    "terrain_limit_workbook": OUTPUT / "无尽关地形限制.xlsx",
    "base_config": OUTPUT / "关卡配置B_0626增难版.json",
}


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def replay_code(row: dict[str, str]) -> str:
    return row.get("ReplayCode", "")


def level_id(row: dict[str, str]) -> str:
    return row.get("levelResId") or row.get("地形编号") or ""


def replay_codes(rows: list[dict[str, str]]) -> set[str]:
    return {replay_code(row) for row in rows if replay_code(row)}


def csv_stats(rows: list[dict[str, str]]) -> dict[str, Any]:
    grades = Counter(str(row.get("grade", "")) for row in rows if row.get("grade", "") != "")
    levels = {level_id(row) for row in rows if level_id(row)}
    pairs = {
        (level_id(row), str(row.get("grade", "")))
        for row in rows
        if level_id(row) and row.get("grade", "") != ""
    }
    return {
        "rows": len(rows),
        "uniqueReplayCodes": len(replay_codes(rows)),
        "levelCount": len(levels),
        "levelGradePairCount": len(pairs),
        "gradeRows": dict(sorted(grades.items())),
    }


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_record(path: Path, rows: int | None = None) -> dict[str, Any]:
    record: dict[str, Any] = {
        "path": relative(path),
        "sizeBytes": path.stat().st_size,
        "sha256": sha256(path),
    }
    if rows is not None:
        record["rows"] = rows
    return record


def build_manifest() -> dict[str, Any]:
    missing = [
        relative(path)
        for path in [*PATHS.values(), *DEPENDENCIES.values()]
        if not path.exists()
    ]
    if missing:
        raise FileNotFoundError("Missing adopted artifacts:\n" + "\n".join(missing))

    data = {
        name: read_csv(path)
        for name, path in PATHS.items()
        if path.suffix.lower() == ".csv"
    }
    stats = {name: csv_stats(rows) for name, rows in data.items()}

    online_raw = replay_codes(data["online_raw"])
    online_enriched = replay_codes(data["online_enriched"])
    strategy2 = replay_codes(data["strategy2_selection"])
    sim1 = replay_codes(data["sim1_selection"])
    sim1_added = sim1 - strategy2
    sim1_removed = strategy2 - sim1
    sim1_backfill = replay_codes(data["sim1_backfill"])

    sim1_generation_by_code = {
        replay_code(row): row for row in data["sim1_generation"] if replay_code(row)
    }
    adopted_sim1_rows = [sim1_generation_by_code[code] for code in sim1_added]

    optimal_base = replay_codes(data["optimal_filtered_base"])
    optimal_backfill = replay_codes(data["optimal_backfill"])
    optimal_final = replay_codes(data["optimal_final_selection"])

    retained = {
        name: file_record(PATHS[name], len(rows))
        for name, rows in data.items()
    }
    retained["optimal_final_workbook"] = file_record(PATHS["optimal_final_workbook"])
    retained["optimal_final_config"] = file_record(PATHS["optimal_final_config"])
    dependencies = {name: file_record(path) for name, path in DEPENDENCIES.items()}
    config = json.loads(PATHS["optimal_final_config"].read_text(encoding="utf-8"))
    stage_override = config.get("StageOverride", {})
    zones = config.get("Zones", [])

    return {
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "policy": {
            "onlineBaseline": "保留原始线上胜率数据及完整机器人指标增强版",
            "effectiveGenerationOutputs": [
                "策略2全量扫描版",
                "G5排除必死关版（sim1Wins > 0）",
                "Optimal体验筛选与补档版",
            ],
            "cleanup": "其他 checkpoint、失败运行、临时分析和未采用资源包可删除",
        },
        "datasets": stats,
        "comparisons": {
            "onlineRawVsEnriched": {
                "sameReplaySet": online_raw == online_enriched,
                "rawOnly": len(online_raw - online_enriched),
                "enrichedOnly": len(online_enriched - online_raw),
            },
            "strategy2ToSim1Positive": {
                "unchanged": len(strategy2 & sim1),
                "removed": len(sim1_removed),
                "added": len(sim1_added),
                "affectedLevels": len({level_id(row) for row in adopted_sim1_rows}),
                "addedFromAdoptedBackfill": len(sim1_added & sim1_backfill),
                "addedOutsideAdoptedBackfill": len(sim1_added - sim1_backfill),
                "addedWithNonPositiveSim1Wins": sum(
                    float(row.get("sim1Wins") or 0) <= 0 for row in adopted_sim1_rows
                ),
            },
            "optimalFinalComposition": {
                "filteredBaseRows": len(optimal_base),
                "backfillRows": len(optimal_backfill),
                "candidateUnionRows": len(optimal_base | optimal_backfill),
                "finalRows": len(optimal_final),
                "finalFromFilteredBase": len(optimal_final & optimal_base),
                "finalFromBackfill": len(optimal_final & optimal_backfill),
                "finalUnknown": len(optimal_final - (optimal_base | optimal_backfill)),
                "candidateRowsExcludedByThreshold": len((optimal_base | optimal_backfill) - optimal_final),
            },
        },
        "currentPackage": {
            "levelPoolCount": len(config.get("LevelPool", [])),
            "zoneCount": len(zones),
            "zoneSequences": [zone.get("gradeSequences", []) for zone in zones],
            "stageValidLength": stage_override.get("StageValidLength"),
            "stageOverrideCount": len(stage_override.get("Stages", [])),
        },
        "retainedCanonicalFiles": retained,
        "retainedReproductionDependencies": dependencies,
    }


def build_summary(manifest: dict[str, Any]) -> str:
    datasets = manifest["datasets"]
    comparisons = manifest["comparisons"]
    v1 = datasets["strategy2_selection"]
    v2 = datasets["sim1_selection"]
    v3 = datasets["optimal_final_selection"]
    delta = comparisons["strategy2ToSim1Positive"]
    composition = comparisons["optimalFinalComposition"]
    package = manifest["currentPackage"]

    def grade_text(stats: dict[str, Any]) -> str:
        return "、".join(f"G{grade} {count}" for grade, count in stats["gradeRows"].items())

    return f"""# 有效测试资源总结

更新时间：{manifest['generatedAt']}

## 保留口径

- 线上原始数据：`output/原始数据.csv`，以及同一批 ReplayCode 的完整指标版 `output/失误率扫描_精选打点/原始数据.csv`。
- 第一次有效产出：策略2全量扫描版。
- 第二次有效产出：G5 排除必死关版，新增样本要求 `sim1Wins > 0`。
- 第三次有效产出：按 Optimal 体验参数筛选并补档，最终采用“单个地形/难度至少 8 局，达到后全部保留”。

## 三版结果

| 版本 | 牌局数 | 地形数 | 地形/难度组合 | 各档牌局数 |
| --- | ---: | ---: | ---: | --- |
| 策略2全量扫描 | {v1['rows']} | {v1['levelCount']} | {v1['levelGradePairCount']} | {grade_text(v1)} |
| G5 `sim1>0` 替换 | {v2['rows']} | {v2['levelCount']} | {v2['levelGradePairCount']} | {grade_text(v2)} |
| Optimal 最终采用 | {v3['rows']} | {v3['levelCount']} | {v3['levelGradePairCount']} | {grade_text(v3)} |

## 关键变化

- 第二版相对第一版：保留 {delta['unchanged']} 局，删除 {delta['removed']} 个旧 G5，加入 {delta['added']} 个新 G5，影响 {delta['affectedLevels']} 个地形；新增项全部来自采用的 project-random 运行，`sim1Wins<=0` 为 {delta['addedWithNonPositiveSim1Wins']}。
- 第三版候选由 {composition['filteredBaseRows']} 条 Optimal 筛选底板和 {composition['backfillRows']} 条补档组成，去重候选 {composition['candidateUnionRows']} 条。
- 最终采用 {composition['finalRows']} 条，其中底板 {composition['finalFromFilteredBase']} 条、补档 {composition['finalFromBackfill']} 条、未知来源 {composition['finalUnknown']} 条；因“至少 8 局”门槛排除 {composition['candidateRowsExcludedByThreshold']} 条。
- 当前配置与最终工作簿一致：LevelPool {package['levelPoolCount']} 个、难度集 {package['zoneCount']} 组、主线有效长度 {package['stageValidLength']}，StageOverride 明细 {package['stageOverrideCount']} 条。

## 当前正式包

- 校准工具：`output/strategy_runs/20260630_至少8局当前校准/02_analysis/无尽关校准工具_每档至少8局_最终.xlsx`
- Replay CSV：`output/strategy_runs/20260630_至少8局当前校准/03_replay/selection.csv`
- Replay JSON：`output/strategy_runs/20260630_至少8局当前校准/03_replay/generated/`
- 配置：`output/strategy_runs/20260630_至少8局当前校准/04_config/关卡配置B_0630.json`
- 机器可读清单：`output/有效产出清单.json`

## 复现依赖

另保留无补缺底板 CSV、校准模板、无补缺工作簿、地形限制表和 `关卡配置B_0626增难版.json`。这些文件不是新增的有效产出版本，但仍是现有策略与配置构建的输入。

## 清理原则

保留上述原始数据、三次有效生成数据、对应 Replay、采用策略快照和当前正式包。checkpoint、进度日志、失败或未采用运行、临时拟合报告和旧配置副本均不再作为事实来源。
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Only validate and print the summary.")
    parser.add_argument("--manifest", type=Path, default=OUTPUT / "有效产出清单.json")
    parser.add_argument("--summary", type=Path, default=OUTPUT / "有效产出总结.md")
    args = parser.parse_args()

    manifest = build_manifest()
    summary = build_summary(manifest)
    if args.check:
        print(summary)
        return

    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    args.summary.write_text(summary, encoding="utf-8")
    print(f"wrote {relative(args.manifest)}")
    print(f"wrote {relative(args.summary)}")


if __name__ == "__main__":
    main()
