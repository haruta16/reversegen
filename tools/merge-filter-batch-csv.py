#!/usr/bin/env python3
"""Clean, merge, and filter ReverseGen batch CSV files.

Outputs:
  1. Second input with probe rows removed.
  2. Merged CSV where each (levelResId, grade) bucket has at least min count.

Usage:
  python3 tools/merge-filter-batch-csv.py base_clean.csv extra_raw.csv cleaned_extra.csv merged_filtered.csv [min_count]
"""

from __future__ import annotations

import csv
import sys
from collections import Counter
from pathlib import Path


def read_csv(path: Path) -> tuple[list[str], list[dict[str, str]]]:
  with path.open("r", encoding="utf-8-sig", newline="") as f:
    reader = csv.DictReader(f)
    if reader.fieldnames is None:
      raise ValueError(f"empty csv: {path}")
    return reader.fieldnames, list(reader)


def write_csv(path: Path, headers: list[str], rows: list[dict[str, str]]) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  with path.open("w", encoding="utf-8-sig", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=headers, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)


def is_usable(row: dict[str, str]) -> bool:
  if row.get("isMaxGradeProbe") == "1":
    return False
  if row.get("CompletionStatus") and row.get("CompletionStatus") != "Success":
    return False
  try:
    grade = int(row.get("grade", ""))
  except ValueError:
    return False
  return 0 <= grade <= 5


def main() -> int:
  if len(sys.argv) < 5:
    print(__doc__.strip(), file=sys.stderr)
    return 2

  base_path = Path(sys.argv[1]).resolve()
  extra_path = Path(sys.argv[2]).resolve()
  clean_extra_path = Path(sys.argv[3]).resolve()
  merged_filtered_path = Path(sys.argv[4]).resolve()
  min_count = int(sys.argv[5]) if len(sys.argv) >= 6 else 5

  base_headers, base_rows_raw = read_csv(base_path)
  extra_headers, extra_rows_raw = read_csv(extra_path)
  if base_headers != extra_headers:
    raise ValueError("CSV headers differ; cannot merge safely")

  extra_clean = [row for row in extra_rows_raw if row.get("isMaxGradeProbe") != "1"]
  write_csv(clean_extra_path, extra_headers, extra_clean)

  base_rows = [row for row in base_rows_raw if is_usable(row)]
  extra_rows = [row for row in extra_clean if is_usable(row)]
  merged = base_rows + extra_rows

  bucket_counts = Counter((row["levelResId"], row["grade"]) for row in merged)
  filtered = [
    row for row in merged
    if bucket_counts[(row["levelResId"], row["grade"])] >= min_count
  ]
  write_csv(merged_filtered_path, base_headers, filtered)

  removed_small = len(merged) - len(filtered)
  kept_buckets = len({(row["levelResId"], row["grade"]) for row in filtered})
  all_buckets = len(bucket_counts)

  print(f"extra raw rows: {len(extra_rows_raw)}")
  print(f"extra cleaned rows: {len(extra_clean)}")
  print(f"extra probe removed: {len(extra_rows_raw) - len(extra_clean)}")
  print(f"merged usable rows: {len(merged)}")
  print(f"filtered rows: {len(filtered)}")
  print(f"removed rows in buckets < {min_count}: {removed_small}")
  print(f"kept buckets: {kept_buckets}/{all_buckets}")
  print(f"cleaned extra: {clean_extra_path}")
  print(f"merged filtered: {merged_filtered_path}")
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
