# Vanessa Runtime Agent Specifications

Root `AGENTS.md` instructs coding assistants how to modify this repository. Files here specify Vanessa's runtime specialists and control-plane services.

- `contracts/agent-contract.md` — common task/result/lifecycle contract.
- `planner.md` — request-to-DAG planning.
- `contextualizer.md` — reference resolution and bounded context.
- `orchestrator.md` — durable task state, dispatch, dependencies and recovery.
- `policy.md` — deterministic authorization and approval.
- `voice.md` — Fish ASR/TTS, session, turn-taking and interruption.
- `memory.md` — persistent memory with provenance/scope.
- `browser.md` — exact navigation, search, YouTube selection and verification.
- `windows.md` — Windows system adapter.
- `coding.md` — repository inspection and isolated patch creation.
- `developer.md` — IDE/coding CLI lifecycle.
- `testing.md` — test execution and evidence.
- `it-ops.md` — authorized diagnostics and log analysis.
- `knowledge.md` — runbook/document retrieval.
- `files.md` — scoped filesystem and Drive operations.
- `incident.md` — composite incident workflow.
- `cloud-integrations.md` — Gmail, Drive, messaging and connectors.
- `openjarvis-adapter.md` — Python/OpenJarvis bridge.
- `relay.md` — device pairing and phone-to-PC delivery.
- `mobile-agent.md` — Android/iOS local task scope.
- `macos.md` — macOS adapter requirements.
- `browser-acceptance.md` — Browser/YouTube release tests.
- `implementation-order.md` — staged implementation and exit gates.
- `browser-acceptance.md` — acceptance matrix for exact links, search and playback.

These are target contracts, not proof every capability is implemented. Verify source and tests and distinguish simulated from live results.

Priority: browser intent/verification → contextualizer and action validation → verifier integrity → Fish voice correlation → multi-agent recovery → relay/mobile/macOS after local Windows execution is reliable.
