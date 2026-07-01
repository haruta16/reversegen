#!/usr/bin/env python3
"""Trim generated backfill rows to the replacements removed by acceptance filtering."""

from __future__ import annotations

import argparse
import csv
import json
import shutil
from collections import Counter
from datetime import datetime
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def resolve_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else REPO_ROOT / path


def number(row: dict[str, str], *keys: str) -> float | None:
    for key in keys:
        raw = row.get(key, "").strip()
        if not raw:
            continue
        try:
            return float(raw)
        except ValueError:
            continue
    return None


def metrics(row: dict[str, str]) -> tuple[float, float, float] | None:
    win_rate = number(row, "optimalWinRate")
    if win_rate is None:
        value = number(row, "最优机器人胜率(%)")
        win_rate = None if value is None else value / 100.0
    total_tiles = number(row, "totalTiles", "地形总牌数")
    starvation = number(row, "optimalStarvationOnWin", "最优机器人胜局平均断色次数")
    remaining = number(row, "optimalRemainingRatioOnLoss")
    if remaining is None:
        value = number(row, "最优机器人负局平均剩余牌比例(%)")
        remaining = None if value is None else value / 100.0
    if win_rate is None or total_tiles is None or total_tiles <= 0 or starvation is None or remaining is None:
        return None
    return win_rate, starvation / total_tiles, remaining


def accepted(row: dict[str, str], constraints: dict[str, dict[str, float]]) -> bool:
    try:
        grade = str(int(float(row["grade"])))
    except (KeyError, ValueError):
        return False
    constraint = constraints.get(grade)
    if constraint is None:
        return True
    values = metrics(row)
    if values is None:
        return False
    win_rate, starvation, remaining = values
    checks = (
        ("min_win_rate", win_rate, lambda value, limit: value >= limit),
        ("min_win_rate_exclusive", win_rate, lambda value, limit: value > limit),
        ("max_win_rate_exclusive", win_rate, lambda value, limit: value < limit),
        ("min_win_starvation_per_tile", starvation, lambda value, limit: value >= limit),
        ("max_win_starvation_per_tile", starvation, lambda value, limit: value < limit),
        ("max_loss_remaining_ratio", remaining, lambda value, limit: value <= limit),
    )
    return all(key not in constraint or compare(value, float(constraint[key])) for key, value, compare in checks)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--strategy", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--backup-dir", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args()

    strategy_path = resolve_path(args.strategy)
    input_path = resolve_path(args.input)
    output_path = resolve_path(args.output)
    backup_dir = resolve_path(args.backup_dir)
    report_path = resolve_path(args.report)
    strategy = json.loads(strategy_path.read_text(encoding="utf-8"))
    target = strategy["target"]
    cap = int(target["target_count_per_grade"])
    target_grades = {int(grade) for grade in target["grades"]}
    excluded = {str(level) for level in strategy.get("scope", {}).get("exclude_levels", [])}
    constraints = strategy.get("evaluation", {}).get("acceptance", {}).get("optimal", {}).get("grade_constraints", {})

    raw_counts: Counter[tuple[str, int]] = Counter()
    accepted_source: Counter[tuple[str, int]] = Counter()
    with input_path.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            level = row.get("levelResId", "").strip()
            try:
                grade = int(float(row.get("grade", "")))
            except ValueError:
                continue
            if not level or level in excluded or grade not in target_grades:
                continue
            key = (level, grade)
            raw_counts[key] += 1
            if accepted(row, constraints):
                accepted_source[key] += 1

    quotas = {
        key: max(0, min(cap, raw_count) - accepted_source[key])
        for key, raw_count in raw_counts.items()
    }
    with output_path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        headers = reader.fieldnames or []
        generated_rows = list(reader)

    kept_counts: Counter[tuple[str, int]] = Counter()
    kept_rows: list[dict[str, str]] = []
    seen_codes: set[str] = set()
    removed_reasons: Counter[str] = Counter()
    removed_by_grade: Counter[int] = Counter()
    for row in generated_rows:
        level = row.get("levelResId", "").strip()
        try:
            grade = int(float(row.get("grade", "")))
        except ValueError:
            removed_reasons["invalid_grade"] += 1
            continue
        key = (level, grade)
        replay_code = row.get("ReplayCode", "").strip()
        reason = ""
        if not replay_code or replay_code in seen_codes:
            reason = "duplicate_replay"
        elif key not in quotas:
            reason = "not_in_original_level_grade"
        elif not accepted(row, constraints):
            reason = "fails_current_acceptance"
        elif kept_counts[key] >= quotas[key]:
            reason = "over_replacement_quota"
        if reason:
            removed_reasons[reason] += 1
            removed_by_grade[grade] += 1
            continue
        seen_codes.add(replay_code)
        kept_counts[key] += 1
        kept_rows.append(row)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / f"{output_path.stem}_before_replace_filtered_cleanup_{timestamp}{output_path.suffix}"
    shutil.copy2(output_path, backup_path)
    temp_path = output_path.with_suffix(f"{output_path.suffix}.tmp")
    with temp_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(kept_rows)
    temp_path.replace(output_path)

    remaining = {key: max(0, quota - kept_counts[key]) for key, quota in quotas.items()}
    report = {
        "createdAt": datetime.now().isoformat(timespec="seconds"),
        "strategy": str(strategy_path),
        "input": str(input_path),
        "output": str(output_path),
        "backup": str(backup_path),
        "beforeRows": len(generated_rows),
        "afterRows": len(kept_rows),
        "removedRows": len(generated_rows) - len(kept_rows),
        "removedReasons": dict(sorted(removed_reasons.items())),
        "removedByGrade": {f"G{grade}": removed_by_grade[grade] for grade in sorted(removed_by_grade)},
        "remainingRows": sum(remaining.values()),
        "remainingPairs": sum(value > 0 for value in remaining.values()),
        "remainingByGrade": {
            f"G{grade}": {
                "rows": sum(value for (level, item_grade), value in remaining.items() if item_grade == grade),
                "pairs": sum(value > 0 for (level, item_grade), value in remaining.items() if item_grade == grade),
            }
            for grade in sorted(target_grades)
        },
        "retentionPolicy": "Keep earlier valid rows first; remove later over-quota rows first.",
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
