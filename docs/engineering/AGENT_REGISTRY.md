# Agent registry

**Status:** generated from `services/orchestrator/src/agents/agentCatalog.ts` —
the catalog that actually gates execution — not from a design sketch. Counts below
were read from that file on the date of this commit.

**12 agents · 62 actions · 46 selectable · 16 explicitly blocked · 23 high-risk.**

## Correction, recorded deliberately

An earlier note in this repository's working conversation claimed the orchestrator
contained "no supervisor, DAG, scheduler, capability gateway or evidence ledger".
That was wrong. `services/orchestrator` is ~24k lines and does contain a
supervisor (`VanessaOrchestrator`), a planner (`VanessaPlanner`), a scheduler
(`runPlan`), a permission guard (`PermissionGuard`), an action registry
(`actionRegistry`), a critic (`CriticEngine`), an evidence-bearing agent result
recorder (`agentResult`), a mobile task engine, and a remote v2 gateway. The
correction matters because it changes what this workstream is allowed to assume:
the system is not a greenfield design exercise.

## The registry as it exists

| Agent | Actions | Blocked | High-risk actions |
|---|---|---|---|
| `developer` | 6 | 4 | `codex.run_task`, `terminal.run_command`, `tests.run`, `claude_code.open`, `codex.open` |
| `windows` | 18 | 0 | `wifi.restart_adapter`, `brightness.set`, `bluetooth.set`, `bluetooth.enable`, `bluetooth.disable`, `volume.set`, `volume.mute`, `app.close`, `ui.click` |
| `browser` | 5 | 1 | — |
| `folder` | 2 | 0 | — |
| `files` | 7 | 2 | `drive.upload` |
| `memory` | 4 | 2 | — |
| `it_ops` | 2 | 0 | — |
| `knowledge` | 2 | 0 | — |
| `coding` | 2 | 0 | `coding.prepare_patch` |
| `testing` | 1 | 0 | `testing.run_incident_lab` |
| `cloud` | 4 | 2 | `gmail.send`, `drive.upload` |
| `vanessa` | 9 | 5 | `vanessa.run_tool`, `vanessa.shell`, `vanessa.run_goal` |

Blocked actions are **declared and refused**, not missing. `codex.run_task` is
blocked because the runner is not yet bound to the repair-worktree and
independent-verification contract; `terminal.run_command` and `tests.run` because
arbitrary shell is disabled until it routes through a registered supervisor
operation. This is the behaviour the product brief asks for — a capability that
cannot be safely verified is not offered.

## Agent shape (real, not proposed)

Each catalog entry carries: `id`, `purpose`, `limitations`, and a list of actions
with `name`, `description`, `parameters` (typed, required/optional), `returns`,
`risk` (`low|medium|high`), `selectable`, `tools`.

The `limitations` field is the authority boundary, and it is written in the
operator's language rather than the model's. Example, verbatim from the catalog:

> *"codex.run_task requires Windows, an installed Codex CLI, a clean Git
> repository root, and a non-detached branch. It never commits or pushes. A
> completed CLI turn is execution evidence only; task success remains partial
> until independent tests/postconditions are verified."*

That last sentence is the same rule as the Android reducer's: **execution
evidence is not verified success**.

## What the brief asks for that does not exist

| Brief | Reality |
|---|---|
| 13 named roles (Supervisor, Intent, Context, Planner, Research, Device, Browser, Filesystem, Terminal, Voice, Communication, Verification, Recovery) | 12 agent ids that do not map one-to-one. There is no `Intent` or `Context` agent; intent routing lives in `core/agentRouting.ts` and `core/router.ts`, context in `core/contextBuilder.ts`. Verification is `CriticEngine` + `recordAgentResult`, not an agent. |
| A shared request/response envelope with `parent_task_id`, `context_ref`, `policy`, `evidence[]` | A `Task` schema in `core/../schemas/task.schema.ts` with its own fields. The proposed envelope is *not* implemented and should not be described as such. |
| PostgreSQL + Redis for durable runtime | **SQLite via `node:sqlite`** (`memoryPalace.ts`, `mobileTaskEngine.ts`). No Postgres, no Redis in the dependency list. |
| Durable execution with leases and an append-only evidence ledger | Locks exist (`resolveTaskLocks`, `getDeclaredLock`, `resourceLocks.ts`), approvals are digest-bound (`computeApprovalDigest`), results are recorded with verification; there is no separate append-only ledger service. |

## Rules for changing this file

1. If an action is added or unblocked, this table is regenerated from
   `agentCatalog.ts`, not hand-edited.
2. A blocked action must state *why* it is blocked in `limitations`. An action
   silently missing from the catalog is indistinguishable from one that was never
   written, and both are worse than an honest refusal.
3. No agent may gain authority by being added here. Authority comes from the
   permission guard and the approval path.
