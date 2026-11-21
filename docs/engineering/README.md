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
| [CONVERSATION_RUNTIME.md](CONVERSATION_RUNTIME.md) | Live session/turn contract, reducer parity, standalone Android controller, integration status | protocol, reducers and standalone controller implemented; Android/desktop wiring pending |
| [THREE_DAY_CONVERSATION_RUNTIME_PLAN.md](THREE_DAY_CONVERSATION_RUNTIME_PLAN.md) | Timeboxed Android conversation-bridge proposal | planning snapshot; not implementation evidence |
| [AGENTIC_PC_FIRST_ARCHITECTURE.md](AGENTIC_PC_FIRST_ARCHITECTURE.md) | Proposed Windows-first execution and remote-access architecture | proposal; verified PC execution and Android/voice connection still pending |
| [VOICE_CONVERSATION_BRIDGE.md](VOICE_CONVERSATION_BRIDGE.md) | Detailed Android-first bridge architecture and original PR #69 design snapshot | historical design snapshot; current status is in the runtime document |
| [END_TO_END_ACCEPTANCE.md](END_TO_END_ACCEPTANCE.md) | CI evidence, emulator journeys, physical-device and release gates | five existing emulator journeys pass; integrated conversation and physical PC journeys remain open |

## Plans and delivery order

The Android bridge plan and the PC-first execution plan describe different
milestones, not proof that either end-to-end path exists. Conversation remains
the foundation and the orchestrator remains the task authority; a PC-first
execution milestone does not make voice or UI a second planner. The Android
controller can be developed as a foundation in parallel, but the plans propose
different first vertical slices. Treat their scheduling as a product decision,
not as a completed implementation or an implicit change to security gates.

## Reading order for a new contributor

1. `ANDROID_SCREEN_INVENTORY.md` — what the app is.
2. `REMOTE_TASK_STATE_MACHINE.md` — the one part where being wrong is dangerous.
3. `END_TO_END_ACCEPTANCE.md` — what you are allowed to claim when CI goes green.

## The rule these documents encode

> The UI never manufactures state. It renders what the local runtime or the
> authenticated PC reports — and when it cannot, it says so.

In the reducer that is `Unrecoverable`. On screen it is "Vanessa can't rebuild
this task". In CI it is a failed job rather than an empty report.
