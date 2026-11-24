# Engineering specifications

These documents include both implementation snapshots and planning proposals.
The [integrated product plan](VANESSA_INTEGRATED_PRODUCTION_PLAN.md) is the
current planning baseline; the [partial S0 report](S0_BASELINE.md) records
verified results, limitations and known failures. Source code and test evidence,
not a plan or an old status line, establish what is actually implemented.

| Document | Covers | Status |
|---|---|---|
| [VANESSA_INTEGRATED_PRODUCTION_PLAN.md](VANESSA_INTEGRATED_PRODUCTION_PLAN.md) | Product, architecture, local-first delivery and release gates | canonical planning baseline; not implementation authorization |
| [S0_BASELINE.md](S0_BASELINE.md) / [JSON](S0_BASELINE.json) | Tested branch, selected suites, PRs, risks and missing evidence | partial read-only audit; not release or security certification |
| [REMOTE_TASK_STATE_MACHINE.md](REMOTE_TASK_STATE_MACHINE.md) | Phone-side task lifecycle, correlation, recovery invariants | implemented |
| [ANDROID_SCREEN_INVENTORY.md](ANDROID_SCREEN_INVENTORY.md) | Every screen, its file, its destinations and states | implemented, gaps listed |
| [SCROLL_AND_LAYOUT_SPEC.md](SCROLL_AND_LAYOUT_SPEC.md) | All 14 scroll regions, insets, keyboard, findings | implemented, device testing owed |
| [NAVIGATION_AND_JOURNEYS.md](NAVIGATION_AND_JOURNEYS.md) | Navigation model, back table, six journeys | model implemented, journeys unverified |
| [AGENT_REGISTRY.md](AGENT_REGISTRY.md) | 12 agents, 62 actions, risk and authority | generated from `agentCatalog.ts` |
| [AGENT_ORCHESTRATION_SPEC.md](AGENT_ORCHESTRATION_SPEC.md) | Supervisor → planner → policy → execution → critic | implemented in `services/orchestrator` |
| [AGENT_CONTRACTS.md](AGENT_CONTRACTS.md) | Wire schemas, approval binding, proposed envelope | wire contract implemented, envelope not |
| [CONVERSATION_RUNTIME.md](CONVERSATION_RUNTIME.md) | Live session/turn contract, reducer parity, Android controller and integration status | desktop and Android wiring merged in PRs #85–#87; durable and physical journeys remain unverified |
| [THREE_DAY_CONVERSATION_RUNTIME_PLAN.md](THREE_DAY_CONVERSATION_RUNTIME_PLAN.md) | Timeboxed Android conversation-bridge proposal | planning snapshot; not implementation evidence |
| [AGENTIC_PC_FIRST_ARCHITECTURE.md](AGENTIC_PC_FIRST_ARCHITECTURE.md) | Proposed Windows-first execution and remote-access architecture | proposal; verified PC execution and Android/voice connection still pending |
| [VANESSA_APPLICATION_BUILD_PLAN.md](VANESSA_APPLICATION_BUILD_PLAN.md) | File-level implementation sequence, SDLC gates and application acceptance | supporting plan; integrated product plan takes precedence and milestones remain open |
| [VOICE_CONVERSATION_BRIDGE.md](VOICE_CONVERSATION_BRIDGE.md) | Detailed Android-first bridge architecture and original PR #69 design snapshot | historical design snapshot; current status is in the runtime document |
| [END_TO_END_ACCEPTANCE.md](END_TO_END_ACCEPTANCE.md) | CI evidence, emulator journeys, physical-device and release gates | historical emulator evidence; integrated physical voice and PC journeys remain open |

## Plans and delivery order

The [integrated plan](VANESSA_INTEGRATED_PRODUCTION_PLAN.md) takes precedence over
older product and delivery plans. Build and test locally before a separately
authorized deployment; a domain or VPS is not a local-development prerequisite.
The detailed Android and PC-first plans remain supporting material, not proof of
an end-to-end journey. Conversation, voice, policy, execution and verification
retain their distinct owners.

## Reading order for a new contributor

1. `VANESSA_INTEGRATED_PRODUCTION_PLAN.md` — product direction and boundaries.
2. `S0_BASELINE.md` — observed results and unresolved gaps.
3. `ANDROID_SCREEN_INVENTORY.md` and `REMOTE_TASK_STATE_MACHINE.md` — mobile surfaces and task-state boundaries.
4. `END_TO_END_ACCEPTANCE.md` — what CI and physical evidence actually prove.

## The rule these documents encode

> The UI never manufactures state. It renders what the local runtime or the
> authenticated PC reports — and when it cannot, it says so.

In the reducer that is `Unrecoverable`. On screen it is "Vanessa can't rebuild
this task". In CI it is a failed job rather than an empty report.
