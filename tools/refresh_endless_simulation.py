#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
from datetime import datetime
from pathlib import Path

import openpyxl

from build_calibration_variant import refresh_simulation


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Refresh the endless-pool simulation sheet from the current workbook grade sequences.",
    )
    parser.add_argument("--workbook", type=Path, required=True, help="Workbook to read and update.")
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Optional output workbook. If omitted, update --workbook in place.",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=None,
        help="Optional JSON report path.",
    )
    parser.add_argument(
        "--backup",
        action="store_true",
        help="Create a timestamped backup before writing in place.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output = args.output or args.workbook
    if args.backup and output == args.workbook:
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup = args.workbook.with_name(f"{args.workbook.stem}.before_sim_refresh_{stamp}{args.workbook.suffix}")
        shutil.copy2(args.workbook, backup)
    else:
        backup = None

    wb = openpyxl.load_workbook(args.workbook)
    summary = refresh_simulation(wb)
    wb.save(output)

    result = {
        "workbook": str(args.workbook),
        "output": str(output),
        "backup": str(backup) if backup else None,
        "simulation": summary,
    }
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
