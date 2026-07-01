# Endless Calibration Workflow

1. Generate or collect candidate boards for the target terrain pool.
2. Select the corresponding source table for the current analysis scope:
   - full terrain coverage,
   - endless terrain pool,
   - mainline stage coverage,
   - grade-sequence validation,
   - replay export.
3. Feed generated/selected board data back into `output/无尽关校准工具.xlsx`.
4. Analyze whether the current terrain pool and grade sequences satisfy the target experience curve.
5. Confirm the analysis result before exporting production artifacts.
6. After confirmation, generate:
   - endless config JSON with `LevelPool` and `Zones`,
   - replay JSON files from the capped replay CSV.

Notes:
- Do not treat rule-generated fallback boards as strategy2 G0 unless they are actually validated by strategy2 simulation.
- For large/high-tile terrains, record the lowest reachable strategy2 grade instead of forcing every terrain to contain every grade.
- `前80关在线胜率` is an analysis/control sheet. Its `难度标签` column maps to
  `DisplayGradeRules.StageLevels` only, and `StageOverride.StageValidLength`
  should be set to the intended mainline effective length. Do not overwrite
  `StageOverride.Stages[].GradeSequence` from this sheet unless explicitly
  requested; concrete online stage sequences are maintained in a separate
  Excel source.
