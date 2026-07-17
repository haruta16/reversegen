# ReverseGen simulation protocol v2

The Rust executable implements simulation policies for batch strategy runs. It
does not grade, filter, generate terrain, or own production concurrency.

The current implementation supports `mistake_player@1`. Unsupported policies
and protocol versions fail explicitly.

Request:

```json
{
  "protocol_version": 2,
  "request_id": "strategy:terrain:attempt:stage:variant",
  "policy": {
    "id": "mistake_player",
    "version": 1
  },
  "variants": [
    {"id": "mistake_01", "config": {"mistake_rate": 0.01}, "base_seed": 101, "collect_trace": false},
    {"id": "mistake_05", "config": {"mistake_rate": 0.05}, "base_seed": 105, "collect_trace": false},
    {"id": "mistake_15", "config": {"mistake_rate": 0.15}, "base_seed": 115, "collect_trace": false}
  ],
  "board": {
    "tiles": [
      {"id": 1, "dependencies": [], "element": 1, "pos_x": 0, "pos_y": 0, "pile": "desk"}
    ]
  },
  "execution": {
    "runs": 100,
    "max_steps": 2000
  }
}
```

Response:

```json
{
  "protocol_version": 2,
  "request_id": "strategy:terrain:attempt:stage:variant",
  "policy": {"id": "mistake_player", "version": 1},
  "variants": [{
    "id": "mistake_05",
    "summary": {
      "runs": 100,
      "wins": 80,
      "losses": 20,
      "win_rate": 0.8,
      "total_win_steps": 1000,
      "total_loss_steps": 300,
      "avg_steps_on_win": 12.5,
      "avg_steps_on_loss": 15.0
    },
    "elapsed_ms": 8.0
  }],
  "elapsed_ms": 25.0
}
```

All variants in one strategy stage share one process invocation. A variant's
`results` is added only when its `collect_trace` is true. The CLI accepts a JSON
file path or `-` for stdin.

```bash
cargo build --release --manifest-path rust/strategy-sim/Cargo.toml
rust/strategy-sim/target/release/reversegen-strategy-sim request.json
```
