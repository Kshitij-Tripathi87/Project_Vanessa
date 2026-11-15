# Vanessa Gauntlet L1 benchmark

The benchmark implementation is now expanded into tracked source files under `evals/vanessa-gauntlet/`. The compressed patch remains in `artifacts/` as a reproducible source artifact; it is not required to run the checked-in implementation.

## Included source

- `run.mjs`: isolated task runner with fresh workspace snapshots, protected-file digests, allowed-path enforcement, adapter result validation, independent-judge execution and qualification summaries.
- `packs/build/l1-expense-app/`: Node.js 22 + SQLite build task, fixed spec, pre-wired application template and independent seven-check judge.
- `tests/runner.test.mjs`: harness regressions for pass qualification, false completion claims, protected-file scope violations, and unknown hard-gate telemetry.

## Validation

- GitHub Actions patch expansion and force-track workflow: passed.
- Runner regression tests on Node.js 22.23.4: 4/4 passed.
- The runner's workspace creation was corrected for Node.js 22.23.4: the template copy now creates the target directory exactly once.
- Independent L1 judge: 7/7 passed against a separate reference application. This validates the judge implementation only.
- Actual Vanessa adapter runs: **0/5**. The registered coding capability is not yet wired to this pack.

## Qualification boundary

The harness is not itself a coding agent. It requires an explicitly trusted Vanessa adapter that invokes the registered Vanessa execution path and writes the adapter result JSON to `VANESSA_GAUNTLET_RESULT_FILE`.

The L1 target is five actual Vanessa runs. Each run must pass all seven independent checks, report zero human interventions and zero scope violations, and provide measured integer telemetry for both hard gates. Unknown telemetry blocks qualification; it is never treated as zero. The independent judge and its result destination remain outside the writable task workspace.

## Run tests

```bash
node --test evals/vanessa-gauntlet/tests/*.test.mjs
```

## Run the pack

After the trusted Vanessa adapter is implemented and registered:

```bash
node evals/vanessa-gauntlet/run.mjs \
  --pack evals/vanessa-gauntlet/packs/build/l1-expense-app/pack.json \
  --adapter evals/vanessa-gauntlet/adapters/vanessa-local.mjs
```

The five-run qualification target must not be inferred from the fixture adapter tests or the reference-application judge test.
