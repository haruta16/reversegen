#!/usr/bin/env python3
"""Apply the current Optimal experience profile to historical online-rate rows."""

from __future__ import annotations

import argparse
import csv
import json
import statistics
from collections import Counter
from pathlib import Path

from filter_optimal_experience_selection import DEFAULT_STRATEGY, evaluate, profile_from_strategy


REPO_ROOT = Path(__file__).resolve().parents[1]


def number(row: dict[str, str], key: str) -> float:
    return float(row[key])


def canonical(row: dict[str, str]) -> dict[str, str]:
    optimal = number(row, "optimal_winRate")
    return {
        "grade": row["策略2档位"],
        "最优机器人胜率(%)": str(optimal),
        "最优机器人胜局数": "1" if optimal > 0 else "0",
        "最优机器人负局数": "1" if optimal < 100 else "0",
        "最优机器人胜局平均断色次数": row["optimal_colorStarvationOnWin"],
        "最优机器人负局平均已走步数": row["optimal_stepsOnLoss"],
        "地形总牌数": row["地形总牌数"],
    }


def percentile(values: list[float], p: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    position = (len(ordered) - 1) * p
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    fraction = position - low
    return ordered[low] * (1.0 - fraction) + ordered[high] * fraction


def stats(rows: list[dict[str, str]]) -> dict[str, object]:
    values = [number(row, "净胜率(%)") for row in rows]
    return {
        "数量": len(rows),
        "线上胜率均值(%)": round(statistics.mean(values), 3) if values else "",
        "线上胜率中位数(%)": round(statistics.median(values), 3) if values else "",
        "P25(%)": round(percentile(values, 0.25), 3) if values else "",
        "P75(%)": round(percentile(values, 0.75), 3) if values else "",
    }


def write_csv(path: Path, headers: list[str], records: list[dict[str, object]]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        writer.writerows(records)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="output/失误率扫描_精选打点_策略2分档.csv")
    parser.add_argument("--output", default="output/Optimal体验筛选_线上验证")
    parser.add_argument("--strategy", default=str(DEFAULT_STRATEGY))
    args = parser.parse_args()
    input_path = Path(args.input) if Path(args.input).is_absolute() else REPO_ROOT / args.input
    output_dir = Path(args.output) if Path(args.output).is_absolute() else REPO_ROOT / args.output
    strategy_path = Path(args.strategy) if Path(args.strategy).is_absolute() else REPO_ROOT / args.strategy
    profile = profile_from_strategy(strategy_path)
    output_dir.mkdir(parents=True, exist_ok=True)

    with input_path.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    evaluated: list[tuple[dict[str, str], bool, str]] = []
    for row in rows:
        accepted, reason = evaluate(canonical(row), profile)
        evaluated.append((row, accepted, reason))

    grade_summary: list[dict[str, object]] = []
    for grade in map(str, range(6)):
        before = [row for row, _, _ in evaluated if row["策略2档位"] == grade]
        after = [row for row, accepted, _ in evaluated if row["策略2档位"] == grade and accepted]
        before_stats = stats(before)
        after_stats = stats(after)
        grade_summary.append({
            "策略2档位": f"G{grade}",
            "筛选前数量": before_stats["数量"],
            "筛选后数量": after_stats["数量"],
            "保留率(%)": round(len(after) / len(before) * 100, 2) if before else "",
            "筛选前线上均值(%)": before_stats["线上胜率均值(%)"],
            "筛选后线上均值(%)": after_stats["线上胜率均值(%)"],
            "筛选前线上中位数(%)": before_stats["线上胜率中位数(%)"],
            "筛选后线上中位数(%)": after_stats["线上胜率中位数(%)"],
            "筛选后P25(%)": after_stats["P25(%)"],
            "筛选后P75(%)": after_stats["P75(%)"],
        })
    write_csv(output_dir / "档位筛选前后线上统计.csv", list(grade_summary[0].keys()), grade_summary)

    band_rows: list[dict[str, object]] = []
    for grade in map(str, range(6)):
        selected = [row for row, accepted, _ in evaluated if row["策略2档位"] == grade and accepted]
        bands = Counter(min(9, int(number(row, "净胜率(%)") // 10)) for row in selected)
        for band in range(10):
            band_rows.append({
                "策略2档位": f"G{grade}",
                "线上胜率区间": f"{band * 10}-{(band + 1) * 10}%",
                "数量": bands[band],
                "档内占比(%)": round(bands[band] / len(selected) * 100, 2) if selected else 0,
            })
    write_csv(output_dir / "筛选后线上十档分布.csv", list(band_rows[0].keys()), band_rows)

    detail: list[dict[str, object]] = []
    reason_counts: Counter[str] = Counter()
    for row, accepted, reason in evaluated:
        reason_counts[f"G{row['策略2档位']}:{reason}"] += 1
        normalized = canonical(row)
        total_tiles = float(normalized["地形总牌数"])
        starvation = float(normalized["最优机器人胜局平均断色次数"]) / total_tiles * 100 if total_tiles else 0
        remaining = 100 - float(normalized["最优机器人负局平均已走步数"]) / total_tiles * 100 if float(normalized["最优机器人负局数"]) > 0 else 0
        detail.append({
            "关卡牌局代码": row["关卡牌局代码"],
            "地形编号": row["地形编号"],
            "策略2档位": row["策略2档位"],
            "策略2估计通过率(%)": row["策略2估计通过率(%)"],
            "实际线上胜率(%)": row["净胜率(%)"],
            "Optimal胜率(%)": row["optimal_winRate"],
            "胜局断色率(每百牌)": round(starvation, 3),
            "败局剩余比例(%)": round(remaining, 3),
            "是否保留": "是" if accepted else "否",
            "判断原因": reason,
        })
    write_csv(output_dir / "逐牌局筛选结果.csv", list(detail[0].keys()), detail)

    report = {
        "profile": profile,
        "profile_source": str(strategy_path),
        "input": str(input_path),
        "rows": len(rows),
        "kept_rows": sum(accepted for _, accepted, _ in evaluated),
        "grade_summary": grade_summary,
        "reason_counts": dict(sorted(reason_counts.items())),
    }
    (output_dir / "验证报告.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
