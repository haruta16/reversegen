#!/usr/bin/env python3
"""Filter a replay selection with the current Optimal experience profile."""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter, defaultdict
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_STRATEGY = REPO_ROOT / "output/generation_feature/strategies/optimal_experience_backfill_v1.json"
BASE_HEADERS = [
    "levelResId", "ReplayKey", "ReplayCode", "grade", "passrate", "ElementCount",
    "DifficultyScore", "CompletionStatus", "ExpectConsume", "LevelTags", "ReplayTags",
    "highWinRate", "MiddleWinRate", "LowWinRate",
]
def number(row: dict[str, str], key: str) -> float:
    return float(row[key])


def profile_from_strategy(path: Path) -> dict[str, dict[str, float | str]]:
    strategy = json.loads(path.read_text(encoding="utf-8"))
    constraints = (
        strategy.get("evaluation", {})
        .get("acceptance", {})
        .get("optimal", {})
        .get("grade_constraints", {})
    )
    if not isinstance(constraints, dict) or not constraints:
        raise ValueError(f"策略未配置 evaluation.acceptance.optimal.grade_constraints: {path}")
    profile: dict[str, dict[str, float | str]] = {"0": {"mode": "keep"}}
    for grade, constraint in constraints.items():
        if not isinstance(constraint, dict):
            raise ValueError(f"Optimal档位约束必须是对象: G{grade}")
        if "min_win_rate" in constraint:
            profile[str(grade)] = {
                "mode": "simple",
                "optimal_min": float(constraint["min_win_rate"]) * 100,
                "win_starvation_min": float(constraint.get("min_win_starvation_per_tile", 0)) * 100,
                "win_starvation_max": float(constraint.get("max_win_starvation_per_tile", 1)) * 100,
            }
        else:
            profile[str(grade)] = {
                "mode": "challenge",
                "optimal_min_exclusive": float(constraint.get("min_win_rate_exclusive", 0)) * 100,
                "optimal_max_exclusive": float(constraint.get("max_win_rate_exclusive", 1)) * 100,
                "loss_remaining_max": float(constraint.get("max_loss_remaining_ratio", 1)) * 100,
            }
    return profile


PROFILE = profile_from_strategy(DEFAULT_STRATEGY)


def evaluate(
    row: dict[str, str],
    profile: dict[str, dict[str, float | str]] | None = None,
) -> tuple[bool, str]:
    grade = row["grade"]
    rule = (profile or PROFILE).get(grade)
    if rule is None:
        return False, "未知档位"
    if rule["mode"] == "keep":
        return True, "G0暂不调整"

    optimal = number(row, "最优机器人胜率(%)")
    total_tiles = number(row, "地形总牌数")
    if rule["mode"] == "simple":
        if optimal < rule["optimal_min"]:
            return False, "Optimal胜率低于区间"
        if number(row, "最优机器人胜局数") <= 0 or total_tiles <= 0:
            return False, "无Optimal胜局"
        starvation = number(row, "最优机器人胜局平均断色次数") / total_tiles * 100.0
        if starvation < rule["win_starvation_min"]:
            return False, "胜局断色率低于区间"
        if starvation >= rule["win_starvation_max"]:
            return False, "胜局断色率高于区间"
        return True, "符合简单档目标区间"

    if not (rule["optimal_min_exclusive"] < optimal < rule["optimal_max_exclusive"]):
        return False, "Optimal胜率不在挑战区间"
    if number(row, "最优机器人负局数") <= 0 or total_tiles <= 0:
        return False, "无Optimal败局"
    remaining = 100.0 - number(row, "最优机器人负局平均已走步数") / total_tiles * 100.0
    if remaining > rule["loss_remaining_max"]:
        return False, "败局剩余比例过高"
    return True, "符合挑战档目标区间"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="output/replay导出_G5替换/selection_optimal.csv")
    parser.add_argument("--output", default="output/replay导出_G5替换/selection_Optimal体验筛选_v1.csv")
    parser.add_argument("--report", default="output/replay导出_G5替换/selection_Optimal体验筛选_v1_报告.json")
    parser.add_argument("--strategy", default=str(DEFAULT_STRATEGY))
    args = parser.parse_args()
    input_path = Path(args.input) if Path(args.input).is_absolute() else REPO_ROOT / args.input
    output_path = Path(args.output) if Path(args.output).is_absolute() else REPO_ROOT / args.output
    report_path = Path(args.report) if Path(args.report).is_absolute() else REPO_ROOT / args.report
    strategy_path = Path(args.strategy) if Path(args.strategy).is_absolute() else REPO_ROOT / args.strategy
    profile = profile_from_strategy(strategy_path)

    with input_path.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    kept: list[dict[str, str]] = []
    reasons: Counter[str] = Counter()
    before: Counter[str] = Counter()
    after: Counter[str] = Counter()
    before_levels: dict[str, set[str]] = defaultdict(set)
    after_levels: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        grade = row["grade"]
        before[grade] += 1
        before_levels[grade].add(row["levelResId"])
        accepted, reason = evaluate(row, profile)
        reasons[f"G{grade}:{reason}"] += 1
        if accepted:
            kept.append(row)
            after[grade] += 1
            after_levels[grade].add(row["levelResId"])

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=BASE_HEADERS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(kept)

    report = {
        "profile": profile,
        "profile_source": str(strategy_path),
        "input": str(input_path),
        "output": str(output_path),
        "input_rows": len(rows),
        "kept_rows": len(kept),
        "removed_rows": len(rows) - len(kept),
        "by_grade": {
            f"G{grade}": {
                "before_rows": before[grade],
                "after_rows": after[grade],
                "before_levels": len(before_levels[grade]),
                "after_levels": len(after_levels[grade]),
            }
            for grade in map(str, range(6))
        },
        "reason_counts": dict(sorted(reasons.items())),
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
