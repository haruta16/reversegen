#!/usr/bin/env python3
"""Backfill derived closeRates for random-color rows in a batch CSV."""

from __future__ import annotations

import argparse
import csv
import json
import shutil
from datetime import datetime
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = (
    "output/generation_feature/runs/optimal_experience_backfill_20260629/"
    "01_generation/backfill.csv"
)
DEFAULT_BACKUP_DIR = (
    "output/generation_feature/runs/optimal_experience_backfill_20260629/"
    "logs/archive"
)
DEFAULT_REPORT = (
    "output/generation_feature/runs/optimal_experience_backfill_20260629/"
    "logs/random_close_rates_backfill_report.json"
)


def absolute(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else REPO_ROOT / path


def parse_rates(raw: str) -> list[float]:
    if not raw.strip():
        return []
    values = [float(value.strip()) for value in raw.split(",") if value.strip()]
    if any(value < 0 or value > 1 for value in values):
        raise ValueError("闭合率超出0到1")
    return values


def format_rates(values: list[float]) -> str:
    return ",".join(format(value, ".15g") for value in values)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default=DEFAULT_INPUT)
    parser.add_argument("--backup-dir", default=DEFAULT_BACKUP_DIR)
    parser.add_argument("--report", default=DEFAULT_REPORT)
    parser.add_argument("--write", action="store_true", help="原子改写输入CSV；不传时只预览")
    args = parser.parse_args()

    input_path = absolute(args.input)
    backup_dir = absolute(args.backup_dir)
    report_path = absolute(args.report)
    with input_path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        headers = reader.fieldnames or []
        rows = list(reader)
    required = {"LevelTags", "closeRates", "actualCloseRates"}
    missing_headers = sorted(required - set(headers))
    if missing_headers:
        raise SystemExit(f"CSV缺少字段: {', '.join(missing_headers)}")

    random_rows = 0
    already_filled = 0
    fillable = 0
    unresolved = 0
    invalid = 0
    changed_levels: set[str] = set()
    for row in rows:
        if row.get("LevelTags", "").strip() != "random":
            continue
        random_rows += 1
        if row.get("closeRates", "").strip():
            already_filled += 1
            continue
        try:
            actual = parse_rates(row.get("actualCloseRates", ""))
        except ValueError:
            invalid += 1
            continue
        if not actual:
            unresolved += 1
            continue
        # 最后一层没有后续隐藏牌，固定自动闭合，不属于生成输入参数。
        row["closeRates"] = format_rates(actual[:-1])
        fillable += 1
        changed_levels.add(row.get("levelResId", ""))

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    report = {
        "createdAt": datetime.now().isoformat(timespec="seconds"),
        "input": str(input_path),
        "mode": "write" if args.write else "preview",
        "totalRows": len(rows),
        "randomRows": random_rows,
        "alreadyFilled": already_filled,
        "fillable": fillable,
        "changedLevels": len(changed_levels),
        "unresolved": unresolved,
        "invalid": invalid,
        "backup": None,
    }
    if args.write:
        backup_dir.mkdir(parents=True, exist_ok=True)
        backup_path = backup_dir / f"{input_path.stem}_before_close_rate_backfill_{timestamp}{input_path.suffix}"
        shutil.copy2(input_path, backup_path)
        temp_path = input_path.with_suffix(f"{input_path.suffix}.tmp")
        with temp_path.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=headers, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)
        temp_path.replace(input_path)
        report["backup"] = str(backup_path)

    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
