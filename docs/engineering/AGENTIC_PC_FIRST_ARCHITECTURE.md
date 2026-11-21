# Vanessa — PC-First Agentic Execution Architecture and Delivery Plan

> **Planning context:** This is a proposed PC execution milestone, not a claim
> that it is implemented or that Android conversation integration is complete.
> Conversation remains the foundation and the orchestrator the task authority.
> The separate [Android bridge plan](THREE_DAY_CONVERSATION_RUNTIME_PLAN.md)
> proposes a different first vertical slice; scheduling between them requires
> an explicit product decision. See [CONVERSATION_RUNTIME.md](CONVERSATION_RUNTIME.md)
> for live status.

**Status:** Proposed implementation baseline  
**Repository baseline reviewed:** main at 22ba127ce9ebe8dfefb250a6fa97e9875fe163e3 (21 November 2026)  
**Proposed delivery order:** Complete and validate the Windows PC agentic execution path first; then connect the full voice-and-text experience and remote Android control.<br>
**Scope:** Windows first, cross-platform interfaces by design.

---

## 1. Product outcome

Vanessa is to become a personal agentic system that accepts a natural-language goal, understands the requested outcome and its context, chooses a plan, delegates work to specialized agents, operates an authorized computer, verifies what happened, recovers safely from failures, and reports the actual result.

The product is measured by **verified user outcomes**, not by the number of agents, tools, prompts, or model calls.

The first milestone must prove that the Windows PC agent can complete multi-step tasks from a local text request without depending on Android voice integration. The subsequent milestone connects the same execution authority to Android text and voice. There must be one planner and one execution authority; a new remote interface must not create a second supervisor.

### Planning assumptions and intended requirements

| Area | Proposed direction |
|---|---|
| Delivery order | PC agentic system first; full voice and text experience second |
| Initial OS | Windows; design platform adapters for Windows, macOS and Linux |
| Connectivity | Select the best secure architecture; prefer outbound connections and no publicly exposed PC ports |
| PC unavailable | Queue with expiry, inform the user, execute on reconnect; attempt wake only where configured and supported |
| Agent capabilities | Browser, files, documents/productivity, software engineering, system operations and communications |
| Autonomy | Act independently by default within configured scopes and policy |
| Agent design | Supervisor + specialist agents + task-scoped workers |
| Failure handling | Autonomous bounded recovery; escalate on missing required facts, denied authority or material risk |
| Voice | PTT, wake word and continuous conversation as user-configurable modes |
| Understanding | Context, intent, sentiment cues, urgency, implied requests and uncertainty |
| Model strategy | Hybrid local/cloud with graceful fallback |
| Memory | User-controlled persistent memory and project-specific context |
| Privacy | Local execution, encrypted transport, data minimization and configurable privacy |
| Observability | Status, live activity, task history and verification evidence |
| Delivery | Phased engineering with explicit acceptance gates |

---

## 2. Baseline: what is already in the repository

This document separates **existing implementation** from **proposed work**. The following observations are based on code and engineering documents on main at the baseline SHA above. They are not claims that the end-to-end product is already complete.

### 2.1 Existing local orchestration

The main PC-side execution path already has:

- VanessaOrchestrator as the natural-language request entrypoint and supervisor.
- VanessaPlanner for producing a bounded plan of tasks.
- Model-plan normalization that checks task IDs, action names, typed parameters, dependencies and cycles.
- PermissionGuard for allow / confirm / block decisions.
- TaskRunner for dependency-aware execution, resource locks, approvals and cancellation.
- A canonical agent catalogue, handler registry and action registry.
- CriticEngine plus recordAgentResult for assessing outcomes and preserving the distinction between execution and verified success.
- Memory Palace and task checkpoints.
- Event-bus updates for agent, task, tool and audit activity.

The current orchestration specification maps the control flow as:

    request → routing/context → planner → policy → task DAG → agent handlers
            → critic/result recorder → user-facing summary

This is the system to extend and validate. Do not introduce a competing supervisor or an alternate agent registry.

### 2.2 Existing catalogue

The current catalogue documents **12 agent IDs, 62 actions, 46 selectable actions, 16 blocked actions and 23 high-risk actions**.

The registry includes Windows, browser, files, folder, developer, coding, testing, memory, knowledge, IT operations, cloud and Vanessa-level capabilities. Actual action contracts, tool permissions, parameter schemas, risk and availability are defined by the source catalogue, not by this list.

Blocked actions must remain unavailable until their execution path, isolation boundary and independent verification contract are implemented. In particular:

- Arbitrary shell and free-form test execution are not generally available.
- The current general developer coding path can hand off to an interactive Codex session; opening a terminal is not evidence of a code change or completed tests.
- The narrowly registered incident-lab repair path must not be generalized to arbitrary projects.
- The current Windows handler documentation explicitly warns that some success flags do not prove a requested state and that arbitrary desktop clicking is not exposed.

The agent catalogue must be treated as an executable capability contract, not a wish list.

### 2.3 Existing remote Android path

The existing remote-v2 path already provides important security foundations:

- P-256 device identity and signed protocol envelopes.
- Strict message schemas, canonicalization, session binding, replay checks, sequence checks and time bounds.
- QR pairing with PC-side approval and trusted-device records.
- Device scopes, task idempotency keys and action-hash-bound approvals.
- Android identity keys held by Android Keystore.
- Remote task state and a SQLite-backed mobile task record/audit store.

However, the current deployed v2 PC listener only starts when its OS-keystore signing bridge is configured and a verified Tailscale IPv4 address is available. The listener binds to that Tailscale address, not to a public relay. The current Android remote submit path calls RemoteTaskService → MobileTaskEngine and requires a named capability plus canonical arguments. It does **not** pass a natural-language request through the full VanessaOrchestrator planner and broad agent catalogue.

MobileTaskEngine has its own narrow allow-listed remote capability registry. It records task/audit state, but its startup reconciliation currently marks queued, validating, running and verifying records as failed after a process restart. It does not resume those actions.

Therefore, current remote support is a useful secure device-control foundation, but it is not yet "full Vanessa agent access from anywhere."

### 2.4 Existing voice and memory

The repository also contains a separate voice-agent service with ASR/TTS adapters, a voice-session lifecycle, partial/final transcript callbacks, wake-word and barge-in mechanisms, and voice tests.

The current sentiment analyzer is mostly keyword heuristics plus basic audio-level measures. It should not be represented as deep semantic or emotional understanding. Planner context also currently has tight limits on recent task and memory context. Memory Palace and project memory need to be evaluated as part of real task continuity rather than assumed to provide complete long-term personalization.

---

## 3. Target architecture

### 3.1 Authority boundaries

The following ownership model is mandatory:

| Component | Owns | Must not own |
|---|---|---|
| Client UI (desktop/Android) | User interaction, display, local audio capture and playback | Agent tool execution authority |
| Voice session | Speech capture, ASR turn boundaries, TTS, barge-in and speech state | OS actions, planning or task cancellation by implication |
| Remote transport | Device identity, session authentication, message delivery, replay protection and reconnect | Planning or execution |
| Remote inbox/task adapter | Durable parent request, deduplication, request correlation and task event delivery | A second planner or second agent catalogue |
| VanessaOrchestrator | Request interpretation, planning entrypoint and supervisor authority | Direct, unguarded OS execution |
| VanessaPlanner | Decomposition and selection of registered agent/action pairs | Granting permissions or claiming execution |
| PermissionGuard | Authorization, risk floors, user/device scopes and approval requirements | Trusting model-selected risk labels |
| TaskRunner | DAG scheduling, dependencies, locks, bounded cancellation and checkpoints | Declaring success without verification |
| Specialist agents | Specific capabilities through typed, registered tools | Expanding their own permissions or invoking arbitrary tools |
| Critic / verifier | Postconditions, evidence and verified outcome status | Rewriting task history to claim success |
| Memory Palace | User-approved facts, project context, episodic and procedural memory with provenance | Treating untrusted content as system instructions |
| Relay service | Routing opaque, expiring messages between authenticated devices | Reading task content, holding PC credentials or executing commands |
| Windows PC runtime | The actual desktop, file and operating-system execution boundary | Trusting client-side claims that work occurred |

**Single-execution-authority rule:** local desktop requests and remote Android requests must converge on the same VanessaOrchestrator and TaskRunner. A remote request must not bypass the planner, permission checks, catalog contracts, resource locks or result verifier.

### 3.2 PC-first task flow

~~~mermaid
flowchart TD
  U[User: text request on Windows] --> I[Request normalizer and context]
  I --> S[VanessaOrchestrator]
  S --> P[VanessaPlanner]
  P --> V[Validate DAG against agent catalogue]
  V --> G[PermissionGuard and device policy]
  G -->|Allowed| R[TaskRunner and resource locks]
  G -->|Approval required| A[Approval wait]
  G -->|Denied| D[Blocked with reason]
  A --> R
  R --> X[Specialist agents and typed tools]
  X --> C[Critic and independent postconditions]
  C -->|Verified| OK[Verified result]
  C -->|Incomplete / failed| REC[Bounded recovery or escalation]
  REC --> R
  OK --> M[Memory update with provenance]
  OK --> N[Result summary and activity history]
  D --> N
~~~

### 3.3 Later Android-to-PC flow

~~~mermaid
sequenceDiagram
  participant Phone as Android client
  participant Relay as Optional opaque relay
  participant PC as Windows Vanessa runtime
  participant Inbox as Durable remote inbox
  participant Orch as VanessaOrchestrator
  participant Guard as PC policy and device-scope guard
  participant Agents as Existing specialist agents
  participant Verify as Critic / verifier

  Phone->>Relay: Submit signed, encrypted request + idempotency key
  PC->>Relay: Outbound authenticated session / poll or receive
  Relay-->>PC: Deliver opaque request
  PC->>PC: Authenticate, decrypt, validate expiry and deduplicate
  PC->>Inbox: Persist parent request before acknowledgement
  PC-->>Phone: Accepted + request/task correlation
  PC->>Orch: Execute natural-language goal with trusted remote principal
  Orch->>Guard: Validate every planned action and scope
  Guard->>Agents: Permit bounded actions or require approval
  Agents->>Verify: Return outputs and evidence
  Verify->>Inbox: Record verified / partial / failed outcome
  Inbox-->>Phone: Sequenced progress and final evidence summary
~~~

The relay is a transport component only. The PC remains the execution target and policy enforcement point.

---

## 4. Agent design

### 4.1 Supervisor and specialist workers

Keep the existing VanessaOrchestrator as supervisor. The supervisor should:

1. Normalize the user's request and resolve references using current context.
2. Identify the requested end state, constraints, target device and deadline where relevant.
3. Determine whether the request can be fulfilled using currently selectable actions.
4. Produce a dependency-aware plan.
5. Validate all agent/action pairs and parameters against the canonical catalogue.
6. Dispatch independent safe work concurrently and serialize work that shares resources.
7. Track evidence and postconditions from each worker.
8. Retry only bounded, safe, idempotent operations.
9. Re-plan when a verified precondition changes or an agent reports a recoverable failure.
10. Provide a concise result, explicit limitations and durable task history.

Specialist agents remain purpose-built. A task-scoped worker can be created dynamically to organize research or reasoning, but it may only use the tools and actions explicitly delegated to it. Dynamic agent creation must never create new privileges, actions, shell access or credentials.

### 4.2 Capability completion workstreams

The current catalogue is the source of truth. The next audit must produce an action-by-action matrix containing:

- Catalogue action and agent.
- Actual handler and platform availability.
- Input schema and path/resource constraints.
- Risk classification and permission scope.
- Idempotency and retry semantics.
- Timeout and cancellation behaviour.
- Execution evidence.
- Independent postcondition/verifier.
- Unit, integration and physical acceptance coverage.
- Current selectable/blocked reason.

Prioritize complete, narrow vertical slices rather than enabling every action at once.

| Workstream | Required outcome |
|---|---|
| Browser | Navigate/search within URL restrictions; distinguish opened, loaded and completed states |
| Filesystem | Search, read, create, edit, move and organize within approved roots; defend against traversal and symlinks |
| Documents/productivity | Reliably read/create/update supported document formats with artifact verification |
| Software engineering | Managed worktree, approved file boundaries, isolated execution, test runner and independent diff/test verification |
| Windows/system | Typed controls with read-back verification, platform checks and privilege boundaries |
| Communications | Draft/review/send separation; sending requires a separate high-impact permission |
| Research/knowledge | Source-backed answers, untrusted-content isolation and provenance |
| Memory | Retrieve/store relevant context with origin, confidence, project scope and user controls |

No action should be made selectable merely because a prompt can describe it. A selectable action requires a real handler, typed arguments, authorization and a meaningful verifier.

### 4.3 Coding and arbitrary command execution

The general developer coding path is currently limited and must not be silently replaced with free-form PowerShell.

A safe autonomous coding capability needs, at minimum:

- A clean isolated worktree per task.
- Explicit repository and path scope.
- No implicit access to unrelated user files or secrets.
- A managed command/test allow-list.
- Process and time limits.
- Network disabled by default, with explicitly scoped exceptions.
- Captured diff and command/test evidence.
- Independent verification against acceptance criteria.
- No automatic commit, push, merge or deployment.
- Recovery that never assumes an interrupted non-idempotent command did not take effect.

Only after that contract is implemented and tested should the blocked autonomous coding action be reconsidered.

---

## 5. Autonomy and permission model

The product should feel autonomous: Vanessa should not ask for permission at every ordinary step. The system must also retain hard policy boundaries.

### 5.1 Default behaviour

- Low-risk, read-only and reversible actions within granted scopes can run automatically.
- Vanessa should infer safe defaults from context rather than repeatedly ask about preferences.
- Independent tasks can run in parallel when their resource locks and dependencies allow it.
- The system should recover from transient failures using bounded, documented strategies.
- The user should be interrupted only when an essential fact is unavailable, target selection is ambiguous, a permission is missing, or a material consequence requires approval.

### 5.2 Mandatory approval and hard blocks

Global autonomy must never override action-level policy.

Fresh user approval remains required for high-impact operations such as destructive changes, external message sending, purchases/payments, security or account changes, privileged system changes, and other actions where an error has material consequences. Actions that the policy permanently blocks stay blocked.

Approval must be bound to the exact operation: device, task, action, canonical arguments/hash, policy version and expiry. A new plan or changed arguments requires a new approval. A task-scoped worker cannot inherit broader authority than its parent request.

### 5.3 Device-scoped authorization

When Android remote execution is introduced, the authenticated device identity and granted scopes must travel as trusted server-side execution context. The model must never choose its own scope.

Before each child task executes, the PC checks:

- Is this phone/device trusted and not revoked?
- Does the device have the relevant scope for this specific agent/action?
- Is the action selectable and currently enabled?
- Does the user-level policy allow this operation?
- Does the operation require fresh approval?
- Is the target inside an approved folder/workspace/application boundary?
- Has the request expired, been cancelled or already executed?

The generic remote agentic request capability must not become a universal bypass around per-action permissions.

---

## 6. Remote PC connectivity: from Tailscale-only to anywhere access

### 6.1 Recommended topology

Use a hybrid transport:

1. **Primary broad-access path:** authenticated outbound WSS connections from both Android and the PC to a relay/control plane. The PC opens the connection; no public inbound port is required.
2. **Optional private fast path:** direct Tailscale communication when both endpoints are on the tailnet.
3. **Fallback:** reconnect with exponential backoff and fetch pending, unexpired work when connectivity returns.

The relay must not execute commands. It should route ciphertext and minimal delivery metadata only.

### 6.2 Relay confidentiality and identity

TLS protects each client-to-relay connection, but TLS alone does not make the relay unable to read messages. Before using a third-party relay for private task content, add an application-level end-to-end confidentiality layer:

- Retain signed device identities and strict v2 message validation.
- Establish a session key using an authenticated key-agreement design.
- Use a reviewed AEAD construction with per-message nonces and replay protection.
- Bind identity, request ID, idempotency key, task ID, target PC ID, expiry and protocol version to authenticated data.
- Ensure the relay cannot forge, decrypt, extend expiry or change the target.
- Rotate session keys and revoke device credentials.
- Never place long-lived device secrets in URLs or logs.

This work requires a focused security review and cross-platform conformance tests before production use. The current signed envelope should not be described as end-to-end encrypted merely because it is signed.

### 6.3 Offline and wake behaviour

If a PC is disconnected, Vanessa may queue a request in an encrypted, expiring inbox and tell the user that it is waiting. The request is executed only after the paired PC reconnects, authenticates, rechecks scopes/expiry/policy and confirms it is still valid.

Wake-on-LAN is best effort, not a universal promise. It depends on device firmware, power state, network adapter, router or a reachable wake gateway. A completely powered-off or unreachable PC cannot be made available by the assistant alone. The UI must distinguish queued, delivered, accepted, running, verifying and complete.

### 6.4 Durable remote task lifecycle

The PC must persist a remote parent request before acknowledging acceptance. It must preserve a stable request ID and idempotency key across retries.

On PC restart:

- Reconcile the parent request with the orchestrator task checkpoints.
- Inspect actual machine state before retrying.
- Resume only idempotent operations with verified preconditions.
- Put uncertain non-idempotent actions into a reconciliation or approval state.
- Never report success based only on an old snapshot or lost connection.
- Deliver sequenced events or a versioned snapshot on reconnect.

The current MobileTaskEngine's "mark every in-flight record failed on startup" behaviour is not adequate for this target and must be replaced or adapted without creating a second execution authority.

---

## 7. Voice intelligence: phase after the PC agentic core

Voice owns the speech session; it does not own planning or computer actions.

The existing voice-agent service and ASR/TTS adapters should be integrated with the same request/response contract used by text.

### 7.1 Required conversation behaviour

- PTT, wake-word and continuous modes are configurable.
- Partial transcripts update the live UI only; they never trigger task planning.
- Only a committed turn enters the planner.
- A conversation supports natural follow-ups, references and clarifications.
- Barge-in stops playback independently from task cancellation.
- A task may continue while Vanessa stops speaking; a user must explicitly cancel the task to stop execution.
- Assistant speech and text are projections of the same response state.
- Offline/local fallback reports degraded capability honestly.

### 7.2 Semantic intent and sentiment

Replace the current keyword-dominant sentiment interpretation with contextual understanding using:

- Utterance meaning and conversation history.
- Explicit task language and implied requests.
- Linguistic urgency, uncertainty and frustration cues.
- Acoustic prosody as a weak, confidence-scored signal, not a definitive emotion detector.
- Language and accent handling, including supported multilingual paths.
- Task context and user preferences.

Sentiment is a communication and prioritization signal. It must not be used to diagnose the user or override task permissions. For example, urgency may affect scheduling and response style, but it must never silently authorize a risky action.

### 7.3 Speech response

The voice runtime should support interruption, ordered audio chunks, playback callbacks, retry/fallback and clear state transitions. Chunked playback of a completed response must not be mislabeled as native model-token streaming. Provider-specific streaming can be added after the session lifecycle and correctness are stable.

---

## 8. Memory and contextual continuity

Keep Memory Palace as the first storage foundation unless measurements demonstrate a concrete reason to migrate. Do not replace SQLite with PostgreSQL/Redis just to match an architecture diagram.

The memory work should provide:

- Working context for the active request.
- Episodic records of useful past interactions and completed tasks.
- Semantic facts with source/provenance.
- Procedural memory for proven workflows.
- Project memory with explicit project boundaries.
- Entity links for people, organizations, devices and tools.
- Confidence, recency, expiry and user correction/deletion controls.
- Retrieval based on current intent, not just recent text similarity.

Memory retrieval is reference data, not executable authority. Retrieved content and website/document text must be treated as untrusted data and must not override system policy or authorize tool execution.

---

## 9. Local/cloud model strategy

The PC remains the execution and privacy boundary. The model provider is replaceable.

- Use a local provider for eligible local tasks and when connectivity is unavailable.
- Route complex planning or language work to configured cloud providers when appropriate.
- Define explicit provider health, timeout, retry and fallback policies.
- Never retry a non-idempotent tool merely because an LLM response timed out.
- Send the minimum context required for the selected provider.
- Do not upload files, screenshots, transcripts or source code to a cloud provider unless the task and privacy policy explicitly allow it.
- Surface which capability is local, cloud-dependent or degraded.

The existing router supports local and cloud provider integrations, but a dependable policy-driven fallback strategy must be separately implemented and tested.

---

## 10. Delivery phases and pull-request order

This is a phased engineering programme, not a promise that all capabilities will be complete in one short milestone.

### Phase 0 — Baseline and execution contract

**Deliverable:** one verified inventory of all catalogue actions and execution authorities.

- Map all 62 actions to handlers, schemas, platform constraints, scopes, risk, idempotency, verifiers and tests.
- Trace the local desktop request through planner, policy, task runner, agents, verifier and event stream.
- Mark each capability as verified, partial, blocked or unavailable.
- Identify duplicate/legacy gateways and choose the single supported remote-v2 path.
- Freeze the parent request, child task and event-correlation model.

**Exit gate:** every selectable action has an accountable handler and a real verification story; all blocked actions have documented reasons.

### Phase 1 — Windows PC agentic vertical slice

**Deliverable:** a local Windows request can complete multi-step work end to end.

1. Validate the existing text request path into VanessaOrchestrator.
2. Harden intent/context construction and task-plan validation.
3. Validate resource locks, dependencies, retries and cancellation.
4. Complete high-value browser, file, folder and Windows actions with postcondition checks.
5. Build the managed coding worktree/runner/verifier before unblocking autonomous coding.
6. Add task-scoped worker composition without new privileges.
7. Add persistent execution checkpoints and recovery/reconciliation.
8. Surface truthful progress, partial outcomes, errors and evidence.
9. Run real Windows acceptance tests.

**Exit gate:** multiple representative multi-step tasks complete on a real Windows PC, with evidence, correct permission decisions and restart/failure tests. No task is reported successful without verified postconditions.

### Phase 2 — Remote Android agentic bridge

**Deliverable:** an Android text request reaches the exact same PC orchestrator.

- Adapt remote-v2 transport to submit a natural-language goal.
- Persist the remote parent request before acknowledgement.
- Route to the existing VanessaOrchestrator with authenticated remote principal context.
- Enforce device scopes on every planned child action.
- Stream correlated parent and child progress to the phone.
- Support approval, cancellation, task status, idempotent retry and reconnect.
- Keep the current direct Tailscale route during relay development.

**Exit gate:** one paired Android device can request a multi-agent PC task and receive truthful, correlated, verified results. Tests prove that the generic request cannot bypass per-action scopes.

### Phase 3 — Anywhere relay and offline delivery

**Deliverable:** the same paired Android and PC can communicate when they are not on the same LAN/tailnet.

- Build the outbound WSS relay connector.
- Add application-level encrypted payloads and session key management.
- Add encrypted expiring inbox delivery and idempotent replay protection.
- Reconnect and reconcile after device/network/PC process restart.
- Add queue expiry and user-visible offline states.
- Add optional Wake-on-LAN where the installation supports it.

**Exit gate:** security review, relay cannot read or modify content, replay/expiry/revocation tests pass, and a disconnected PC later executes one unexpired queued request exactly once.

### Phase 4 — Integrated voice and conversation intelligence

**Deliverable:** one coherent voice-and-text conversation controlling the same agentic authority.

- Integrate ConversationController with ASR partial/final and typed input.
- Integrate validated assistant response and TTS playback.
- Improve semantic intent/context and confidence-aware sentiment handling.
- Add turn-taking, interruption, barge-in, wake-word, PTT and local fallback.
- Connect Memory Palace retrieval to multi-turn and project-specific work.
- Add clarify-only-when-essential behaviour.

**Exit gate:** voice and text run the same task flow; a multi-turn voice task survives barge-in, device reconnect and task progress updates without duplicate execution.

### Phase 5 — Cross-platform and product hardening

**Deliverable:** macOS and Linux device agents using the same capability and policy contracts.

- Define platform-specific execution adapters.
- Keep the capability interface independent from OS-specific implementations.
- Add platform-specific permission, UI automation and process isolation.
- Run acceptance suites on supported OS versions.
- Complete packaging, diagnostics, update and recovery processes.

**Exit gate:** each supported platform passes the same contract conformance suite and its own real-device acceptance tests.

---

## 11. Acceptance benchmark

A build is not accepted because a service starts or a model returns a plan. Each scenario must record the request, plan, selected actions, policy decision, execution evidence, verification result, timing, recovery and final response.

| Scenario | Required proof |
|---|---|
| PC health request | Observed system values and timestamp; no fabricated metrics |
| Browser workflow | Distinguish browser launch, page load and target-state completion |
| File organization | Only approved paths touched; expected files/folders verified afterward |
| Multi-step document task | Artifact exists, opens and satisfies required content checks |
| Research task | Source-linked claims and explicit uncertainty |
| Coding task | Isolated diff, test logs, exit status and independent postconditions |
| Failure recovery | Bounded retry only when safe; no duplicate side effects |
| Destructive operation | Correct approval binding or policy refusal |
| PC restart mid-task | Reconciliation from persisted state; no false success or duplicate non-idempotent action |
| Remote offline queue | Expiry, idempotency, reconnect and exact-once acceptance |
| Voice multi-turn request | Partial transcript does not execute; committed turn executes once |
| Voice interruption | Stop playback does not imply task cancellation |
| Unauthorized device | Revoked device, missing scope and replayed frame are rejected |

**Physical acceptance matters:** CI and emulator journeys cannot prove real Windows desktop controls, wake-word detection, microphones, display state or Windows application behaviour. A named Windows hardware acceptance record is required for those claims.

---

## 12. Non-negotiable invariants

1. One supervisor and one task execution authority.
2. The PC validates every action; the phone and relay cannot grant privilege.
3. No arbitrary shell execution by default.
4. Every agent action has a typed contract and explicit tool allow-list.
5. Model-generated plans are untrusted until validated against the catalogue.
6. High-impact operations require fresh approval or remain blocked.
7. Draft ASR transcripts never execute tasks.
8. Stop playback and cancel task are distinct commands.
9. Retries require idempotency or verified reconciliation.
10. A task is complete only after its postconditions pass.
11. A disconnected client is not proof of task failure or success.
12. A relay cannot decrypt or modify task content.
13. Memory and retrieved external content cannot authorize actions.
14. Logs, screenshots and evidence must be redacted for secrets and unnecessary private data.
15. Unsupported platforms/capabilities report unavailability; they do not silently simulate success.

---

## 13. Immediate engineering sequence

The next source changes should follow this dependency order:

1. **Agent capability audit:** generate a precise catalogue-to-handler-and-verifier map from the code.
2. **PC execution benchmark:** establish deterministic multi-agent task scenarios and a Windows acceptance harness.
3. **Task authority/recovery:** resolve the gap between Memory Palace checkpoints, local orchestration tasks and the remote parent task record.
4. **Managed coding execution:** implement the isolated runner and independent verification needed to unblock meaningful software-engineering tasks.
5. **Remote agentic bridge:** make a remote natural-language request call the existing orchestrator with trusted device-scope context.
6. **Relay connectivity:** introduce outbound relay delivery and app-level confidentiality without exposing a PC listener publicly.
7. **Voice integration:** bring the already separate voice runtime into the now-validated agentic flow.

PRs #71 and #72 are not substitutes for this programme. They concern conversation documentation and the Android conversation controller respectively; they may be retained for the later conversation-integration phase, but they must not delay the PC agentic work.

---

## 14. Definition of done

Vanessa's agentic foundation is considered complete only when a user can issue a realistic multi-step goal, locally or through an authenticated remote client, and the PC can:

- Understand the goal and relevant context.
- Build a valid plan from real registered capabilities.
- Choose and coordinate the correct agents.
- Execute within the user's device and action scopes.
- Make ordinary safe decisions autonomously.
- Stop and request approval only when genuinely required.
- Recover safely from transient failures and restarts.
- Verify actual effects on the PC.
- Preserve useful project/task memory with provenance.
- Present live progress and an honest final outcome.

The first release should be narrow enough to verify deeply. Capability breadth comes only after each vertical slice proves execution, permission enforcement, recovery and verification.
