#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import re
import shlex
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
BASE_DIR = ROOT / "output" / "generation_feature"
STRATEGIES_DIR = BASE_DIR / "strategies"
RUNS_DIR = BASE_DIR / "runs"
SCHEMA_PATH = BASE_DIR / "strategy.schema.json"
STRATEGY_INDEX_CSV = BASE_DIR / "strategies.csv"
RUNS_JSONL = BASE_DIR / "runs.jsonl"
RUNS_INDEX_CSV = BASE_DIR / "runs.csv"
PYTHON = "/Users/wenhaowang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3"

EXECUTORS = {
    "run-batch-generation",
    "backfill-missing-grades",
    "search-missing-grade-samples",
    "build-calibration-variant",
    "refresh-endless-simulation",
}

MODE_ENUMS = {
    "closure": {"random", "random_range", "fixed_points", "full_layer_max", "per_layer_list"},
    "color": {"ratio", "ratio_jitter", "fixed_count", "range"},
    "color_allocation": {"balanced", "single_heavy"},
    "spread_debt": {"fixed", "random", "random_range"},
}

STRATEGY_INDEX_FIELDS = [
    "strategy_id",
    "name",
    "version",
    "purpose",
    "status",
    "executor",
    "terrain_source",
    "level_range",
    "include_levels",
    "exclude_levels",
    "source_csv",
    "workbook",
    "grades",
    "target_count_per_grade",
    "fill_policy",
    "fallback_policy",
    "closure",
    "color",
    "spread",
    "debt",
    "grade_strategy",
    "sim_runs",
    "attempts_per_level",
    "template_attempts",
    "concurrency",
    "min_per_level_grade",
    "cap_per_level_grade",
    "notes",
    "strategy_file",
]

RUN_INDEX_FIELDS = [
    "run_id",
    "strategy_id",
    "strategy_version",
    "status",
    "created_at",
    "updated_at",
    "run_dir",
    "command_file",
    "primary_output",
    "analysis_output",
    "config_output",
    "report_output",
    "notes",
]

DEFAULT_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "ReverseGen generation strategy",
    "type": "object",
    "required": ["meta", "scope", "target", "generation", "evaluation", "search", "outputs", "adapter"],
    "properties": {
        "meta": {
            "type": "object",
            "required": ["strategy_id", "name", "version", "purpose", "status"],
            "properties": {
                "strategy_id": {"type": "string"},
                "name": {"type": "string"},
                "version": {"type": "integer", "minimum": 1},
                "purpose": {"type": "string"},
                "status": {"enum": ["active", "draft", "deprecated", "archived"]},
                "notes": {"type": "string"},
            },
        },
        "scope": {
            "type": "object",
            "properties": {
                "terrain_source": {"type": "string"},
                "level_range": {"type": "string"},
                "include_levels": {"type": "array", "items": {"type": ["integer", "string"]}},
                "exclude_levels": {"type": "array", "items": {"type": ["integer", "string"]}},
                "levels_dir": {"type": "string"},
                "source_csv": {"type": "string"},
                "first_backfill_csv": {"type": "string"},
                "latest_backfill_csv": {"type": "string"},
                "workbook": {"type": "string"},
                "template_workbook": {"type": "string"},
            },
        },
        "target": {
            "type": "object",
            "required": ["grades", "target_count_per_grade", "fill_policy", "fallback_policy"],
            "properties": {
                "grades": {"type": "array", "items": {"type": "integer", "minimum": 0}},
                "target_count_per_grade": {"type": "integer", "minimum": 0},
                "fill_policy": {"enum": ["all", "missing_only", "replace_filtered", "probe_only", "cap_only", "none"]},
                "fallback_policy": {"enum": ["downward_only", "lowest_available", "allow_any", "none"]},
                "min_existing_count": {"type": "integer", "minimum": 0},
            },
        },
        "generation": {
            "type": "object",
            "required": ["closure", "color", "spread", "debt"],
            "properties": {
                "placement_mode": {"enum": ["layer-closure", "random-color"]},
                "closure": {"$ref": "#/$defs/parameterPolicy"},
                "color": {"$ref": "#/$defs/parameterPolicy"},
                "spread": {"$ref": "#/$defs/parameterPolicy"},
                "debt": {"$ref": "#/$defs/parameterPolicy"},
                "color_allocation": {"$ref": "#/$defs/parameterPolicy"},
            },
        },
        "evaluation": {
            "type": "object",
            "required": ["grade_strategy", "sim_runs", "threshold_profile"],
            "properties": {
                "grade_strategy": {"type": "string"},
                "sim_runs": {"type": "integer", "minimum": 0},
                "threshold_profile": {"type": "string"},
                "acceptance": {
                    "type": "object",
                    "properties": {
                        "min_sim1_wins": {"type": "integer", "minimum": 0},
                        "min_sim5_wins": {"type": "integer", "minimum": 0},
                        "min_sim15_wins": {"type": "integer", "minimum": 0},
                        "min_passrate": {"type": "number", "minimum": 0},
                        "optimal": {
                            "type": "object",
                            "required": ["runs", "grade_constraints"],
                            "properties": {
                                "runs": {"type": "integer", "minimum": 1},
                                "grade_constraints": {
                                    "type": "object",
                                    "additionalProperties": {"$ref": "#/$defs/optimalGradeConstraint"},
                                },
                            },
                        },
                    },
                },
            },
        },
        "search": {
            "type": "object",
            "properties": {
                "attempts_per_level": {"type": "integer", "minimum": 0},
                "attempts_per_missing_grade": {"type": "integer", "minimum": 0},
                "max_attempts_per_missing": {"type": "integer", "minimum": 0},
                "template_attempts": {"type": "integer", "minimum": 0},
                "concurrency": {"type": "integer", "minimum": 1},
                "shuffle": {"type": "boolean"},
                "resume": {"type": "boolean"},
                "reuse_template_params": {"type": "boolean"},
                "target_from_output_only": {"type": "boolean"},
                "adaptive_search": {"type": "boolean"},
                "optimal_first": {"type": "boolean"},
                "adaptive_explore_rate": {"type": "number", "minimum": 0, "maximum": 1},
                "adaptive_pool_size": {"type": "integer", "minimum": 1},
                "adaptive_min_samples": {"type": "integer", "minimum": 1},
                "adaptive_continuous_step": {"type": "number", "exclusiveMinimum": 0, "maximum": 0.5},
            },
        },
        "outputs": {
            "type": "object",
            "properties": {
                "min_per_level_grade": {"type": "integer", "minimum": 0},
                "cap_per_level_grade": {"type": "integer", "minimum": 0},
                "write_csv": {"type": "boolean"},
                "write_replay_json": {"type": "boolean"},
                "write_calibration_xlsx": {"type": "boolean"},
                "write_config_json": {"type": "boolean"},
            },
        },
        "adapter": {
            "type": "object",
            "required": ["executor", "mode"],
            "properties": {
                "executor": {"enum": sorted(EXECUTORS)},
                "mode": {"enum": ["plan_command", "execute_command"]},
            },
        },
    },
    "$defs": {
        "parameterPolicy": {
            "type": "object",
            "required": ["mode"],
            "properties": {
                "mode": {"type": "string"},
                "value": {"type": ["number", "string"]},
                "min": {"type": "number"},
                "max": {"type": "number"},
                "ratio": {"type": "number"},
                "jitter": {"type": "integer"},
                "points": {"type": "array", "items": {"type": "number"}},
                "values": {"type": "array", "items": {"type": "number"}},
            },
        },
        "optimalGradeConstraint": {
            "type": "object",
            "properties": {
                "min_win_rate": {"type": "number", "minimum": 0, "maximum": 1},
                "min_win_rate_exclusive": {"type": "number", "minimum": 0, "maximum": 1},
                "max_win_rate_exclusive": {"type": "number", "minimum": 0, "maximum": 1},
                "min_win_starvation_per_tile": {"type": "number", "minimum": 0, "maximum": 1},
                "max_win_starvation_per_tile": {"type": "number", "minimum": 0, "maximum": 1},
                "max_loss_remaining_ratio": {"type": "number", "minimum": 0, "maximum": 1},
            },
            "additionalProperties": False,
        },
    },
}

DEFAULT_STRATEGIES: list[dict[str, Any]] = [
    {
        "meta": {
            "strategy_id": "base_random_s2_v1",
            "name": "基础随机策略2批量生成",
            "version": 1,
            "purpose": "页面端批量产关的后台版本：随机闭合率、随机分布/债务，策略2分档。",
            "status": "active",
            "notes": "适合作为全新批量生产默认入口。",
        },
        "scope": {
            "terrain_source": "level_json",
            "level_range": "",
            "include_levels": [100075, 100074],
            "exclude_levels": [],
            "levels_dir": "../TileMatchShell/Tools/Config/Json/Levels",
        },
        "target": {
            "grades": [0, 1, 2, 3, 4, 5],
            "target_count_per_grade": 10,
            "fill_policy": "all",
            "fallback_policy": "none",
        },
        "generation": {
            "closure": {"mode": "random"},
            "color": {"mode": "ratio", "ratio": 0.6},
            "spread": {"mode": "random"},
            "debt": {"mode": "random"},
        },
        "evaluation": {
            "grade_strategy": "strategy2",
            "sim_runs": 200,
            "threshold_profile": "current",
        },
        "search": {
            "attempts_per_level": 500,
            "template_attempts": 100,
            "concurrency": 5,
            "shuffle": True,
            "resume": False,
        },
        "outputs": {
            "cap_per_level_grade": 10,
            "write_csv": True,
            "write_replay_json": False,
            "write_calibration_xlsx": False,
            "write_config_json": False,
        },
        "adapter": {
            "executor": "run-batch-generation",
            "mode": "plan_command",
        },
    },
    {
        "meta": {
            "strategy_id": "low_grade_backfill_v1",
            "name": "低难度补缺策略",
            "version": 1,
            "purpose": "为缺少 G0/G1/G2 的地形寻找低难样本。",
            "status": "active",
            "notes": "G0 规则补缺不等同于策略2真实G0；G1/G2 通过策略2验收。",
        },
        "scope": {
            "terrain_source": "calibration_workbook",
            "level_range": "100003-100180",
            "include_levels": [],
            "exclude_levels": [100001, 100002, 100004],
            "source_csv": "output/100003～100071_100073+_合并去少_含补缺_每档最多10.csv",
            "template_workbook": "output/无尽关校准工具.xlsx",
        },
        "target": {
            "grades": [0, 1, 2],
            "target_count_per_grade": 10,
            "fill_policy": "missing_only",
            "fallback_policy": "downward_only",
            "min_existing_count": 1,
        },
        "generation": {
            "closure": {"mode": "random_range", "min": 0.8, "max": 1.0},
            "color": {"mode": "ratio_jitter", "ratio": 0.6, "jitter": 2},
            "spread": {"mode": "random_range", "min": 0.0, "max": 1.0},
            "debt": {"mode": "random_range", "min": 0.0, "max": 0.5},
        },
        "evaluation": {
            "grade_strategy": "strategy2",
            "sim_runs": 100,
            "threshold_profile": "current",
        },
        "search": {
            "attempts_per_level": 300,
            "max_attempts_per_missing": 300,
            "template_attempts": 100,
            "concurrency": 5,
            "shuffle": True,
            "resume": True,
        },
        "outputs": {
            "cap_per_level_grade": 10,
            "write_csv": True,
            "write_replay_json": False,
            "write_calibration_xlsx": True,
            "write_config_json": False,
        },
        "adapter": {
            "executor": "backfill-missing-grades",
            "mode": "plan_command",
        },
    },
    {
        "meta": {
            "strategy_id": "endless_sim_refresh_current_v1",
            "name": "无尽池模拟刷新",
            "version": 1,
            "purpose": "按当前无尽校准工具中的难度集和可用难度，刷新无尽池10000组抽样模拟。",
            "status": "active",
            "notes": "只刷新模拟分析副本，不覆盖源工作簿。",
        },
        "scope": {
            "terrain_source": "calibration_workbook",
            "level_range": "",
            "include_levels": [],
            "exclude_levels": [],
            "workbook": "output/无尽关校准工具.xlsx",
        },
        "target": {
            "grades": [0, 1, 2, 3, 4, 5],
            "target_count_per_grade": 0,
            "fill_policy": "none",
            "fallback_policy": "lowest_available",
        },
        "generation": {
            "closure": {"mode": "random"},
            "color": {"mode": "ratio", "ratio": 0.0},
            "spread": {"mode": "random"},
            "debt": {"mode": "random"},
        },
        "evaluation": {
            "grade_strategy": "endless_pool_selection",
            "sim_runs": 10000,
            "threshold_profile": "workbook_grade_sequence",
        },
        "search": {
            "attempts_per_level": 0,
            "template_attempts": 0,
            "concurrency": 1,
            "shuffle": False,
            "resume": False,
        },
        "outputs": {
            "cap_per_level_grade": 0,
            "write_csv": False,
            "write_replay_json": False,
            "write_calibration_xlsx": True,
            "write_config_json": False,
        },
        "adapter": {
            "executor": "refresh-endless-simulation",
            "mode": "plan_command",
        },
    },
    {
        "meta": {
            "strategy_id": "endless_sim_refresh_no_backfill_v1",
            "name": "无补缺无尽池模拟刷新",
            "version": 1,
            "purpose": "按无补缺校准工具中的难度集和可用难度，刷新无尽池10000组抽样模拟。",
            "status": "active",
            "notes": "用于对比不使用补缺数据时的地形选中率与覆盖风险。",
        },
        "scope": {
            "terrain_source": "calibration_workbook",
            "level_range": "",
            "include_levels": [],
            "exclude_levels": [],
            "workbook": "output/无尽关校准工具_无补缺.xlsx",
        },
        "target": {
            "grades": [0, 1, 2, 3, 4, 5],
            "target_count_per_grade": 0,
            "fill_policy": "none",
            "fallback_policy": "lowest_available",
        },
        "generation": {
            "closure": {"mode": "random"},
            "color": {"mode": "ratio", "ratio": 0.0},
            "spread": {"mode": "random"},
            "debt": {"mode": "random"},
        },
        "evaluation": {
            "grade_strategy": "endless_pool_selection",
            "sim_runs": 10000,
            "threshold_profile": "workbook_grade_sequence",
        },
        "search": {
            "attempts_per_level": 0,
            "template_attempts": 0,
            "concurrency": 1,
            "shuffle": False,
            "resume": False,
        },
        "outputs": {
            "cap_per_level_grade": 0,
            "write_csv": False,
            "write_replay_json": False,
            "write_calibration_xlsx": True,
            "write_config_json": False,
        },
        "adapter": {
            "executor": "refresh-endless-simulation",
            "mode": "plan_command",
        },
    },
]


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def ensure_dirs() -> None:
    BASE_DIR.mkdir(parents=True, exist_ok=True)
    STRATEGIES_DIR.mkdir(parents=True, exist_ok=True)
    RUNS_DIR.mkdir(parents=True, exist_ok=True)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_csv(path: Path, fields: list[str], rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({k: csv_value(row.get(k, "")) for k in fields})


def csv_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return ",".join(str(v) for v in value)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return str(value)


def coerce_list(value: Any) -> list[Any]:
    if value is None or value == "":
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        return [v.strip() for v in value.split(",") if v.strip()]
    return [value]


def coerce_int_list(value: Any) -> list[int]:
    result: list[int] = []
    for item in coerce_list(value):
        try:
            result.append(int(item))
        except (TypeError, ValueError):
            pass
    return result


def policy(generation: dict[str, Any], name: str) -> dict[str, Any]:
    p = generation.get(name)
    return p if isinstance(p, dict) else {"mode": "random"}


def policy_summary(policy_obj: dict[str, Any]) -> str:
    mode = str(policy_obj.get("mode", ""))
    if mode in {"random", "full_layer_max"}:
        return mode
    if mode in {"fixed", "fixed_count"}:
        return f"{mode}:{policy_obj.get('value', policy_obj.get('count', ''))}"
    if mode in {"random_range", "range"}:
        return f"{mode}:{policy_obj.get('min', '')}-{policy_obj.get('max', '')}"
    if mode in {"fixed_points", "per_layer_list"}:
        values = policy_obj.get("points", policy_obj.get("values", []))
        return f"{mode}:{csv_value(values)}"
    if "ratio" in policy_obj:
        suffix = f":{policy_obj.get('ratio')}"
        if policy_obj.get("jitter") not in (None, ""):
            suffix += f"+-{policy_obj.get('jitter')}"
        return f"{mode}{suffix}"
    return mode


def strategy_file_name(strategy: dict[str, Any]) -> str:
    strategy_id = str(strategy.get("meta", {}).get("strategy_id", "")).strip()
    if not strategy_id:
        raise SystemExit("默认策略缺少 meta.strategy_id")
    return f"{strategy_id}.json"


def init_feature(
    overwrite: bool,
    reset_runs: bool = False,
    quiet: bool = False,
    overwrite_schema: bool = False,
) -> None:
    ensure_dirs()
    if overwrite or overwrite_schema or not SCHEMA_PATH.exists():
        write_json(SCHEMA_PATH, DEFAULT_SCHEMA)
    for strategy in DEFAULT_STRATEGIES:
        path = STRATEGIES_DIR / strategy_file_name(strategy)
        if overwrite or not path.exists():
            write_json(path, strategy)
    if reset_runs or not RUNS_JSONL.exists():
        RUNS_JSONL.parent.mkdir(parents=True, exist_ok=True)
        RUNS_JSONL.write_text("", encoding="utf-8")
    migrate_legacy_runs_from_dirs()
    export_strategy_index()
    export_run_index()
    if not quiet:
        print(json.dumps({
            "strategiesDir": str(STRATEGIES_DIR),
            "schema": str(SCHEMA_PATH),
            "strategyIndexCsv": str(STRATEGY_INDEX_CSV),
            "runsJsonl": str(RUNS_JSONL),
            "runsIndexCsv": str(RUNS_INDEX_CSV),
            "runsDir": str(RUNS_DIR),
        }, ensure_ascii=False, indent=2))


def migrate_legacy_runs_from_dirs() -> None:
    existing_ids = {event.get("run_id") for event in read_run_events() if event.get("run_id")}
    if not RUNS_DIR.exists():
        return
    for run_dir in sorted(path for path in RUNS_DIR.iterdir() if path.is_dir()):
        if run_dir.name in existing_ids:
            continue
        config_path = run_dir / "run_config.json"
        if not config_path.exists():
            continue
        try:
            config = read_json(config_path)
        except Exception:
            continue
        strategy = config.get("strategy", {}) if isinstance(config, dict) else {}
        if isinstance(strategy, dict) and isinstance(strategy.get("meta"), dict):
            meta = strategy["meta"]
        elif isinstance(strategy, dict):
            meta = strategy
        else:
            meta = {}
        created = config.get("created_at") or datetime.fromtimestamp(config_path.stat().st_mtime).isoformat(timespec="seconds")
        event = {
            "event": "planned",
            "run_id": config.get("run_id", run_dir.name),
            "strategy_id": meta.get("strategy_id", ""),
            "strategy_version": meta.get("version", "legacy"),
            "status": "planned",
            "created_at": created,
            "updated_at": created,
            "run_dir": str(run_dir),
            "command_file": str(run_dir / "command.sh"),
            "artifacts": config.get("artifacts", {}),
            "strategy_file": "",
            "notes": meta.get("notes", "migrated from legacy run_config.json"),
            "migrated_from": str(config_path),
        }
        append_run_event(event)
        existing_ids.add(run_dir.name)


def resolve_strategy_ref(ref: str) -> Path:
    path = Path(ref)
    if path.exists():
        return path
    if not path.suffix:
        direct = STRATEGIES_DIR / f"{ref}.json"
        if direct.exists():
            return direct
    direct = STRATEGIES_DIR / ref
    if direct.exists():
        return direct
    raise SystemExit(f"未找到策略: {ref}。可传 JSON 路径，或传 strategies/ 下的 strategy_id。")


def load_strategy(ref: str) -> tuple[dict[str, Any], Path]:
    path = resolve_strategy_ref(ref)
    strategy = read_json(path)
    if not isinstance(strategy, dict):
        raise SystemExit(f"策略文件不是 JSON object: {path}")
    return strategy, path


def list_strategy_files() -> list[Path]:
    if not STRATEGIES_DIR.exists():
        return []
    return sorted(STRATEGIES_DIR.glob("*.json"))


def require_obj(strategy: dict[str, Any], key: str, errors: list[str]) -> dict[str, Any]:
    value = strategy.get(key)
    if isinstance(value, dict):
        return value
    errors.append(f"{key}: 必须是 object")
    return {}


def validate_int(value: Any, path: str, errors: list[str], minimum: int | None = None) -> None:
    if not isinstance(value, int) or isinstance(value, bool):
        errors.append(f"{path}: 必须是整数")
        return
    if minimum is not None and value < minimum:
        errors.append(f"{path}: 必须 >= {minimum}")


def validate_number_range(policy_obj: dict[str, Any], path: str, errors: list[str]) -> None:
    if "min" in policy_obj and not isinstance(policy_obj["min"], (int, float)):
        errors.append(f"{path}.min: 必须是数字")
    if "max" in policy_obj and not isinstance(policy_obj["max"], (int, float)):
        errors.append(f"{path}.max: 必须是数字")
    if isinstance(policy_obj.get("min"), (int, float)) and isinstance(policy_obj.get("max"), (int, float)):
        if float(policy_obj["min"]) > float(policy_obj["max"]):
            errors.append(f"{path}: min 不能大于 max")


def validate_strategy(strategy: dict[str, Any], strategy_path: Path | None = None) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    for key in ["meta", "scope", "target", "generation", "evaluation", "search", "outputs", "adapter"]:
        if key not in strategy:
            errors.append(f"{key}: 缺少必要字段")

    meta = require_obj(strategy, "meta", errors)
    target = require_obj(strategy, "target", errors)
    generation = require_obj(strategy, "generation", errors)
    evaluation = require_obj(strategy, "evaluation", errors)
    search = require_obj(strategy, "search", errors)
    adapter = require_obj(strategy, "adapter", errors)
    scope = require_obj(strategy, "scope", errors)

    for key in ["strategy_id", "name", "purpose", "status"]:
        if not str(meta.get(key, "")).strip():
            errors.append(f"meta.{key}: 不能为空")
    if "version" in meta:
        validate_int(meta["version"], "meta.version", errors, 1)
    else:
        errors.append("meta.version: 缺少必要字段")
    if meta.get("status") not in {"active", "draft", "deprecated", "archived"}:
        errors.append("meta.status: 必须是 active/draft/deprecated/archived")

    executor = adapter.get("executor")
    if executor not in EXECUTORS:
        errors.append(f"adapter.executor: 暂不支持 {executor}")
    if adapter.get("mode") not in {"plan_command", "execute_command"}:
        errors.append("adapter.mode: 必须是 plan_command 或 execute_command")

    grades = target.get("grades")
    if not isinstance(grades, list) or any(not isinstance(g, int) or g < 0 for g in grades):
        errors.append("target.grades: 必须是非负整数数组")
    validate_int(target.get("target_count_per_grade"), "target.target_count_per_grade", errors, 0)
    if target.get("fill_policy") not in {"all", "missing_only", "replace_filtered", "probe_only", "cap_only", "none"}:
        errors.append("target.fill_policy: 枚举值无效")
    if target.get("fallback_policy") not in {"downward_only", "lowest_available", "allow_any", "none"}:
        errors.append("target.fallback_policy: 枚举值无效")
    if "min_existing_count" in target:
        validate_int(target["min_existing_count"], "target.min_existing_count", errors, 0)

    closure = policy(generation, "closure")
    if closure.get("mode") not in MODE_ENUMS["closure"]:
        errors.append("generation.closure.mode: 枚举值无效")
    validate_number_range(closure, "generation.closure", errors)
    color = policy(generation, "color")
    if color.get("mode") not in MODE_ENUMS["color"]:
        errors.append("generation.color.mode: 枚举值无效")
    validate_number_range(color, "generation.color", errors)
    color_allocation = policy(generation, "color_allocation")
    if color_allocation and color_allocation.get("mode") not in MODE_ENUMS["color_allocation"]:
        errors.append("generation.color_allocation.mode: 枚举值无效")
    if color_allocation.get("mode") == "single_heavy" and color_allocation.get("ratio") is not None:
        ratio = color_allocation.get("ratio")
        if not isinstance(ratio, (int, float)) or not 0 < float(ratio) <= 1:
            errors.append("generation.color_allocation.ratio: 必须在 0 到 1 之间")
    for name in ["spread", "debt"]:
        p = policy(generation, name)
        if p.get("mode") not in MODE_ENUMS["spread_debt"]:
            errors.append(f"generation.{name}.mode: 枚举值无效")
        validate_number_range(p, f"generation.{name}", errors)

    if not str(evaluation.get("grade_strategy", "")).strip():
        errors.append("evaluation.grade_strategy: 不能为空")
    validate_int(evaluation.get("sim_runs"), "evaluation.sim_runs", errors, 0)
    if not str(evaluation.get("threshold_profile", "")).strip():
        errors.append("evaluation.threshold_profile: 不能为空")

    acceptance = evaluation.get("acceptance", {})
    if acceptance is not None and not isinstance(acceptance, dict):
        errors.append("evaluation.acceptance: 必须是对象")
    elif isinstance(acceptance, dict):
        for key in ["min_sim1_wins", "min_sim5_wins", "min_sim15_wins"]:
            if key in acceptance:
                validate_int(acceptance[key], f"evaluation.acceptance.{key}", errors, 0)
                if isinstance(acceptance[key], int) and isinstance(evaluation.get("sim_runs"), int) and acceptance[key] > evaluation["sim_runs"]:
                    warnings.append(f"evaluation.acceptance.{key}: 大于 sim_runs，通常无法命中")
        if "min_passrate" in acceptance:
            value = acceptance["min_passrate"]
            if not isinstance(value, (int, float)):
                errors.append("evaluation.acceptance.min_passrate: 必须是数字")
            elif not 0 <= float(value) <= 1:
                errors.append("evaluation.acceptance.min_passrate: 必须在0到1之间")
        if "optimal" in acceptance:
            optimal = acceptance.get("optimal")
            if not isinstance(optimal, dict):
                errors.append("evaluation.acceptance.optimal: 必须是对象")
            else:
                validate_int(optimal.get("runs"), "evaluation.acceptance.optimal.runs", errors, 1)
                constraints = optimal.get("grade_constraints")
                if not isinstance(constraints, dict) or not constraints:
                    errors.append("evaluation.acceptance.optimal.grade_constraints: 必须是非空对象")
                else:
                    ratio_keys = {
                        "min_win_rate", "min_win_rate_exclusive", "max_win_rate_exclusive",
                        "max_loss_remaining_ratio",
                    }
                    for grade, constraint in constraints.items():
                        path = f"evaluation.acceptance.optimal.grade_constraints.{grade}"
                        if not str(grade).isdigit() or int(grade) < 0:
                            errors.append(f"{path}: 档位键必须是非负整数")
                        if not isinstance(constraint, dict):
                            errors.append(f"{path}: 必须是对象")
                            continue
                        allowed_keys = {
                            "min_win_rate", "min_win_rate_exclusive", "max_win_rate_exclusive",
                            "min_win_starvation_per_tile", "max_win_starvation_per_tile",
                            "max_loss_remaining_ratio",
                        }
                        for key in constraint.keys() - allowed_keys:
                            errors.append(f"{path}.{key}: 未知字段")
                        for key, value in constraint.items():
                            if not isinstance(value, (int, float)):
                                errors.append(f"{path}.{key}: 必须是数字")
                            elif key in ratio_keys and not 0 <= float(value) <= 1:
                                errors.append(f"{path}.{key}: 必须在0到1之间")
                            elif key.startswith(("min_win_starvation", "max_win_starvation")) and not 0 <= float(value) <= 1:
                                errors.append(f"{path}.{key}: 必须在0到1之间")
                        min_starve = constraint.get("min_win_starvation_per_tile")
                        max_starve = constraint.get("max_win_starvation_per_tile")
                        if isinstance(min_starve, (int, float)) and isinstance(max_starve, (int, float)) and min_starve > max_starve:
                            errors.append(f"{path}: 断色下限不能大于上限")
                        low = constraint.get("min_win_rate", constraint.get("min_win_rate_exclusive"))
                        high = constraint.get("max_win_rate_exclusive")
                        if isinstance(low, (int, float)) and isinstance(high, (int, float)) and low >= high:
                            errors.append(f"{path}: Optimal胜率下限必须小于上限")
                        if constraint.get("max_loss_remaining_ratio") == 0 and isinstance(high, (int, float)) and high <= 1:
                            warnings.append(f"{path}: 失败剩余率上限为0且胜率要求小于100%，通常几乎无法命中")

    for key in ["attempts_per_level", "attempts_per_missing_grade", "max_attempts_per_missing", "template_attempts"]:
        if key in search:
            validate_int(search[key], f"search.{key}", errors, 0)
    if "concurrency" in search:
        validate_int(search["concurrency"], "search.concurrency", errors, 1)
    for key in ["adaptive_pool_size", "adaptive_min_samples"]:
        if key in search:
            validate_int(search[key], f"search.{key}", errors, 1)
    for key in ["adaptive_explore_rate", "adaptive_continuous_step"]:
        if key in search:
            value = search[key]
            if not isinstance(value, (int, float)):
                errors.append(f"search.{key}: 必须是数字")
            elif key == "adaptive_explore_rate" and not 0 <= float(value) <= 1:
                errors.append(f"search.{key}: 必须在0到1之间")
            elif key == "adaptive_continuous_step" and not 0 < float(value) <= 0.5:
                errors.append(f"search.{key}: 必须大于0且不超过0.5")
    for key in ["shuffle", "resume", "reuse_template_params", "target_from_output_only", "adaptive_search", "optimal_first"]:
        if key in search and not isinstance(search[key], bool):
            errors.append(f"search.{key}: 必须是布尔值")

    for key in ["write_csv", "write_replay_json", "write_calibration_xlsx", "write_config_json"]:
        if key in strategy.get("outputs", {}) and not isinstance(strategy["outputs"][key], bool):
            errors.append(f"outputs.{key}: 必须是布尔值")
    output_config = strategy.get("outputs", {})
    for key in ["min_per_level_grade", "cap_per_level_grade"]:
        if key in output_config:
            validate_int(output_config[key], f"outputs.{key}", errors, 0)
    minimum = output_config.get("min_per_level_grade", 0)
    cap = output_config.get("cap_per_level_grade", 0)
    if isinstance(minimum, int) and isinstance(cap, int) and cap > 0 and minimum > cap:
        errors.append("outputs: min_per_level_grade 不能大于非零 cap_per_level_grade")
    if search.get("optimal_first") is True and not (
        isinstance(acceptance, dict) and isinstance(acceptance.get("optimal"), dict)
    ):
        warnings.append("search.optimal_first=true 但未配置 evaluation.acceptance.optimal，不会产生预筛效果。")
    if isinstance(acceptance, dict) and acceptance and executor not in {"run-batch-generation", "backfill-missing-grades"}:
        warnings.append(f"{executor}: 当前执行器不会应用 evaluation.acceptance，请移除该配置或切换执行器。")

    if executor == "run-batch-generation":
        if not coerce_int_list(scope.get("include_levels")) and not str(scope.get("level_range", "")).strip():
            warnings.append("run-batch-generation 没有固定关卡范围；plan 时必须通过 --levels 覆盖。")
    if executor in {"backfill-missing-grades", "search-missing-grade-samples", "build-calibration-variant"}:
        if not str(scope.get("source_csv", "")).strip():
            errors.append(f"{executor}: scope.source_csv 不能为空")
    if executor == "search-missing-grade-samples":
        if not str(scope.get("first_backfill_csv", "")).strip():
            errors.append("search-missing-grade-samples: scope.first_backfill_csv 不能为空")
        if not str(scope.get("latest_backfill_csv", "")).strip():
            errors.append("search-missing-grade-samples: scope.latest_backfill_csv 不能为空")
    if executor == "build-calibration-variant" and not str(scope.get("template_workbook", "")).strip():
        warnings.append("build-calibration-variant 未配置 scope.template_workbook，将使用默认校准工具。")
    if executor == "refresh-endless-simulation" and not str(scope.get("workbook", "")).strip():
        errors.append("refresh-endless-simulation: scope.workbook 不能为空")

    if strategy_path and strategy_path.parent == STRATEGIES_DIR:
        expected = f"{meta.get('strategy_id', '')}.json"
        if strategy_path.name != expected:
            warnings.append(f"策略文件名建议为 {expected}")
    return errors, warnings


def validate_or_exit(strategy: dict[str, Any], path: Path) -> None:
    errors, warnings = validate_strategy(strategy, path)
    if errors:
        print(json.dumps({"strategy": str(path), "ok": False, "errors": errors, "warnings": warnings}, ensure_ascii=False, indent=2))
        raise SystemExit(1)


def strategy_summary(strategy: dict[str, Any], path: Path) -> dict[str, Any]:
    meta = strategy.get("meta", {})
    scope = strategy.get("scope", {})
    target = strategy.get("target", {})
    generation = strategy.get("generation", {})
    evaluation = strategy.get("evaluation", {})
    search = strategy.get("search", {})
    outputs = strategy.get("outputs", {})
    adapter = strategy.get("adapter", {})
    return {
        "strategy_id": meta.get("strategy_id", ""),
        "name": meta.get("name", ""),
        "version": meta.get("version", ""),
        "purpose": meta.get("purpose", ""),
        "status": meta.get("status", ""),
        "executor": adapter.get("executor", ""),
        "terrain_source": scope.get("terrain_source", ""),
        "level_range": scope.get("level_range", ""),
        "include_levels": coerce_list(scope.get("include_levels")),
        "exclude_levels": coerce_list(scope.get("exclude_levels")),
        "source_csv": scope.get("source_csv", ""),
        "workbook": scope.get("workbook", scope.get("template_workbook", "")),
        "grades": coerce_list(target.get("grades")),
        "target_count_per_grade": target.get("target_count_per_grade", ""),
        "fill_policy": target.get("fill_policy", ""),
        "fallback_policy": target.get("fallback_policy", ""),
        "closure": policy_summary(policy(generation, "closure")),
        "color": policy_summary(policy(generation, "color")),
        "spread": policy_summary(policy(generation, "spread")),
        "debt": policy_summary(policy(generation, "debt")),
        "grade_strategy": evaluation.get("grade_strategy", ""),
        "sim_runs": evaluation.get("sim_runs", ""),
        "attempts_per_level": search.get("attempts_per_level", ""),
        "template_attempts": search.get("template_attempts", ""),
        "concurrency": search.get("concurrency", ""),
        "min_per_level_grade": outputs.get("min_per_level_grade", ""),
        "cap_per_level_grade": outputs.get("cap_per_level_grade", ""),
        "notes": meta.get("notes", ""),
        "strategy_file": str(path),
    }


def export_strategy_index() -> list[dict[str, Any]]:
    ensure_dirs()
    rows: list[dict[str, Any]] = []
    for path in list_strategy_files():
        try:
            strategy = read_json(path)
            rows.append(strategy_summary(strategy, path))
        except Exception as exc:  # noqa: BLE001 - index should stay usable if one file is bad.
            rows.append({
                "strategy_id": path.stem,
                "name": "",
                "version": "",
                "purpose": f"读取失败: {exc}",
                "status": "invalid",
                "strategy_file": str(path),
            })
    write_csv(STRATEGY_INDEX_CSV, STRATEGY_INDEX_FIELDS, rows)
    return rows


def read_run_events() -> list[dict[str, Any]]:
    if not RUNS_JSONL.exists():
        return []
    events: list[dict[str, Any]] = []
    for line in RUNS_JSONL.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
            if isinstance(item, dict):
                events.append(item)
        except json.JSONDecodeError:
            continue
    return events


def append_run_event(event: dict[str, Any]) -> None:
    RUNS_JSONL.parent.mkdir(parents=True, exist_ok=True)
    with RUNS_JSONL.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")


def latest_run_rows() -> list[dict[str, Any]]:
    runs: dict[str, dict[str, Any]] = {}
    for event in read_run_events():
        run_id = str(event.get("run_id", ""))
        if not run_id:
            continue
        current = runs.setdefault(run_id, {})
        if event.get("event") == "planned":
            current.update(event)
        elif event.get("event") == "status":
            current["status"] = event.get("status", current.get("status", ""))
            current["updated_at"] = event.get("updated_at", event.get("created_at", now()))
            if event.get("log"):
                current["log"] = event["log"]
    return sorted(runs.values(), key=lambda row: row.get("created_at", ""))


def export_run_index() -> list[dict[str, Any]]:
    rows = []
    for run in latest_run_rows():
        artifacts = run.get("artifacts", {}) if isinstance(run.get("artifacts"), dict) else {}
        rows.append({
            "run_id": run.get("run_id", ""),
            "strategy_id": run.get("strategy_id", ""),
            "strategy_version": run.get("strategy_version", ""),
            "status": run.get("status", ""),
            "created_at": run.get("created_at", ""),
            "updated_at": run.get("updated_at", ""),
            "run_dir": run.get("run_dir", ""),
            "command_file": run.get("command_file", ""),
            "primary_output": artifacts.get("primary_output", ""),
            "analysis_output": artifacts.get("analysis_output", ""),
            "config_output": artifacts.get("config_output", ""),
            "report_output": artifacts.get("report_output", ""),
            "notes": run.get("notes", ""),
        })
    write_csv(RUNS_INDEX_CSV, RUN_INDEX_FIELDS, rows)
    return rows


def shell_join(parts: list[str]) -> str:
    return " ".join(shlex.quote(str(part)) for part in parts if str(part) != "")


def format_shell_command(parts: list[str]) -> str:
    prefix: list[str] = []
    groups: list[list[str]] = []
    index = 0
    while index < len(parts) and not str(parts[index]).startswith("--"):
        prefix.append(str(parts[index]))
        index += 1
    while index < len(parts):
        group = [str(parts[index])]
        index += 1
        while index < len(parts) and not str(parts[index]).startswith("--"):
            group.append(str(parts[index]))
            index += 1
        groups.append(group)
    if not groups:
        return shell_join(prefix)
    lines = [shell_join(prefix)] + [shell_join(group) for group in groups]
    return " \\\n  ".join(lines)


def run_id_for(strategy_id: str) -> str:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"{stamp}_{strategy_id}"


def range_levels(level_range: str) -> list[int]:
    if not level_range:
        return []
    parts = [p for p in re.split(r"[-~～,，\\s]+", level_range) if p]
    if len(parts) < 2:
        return coerce_int_list(parts)
    start, end = int(parts[0]), int(parts[1])
    step = 1 if end >= start else -1
    return list(range(start, end + step, step))


def levels_for_scope(scope: dict[str, Any], override_levels: str | None = None) -> list[str]:
    if override_levels:
        levels = coerce_int_list(override_levels)
    else:
        levels = coerce_int_list(scope.get("include_levels"))
        if not levels:
            levels = range_levels(str(scope.get("level_range", "")).strip())
    exclude = {str(level) for level in coerce_int_list(scope.get("exclude_levels"))}
    return [str(level) for level in levels if str(level) not in exclude]


def closure_arg(policy_obj: dict[str, Any]) -> str:
    mode = policy_obj.get("mode")
    if mode in {"random", "random_range"}:
        return "random"
    if mode == "full_layer_max":
        return "1"
    if mode == "fixed_points":
        return csv_value(policy_obj.get("points", []))
    if mode == "per_layer_list":
        return csv_value(policy_obj.get("values", []))
    return "random"


def color_count_arg(policy_obj: dict[str, Any]) -> str:
    mode = policy_obj.get("mode")
    if mode == "fixed_count":
        return str(policy_obj.get("value", policy_obj.get("count", "")))
    return "random"


def color_ratio_arg(policy_obj: dict[str, Any], default: str = "0.6") -> str:
    if policy_obj.get("mode") == "range":
        return str(policy_obj.get("min", default))
    return str(policy_obj.get("ratio", default))


def fixed_or_random_arg(policy_obj: dict[str, Any]) -> str:
    mode = policy_obj.get("mode")
    if mode == "fixed":
        return str(policy_obj.get("value", "0"))
    return "random"


def add_range_flags(cmd: list[str], policy_obj: dict[str, Any], min_flag: str, max_flag: str) -> None:
    mode = policy_obj.get("mode")
    if mode in {"random_range", "range"}:
        if policy_obj.get("min") is not None:
            cmd += [min_flag, str(policy_obj["min"])]
        if policy_obj.get("max") is not None:
            cmd += [max_flag, str(policy_obj["max"])]
    elif mode == "fixed" and policy_obj.get("value") is not None:
        value = str(policy_obj["value"])
        cmd += [min_flag, value, max_flag, value]
    elif mode == "full_layer_max":
        cmd += [min_flag, "1", max_flag, "1"]


def is_full_random_range(policy_obj: dict[str, Any]) -> bool:
    if policy_obj.get("mode") != "random_range":
        return False
    min_value = policy_obj.get("min", 0)
    max_value = policy_obj.get("max", 1)
    try:
        return float(min_value) <= 0 and float(max_value) >= 1
    except (TypeError, ValueError):
        return False


def add_closure_flags(cmd: list[str], policy_obj: dict[str, Any]) -> None:
    mode = policy_obj.get("mode")
    if mode == "random" or is_full_random_range(policy_obj):
        cmd += ["--search-close-mode", "project-random"]
    elif mode in {"random_range", "range", "fixed", "full_layer_max"}:
        cmd += ["--search-close-mode", "strict-range"]
        add_range_flags(cmd, policy_obj, "--search-close-min", "--search-close-max")


def add_acceptance_flags(cmd: list[str], evaluation: dict[str, Any]) -> None:
    acceptance = evaluation.get("acceptance")
    if not isinstance(acceptance, dict):
        return
    mapping = [
        ("min_sim1_wins", "--accept-min-sim1-wins"),
        ("min_sim5_wins", "--accept-min-sim5-wins"),
        ("min_sim15_wins", "--accept-min-sim15-wins"),
        ("min_passrate", "--accept-min-passrate"),
    ]
    for key, flag in mapping:
        if acceptance.get(key) is not None:
            cmd += [flag, str(acceptance[key])]
    optimal = acceptance.get("optimal")
    if isinstance(optimal, dict):
        cmd += [
            "--optimal-acceptance-json",
            json.dumps(optimal, ensure_ascii=False, separators=(",", ":")),
        ]


def command_for(strategy: dict[str, Any], run_dir: Path, args: argparse.Namespace) -> tuple[list[str], dict[str, str], list[str]]:
    scope = strategy.get("scope", {})
    target = strategy.get("target", {})
    generation = strategy.get("generation", {})
    evaluation = strategy.get("evaluation", {})
    search = strategy.get("search", {})
    outputs = strategy.get("outputs", {})
    executor = strategy.get("adapter", {}).get("executor")

    generation_dir = run_dir / "01_generation"
    analysis_dir = run_dir / "02_analysis"
    config_dir = run_dir / "03_config"
    logs_dir = run_dir / "logs"
    for path in [generation_dir, analysis_dir, config_dir, logs_dir]:
        path.mkdir(parents=True, exist_ok=True)

    source_csv = args.source_csv or scope.get("source_csv", "")
    template_workbook = args.template_workbook or scope.get("template_workbook", "output/无尽关校准工具.xlsx")
    concurrency = args.concurrency or str(search.get("concurrency", ""))
    artifacts: dict[str, str] = {}
    notes: list[str] = []

    if executor == "run-batch-generation":
        levels = levels_for_scope(scope, args.levels)
        if not levels:
            raise SystemExit("run-batch-generation 需要 scope.include_levels/scope.level_range，或 plan --levels 覆盖。")
        output = generation_dir / "batch.csv"
        plan = analysis_dir / "batch_plan.csv"
        status = logs_dir / "batch_status.json"
        closure = policy(generation, "closure")
        color = policy(generation, "color")
        color_alloc = policy(generation, "color_allocation")
        spread = policy(generation, "spread")
        debt = policy(generation, "debt")
        cmd = [
            "npx", "tsx", "tools/run-batch-generation.ts",
            "--levels", ",".join(levels),
            "--output", str(output),
            "--plan", str(plan),
            "--status", str(status),
            "--levels-dir", scope.get("levels_dir", "../TileMatchShell/Tools/Config/Json/Levels"),
            "--close-rates", closure_arg(closure),
            "--color-count", color_count_arg(color),
            "--color-ratio", color_ratio_arg(color),
            "--color-allocation", "single-heavy" if color_alloc.get("mode") == "single_heavy" else "balanced",
            "--spread", fixed_or_random_arg(spread),
            "--debt", fixed_or_random_arg(debt),
            "--sim-runs", str(evaluation.get("sim_runs", 200)),
            "--target-per-tier", str(target.get("target_count_per_grade", 10)),
            "--target-grades", csv_value(target.get("grades", [])),
            "--max-attempts", str(search.get("attempts_per_level", 500)),
            "--concurrency", concurrency or "2",
            "--run",
        ]
        if color_alloc.get("mode") == "single_heavy" and color_alloc.get("ratio") is not None:
            cmd += ["--heavy-color-max-ratio", str(color_alloc["ratio"])]
        if closure.get("mode") == "random_range":
            add_range_flags(cmd, closure, "--close-min", "--close-max")
        if color.get("mode") == "range":
            add_range_flags(cmd, color, "--color-ratio-min", "--color-ratio-max")
        elif color.get("mode") == "ratio_jitter":
            cmd += ["--color-jitter", str(color.get("jitter", 0))]
        add_range_flags(cmd, spread, "--spread-min", "--spread-max")
        add_range_flags(cmd, debt, "--debt-min", "--debt-max")
        add_acceptance_flags(cmd, evaluation)
        if search.get("resume"):
            cmd.append("--resume")
        artifacts.update({"primary_output": str(output), "analysis_output": str(plan), "report_output": str(status)})

    elif executor == "backfill-missing-grades":
        output = generation_dir / "backfill.csv"
        plan = analysis_dir / "backfill_plan.csv"
        status = logs_dir / "backfill_status.json"
        closure = policy(generation, "closure")
        color = policy(generation, "color")
        color_alloc = policy(generation, "color_allocation")
        spread = policy(generation, "spread")
        debt = policy(generation, "debt")
        cmd = [
            "npx", "tsx", "tools/backfill-missing-grades.ts",
            "--input", source_csv,
            "--target", str(target.get("target_count_per_grade", 10)),
            "--grades", csv_value(target.get("grades", [0, 1, 2, 3, 4, 5])),
            "--color-jitter", str(color.get("jitter", 2 if color.get("mode") == "ratio_jitter" else 0)),
            "--color-allocation", "single-heavy" if color_alloc.get("mode") == "single_heavy" else "balanced",
            "--sim-runs", str(evaluation.get("sim_runs", 100)),
            "--template-attempts", str(search.get("template_attempts", 100)),
            "--concurrency", concurrency or "5",
            "--plan", str(plan),
            "--output", str(output),
            "--status", str(status),
            "--run",
        ]
        if color.get("mode") == "range":
            cmd += [
                "--color-ratio-min", str(color.get("min", 0.6)),
                "--color-ratio-max", str(color.get("max", 0.6)),
            ]
        else:
            cmd += ["--color-ratio", color_ratio_arg(color)]
        if color_alloc.get("mode") == "single_heavy" and color_alloc.get("ratio") is not None:
            cmd += ["--heavy-color-max-ratio", str(color_alloc["ratio"])]
        if generation.get("placement_mode") == "random-color":
            cmd += ["--placement-mode", "random-color"]
        if search.get("max_attempts_per_missing") is not None:
            cmd += ["--max-attempts-per-missing", str(search["max_attempts_per_missing"])]
        else:
            cmd += ["--max-attempts-per-level", str(search.get("attempts_per_level", 300))]
        if target.get("min_existing_count") is not None:
            cmd += ["--min-existing-count", str(target["min_existing_count"])]
        if target.get("fill_policy") == "replace_filtered":
            cmd += ["--target-policy", "replace-filtered"]
        if scope.get("exclude_levels"):
            cmd += ["--exclude-levels", csv_value(scope.get("exclude_levels"))]
        if scope.get("levels_dir"):
            cmd += ["--levels-dir", str(scope["levels_dir"])]
        if search.get("resume"):
            cmd.append("--resume")
        if search.get("shuffle") is False:
            cmd.append("--no-shuffle")
        if search.get("reuse_template_params") is False:
            cmd.append("--no-reuse-template")
        if search.get("target_from_output_only") is True:
            cmd.append("--target-from-output-only")
        if search.get("adaptive_search") is True:
            cmd += [
                "--adaptive-search",
                "--adaptive-explore-rate", str(search.get("adaptive_explore_rate", 0.2)),
                "--adaptive-pool-size", str(search.get("adaptive_pool_size", 5)),
                "--adaptive-min-samples", str(search.get("adaptive_min_samples", 3)),
                "--adaptive-continuous-step", str(search.get("adaptive_continuous_step", 0.08)),
            ]
        if search.get("optimal_first") is True:
            cmd.append("--optimal-first")
        add_acceptance_flags(cmd, evaluation)
        add_closure_flags(cmd, closure)
        add_range_flags(cmd, spread, "--search-spread-min", "--search-spread-max")
        add_range_flags(cmd, debt, "--search-debt-min", "--search-debt-max")
        if spread.get("mode") == "fixed":
            cmd += ["--g0-spread", str(spread.get("value", 0))]
        if debt.get("mode") == "fixed":
            cmd += ["--g0-debt", str(debt.get("value", 0))]
        artifacts.update({"primary_output": str(output), "analysis_output": str(plan), "report_output": str(status)})

    elif executor == "search-missing-grade-samples":
        output = generation_dir / "missing_samples.csv"
        plan = analysis_dir / "missing_samples_plan.csv"
        status = logs_dir / "missing_samples_status.json"
        color = policy(generation, "color")
        color_min = color.get("min", color.get("ratio", 0.4))
        color_max = color.get("max", color.get("ratio", 0.6))
        cmd = [
            "npx", "tsx", "tools/search-missing-grade-samples.ts",
            "--initial", source_csv,
            "--first-backfill", scope.get("first_backfill_csv", "output/无尽补缺生成.csv"),
            "--latest-backfill", scope.get("latest_backfill_csv", "output/无尽补缺_G1G2_高闭合生成.csv"),
            "--output", str(output),
            "--plan", str(plan),
            "--status", str(status),
            "--attempts-per-missing-grade", str(search.get("attempts_per_missing_grade", search.get("attempts_per_level", 300))),
            "--sim-runs", str(evaluation.get("sim_runs", 100)),
            "--concurrency", concurrency or "5",
            "--color-ratio-min", str(color_min),
            "--color-ratio-max", str(color_max),
            "--exclude-levels", csv_value(scope.get("exclude_levels", [100001, 100002])),
            "--run",
        ]
        if search.get("resume"):
            cmd.append("--resume")
        artifacts.update({"primary_output": str(output), "analysis_output": str(plan), "report_output": str(status)})

    elif executor == "build-calibration-variant":
        output_csv = generation_dir / "capped.csv"
        output_workbook = analysis_dir / "calibration.xlsx"
        report = analysis_dir / "calibration_report.json"
        cmd = [
            PYTHON, "tools/build_calibration_variant.py",
            "--variant-name", strategy.get("meta", {}).get("name", strategy.get("meta", {}).get("strategy_id", "variant")),
            "--source-csv", source_csv,
            "--template-workbook", template_workbook,
            "--output-csv", str(output_csv),
            "--output-workbook", str(output_workbook),
            "--report", str(report),
            "--cap", str(outputs.get("cap_per_level_grade", 10)),
            "--min-per-level-grade", str(outputs.get("min_per_level_grade", 0)),
        ]
        artifacts.update({"primary_output": str(output_csv), "analysis_output": str(output_workbook), "report_output": str(report)})

    elif executor == "refresh-endless-simulation":
        workbook = scope.get("workbook", template_workbook)
        output_workbook = analysis_dir / "endless_simulation.xlsx"
        report = analysis_dir / "endless_simulation_report.json"
        cmd = [
            PYTHON, "tools/refresh_endless_simulation.py",
            "--workbook", str(workbook),
            "--output", str(output_workbook),
            "--report", str(report),
        ]
        artifacts.update({"analysis_output": str(output_workbook), "report_output": str(report)})

    else:
        raise SystemExit(f"暂不支持 executor={executor}")

    return cmd, artifacts, notes


def plan_run(args: argparse.Namespace) -> None:
    init_feature(overwrite=False, quiet=True)
    ref = args.strategy or args.strategy_id
    if not ref:
        raise SystemExit("请通过 --strategy 传 JSON 路径/strategy_id，或兼容传 --strategy-id。")
    strategy, path = load_strategy(ref)
    validate_or_exit(strategy, path)
    meta = strategy.get("meta", {})
    run_id = args.run_id or run_id_for(str(meta.get("strategy_id", path.stem)))
    run_dir = RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    cmd, artifacts, mapping_notes = command_for(strategy, run_dir, args)
    command_file = run_dir / "command.sh"
    command_file.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        f"cd {shlex.quote(str(ROOT))}\n"
        f"{format_shell_command(cmd)} \"$@\"\n",
        encoding="utf-8",
    )
    command_file.chmod(0o755)

    created = now()
    write_json(run_dir / "strategy_snapshot.json", strategy)
    write_json(run_dir / "run_config.json", {
        "run_id": run_id,
        "strategy_file": str(path),
        "strategy": strategy,
        "command": cmd,
        "artifacts": artifacts,
        "mapping_notes": mapping_notes,
        "created_at": created,
        "notes": args.notes or "",
    })

    event = {
        "event": "planned",
        "run_id": run_id,
        "strategy_id": meta.get("strategy_id", path.stem),
        "strategy_version": meta.get("version", ""),
        "status": "planned",
        "created_at": created,
        "updated_at": created,
        "run_dir": str(run_dir),
        "command_file": str(command_file),
        "artifacts": artifacts,
        "strategy_file": str(path),
        "notes": args.notes or "",
    }
    append_run_event(event)
    export_run_index()
    print(json.dumps(event | {"mapping_notes": mapping_notes}, ensure_ascii=False, indent=2))

    if args.execute:
        append_run_event({"event": "status", "run_id": run_id, "status": "running", "updated_at": now()})
        export_run_index()
        log_path = run_dir / "logs" / "execute.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("w", encoding="utf-8") as log:
            proc = subprocess.run(cmd, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, text=True)
        final_status = "done" if proc.returncode == 0 else "error"
        append_run_event({"event": "status", "run_id": run_id, "status": final_status, "updated_at": now(), "log": str(log_path)})
        export_run_index()
        if proc.returncode != 0:
            raise SystemExit(f"运行失败，查看日志: {log_path}")


def cmd_validate(args: argparse.Namespace) -> None:
    init_feature(overwrite=False, quiet=True)
    strategy, path = load_strategy(args.strategy)
    errors, warnings = validate_strategy(strategy, path)
    print(json.dumps({
        "strategy": str(path),
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
    }, ensure_ascii=False, indent=2))
    if errors:
        raise SystemExit(1)


def cmd_list_strategies(args: argparse.Namespace) -> None:
    init_feature(overwrite=False, quiet=True)
    rows = export_strategy_index()
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return
    for row in rows:
        print(f"{row['strategy_id']}\t{row['status']}\t{row['executor']}\t{row['name']}")
    print(f"\nindex: {STRATEGY_INDEX_CSV}")


def cmd_list_runs(args: argparse.Namespace) -> None:
    init_feature(overwrite=False, quiet=True)
    rows = export_run_index()
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return
    if not rows:
        print(f"暂无运行记录。index: {RUNS_INDEX_CSV}")
        return
    for row in rows:
        print(f"{row['run_id']}\t{row['status']}\t{row['strategy_id']}\t{row['primary_output']}")
    print(f"\njsonl: {RUNS_JSONL}\nindex: {RUNS_INDEX_CSV}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generation feature strategy/run registry.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_init = sub.add_parser("init", help="Create JSON strategy registry, schema, and run registry files.")
    p_init.add_argument("--overwrite", action="store_true", help="Overwrite default schema/sample strategies.")
    p_init.add_argument("--overwrite-schema", action="store_true", help="Refresh only strategy.schema.json; preserve strategy files.")
    p_init.add_argument("--reset-runs", action="store_true", help="Clear runs.jsonl. Use only when intentionally resetting history.")

    p_validate = sub.add_parser("validate", help="Validate one strategy JSON.")
    p_validate.add_argument("--strategy", required=True, help="Strategy JSON path or strategy_id.")

    p_list_strategies = sub.add_parser("list-strategies")
    p_list_strategies.add_argument("--json", action="store_true")

    p_list_runs = sub.add_parser("list-runs")
    p_list_runs.add_argument("--json", action="store_true")

    p_plan = sub.add_parser("plan", help="Create a run directory and command from a strategy JSON.")
    p_plan.add_argument("--strategy", help="Strategy JSON path or strategy_id.")
    p_plan.add_argument("--strategy-id", help="Backward-compatible alias for --strategy.")
    p_plan.add_argument("--run-id")
    p_plan.add_argument("--levels", help="Override terrain IDs, comma separated.")
    p_plan.add_argument("--source-csv")
    p_plan.add_argument("--template-workbook")
    p_plan.add_argument("--concurrency")
    p_plan.add_argument("--notes", default="")
    p_plan.add_argument("--execute", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.cmd == "init":
        init_feature(args.overwrite, args.reset_runs, overwrite_schema=args.overwrite_schema)
    elif args.cmd == "validate":
        cmd_validate(args)
    elif args.cmd == "list-strategies":
        cmd_list_strategies(args)
    elif args.cmd == "list-runs":
        cmd_list_runs(args)
    elif args.cmd == "plan":
        plan_run(args)


if __name__ == "__main__":
    main()
