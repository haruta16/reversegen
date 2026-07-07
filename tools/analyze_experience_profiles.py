#!/usr/bin/env python3
"""Quantify ReverseGen experience profiles from batch generation CSV files."""

from __future__ import annotations

import argparse
import csv
import glob
import json
import math
from collections import Counter, defaultdict
from pathlib import Path
from statistics import mean
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "config" / "experience-level-profiles.json"
DEFAULT_INPUTS = [str(ROOT / "output" / "generation_feature" / "runs" / "different_exp_*" / "01_generation" / "batch.csv")]


def number(value: Any) -> float | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        result = float(text)
    except ValueError:
        return None
    return result if math.isfinite(result) else None


def series(value: Any) -> list[float]:
    text = str(value or "").strip().strip('"')
    if not text:
        return []
    result: list[float] = []
    for part in text.split(","):
        item = number(part)
        if item is not None:
            result.append(item)
    return result


def bounded_mean(values: list[float]) -> float | None:
    return mean(values) if values else None


def prefinal_mean(values: list[float]) -> float | None:
    if not values:
        return None
    if len(values) > 1 and values[-1] >= 0.999:
        values = values[:-1]
    return bounded_mean(values)


def detect_run(path: Path) -> str:
    parts = path.parts
    if "runs" in parts:
        index = parts.index("runs")
        if index + 1 < len(parts):
            return parts[index + 1]
    return path.parent.name


def expand_inputs(patterns: list[str]) -> list[Path]:
    paths: list[Path] = []
    for pattern in patterns:
        expanded = glob.glob(str(Path(pattern).expanduser()))
        if expanded:
            paths.extend(Path(path) for path in expanded)
        else:
            paths.append(Path(pattern).expanduser())
    return sorted(path for path in paths if path.exists())


def load_rows(paths: list[Path], include_probes: bool) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in paths:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                if not row.get("ReplayCode"):
                    continue
                if not include_probes and str(row.get("isMaxGradeProbe", "")).strip() == "1":
                    continue
                if str(row.get("grade", "")).strip() == "":
                    continue
                row["_sourceFile"] = str(path)
                row["_sourceRun"] = detect_run(path)
                rows.append(row)
    return rows


def range_contains(value: float | None, range_value: Any) -> bool:
    if value is None or not isinstance(range_value, list) or len(range_value) != 2:
        return False
    low = number(range_value[0])
    high = number(range_value[1])
    if low is None or high is None:
        return False
    return low <= value <= high


def closure_band(value: float | None, bands: list[dict[str, Any]]) -> str:
    for band in bands:
        if range_contains(value, band.get("actualCloseMeanRange")):
            return str(band.get("id", "unknown"))
    return "unknown"


def row_metrics(row: dict[str, Any]) -> dict[str, Any]:
    total_tiles = number(row.get("totalTiles"))
    color_count = number(row.get("colorCount")) or number(row.get("ElementCount"))
    triplet_count = math.floor(total_tiles / 3) if total_tiles and total_tiles > 0 else None
    optimal_starvation = number(row.get("optimalStarvationOnWin"))
    metrics = {
        "grade": int(number(row.get("grade")) or -1),
        "passrate": number(row.get("passrate")),
        "inputCloseMean": prefinal_mean(series(row.get("closeRates"))),
        "actualCloseMean": prefinal_mean(series(row.get("actualCloseRates"))),
        "colorCount": color_count,
        "totalTiles": total_tiles,
        "colorRatio": (color_count / triplet_count) if color_count is not None and triplet_count else None,
        "spreadParam": number(row.get("spreadParam")),
        "debtPersistenceWeight": number(row.get("debtPersistenceWeight")),
        "allocationMode": str(row.get("colorAllocationMode") or "balanced"),
        "heavyColorMaxRatio": number(row.get("colorAllocationMaxRatio")),
        "optimalWinRate": number(row.get("optimalWinRate")),
        "winStarvationPerTile": (
            optimal_starvation / total_tiles
            if optimal_starvation is not None and total_tiles and total_tiles > 0
            else None
        ),
        "lossRemainingRatio": number(row.get("optimalRemainingRatioOnLoss")),
        "sourceRun": row.get("_sourceRun"),
        "sourceFile": row.get("_sourceFile"),
    }
    metrics["pressureScore"] = pressure_score(metrics)
    return metrics


def normalize(value: float | None, low: float, high: float) -> float | None:
    if value is None:
        return None
    if high <= low:
        return 0.0
    return max(0.0, min(1.0, (value - low) / (high - low)))


def pressure_score(metrics: dict[str, Any]) -> float | None:
    close_pressure = None
    close_mean = metrics.get("actualCloseMean")
    if close_mean is not None:
        close_pressure = 1.0 - max(0.0, min(1.0, float(close_mean)))
    components = [
        (0.25, close_pressure),
        (0.15, normalize(metrics.get("colorRatio"), 0.25, 0.7)),
        (0.18, normalize(metrics.get("spreadParam"), 0.0, 1.0)),
        (0.18, normalize(metrics.get("debtPersistenceWeight"), 0.0, 1.0)),
        (0.14, normalize(metrics.get("winStarvationPerTile"), 0.0, 0.4)),
        (0.10, normalize(metrics.get("lossRemainingRatio"), 0.0, 0.4)),
    ]
    available = [(weight, value) for weight, value in components if value is not None]
    if not available:
        return None
    total_weight = sum(weight for weight, _ in available)
    return round(100 * sum(weight * value for weight, value in available) / total_weight, 2)


def profile_match(metrics: dict[str, Any], profiles: list[dict[str, Any]]) -> tuple[str, float]:
    best_id = "unclassified"
    best_score = 0.0
    for profile in profiles:
        ranges = profile.get("expectedMetricRanges", {})
        checks = 0
        hits = 0
        for key, range_value in ranges.items():
            if key not in metrics:
                continue
            checks += 1
            if range_contains(metrics.get(key), range_value):
                hits += 1
        allocation = profile.get("generation", {}).get("color_allocation", {}).get("mode")
        if allocation:
            checks += 1
            if metrics.get("allocationMode") == ("single-heavy" if allocation == "single_heavy" else allocation):
                hits += 1
        if checks == 0:
            continue
        score = hits / checks
        if score > best_score:
            best_id = str(profile.get("id", "unknown"))
            best_score = score
    if best_score < 0.5:
        return "unclassified", best_score
    return best_id, best_score


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    numeric_keys = [
        "actualCloseMean",
        "inputCloseMean",
        "colorRatio",
        "spreadParam",
        "debtPersistenceWeight",
        "passrate",
        "optimalWinRate",
        "winStarvationPerTile",
        "lossRemainingRatio",
        "pressureScore",
    ]
    result: dict[str, Any] = {"rows": len(rows)}
    result["grades"] = dict(sorted(Counter(row.get("grade") for row in rows).items()))
    result["allocationModes"] = dict(sorted(Counter(row.get("allocationMode") for row in rows).items()))
    for key in numeric_keys:
        values = [row[key] for row in rows if row.get(key) is not None]
        if values:
            sorted_values = sorted(values)
            result[key] = {
                "mean": round(mean(values), 4),
                "min": round(sorted_values[0], 4),
                "p25": round(sorted_values[int((len(sorted_values) - 1) * 0.25)], 4),
                "p50": round(sorted_values[int((len(sorted_values) - 1) * 0.50)], 4),
                "p75": round(sorted_values[int((len(sorted_values) - 1) * 0.75)], 4),
                "max": round(sorted_values[-1], 4),
            }
    return result


def grouped_summary(rows: list[dict[str, Any]], key: str) -> dict[str, Any]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[str(row.get(key, "unknown"))].append(row)
    return {group: summarize(items) for group, items in sorted(groups.items())}


def write_detail_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "sourceRun",
        "grade",
        "profile",
        "profileScore",
        "closureBand",
        "pressureScore",
        "actualCloseMean",
        "inputCloseMean",
        "colorRatio",
        "spreadParam",
        "debtPersistenceWeight",
        "allocationMode",
        "optimalWinRate",
        "winStarvationPerTile",
        "lossRemainingRatio",
        "sourceFile",
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in fields})


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--inputs", nargs="+", default=DEFAULT_INPUTS)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--detail-csv", type=Path)
    parser.add_argument("--include-probes", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8"))
    paths = expand_inputs(args.inputs)
    raw_rows = load_rows(paths, args.include_probes)
    metrics_rows = [row_metrics(row) for row in raw_rows]
    for row in metrics_rows:
        row["closureBand"] = closure_band(row.get("actualCloseMean"), config.get("closureBands", []))
        profile, score = profile_match(row, config.get("profiles", []))
        row["profile"] = profile
        row["profileScore"] = round(score, 4)

    result = {
        "config": str(args.config),
        "inputFiles": [str(path) for path in paths],
        "rowCount": len(metrics_rows),
        "summary": summarize(metrics_rows),
        "bySourceRun": grouped_summary(metrics_rows, "sourceRun"),
        "byClosureBand": grouped_summary(metrics_rows, "closureBand"),
        "byProfile": grouped_summary(metrics_rows, "profile"),
        "limitations": [
            "colorRatio uses totalTiles when batch CSV does not include freeTiles, so levels with const tiles are approximate.",
            "profile is a range-hit classifier for diagnostics, not a replacement for Strategy2 grade or Optimal acceptance.",
            "actualCloseMean excludes the final auto-closed layer when possible.",
        ],
    }
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text + "\n", encoding="utf-8")
    if args.detail_csv:
        write_detail_csv(args.detail_csv, metrics_rows)
    print(text)


if __name__ == "__main__":
    main()
