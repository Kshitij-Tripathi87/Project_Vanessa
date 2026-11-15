# Vanessa Gauntlet

A task-pack benchmark runner for measuring Vanessa's execution capability. Each pack supplies a fixed specification, a fresh task workspace, an independent judge, immutable/protected files, allowed edit paths, a timeout and a required repeat count.

## Core invariants

- The coding agent never receives the judge implementation or the result destination inside its writable workspace.
- Every run starts from a fresh copy of the pack template.
- The runner compares the task workspace against its baseline and rejects changes outside the pack's exact `allowedPaths` list.
- Protected files are hashed before execution and checked again by the independent judge.
- A completion claim is accepted only when all expected judge checks pass.
- Any false completion claim or scope violation fails the run. A pack qualifies only when every required repeat passes.
- The adapter is an explicitly selected, trusted integration. The runner never invents an adapter or silently substitutes a mock.

## L1 expense application

The initial pack is `packs/build/l1-expense-app/pack.json`. It supplies a pre-wired Node.js 22 + SQLite application with the HTTP server, DB schema, seed data, routes, tests, package scripts and README already in place. Vanessa's coding agent is expected to implement only:

- `src/auth.mjs`
- `src/expenses.mjs`
- `src/dashboard.mjs`

The independent judge runs seven checks: health/startup, authentication/session, expense CRUD, tenant isolation, seeded dashboard totals, project tests/protected-file integrity, and clean-copy install/start. The acceptance judge is outside the task workspace and is not supplied to the coding agent.

The L1 pack requires five runs and allows zero human interventions. The harness is not itself a coding agent: it needs a real Vanessa adapter which invokes the registered Vanessa execution path and writes the adapter result JSON to `VANESSA_GAUNTLET_RESULT_FILE`. No mock adapter is included for benchmark scoring. Runner tests use disposable fixture adapters only to validate the benchmark machinery; these are not capability results.

## Running

After a trusted Vanessa adapter has been implemented and registered:

```bash
node evals/vanessa-gauntlet/run.mjs \
  --pack evals/vanessa-gauntlet/packs/build/l1-expense-app/pack.json \
  --adapter evals/vanessa-gauntlet/adapters/vanessa-local.mjs
```

For a diagnostic single run, use `--runs 1`; this can never qualify the five-run L1 pack. Results are written to `evals/vanessa-gauntlet/results/` by default, while workspaces are retained under the OS temporary directory for inspection. Both roots can be overridden for tests with `--results-root` and `--workspace-root`.

Adapter result contract (written after the agent process has returned):

```json
{
  "claimedDone": true,
  "humanInterventions": 0,
  "repairAttempts": 2,
  "creditsSpent": null,
  "scopeViolations": 0,
  "summary": "What the agent actually did",
  "metadata": {}
}
```

Use `null` for metrics that are not instrumented. Do not report unmeasured values as zero. Credits and repair attempts may remain `null`; human-intervention and scope-violation counts must be instrumented integers for a run to qualify. Unknown hard-gate telemetry blocks qualification. The adapter result destination is created outside the task workspace so the coding agent cannot write its own benchmark report.

## Development tests

```bash
node --test evals/vanessa-gauntlet/tests/*.test.mjs
```

These tests validate batch qualification, false-done rejection and scope enforcement. They do not count as Gauntlet runs.
