#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from copy import deepcopy
from datetime import datetime
from pathlib import Path

from export_temp_no_backfill_config import read_level_pool, read_zone_sequences, update_zones


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="从校准工作簿更新配置的 LevelPool 和 Zones。")
    parser.add_argument("--workbook", type=Path, required=True)
    parser.add_argument("--base-config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--clear-stage-overrides", action="store_true", help="保留 StageOverride 结构和有效长度，仅将 Stages 清空")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    original = json.loads(args.base_config.read_text(encoding="utf-8"))
    updated = deepcopy(original)
    level_pool = read_level_pool(args.workbook)
    zones = read_zone_sequences(args.workbook)
    updated["LevelPool"] = level_pool
    update_zones(updated, zones)
    if args.clear_stage_overrides:
        stage_override = updated.setdefault("StageOverride", {})
        if not isinstance(stage_override, dict):
            stage_override = {}
            updated["StageOverride"] = stage_override
        stage_override["Stages"] = []

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(updated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    changed_keys = {"LevelPool", "Zones"}
    if args.clear_stage_overrides:
        changed_keys.add("StageOverride")
    untouched_keys = [key for key in original if key not in changed_keys]
    unchanged = all(original.get(key) == updated.get(key) for key in untouched_keys)
    report = {
        "updatedAt": datetime.now().isoformat(timespec="seconds"),
        "workbook": str(args.workbook),
        "baseConfig": str(args.base_config),
        "output": str(args.output),
        "levelPoolCount": len(level_pool),
        "zoneCount": len(zones),
        "updatedKeys": ["LevelPool", "Zones", *(["StageOverride.Stages (cleared)"] if args.clear_stage_overrides else [])],
        "otherTopLevelKeysUnchanged": unchanged,
    }
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
