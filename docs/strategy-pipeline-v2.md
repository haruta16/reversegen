# Strategy pipeline v2

Strategy v2 is intentionally incompatible with the legacy generation-feature
strategy JSON files. A strategy is one ordered production pipeline, not a name
for a generator, robot, grader, or filter.

The stages are separated as follows:

1. `generator`: creates a candidate board (`layer_closure` today).
2. `simulate`: runs a named player policy and produces metrics.
3. `grade`: maps metrics to a grade/passrate (`strategy2` today).
4. `filter`: accepts or rejects the graded candidate (`optimal_experience`
   constraints are represented as a metric filter).
5. `runtime`: owns seed, concurrency, trace, and execution-engine choices.

Canonical identifiers in the first v2 strategy:

- generator: `layer_closure@1`
- simulation policies: `mistake_player@1`, `shortest_current_state@1`
- grader: `strategy2@1`
- filter: `grade_metric_constraints@1`

The canonical production artifact is JSONL containing `StrategyRunRecord`.
CSV and replay-selection files are projections generated from that record, not
the internal strategy contract.

Every attempt derives stage seeds from:

```text
runtime.seed / terrain / attempt / stage / variant
```

The web application may keep TypeScript implementations. Batch production can
select Rust per simulation stage without changing the strategy meaning.

## Web boundary

- The ordinary main-page, single-board workflow remains independent from the
  batch strategy runtime.
- The web batch page compiles its form values to an ephemeral v2 strategy and
  launches `tools/run-strategy.ts`; its existing progress and CSV endpoints are
  compatibility projections over `status.json` and `accepted.jsonl`.
- The strategy editor uses an authoring view model in the browser. Its
  executable source of truth is `strategies/<strategy_id>/strategy.v2.json`;
  tracked `ui.json` metadata never changes runtime semantics.
- Runtime artifacts are local-only under the Git-ignored
  `output/runs/<strategy_id>/<run_id>/` tree.

## Canonical entry point

`tools/run-strategy.ts` is the production entry point. Legacy generation
strategy JSON is not converted or accepted by this runner.

```bash
# Build the Rust policy engine once.
npm run strategy:rust:build

# Validate the tracked strategy without creating output.
npm run strategy:validate

# Write plan.json only.
npm run strategy:plan -- --strategy strategies/current_calibration/strategy.v2.json

# Execute the complete configured scope.
npm run strategy:run -- --strategy strategies/current_calibration/strategy.v2.json

# Controlled smoke/performance sample.
npm run strategy:run -- \
  --strategy strategies/current_calibration/strategy.v2.json \
  --levels 100075 \
  --max-attempts 1 \
  --concurrency 1 \
  --output-dir output/runs/current_calibration/smoke_100075_1_attempt

# Resume one exact run from records.jsonl and status.json.
npm run strategy:run -- --resume \
  --output-dir output/runs/current_calibration/<run_id>
```

Without `--output-dir`, each invocation creates a unique directory named from
UTC time, strategy version, and strategy hash. Each run directory contains:

- `manifest.json`: run identity, strategy hash, lifecycle status, and artifact map.

- `plan.json`: exact scope, quotas, attempt ranges, and concurrency.
- `strategy.snapshot.json`: immutable strategy used by the run; resume rejects
  a different current definition.
- `records.jsonl`: every successfully generated and evaluated candidate.
- `accepted.jsonl`: accepted records only; no alternate row schema.
- `status.json`: resumable per-level progress and accumulated stage timing.
- `timing.log.jsonl`: run, job, and attempt-error events.

## Execution boundaries

Node workers own terrain-level production concurrency. Rust does not silently
choose the number of production workers. Within one Rust `simulate` stage, all
policy variants are sent in one protocol request and one process invocation.
This avoids one process launch per mistake-rate variant while keeping seeds and
traces independent per variant.

The current v2 migration does not claim cross-language result equivalence as a
release gate. The protocol, seed ownership, stage outputs, and deterministic
generation are fixed first; parity can be audited separately against the same
candidate records.

## Guardrails handled by v2

- `layer_closure` receives one seeded RNG for both color allocation and tile
  placement; no hidden `Math.random()` remains in a batch candidate.
- Strategy validation rejects missing stage inputs, duplicate IDs, unsupported
  Rust policies, invalid mistake rates, missing target-grade filters, and bad
  numeric ranges before production starts.
- `shortest_current_state` is a simulation policy. `optimal_experience` is a
  grade-aware metric filter. They are no longer represented by one ambiguous
  “optimal” switch.
- Trace retention is runtime policy (`enabled` plus deterministic sample rate),
  not a different simulator contract.
- Rust implements player policy simulation only. LayerClosure generation,
  Strategy2 grading, quota selection, output, and resume stay explicit in the
  pipeline rather than being hidden inside the Rust binary.
