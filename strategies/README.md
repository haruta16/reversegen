# Strategy catalog

Each tracked strategy owns one directory:

```text
strategies/<strategy_id>/
  strategy.v2.json
  ui.json
  versions/
```

`strategy.v2.json` is the executable source of truth. `ui.json` contains only
display metadata. Web-editor snapshots live under `versions/` when created.

Runtime data never belongs here. Every plan or execution is written to the
Git-ignored `output/runs/<strategy_id>/<run_id>/` directory.
