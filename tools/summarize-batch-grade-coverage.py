#!/usr/bin/env python3
"""Summarize ReverseGen batch CSV grade coverage into an Excel workbook.

Usage:
  python3 tools/summarize-batch-grade-coverage.py input.csv [output.xlsx]

The input is the 26-column batch-generate CSV. Probe rows
(`isMaxGradeProbe=1`) and failed rows are ignored by default.
"""

from __future__ import annotations

import csv
import re
import sys
import zipfile
from collections import Counter, defaultdict
from pathlib import Path
from xml.sax.saxutils import escape


GRADES = list(range(6))


def col_name(index: int) -> str:
    name = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        name = chr(65 + rem) + name
    return name


def cell_ref(row: int, col: int) -> str:
    return f"{col_name(col)}{row}"


def safe_sheet_name(name: str) -> str:
    return re.sub(r"[\[\]:*?/\\]", "_", name)[:31] or "Sheet"


def xml_text(value: object) -> str:
    return escape(str(value), {'"': "&quot;"})


def sheet_xml(rows: list[list[object]], widths: list[float] | None = None, freeze_top_row: bool = True) -> str:
    cols = ""
    if widths:
        cols = "<cols>" + "".join(
            f'<col min="{i + 1}" max="{i + 1}" width="{width}" customWidth="1"/>'
            for i, width in enumerate(widths)
        ) + "</cols>"

    pane = ""
    if freeze_top_row:
        pane = (
            '<sheetViews><sheetView workbookViewId="0">'
            '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
            '</sheetView></sheetViews>'
        )

    row_xml = []
    for r_idx, row in enumerate(rows, start=1):
        cells = []
        for c_idx, value in enumerate(row):
            ref = cell_ref(r_idx, c_idx)
            style = ' s="1"' if r_idx == 1 else ""
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                cells.append(f'<c r="{ref}"{style}><v>{value}</v></c>')
            else:
                cells.append(f'<c r="{ref}" t="inlineStr"{style}><is><t>{xml_text(value)}</t></is></c>')
        row_xml.append(f'<row r="{r_idx}">{"".join(cells)}</row>')

    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f"{pane}{cols}<sheetData>{''.join(row_xml)}</sheetData>"
        '<autoFilter ref="A1:Z1"/>'
        "</worksheet>"
    )


def write_xlsx(path: Path, sheets: list[tuple[str, list[list[object]], list[float]]]) -> None:
    content_types = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Default Extension="xml" ContentType="application/xml"/>',
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    ]
    for idx in range(1, len(sheets) + 1):
        content_types.append(
            f'<Override PartName="/xl/worksheets/sheet{idx}.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        )
    content_types.append("</Types>")

    workbook_sheets = "".join(
        f'<sheet name="{xml_text(safe_sheet_name(name))}" sheetId="{idx}" r:id="rId{idx}"/>'
        for idx, (name, _, _) in enumerate(sheets, start=1)
    )
    rels = "".join(
        f'<Relationship Id="rId{idx}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{idx}.xml"/>'
        for idx in range(1, len(sheets) + 1)
    )
    rels += (
        f'<Relationship Id="rId{len(sheets) + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    )

    styles = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
</styleSheet>"""

    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "".join(content_types))
        z.writestr("_rels/.rels", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>""")
        z.writestr("xl/workbook.xml", f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>{workbook_sheets}</sheets></workbook>""")
        z.writestr("xl/_rels/workbook.xml.rels", f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{rels}</Relationships>""")
        z.writestr("xl/styles.xml", styles)
        z.writestr("docProps/core.xml", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>ReverseGen</dc:creator></cp:coreProperties>""")
        z.writestr("docProps/app.xml", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>ReverseGen</Application></Properties>""")
        for idx, (_, rows, widths) in enumerate(sheets, start=1):
            z.writestr(f"xl/worksheets/sheet{idx}.xml", sheet_xml(rows, widths))


def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def summarize(rows: list[dict[str, str]]) -> tuple[list[list[object]], list[list[object]], dict[str, int]]:
    filtered: list[dict[str, str]] = []
    skipped_probe = skipped_failed = skipped_grade = 0
    for row in rows:
        if row.get("isMaxGradeProbe") == "1":
            skipped_probe += 1
            continue
        if row.get("CompletionStatus") and row.get("CompletionStatus") != "Success":
            skipped_failed += 1
            continue
        try:
            grade = int(row.get("grade", ""))
        except ValueError:
            skipped_grade += 1
            continue
        if grade not in GRADES:
            skipped_grade += 1
            continue
        filtered.append(row)

    by_level: dict[str, Counter[int]] = defaultdict(Counter)
    for row in filtered:
        by_level[row["levelResId"]][int(row["grade"])] += 1

    terrain_rows: list[list[object]] = [[
        "地形", "总牌局数", "最低难度", "最高难度", "难度范围",
        "G0", "G1", "G2", "G3", "G4", "G5",
    ]]
    for level in sorted(by_level, key=lambda x: int(x) if x.isdigit() else x):
        counts = by_level[level]
        present = [g for g in GRADES if counts[g] > 0]
        grade_range = ",".join(str(g) for g in present)
        terrain_rows.append([
            level,
            sum(counts.values()),
            min(present) if present else "",
            max(present) if present else "",
            grade_range,
            *[counts[g] for g in GRADES],
        ])

    grade_rows: list[list[object]] = [["难度", "覆盖地形数", "牌局数", "覆盖地形"]]
    for grade in GRADES:
        levels = [level for level, counts in by_level.items() if counts[grade] > 0]
        levels_sorted = sorted(levels, key=lambda x: int(x) if x.isdigit() else x)
        board_count = sum(by_level[level][grade] for level in levels_sorted)
        grade_rows.append([f"G{grade}", len(levels_sorted), board_count, ",".join(levels_sorted)])

    stats = {
        "input_rows": len(rows),
        "used_rows": len(filtered),
        "skipped_probe": skipped_probe,
        "skipped_failed": skipped_failed,
        "skipped_grade": skipped_grade,
        "terrain_count": len(by_level),
    }
    return terrain_rows, grade_rows, stats


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__.strip())
        return 2
    src = Path(sys.argv[1]).resolve()
    if not src.exists():
        print(f"input not found: {src}", file=sys.stderr)
        return 1
    dst = Path(sys.argv[2]).resolve() if len(sys.argv) >= 3 else src.with_name(f"{src.stem}_难度覆盖统计.xlsx")

    rows = read_rows(src)
    terrain_rows, grade_rows, stats = summarize(rows)
    summary_rows = [
        ["指标", "值"],
        ["输入行数", stats["input_rows"]],
        ["有效牌局行数", stats["used_rows"]],
        ["过滤探测行", stats["skipped_probe"]],
        ["过滤失败行", stats["skipped_failed"]],
        ["过滤无效难度行", stats["skipped_grade"]],
        ["地形数", stats["terrain_count"]],
    ]

    write_xlsx(dst, [
        ("地形G0-G5分布", terrain_rows, [12, 12, 10, 10, 12, 8, 8, 8, 8, 8, 8]),
        ("难度汇总", grade_rows, [10, 12, 12, 80]),
        ("统计说明", summary_rows, [18, 18]),
    ])
    print(f"wrote {dst}")
    print(stats)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
