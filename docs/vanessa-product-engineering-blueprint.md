# Vanessa Product & Engineering Blueprint
**Target branch:** `Vanessa-Prototype-1-MAIN`  
**Status:** Planning baseline from source inspection; not an implementation or test certification  
**Product target:** Windows 11 first, voice-native, local-first, verifiable desktop agent

## 1. Product thesis

Vanessa is a persistent, voice-first AI control layer for a user's computer and engineering workflow. It should feel like a quiet sci-fi companion—not a conventional dashboard—while its backend behaves like a dependable operations system: explicit plans, least-privilege tools, durable task state, observable progress, verified outcomes, and honest recovery.

**North-star experience:** “Hey Vanessa, inspect why this service is failing, find the relevant logs and code, prepare a fix on an isolated branch, run the appropriate tests, and show me the evidence.” Vanessa decomposes the work, asks only necessary questions, pauses at policy boundaries, executes bounded actions, verifies outcomes, and reports what passed, failed, or remains uncertain.

## 2. Source-inspection baseline

Reviewed on branch `Vanessa-Prototype-1-MAIN`: root README and package manifest; `docs/architecture.md`; `docs/codebase-audit.md`; `docs/scenarios.md`; workspace/package manifests; planner, task runner, permission guard, working memory, PowerShell adapter, Windows/system agent, browser agent, file agent, coding agent, testing agent, scenario tests, and Electron main process.

Current foundations:
- pnpm monorepo: Electron + React + TypeScript desktop; separate `services/voice-agent`, `services/orchestrator`, and `services/relay`; shared contracts in `packages/shared`.
- Voice and orchestration are already separated. Voice drafts should update the HUD only; committed turns may become commands.
- Planner uses a canonical agent/action catalog and explicit instructions not to claim work happened merely because a plan was created.
- Existing agent families include system/Windows, browser, files, developer/Codex, coding, testing, cloud and memory/knowledge-related capabilities; skills are a reusable task layer.
- Permission guard, event bus, resource locks, scenario tests, relay pairing, and architecture documentation are already present.
- Electron main window is already a transparent, always-on-top 90px orb with context isolation, sandboxing, disabled Node integration, Alt+Space PTT and Escape cancellation.

Important source-level reliability risks to address before expanding autonomy:
1. `SystemAgent.restartWifiAdapter()` catches execution errors but returns `success: true`; `wifiStatus()` can report “Up” on a read failure. These must become explicit failed/unknown results.
2. Bluetooth state-setting swallows errors and returns success without reading back actual radio state. Volume setting sends a fixed sequence of volume-up keys rather than setting the requested level and verifying it.
3. Browser actions create evidence and report “loaded”/“playing” based on navigation launch rather than confirmed page readiness or playback. Browser navigation must distinguish launched, navigated, loaded, and verified interaction.
4. `WorkingMemory` is an in-process snapshot, not durable long-term memory. Active task maps in the task runner are also in-memory; the architecture's durable ledger is a requirement, not something to assume already exists.
5. `recordAgentResult` in the task runner can infer success from generic `success: true` or a summary string. Only explicit, action-specific postconditions should qualify as verified success.
6. File-agent `FAKE=1` results use success language implying a real directory was created. Test/dry-run results must be labelled simulated and must never be confused with real side effects.
7. The coding agent contains hard-coded incident-lab assumptions and interpolated shell/Git operations in its implementation. General coding work must be scoped to the active project, use safe argument passing, isolated branches/worktrees, and verify the actual diff and test exit codes.
8. Existing audit identifies unprotected remote command/approval routes, a phone pairing URL that points to loopback, relay cleanup gaps, path containment/symlink gaps, and drills that do not yet inject the failures their names imply. Treat these as blockers before remote autonomy.
9. Some README/setup/port statements may be stale; reconcile docs with actual scripts and runtime configuration as part of release readiness.

This is a source review, not a local build, runtime test, penetration test, or certification. Re-run all checks in the target branch before implementation PRs are considered complete.

## 3. Experience design: the “Living Orb”

The primary surface is a compact 90×90px transparent orb docked to a user-selected screen corner. It should expand only when interaction requires it; never turn the product into a permanently open dashboard.

### Orb states (visual and accessible)
- **Idle:** calm, low-motion glow; microphone is not streaming.
- **Listening:** subtle pulse and clear listening indicator.
- **Transcribing:** live draft caption, explicitly non-executable.
- **Thinking:** orbiting segments reflect planning, not fake “brain activity”.
- **Executing:** a small progress arc plus current task label.
- **Needs you:** amber/contrasting approval state, with exact action and target.
- **Verifying:** distinct inspection/check animation.
- **Succeeded:** short completion pulse backed by verified evidence.
- **Partial / failed / offline:** visually distinct, accessible status and a plain-language recovery action.

Interaction rules: Alt+Space starts push-to-talk; Escape stops speech immediately and opens/activates the cancellation affordance, but stopping playback must not silently cancel an executing task. Provide a compact expandable transcript/task timeline, current plan, approval cards, evidence links, provider readiness, privacy/mic state, and retry/cancel controls. Support keyboard navigation, reduced motion, high contrast, DPI scaling, multi-monitor placement, and a no-animation mode.

## 4. Target architecture

```text
Orb UI (React)
  └─ typed, narrow Electron preload IPC
      └─ Desktop main process / local service supervisor
          ├─ Voice session service
          │   ├─ local activation gate / PTT + VAD + turn segmentation
          │   ├─ ASR provider adapter (Sarvam preferred; configurable fallback)
          │   ├─ barge-in / playback queue / TTS adapter (Sarvam or Fish per configured provider)
          │   └─ committed CommandEnvelope only
          ├─ Orchestrator (single authority for task lifecycle)
          │   ├─ context builder + clarification policy
          │   ├─ planner → typed, validated DAG
          │   ├─ policy engine → allow / confirm / block
          │   ├─ durable task ledger + event sequence + checkpoints
          │   ├─ bounded tool runtime + resource locks + cancellation
          │   ├─ specialist agents / skills
          │   └─ verifier → evidence-backed outcome
          ├─ Local memory service (SQLite first; explicit retention and provenance)
          └─ Optional authenticated relay → paired mobile client
```

Keep the voice service as transport/session owner, not a second planner. Keep one authoritative orchestrator. The renderer never receives provider secrets and never gets unrestricted shell, filesystem, or OS access. All local APIs bind to loopback by default; remote access requires pairing, device authentication, transport protection, scoped authorization, replay protection, and rate limits.

## 5. OpenClaw-inspired design principles

Adapt architectural patterns, not code or complexity for its own sake:
- **Gateway/session boundary:** one clear entry point for sessions, identity, routing and lifecycle.
- **Tool-first execution:** expose typed tools with schemas and explicit outputs instead of letting every agent invent shell commands.
- **Skills as playbooks:** skills describe reusable procedures, prerequisites, locks, risk, success criteria and recovery; the runtime validates them.
- **Subagents for bounded parallelism:** independent read-only research can run in parallel; conflicting writes and shared browser/profile/network resources are serialized by locks.
- **Context assembly:** inject only task-relevant project, conversation, memory and tool evidence; retrieved content is untrusted data, never authority.
- **Evented progress:** stream lifecycle events and tool evidence to the HUD; persist the canonical event/task record so reconnects can replay it.
- **Model/provider abstraction:** planner and voice provider choices are configured behind adapters; deterministic rules handle safety, schemas, and straightforward commands.
- **No agent is trusted by role alone:** policy is enforced centrally at the tool boundary, even when a specialist or model requests an action.

Do not create an uncontrolled “agent swarm”. The planner owns the DAG; specialists cannot grant permissions, rewrite policy, or mark themselves verified.

## 6. Agent responsibility map

| Agent/service | Responsibility | Must not do |
|---|---|---|
| Planner/orchestrator | Interpret intent, ask for missing essential details, produce typed DAG, own task state | Execute shell directly or self-authorize risky actions |
| Windows/system | Settings, app lifecycle, radio, audio, display and OS diagnostics through narrow adapters | Return success after swallowing errors |
| Browser | Open exact URL, search, interact, inspect page, optionally use Playwright | Treat opening a browser/search page as completed user goal |
| Folder/files | Resolve, classify, search, inspect and manipulate approved files; open requested path | Escape approved roots or pretend dry-run is real |
| Developer/Coding | Inspect current repo, prepare isolated diff/branch, implement bounded change | Assume a launched CLI means coding finished; use interpolated shell strings |
| Testing/verifier | Run approved commands, capture exit code/logs/artifacts, assert postconditions | Infer pass from text fragments alone |
| Memory/context | Store and retrieve explicit, scoped, provenance-tagged facts and task summaries | Store secrets or treat recalled content as policy |
| IT operations/incident | Gather diagnostics, correlate logs/runbooks, propose/execute approved remediation | Restart services or alter production without risk gating |
| Cloud/integrations | Draft/search/upload/share through scoped connectors | Send, upload, or publish without required approval |
| Relay/mobile | Authenticate paired devices, durable delivery, ordered events, approval handoff | Trust fixed demo tokens or expose unauthenticated task routes |

Every agent contract must document: supported actions, input/output schema, capabilities, risk classes, timeout, cancellation, resource locks, evidence, failure modes, and tests. Keep one canonical registry and remove ambiguous duplicate/legacy routes over time.

## 7. Execution contract and data model

Every command should have a versioned envelope containing at least: `requestId`, `idempotencyKey`, `sessionId`, `sourceDeviceId`, `targetDeviceId`, timestamp/expiry, committed transcript, locale, and bounded context references. Do not treat transcript text as authorization.

Each task stores: task/plan IDs, parent/dependencies, canonical agent/action, validated parameters, policy decision and approval record, status, attempt, timestamps, timeout/cancel state, tool output, exit code, evidence, artifacts, postconditions, and error/recovery metadata.

Lifecycle: `received → accepted → planning → awaiting_approval/running → verifying → succeeded/partial/failed/blocked/cancelled`. Persist before acknowledging acceptance. On restart, reconcile actual machine state before resuming; replay only idempotent work, and ask for approval if the outcome is ambiguous. Use explicit `unknown` rather than fabricated defaults.

## 8. Safety, privacy and trust requirements

- Fail closed. Default autonomous mode off; confirmation policy is centrally enforced and cannot be overridden by agent prompts.
- Use typed allowlisted tools and fixed executable paths; pass user data as arguments/environment values, not generated shell source. No arbitrary shell by default.
- Canonicalize paths, resolve symlinks, check containment at the file-agent boundary, and scope writes to explicit approved roots.
- Separate permission to read, modify, delete, upload, send, execute, and deploy. Ask before destructive, externally visible, privileged, or non-idempotent operations.
- Keep keys in OS credential storage/server environment; never in renderer bundles, logs, task payloads, or memory.
- Keep audio local while idle; expose a clear active-microphone indicator; send only active capture after PTT/wake gate.
- Treat websites, files, logs, emails, and retrieved memory as untrusted prompt-injection surfaces.
- Audit decisions and evidence without logging secrets or unnecessary raw audio.
- Make “stop speaking”, “cancel task”, and “emergency stop” distinct operations.

## 9. Delivery plan (dependency ordered)

### Phase 0 — Baseline and release gate
- Confirm branch/head and inventory package scripts, service ports, agent registry/catalog, IPC boundaries, env defaults and tests.
- Run install/build/lint/scenarios/skills/voice tests and record baseline failures without masking them.
- Reconcile stale docs, demo-mode behavior, and package boundaries.

### Phase 1 — Truthful execution (highest priority)
- Fix system/browser/file false-success behavior and fabricated fallback status.
- Introduce action-specific result schemas: `started`, `completed`, `verified`, `partial`, `failed`, `unknown`.
- Add postcondition verifiers for app launch, browser URL/page readiness, Bluetooth/Wi-Fi state, volume, file existence, and test execution.
- Add regression tests for every known false-positive.

### Phase 2 — Durable orchestrator
- Implement SQLite-backed task/event ledger and migrations; persist before ACK.
- Formalize DAG validation, dependency failure propagation, idempotency, cancellation, resource locks and restart reconciliation.
- Make verification evidence mandatory for `succeeded`; add structured error taxonomy and retry policy.

### Phase 3 — Reliable conversational voice
- Complete one voice session state machine: PTT/wake gate, VAD, draft/commit, interruption, playback queue, provider readiness, timeouts and reconnects.
- Use Sarvam as the configured low-cost path where credentials/models are available; keep ASR/TTS/chat adapters swappable. Fish Audio remains an optional configured TTS/ASR provider, not a hard-coded dependency.
- Add provider circuit breakers, visible text fallback, usage/budget controls and real microphone acceptance tests.

### Phase 4 — Agent/tool hardening
- Establish canonical typed tool registry and validate all inputs/outputs at runtime.
- Replace arbitrary command execution and shell interpolation with allowlisted commands and argument arrays.
- Harden file roots/symlink checks, browser navigation/interaction verification, and developer worktree/branch handling.
- Write an `AGENTS.md` index plus one contract file per specialist and skill.

### Phase 5 — Sci-fi HUD and interaction
- Keep orb as the default; add truthful state animation, transcript, progress, approvals, task details, evidence, privacy and diagnostics panels.
- Add corner docking, multi-monitor/DPI, accessibility, reduced-motion and packaged-Windows checks.
- UI state must be driven by backend events, not hardcoded demo status.

### Phase 6 — Memory and context
- SQLite memory with user-visible inspect/edit/forget controls, retention, source provenance and confidence.
- Separate session context, task working set, durable user-approved memory and indexed project knowledge.
- Retrieve minimal relevant context; provide “why I used this memory” and never allow memory to authorize actions.

### Phase 7 — Remote mobile companion
- Fix authenticated pairing and approval flow before LAN/remote exposure.
- Use per-device identity, short-lived scoped credentials, TLS/WSS, replay/idempotency protection, sequence-numbered events and expiry cleanup.
- Desktop policy remains authoritative; mobile can request/approve only the exact action hash shown to the user.

### Phase 8 — Engineering/IT workflows
- Incident triage: gather logs/runbooks/metrics, produce evidence-backed hypothesis, prepare isolated patch, run tests, present diff.
- Require human review for merge/deploy/production changes.
- Add workflow templates with checkpoints and reproducible audit reports.

## 10. Acceptance criteria

A release is not “done” because the app opens or a terminal appears. Minimum acceptance:
1. Every core action has deterministic unit/contract tests and a real postcondition test.
2. No provider key appears in renderer assets, logs, or task events.
3. Draft ASR never triggers execution; repeated request IDs do not duplicate side effects.
4. Failures are reported as failures/unknown, never as success.
5. High-risk actions pause before side effects and approvals are bound to the exact action.
6. Cancellation stops the intended scope and cannot silently resume a destructive action.
7. Process crash/restart tests prove ledger recovery and safe reconciliation.
8. Windows packaging smoke test covers install, startup, orb docking, mic permission, voice turn, system action, browser action, file action, logs and clean shutdown.
9. Browser “open URL”, “search”, “interact”, and “play” each have separate verified outcomes.
10. Coding workflow proves the actual diff, test exit code, and artifacts; a launched terminal is only a handoff.
11. Remote route tests prove unauthenticated commands and approvals are rejected.
12. All test reports distinguish mocks/simulation from real OS/provider execution.

## 11. First implementation slice

Do not start with a full redesign or many new agents. First fix the false-success contract in SystemAgent and BrowserAgent, add focused tests, and route those results through the existing orchestrator/verifier. In parallel, run and record the existing suite. This is the highest-leverage foundation: a beautiful orb is memorable only if Vanessa is trustworthy.

## 12. Open decisions to settle during implementation

- Exact wake-word engine and whether it is enabled by default versus PTT-first.
- Which Sarvam models/voices are available to the user's account; verify provider contracts at implementation time.
- Whether SQLite is sufficient for the first durable ledger or a lightweight local database adapter already exists.
- Which browser automation mode is supported on the target Windows build and how user profiles are isolated.
- Whether the mobile relay is in MVP scope or remains disabled until the remote security audit passes.
