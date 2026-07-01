#!/usr/bin/env python3
"""逐层花色使用率/债务保留率的相关性、地形内效应和聚类稳健显著性。"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "output/失误率扫描/原始数据.csv"
OUT_CSV = ROOT / "output/逐层指标显著性分析.csv"
OUT_JSON = ROOT / "output/逐层指标显著性分析.json"


def parse_curve(value) -> list[float]:
    if pd.isna(value) or str(value).strip() == "":
        return []
    return [float(x) for x in str(value).split("|") if x != ""]


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def derive(row: pd.Series) -> dict[str, float]:
    usage = parse_curve(row["花色使用率_逐层"])
    retention = parse_curve(row["债务保留率_逐层"])
    debt = parse_curve(row["债务Tile数_逐层"])
    depth = len(usage)
    valid = [i for i in range(min(len(retention), len(debt))) if debt[i] > 0]
    retained_counts = [retention[i] * debt[i] for i in valid]

    first_full = next((i + 1 for i, value in enumerate(usage) if value >= 1 - 1e-9), depth)
    increments = [usage[0] if usage else 0] + [usage[i] - usage[i - 1] for i in range(1, depth)]
    activation = float(row.get("花色平均启用层", 0) or 0)
    retention_weighted = (
        sum(retained_counts) / sum(debt[i] for i in valid) if valid else 0.0
    )

    return {
        "花色使用率_首层": usage[0] if usage else 0.0,
        "花色使用率_中层": usage[(depth - 1) // 2] if usage else 0.0,
        "花色使用率_曲线均值": mean(usage),
        "花色平均启用层": activation,
        "花色平均启用层_归一": (activation - 1) / (depth - 1) if depth > 1 else 0.0,
        "全花色启用层_归一": first_full / depth if depth else 0.0,
        "单层最大花色启用增量": max(increments, default=0.0),
        "债务保留率_首跳": retention[0] if retention else 0.0,
        "债务保留率_曲线均值": mean(retention),
        "债务保留率_Tile加权": retention_weighted,
        "债务保留率_最大值": max(retention, default=0.0),
        "债务保留活跃转移占比": (
            sum(1 for i in valid if retention[i] > 0) / len(valid) if valid else 0.0
        ),
        "高保留转移占比_至少50%": (
            sum(1 for i in valid if retention[i] >= 0.5) / len(valid) if valid else 0.0
        ),
        "保留旧债务Tile总量": sum(retained_counts),
        "每次有效转移平均保留Tile": mean(retained_counts),
    }


def zscore(values: np.ndarray) -> np.ndarray:
    sd = values.std(ddof=0)
    return (values - values.mean()) / sd if sd > 1e-12 else np.zeros_like(values)


def pearson(x: np.ndarray, y: np.ndarray) -> float:
    if x.std() < 1e-12 or y.std() < 1e-12:
        return 0.0
    return float(np.corrcoef(x, y)[0, 1])


def residualize(y: np.ndarray, x: np.ndarray) -> np.ndarray:
    return y - x @ (np.linalg.pinv(x) @ y)


def normal_p(z: float) -> float:
    return math.erfc(abs(z) / math.sqrt(2))


def cluster_regression(y: np.ndarray, metric: np.ndarray, controls: np.ndarray, groups: np.ndarray):
    x = np.column_stack([controls, zscore(metric)])
    inv = np.linalg.pinv(x.T @ x)
    beta = inv @ x.T @ zscore(y)
    resid = zscore(y) - x @ beta
    meat = np.zeros((x.shape[1], x.shape[1]))
    unique = np.unique(groups)
    for group in unique:
        idx = groups == group
        score = x[idx].T @ resid[idx]
        meat += np.outer(score, score)
    n, k, g = len(y), x.shape[1], len(unique)
    correction = (g / (g - 1)) * ((n - 1) / (n - k)) if g > 1 and n > k else 1
    cov = correction * inv @ meat @ inv
    se = math.sqrt(max(float(cov[-1, -1]), 0))
    coefficient = float(beta[-1])
    z = coefficient / se if se > 1e-12 else 0.0
    return coefficient, se, normal_p(z)


def grouped_folds(groups: np.ndarray, count: int = 5) -> list[np.ndarray]:
    buckets = {group: np.flatnonzero(groups == group) for group in np.unique(groups)}
    folds: list[list[int]] = [[] for _ in range(count)]
    sizes = [0] * count
    for indices in sorted(buckets.values(), key=len, reverse=True):
        target = int(np.argmin(sizes))
        folds[target].extend(indices.tolist())
        sizes[target] += len(indices)
    return [np.array(fold, dtype=int) for fold in folds]


def ridge_cv(y: np.ndarray, features: np.ndarray, groups: np.ndarray, ridge: float = 1.0) -> np.ndarray:
    predictions = np.zeros(len(y))
    for test in grouped_folds(groups):
        train_mask = np.ones(len(y), dtype=bool)
        train_mask[test] = False
        train = np.flatnonzero(train_mask)
        means = features[train].mean(axis=0)
        stds = features[train].std(axis=0)
        stds[stds < 1e-12] = 1
        x_train = np.column_stack([np.ones(len(train)), (features[train] - means) / stds])
        x_test = np.column_stack([np.ones(len(test)), (features[test] - means) / stds])
        penalty = np.eye(x_train.shape[1]) * ridge
        penalty[0, 0] = 0
        beta = np.linalg.pinv(x_train.T @ x_train + penalty) @ x_train.T @ y[train]
        predictions[test] = np.clip(x_test @ beta, 0, 1)
    return predictions


def grade(rate: float) -> int:
    if rate >= .9: return 0
    if rate >= .6: return 1
    if rate >= .4: return 2
    if rate >= .2: return 3
    if rate >= .1: return 4
    return 5


def evaluate_cv(name: str, y: np.ndarray, prediction: np.ndarray) -> dict:
    actual_grade = np.array([grade(v) for v in y])
    predicted_grade = np.array([grade(v) for v in prediction])
    distance = np.abs(actual_grade - predicted_grade)
    return {
        "方法": name,
        "胜率MAE": float(np.mean(np.abs(prediction - y))),
        "胜率RMSE": float(np.sqrt(np.mean((prediction - y) ** 2))),
        "精确分档": float(np.mean(distance == 0)),
        "相邻档内": float(np.mean(distance <= 1)),
        "跨两档及以上": float(np.mean(distance >= 2)),
        "档位MAE": float(np.mean(distance)),
    }


def main():
    frame = pd.read_csv(RAW)
    derived = pd.DataFrame([derive(row) for _, row in frame.iterrows()])
    data = pd.concat([frame.reset_index(drop=True), derived], axis=1)

    y = data["在线胜率(%)"].to_numpy(float) / 100
    sim = data[["mistake_0.01", "mistake_0.05", "mistake_0.15"]].to_numpy(float) / 100
    sim_controls = np.column_stack([np.ones(len(data)), *[zscore(sim[:, i]) for i in range(3)]])
    terrain_dummies = pd.get_dummies(data["地形编号"].astype(str), drop_first=True, dtype=float).to_numpy()
    full_controls = np.column_stack([sim_controls, terrain_dummies])
    groups = data["地形编号"].astype(str).to_numpy()

    results = []
    for metric in derived.columns:
        x = derived[metric].to_numpy(float)
        raw_r = pearson(x, y)
        spearman = pearson(pd.Series(x).rank(method="average").to_numpy(), pd.Series(y).rank(method="average").to_numpy())

        # derived列和原表可能同名；显式按地形重新聚合当前x。
        temp = pd.DataFrame({"terrain": groups, "x": x, "y": y})
        within_x = x - temp.groupby("terrain")["x"].transform("mean").to_numpy()
        within_y = y - temp.groupby("terrain")["y"].transform("mean").to_numpy()
        within_r = pearson(within_x, within_y)

        sim_partial = pearson(residualize(x, sim_controls), residualize(y, sim_controls))
        full_partial = pearson(residualize(x, full_controls), residualize(y, full_controls))
        beta, robust_se, robust_p = cluster_regression(y, x, full_controls, groups)

        try:
            bins = pd.qcut(pd.Series(x), 5, duplicates="drop")
            grouped = pd.DataFrame({"bin": bins, "online": y}).groupby("bin", observed=True)["online"].mean()
            q1, q5 = float(grouped.iloc[0]), float(grouped.iloc[-1])
        except Exception:
            q1 = q5 = float(y.mean())

        results.append({
            "指标": metric,
            "全局Pearson": raw_r,
            "全局Spearman": spearman,
            "同地形Pearson": within_r,
            "控制sim偏相关": sim_partial,
            "控制sim和地形偏相关": full_partial,
            "标准化回归系数": beta,
            "地形聚类稳健SE": robust_se,
            "地形聚类稳健p值": robust_p,
            "Q1在线均值": q1,
            "Q5在线均值": q5,
            "Q5减Q1": q5 - q1,
        })

    result_frame = pd.DataFrame(results)
    result_frame["独立信息等级"] = np.select(
        [
            (result_frame["地形聚类稳健p值"] < 0.05) & (result_frame["控制sim和地形偏相关"].abs() >= 0.05),
            result_frame["地形聚类稳健p值"] < 0.05,
            result_frame["全局Pearson"].abs() >= 0.20,
        ],
        ["显著且有独立信息", "统计显著但效应很弱", "仅总体相关"],
        default="基本无效",
    )
    result_frame = result_frame.sort_values(
        ["独立信息等级", "控制sim和地形偏相关"], ascending=[True, False]
    )
    result_frame.to_csv(OUT_CSV, index=False, float_format="%.6f")

    base_features = sim
    candidate_sets = [
        ("三率基线", []),
        ("三率+保留旧债务Tile总量", ["保留旧债务Tile总量"]),
        ("三率+每次平均保留Tile", ["每次有效转移平均保留Tile"]),
        ("三率+Tile加权保留率", ["债务保留率_Tile加权"]),
        ("三率+三项债务保留指标", ["保留旧债务Tile总量", "每次有效转移平均保留Tile", "债务保留率_Tile加权"]),
        ("三率+花色平均启用层", ["花色平均启用层"]),
    ]
    cv_results = []
    for name, metrics in candidate_sets:
        extra = derived[metrics].to_numpy(float) if metrics else np.empty((len(data), 0))
        features = np.column_stack([base_features, extra])
        prediction = ridge_cv(y, features, groups)
        cv_results.append(evaluate_cv(name, y, prediction))

    payload = {
        "rows": len(data),
        "terrains": int(data["地形编号"].nunique()),
        "method": "全局相关 + 同地形去均值 + 控制sim偏相关 + 地形固定效应/地形聚类稳健SE",
        "results": result_frame.to_dict(orient="records"),
        "cvComparisons": cv_results,
    }
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf8")
    print(result_frame.to_string(index=False))


if __name__ == "__main__":
    main()
