# Engineering specifications

Each document here describes **what the code does**, with a status line at the
top. Where the product brief asks for something that does not exist, the document
says so in a "gaps" or "not implemented" section rather than describing the
intention as if it were built. That rule exists because this repository has
already shipped two features whose documentation described a system that was not
there.

| Document | Covers | Status |
|---|---|---|
| [REMOTE_TASK_STATE_MACHINE.md](REMOTE_TASK_STATE_MACHINE.md) | Phone-side task lifecycle, correlation, recovery invariants | implemented |
| [ANDROID_SCREEN_INVENTORY.md](ANDROID_SCREEN_INVENTORY.md) | Every screen, its file, its destinations and states | implemented, gaps listed |
| [SCROLL_AND_LAYOUT_SPEC.md](SCROLL_AND_LAYOUT_SPEC.md) | All 14 scroll regions, insets, keyboard, findings | implemented, device testing owed |
| [NAVIGATION_AND_JOURNEYS.md](NAVIGATION_AND_JOURNEYS.md) | Navigation model, back table, six journeys | model implemented, journeys unverified |
| [AGENT_REGISTRY.md](AGENT_REGISTRY.md) | 12 agents, 62 actions, risk and authority | generated from `agentCatalog.ts` |
| [AGENT_ORCHESTRATION_SPEC.md](AGENT_ORCHESTRATION_SPEC.md) | Supervisor → planner → policy → execution → critic | implemented in `services/orchestrator` |
| [AGENT_CONTRACTS.md](AGENT_CONTRACTS.md) | Wire schemas, approval binding, proposed envelope | wire contract implemented, envelope not |
| [END_TO_END_ACCEPTANCE.md](END_TO_END_ACCEPTANCE.md) | What each CI signal proves, release gates | gates defined, most unmet |

## Reading order for a new contributor

1. `ANDROID_SCREEN_INVENTORY.md` — what the app is.
2. `REMOTE_TASK_STATE_MACHINE.md` — the one part where being wrong is dangerous.
3. `END_TO_END_ACCEPTANCE.md` — what you are allowed to claim when CI goes green.

## The rule these documents encode

> The UI never manufactures state. It renders what the local runtime or the
> authenticated PC reports — and when it cannot, it says so.

In the reducer that is `Unrecoverable`. On screen it is "Vanessa can't rebuild
this task". In CI it is a failed job rather than an empty report.
