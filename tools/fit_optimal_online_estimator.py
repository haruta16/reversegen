#!/usr/bin/env python3
"""Fit and compare online-win-rate estimators with terrain-grouped cross validation."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
from pathlib import Path

import numpy as np


REPO_ROOT = Path(__file__).resolve().parents[1]
LAMBDAS = [0.0, 0.0001, 0.001, 0.01, 0.1, 1.0, 10.0]


def stable_fold(text: str, folds: int, salt: str) -> int:
    digest = hashlib.sha256(f"{salt}:{text}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % folds


def clamp(values: np.ndarray) -> np.ndarray:
    return np.clip(values, 0.0, 1.0)


def grade(rate: float) -> int:
    if rate >= 0.90:
        return 0
    if rate >= 0.60:
        return 1
    if rate >= 0.40:
        return 2
    if rate >= 0.20:
        return 3
    if rate >= 0.10:
        return 4
    return 5


def ten_band(rate: float) -> int:
    return min(9, max(0, int(rate * 10)))


def number(row: dict[str, str], key: str) -> float:
    return float(row[key])


def optimal_features(row: dict[str, str]) -> dict[str, float]:
    optimal = number(row, "optimal_winRate") / 100.0
    tiles = max(number(row, "地形总牌数"), 1.0)
    win_forced = number(row, "optimal_forcedPickOnWin")
    win_starve = number(row, "optimal_colorStarvationOnWin")
    loss_steps = number(row, "optimal_stepsOnLoss")
    loss_forced = number(row, "optimal_forcedPickOnLoss")
    loss_starve = number(row, "optimal_colorStarvationOnLoss")
    has_win = 1.0 if optimal > 0 else 0.0
    has_loss = 1.0 if optimal < 1 else 0.0
    loss_progress = loss_steps / tiles if has_loss else 1.0
    return {
        "optimal_win_rate": optimal,
        "optimal_win_rate_sq": optimal * optimal,
        "log_tile_count": math.log1p(tiles),
        "win_starvation_per_tile": win_starve / tiles if has_win else 0.0,
        "loss_progress": loss_progress,
        "loss_progress_sq": loss_progress * loss_progress,
        "loss_starvation_per_step": loss_starve / loss_steps if has_loss and loss_steps > 0 else 0.0,
        "win_forced_per_tile": win_forced / tiles if has_win else 0.0,
        "loss_forced_per_step": loss_forced / loss_steps if has_loss and loss_steps > 0 else 0.0,
        "has_optimal_win": has_win,
        "has_optimal_loss": has_loss,
    }


def sim_features(row: dict[str, str]) -> dict[str, float]:
    return {
        "sim1": number(row, "mistake_0.01") / 100.0,
        "sim5": number(row, "mistake_0.05") / 100.0,
        "sim15": number(row, "mistake_0.15") / 100.0,
    }


class RidgeModel:
    def __init__(self, names: list[str], mean: np.ndarray, scale: np.ndarray, beta: np.ndarray, ridge: float):
        self.names = names
        self.mean = mean
        self.scale = scale
        self.beta = beta
        self.ridge = ridge

    def predict(self, matrix: np.ndarray) -> np.ndarray:
        z = (matrix - self.mean) / self.scale
        return clamp(self.beta[0] + np.sum(z * self.beta[1:], axis=1))

    def raw_parameters(self) -> dict[str, object]:
        coefficients = self.beta[1:] / self.scale
        intercept = float(self.beta[0] - np.sum(coefficients * self.mean))
        return {
            "ridge_lambda": self.ridge,
            "intercept": intercept,
            "coefficients": {name: float(value) for name, value in zip(self.names, coefficients)},
            "formula": "clamp(intercept + sum(coefficient[feature] * feature), 0, 1)",
        }


def fit_ridge(matrix: np.ndarray, target: np.ndarray, names: list[str], ridge: float) -> RidgeModel:
    mean = matrix.mean(axis=0)
    scale = matrix.std(axis=0)
    scale[scale < 1e-12] = 1.0
    z = (matrix - mean) / scale
    design = np.column_stack([np.ones(len(z)), z])
    penalty = np.eye(design.shape[1]) * ridge * len(design)
    penalty[0, 0] = 0.0
    gram = np.einsum("ni,nj->ij", design, design)
    rhs = np.einsum("ni,n->i", design, target)
    beta = np.linalg.lstsq(gram + penalty, rhs, rcond=None)[0]
    return RidgeModel(names, mean, scale, beta, ridge)


def pick_lambda(matrix: np.ndarray, target: np.ndarray, groups: list[str], names: list[str], salt: str) -> float:
    losses: dict[float, list[float]] = {value: [] for value in LAMBDAS}
    folds = np.array([stable_fold(group, 4, salt) for group in groups])
    for fold in range(4):
        train = folds != fold
        valid = folds == fold
        if not train.any() or not valid.any():
            continue
        for ridge in LAMBDAS:
            model = fit_ridge(matrix[train], target[train], names, ridge)
            prediction = model.predict(matrix[valid])
            losses[ridge].append(float(np.mean((prediction - target[valid]) ** 2)))
    return min(LAMBDAS, key=lambda value: (np.mean(losses[value]) if losses[value] else float("inf"), value))


def cross_validate(matrix: np.ndarray, target: np.ndarray, groups: list[str], names: list[str], model_name: str) -> tuple[np.ndarray, list[float]]:
    predictions = np.zeros(len(target))
    selected: list[float] = []
    outer = np.array([stable_fold(group, 5, "outer") for group in groups])
    for fold in range(5):
        train = outer != fold
        valid = outer == fold
        train_groups = [group for group, keep in zip(groups, train) if keep]
        ridge = pick_lambda(matrix[train], target[train], train_groups, names, f"inner:{model_name}:{fold}")
        selected.append(ridge)
        model = fit_ridge(matrix[train], target[train], names, ridge)
        predictions[valid] = model.predict(matrix[valid])
    return predictions, selected


def metrics(actual: np.ndarray, predicted: np.ndarray) -> dict[str, float]:
    error = predicted - actual
    actual_grades = np.array([grade(value) for value in actual])
    predicted_grades = np.array([grade(value) for value in predicted])
    distance = np.abs(actual_grades - predicted_grades)
    total_variance = float(np.sum((actual - actual.mean()) ** 2))
    pearson = float(np.corrcoef(actual, predicted)[0, 1]) if np.std(predicted) > 0 else 0.0
    return {
        "mae": float(np.mean(np.abs(error))),
        "rmse": float(np.sqrt(np.mean(error ** 2))),
        "r2": 1.0 - float(np.sum(error ** 2)) / total_variance,
        "pearson": pearson,
        "grade_exact": float(np.mean(distance == 0)),
        "grade_within_one": float(np.mean(distance <= 1)),
        "grade_cross_two": float(np.mean(distance >= 2)),
        "grade_mae": float(np.mean(distance)),
    }


def write_csv(path: Path, headers: list[str], records: list[dict[str, object]]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        writer.writerows(records)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="output/失误率扫描_精选打点/原始数据.csv")
    parser.add_argument("--output", default="output/optimal在线胜率拟合")
    args = parser.parse_args()
    input_path = (REPO_ROOT / args.input).resolve() if not Path(args.input).is_absolute() else Path(args.input)
    output_dir = (REPO_ROOT / args.output).resolve() if not Path(args.output).is_absolute() else Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    with input_path.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    rows = [row for row in rows if row.get("净胜率(%)", "") != ""]
    target = np.array([number(row, "净胜率(%)") / 100.0 for row in rows])
    groups = [row["地形编号"] for row in rows]
    optimal = [optimal_features(row) for row in rows]
    sims = [sim_features(row) for row in rows]

    feature_sets: dict[str, tuple[list[str], list[dict[str, float]]]] = {
        "sim重新拟合": (["sim1", "sim5", "sim15"], sims),
        "Optimal胜率校准": (["optimal_win_rate", "optimal_win_rate_sq", "log_tile_count"], optimal),
        "Optimal全参数": (list(optimal[0].keys()), optimal),
        "sim+Optimal联合": (list(sims[0].keys()) + list(optimal[0].keys()), [{**s, **o} for s, o in zip(sims, optimal)]),
    }
    predictions: dict[str, np.ndarray] = {
        "策略2固定公式": clamp(np.array([
            0.30 * values["sim1"] + 0.10 * values["sim5"] + 0.60 * values["sim15"] + 0.08
            for values in sims
        ])),
    }
    selected_lambdas: dict[str, list[float]] = {}
    final_models: dict[str, object] = {}

    for model_name, (names, records) in feature_sets.items():
        matrix = np.array([[record[name] for name in names] for record in records], dtype=float)
        prediction, selected = cross_validate(matrix, target, groups, names, model_name)
        predictions[model_name] = prediction
        selected_lambdas[model_name] = selected
        final_lambda = pick_lambda(matrix, target, groups, names, f"final:{model_name}")
        final_model = fit_ridge(matrix, target, names, final_lambda)
        final_models[model_name] = {
            "features": names,
            "cross_validation_lambdas": selected,
            **final_model.raw_parameters(),
        }

    comparison: list[dict[str, object]] = []
    for model_name, prediction in predictions.items():
        result = metrics(target, prediction)
        comparison.append({
            "模型": model_name,
            "MAE": round(result["mae"] * 100, 3),
            "RMSE": round(result["rmse"] * 100, 3),
            "R2": round(result["r2"], 4),
            "Pearson": round(result["pearson"], 4),
            "档位完全一致率": round(result["grade_exact"] * 100, 2),
            "档位误差不超过1率": round(result["grade_within_one"] * 100, 2),
            "跨2档及以上率": round(result["grade_cross_two"] * 100, 2),
            "平均档位误差": round(result["grade_mae"], 3),
        })
    write_csv(output_dir / "模型对比.csv", list(comparison[0].keys()), comparison)

    ten_band_comparison: list[dict[str, object]] = []
    actual_bands = np.array([ten_band(value) for value in target])
    for model_name, prediction in predictions.items():
        predicted_bands = np.array([ten_band(value) for value in prediction])
        distance = np.abs(actual_bands - predicted_bands)
        ten_band_comparison.append({
            "模型": model_name,
            "十档完全一致率": round(float(np.mean(distance == 0)) * 100, 2),
            "误差不超过1档率": round(float(np.mean(distance <= 1)) * 100, 2),
            "误差不超过2档率": round(float(np.mean(distance <= 2)) * 100, 2),
            "跨3档及以上率": round(float(np.mean(distance >= 3)) * 100, 2),
            "平均档位误差": round(float(np.mean(distance)), 3),
        })
    write_csv(output_dir / "十档模型对比.csv", list(ten_band_comparison[0].keys()), ten_band_comparison)

    ten_band_distribution: list[dict[str, object]] = []
    for model_name, prediction in predictions.items():
        predicted_bands = np.array([ten_band(value) for value in prediction])
        for value in range(10):
            mask = predicted_bands == value
            ten_band_distribution.append({
                "模型": model_name,
                "预测胜率档": f"{value * 10}-{(value + 1) * 10}%",
                "数量": int(mask.sum()),
                "实际线上胜率均值(%)": round(float(target[mask].mean() * 100), 3) if mask.any() else "",
                "实际线上胜率中位数(%)": round(float(np.median(target[mask]) * 100), 3) if mask.any() else "",
            })
    write_csv(output_dir / "十档线上分布.csv", list(ten_band_distribution[0].keys()), ten_band_distribution)

    detail: list[dict[str, object]] = []
    for index, row in enumerate(rows):
        record: dict[str, object] = {
            "关卡牌局代码": row["关卡牌局代码"],
            "地形编号": row["地形编号"],
            "线上胜率(%)": round(target[index] * 100, 3),
            "线上真实档位": grade(target[index]),
        }
        for model_name, prediction in predictions.items():
            record[f"{model_name}预测胜率(%)"] = round(prediction[index] * 100, 3)
            record[f"{model_name}预测档位"] = grade(prediction[index])
        detail.append(record)
    write_csv(output_dir / "逐牌局交叉验证预测.csv", list(detail[0].keys()), detail)

    grade_rows: list[dict[str, object]] = []
    for model_name, prediction in predictions.items():
        predicted_grades = np.array([grade(value) for value in prediction])
        for value in range(6):
            mask = predicted_grades == value
            grade_rows.append({
                "模型": model_name,
                "预测档位": value,
                "数量": int(mask.sum()),
                "实际线上胜率均值(%)": round(float(target[mask].mean() * 100), 3) if mask.any() else "",
                "实际线上胜率中位数(%)": round(float(np.median(target[mask]) * 100), 3) if mask.any() else "",
            })
    write_csv(output_dir / "预测档位线上分布.csv", list(grade_rows[0].keys()), grade_rows)

    parameter_output = {
        "input": str(input_path),
        "rows": len(rows),
        "validation": "5-fold grouped by terrain; ridge lambda selected by inner terrain-grouped CV",
        "strategy2_fixed": {
            "formula": "clamp(0.30*sim1 + 0.10*sim5 + 0.60*sim15 + 0.08, 0, 1)",
        },
        "models": final_models,
    }
    (output_dir / "模型参数.json").write_text(json.dumps(parameter_output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    feature_notes = [
        {"特征": "optimal_win_rate", "说明": "Optimal胜率，0-1"},
        {"特征": "optimal_win_rate_sq", "说明": "Optimal胜率平方，用于拟合非线性"},
        {"特征": "log_tile_count", "说明": "log(1+地形总牌数)，控制大地形天然偏难"},
        {"特征": "win_starvation_per_tile", "说明": "Optimal胜局平均断色次数/地形总牌数"},
        {"特征": "loss_progress", "说明": "Optimal败局平均已走步数/地形总牌数；无败局时为1"},
        {"特征": "loss_progress_sq", "说明": "败局进度平方"},
        {"特征": "loss_starvation_per_step", "说明": "Optimal败局平均断色次数/败局平均已走步数"},
        {"特征": "win_forced_per_tile", "说明": "Optimal胜局平均被迫选牌次数/地形总牌数"},
        {"特征": "loss_forced_per_step", "说明": "Optimal败局平均被迫选牌次数/败局平均已走步数"},
        {"特征": "has_optimal_win", "说明": "Optimal是否至少有胜局"},
        {"特征": "has_optimal_loss", "说明": "Optimal是否至少有败局"},
    ]
    write_csv(output_dir / "Optimal特征说明.csv", ["特征", "说明"], feature_notes)

    lines = [
        "# Optimal在线胜率拟合对比",
        "",
        f"- 数据：{len(rows)}条",
        "- 验证：按地形分组五折；训练折内再按地形选择岭回归强度",
        "- 所有预测指标均为测试折结果，不是训练集拟合分数",
        "",
        "| 模型 | MAE(pp) | RMSE(pp) | R2 | Pearson | 档位一致 | 误差≤1档 | 跨≥2档 |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in comparison:
        lines.append(
            f"| {row['模型']} | {row['MAE']:.3f} | {row['RMSE']:.3f} | {row['R2']:.4f} | "
            f"{row['Pearson']:.4f} | {row['档位完全一致率']:.2f}% | {row['档位误差不超过1率']:.2f}% | {row['跨2档及以上率']:.2f}% |"
        )
    (output_dir / "对比报告.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"rows": len(rows), "output": str(output_dir), "comparison": comparison}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
