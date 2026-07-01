#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import shutil
import subprocess
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
REPLAY_HEADERS = [
    "levelResId", "ReplayKey", "ReplayCode", "grade", "passrate", "ElementCount",
    "DifficultyScore", "CompletionStatus", "ExpectConsume", "LevelTags", "ReplayTags",
    "highWinRate", "MiddleWinRate", "LowWinRate",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="按地形/难度最低牌局数构建校准、replay 和配置产物包。")
    parser.add_argument("--source", type=Path, action="append", required=True, help="可重复传入；按顺序合并并去重")
    parser.add_argument("--min-count", type=int, default=8)
    parser.add_argument("--template-workbook", type=Path, default=Path("output/无尽关校准工具.xlsx"))
    parser.add_argument("--base-config", type=Path, default=Path("output/关卡配置B_0626增难版.json"))
    parser.add_argument("--run-name", default=None)
    parser.add_argument("--output-root", type=Path, default=Path("output/strategy_runs"))
    parser.add_argument("--exclude-level", action="append", default=["100001", "100002"])
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_csv(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        return list(reader.fieldnames or []), list(reader)


def write_csv(path: Path, headers: list[str], rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=headers, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def valid_row(row: dict[str, str], excluded: set[str]) -> bool:
    level = row.get("levelResId", "").strip()
    if not level or level in excluded or not row.get("ReplayCode", "").strip():
        return False
    if row.get("isMaxGradeProbe", "").strip() == "1":
        return False
    if not row.get("CompletionStatus", "Success").strip().startswith("Success"):
        return False
    try:
        return 0 <= int(row.get("grade", "")) <= 5
    except ValueError:
        return False


def number(row: dict[str, str], key: str, default: str = "0") -> str:
    value = row.get(key, "").strip()
    if not value:
        return default
    try:
        parsed = float(value)
    except ValueError:
        return default
    return str(parsed)


def replay_row(row: dict[str, str]) -> dict[str, str]:
    element = row.get("ElementCount", "").strip() or row.get("colorCount", "").strip()
    element_int = int(float(element))
    return {
        "levelResId": str(int(float(row["levelResId"]))),
        "ReplayKey": f"1-2-3-{element_int}-",
        "ReplayCode": row["ReplayCode"].strip(),
        "grade": str(int(float(row["grade"]))),
        "passrate": number(row, "passrate"),
        "ElementCount": str(element_int),
        "DifficultyScore": number(row, "DifficultyScore"),
        "CompletionStatus": "Success",
        "ExpectConsume": number(row, "ExpectConsume"),
        "LevelTags": "",
        "ReplayTags": "",
        "highWinRate": number(row, "highWinRate"),
        "MiddleWinRate": number(row, "MiddleWinRate"),
        "LowWinRate": number(row, "LowWinRate"),
    }


def run(command: list[str]) -> None:
    print("+", " ".join(command))
    subprocess.run(command, cwd=ROOT, check=True)


def main() -> None:
    args = parse_args()
    if args.min_count < 1:
        raise SystemExit("--min-count 必须大于等于 1")

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    run_name = args.run_name or f"{timestamp}_至少{args.min_count}局当前校准"
    run_dir = (args.output_root / run_name).resolve()
    inputs_dir = run_dir / "inputs"
    data_dir = run_dir / "01_data"
    analysis_dir = run_dir / "02_analysis"
    replay_dir = run_dir / "03_replay"
    config_dir = run_dir / "04_config"
    for directory in [inputs_dir, data_dir, analysis_dir, replay_dir, config_dir]:
        directory.mkdir(parents=True, exist_ok=True)

    headers: list[str] = []
    merged: list[dict[str, str]] = []
    input_meta: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    excluded = set(args.exclude_level)

    for index, source in enumerate(args.source, start=1):
        source = source.resolve()
        source_headers, source_rows = read_csv(source)
        for header in source_headers:
            if header not in headers:
                headers.append(header)
        snapshot = inputs_dir / f"{index:02d}_{source.name}"
        write_csv(snapshot, source_headers, source_rows)
        input_meta.append({
            "source": str(source),
            "snapshot": str(snapshot),
            "rows": len(source_rows),
            "sha256": sha256(snapshot),
        })
        for row in source_rows:
            if not valid_row(row, excluded):
                continue
            key = (row["levelResId"].strip(), row["ReplayCode"].strip())
            if key in seen:
                continue
            seen.add(key)
            row = dict(row)
            row["_source"] = source.name
            merged.append(row)

    if "_source" not in headers:
        headers.append("_source")
    counts = Counter((row["levelResId"].strip(), int(row["grade"])) for row in merged)
    eligible = {key for key, count in counts.items() if count >= args.min_count}
    selected = [row for row in merged if (row["levelResId"].strip(), int(row["grade"])) in eligible]
    selected.sort(key=lambda row: (int(row["levelResId"]), int(row["grade"]), row.get("_source", ""), int(float(row.get("attemptIndex") or 0))))

    merged_path = data_dir / "全部有效牌局_去重.csv"
    eligible_path = data_dir / f"每档至少{args.min_count}局_全部保留.csv"
    write_csv(merged_path, headers, merged)
    write_csv(eligible_path, headers, selected)

    selection_rows = [replay_row(row) for row in selected]
    selection_path = replay_dir / "selection.csv"
    write_csv(selection_path, REPLAY_HEADERS, selection_rows)

    workbook = analysis_dir / f"无尽关校准工具_每档至少{args.min_count}局.xlsx"
    calibration_csv = analysis_dir / f"校准数据_每档至少{args.min_count}局_全部保留.csv"
    calibration_report = analysis_dir / "校准构建报告.json"
    run([
        sys.executable, "tools/build_calibration_variant.py",
        "--variant-name", f"每档至少{args.min_count}局",
        "--source-csv", str(eligible_path),
        "--template-workbook", str(args.template_workbook),
        "--output-csv", str(calibration_csv),
        "--output-workbook", str(workbook),
        "--report", str(calibration_report),
        "--cap", "0",
        "--min-per-level-grade", str(args.min_count),
    ])

    generated_dir = replay_dir / "generated"
    node_command = ["node", "--import", "tsx", "cli/replay-selection.ts"]
    run([*node_command, "check", "--csv", str(selection_path)])
    run([*node_command, "build", "--csv", str(selection_path), "--out", str(generated_dir)])

    config_path = config_dir / f"关卡配置B_每档至少{args.min_count}局.json"
    config_report = config_dir / "配置构建报告.json"
    run([
        sys.executable, "tools/export_endless_config_from_workbook.py",
        "--workbook", str(workbook),
        "--base-config", str(args.base_config),
        "--output", str(config_path),
        "--report", str(config_report),
    ])

    grade_rows = {f"G{grade}": sum(1 for row in selected if int(row["grade"]) == grade) for grade in range(6)}
    grade_levels = {f"G{grade}": len({row["levelResId"] for row in selected if int(row["grade"]) == grade}) for grade in range(6)}
    manifest = {
        "strategyName": f"每档至少{args.min_count}局当前校准",
        "createdAt": datetime.now().isoformat(timespec="seconds"),
        "rule": f"每个地形/难度至少 {args.min_count} 局才启用；达到门槛后保留全部有效牌局，不设上限",
        "excludedLevels": sorted(excluded),
        "inputs": input_meta,
        "outputs": {
            "eligibleCsv": str(eligible_path),
            "workbook": str(workbook),
            "selectionCsv": str(selection_path),
            "replayJsonDir": str(generated_dir),
            "config": str(config_path),
        },
        "summary": {
            "mergedValidRows": len(merged),
            "eligibleRows": len(selected),
            "eligibleLevelGradePairs": len(eligible),
            "excludedLevelGradePairs": len(counts) - len(eligible),
            "levelCount": len({row["levelResId"] for row in selected}),
            "gradeRows": grade_rows,
            "gradeLevelCoverage": grade_levels,
        },
    }
    manifest_path = run_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    index_path = args.output_root / "index.jsonl"
    with index_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"runDir": str(run_dir), **manifest}, ensure_ascii=False) + "\n")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
