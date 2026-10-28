# Vanessa — Revised Product & Engineering Plan

Planning baseline: 25 October 2026 · Target branch: `Vanessa-Prototype-1-MAIN` · Scope: planning only; no repository changes made

The recent work changes Vanessa's next milestone. The project has passed an important code-quality gate, so the priority should no longer be fixing TypeScript warnings or expanding the number of agents. The priority is to make Vanessa reliably complete a real task from voice input to verified result and spoken response.

The previous product blueprint remains useful, but its phases should be reordered around this goal.

THE NEXT PRODUCT MILESTONE

# Hear → Understand → Execute → Verify → Respond

Vanessa hears a command, routes it through one orchestrator, delegates to the appropriate specialist, verifies the actual result, and tells the user what happened. The floating orb reflects the real execution state throughout.

Code quality and deterministic CI

Reported green for the current branch baseline.

Verified end-to-end task execution

The next release-defining milestone.

## 1. What the recent work establishes

The reported successful CI run at commit [`bfd3216`](https://github.com/Kshitij-Tripathi87/Project_Vanessa/commit/bfd3216aad879c496ebd44f2e3fe57cfcf1a43ef) should be treated as the new baseline.

| Area                                                  | Current position                               | Planning decision                                                   |
| ----------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------- |
| TypeScript issues                                     | Reported fixed                                 | Keep the new type-check in CI.                                      |
| Build and Sarvam deterministic tests                  | Reported passed                                | Preserve as required regression gates.                              |
| Security checks                                       | Reported passed                                | Keep them, but do not interpret them as a complete security audit.  |
| Windows Wi-Fi result handling                         | Reported corrected                             | Add regression tests for real state and failure cases.              |
| Audio framing and ASR lifecycle                       | Improved and tested deterministically          | Validate the complete voice path next.                              |
| Voice-to-orchestrator connection                      | A command submission path exists                | Test the whole path instead of testing individual packages only.    |
| Direct execution of an existing plan                   | Explicitly not implemented by the current stub | Do not depend on this method as the execution mechanism in the MVP. |
| Live microphone, speaker and paid-provider acceptance | Not established by the reported CI             | Require a separate real-device test.                                |

One important issue remains in the inspected orchestrator implementation: `recordAgentResult()` can still mark a task successful based on generic success fields or a non-null result, without requiring an action-specific, independently checked postcondition. The default response composition also needs to be audited so that an absence of errors cannot automatically be interpreted as success.

That means the next step is execution correctness, not simply connecting more components.

## 2. Revised architecture and execution flow

Keep the current monorepo, service separation and floating-orb window. Do not replace working foundations with a large architectural rewrite.

1. Voice session

Push-to-talk · Sarvam ASR · final transcript · interruption handling

2. Single orchestrator

Intent, context, clarification, task plan, policy and lifecycle

Windows agent

Settings and OS tools

Browser agent

Navigation and page interaction

File agent

Approved file operations

Developer agent

Scoped coding and testing

3. Verification and task record

Observe the actual result · capture evidence · establish success, failure or uncertainty

4. Voice response and Living Orb

Speak the verified outcome and show progress, evidence or recovery options

Architectural rule: one orchestrator owns the task lifecycle. Voice handles the conversation, agents perform bounded actions, and the verifier determines what can honestly be reported. The orb renders backend events; it does not invent progress or completion status.

## 3. Prioritized implementation phases

### Phase 0 — Freeze and preserve the green baseline

Goal: protect the recent progress before adding features.

Keep the build, root TypeScript check, Sarvam deterministic tests and security checks as mandatory CI gates. Add the broader scenario, skill and voice tests to the release gate where their runtime is reliable.

Record separately which checks are mocked, deterministic, provider-backed and performed on actual Windows hardware. A green build is necessary, but it is not proof that Vanessa can complete an OS task.

Exit criteria: the current branch builds consistently, the test results are reproducible, and each test category has a clear meaning.

### Phase 1 — Make execution results truthful

Priority: P0. Complete this before expanding autonomy.

Establish a single result contract for all agents. Every action must resolve to one of the following meaningful outcomes:

| Outcome                 | Meaning                                                   |
| ----------------------- | --------------------------------------------------------- |
| `started`               | The action has begun, but completion is not established.  |
| `verified`              | An action-specific postcondition was checked and passed.  |
| `partial`               | Some work happened, but the full request is not complete. |
| `failed`                | The action failed or a required check failed.             |
| `unknown`               | The system cannot determine the actual state.             |
| `cancelled` / `blocked` | Execution was stopped or prevented by policy.             |

The orchestrator must never turn a vague response, generic `success: true`, or merely non-null result into verified success.

Implement verification for the core actions already present in the codebase:

- Windows: verify the requested state after changing it, including Wi-Fi, Bluetooth and volume.
- Browser: distinguish launching a browser, navigating to a URL, loading the intended page and completing a requested interaction. Opening a search page is not equivalent to finding or playing a particular item.
- Files: check the real filesystem after creation, modification or deletion. Explicitly label dry-run and simulated outcomes.
- Coding/testing: opening a terminal or starting a coding CLI is not proof that code was written, tests passed or a requested fix was completed.

Audit response composition as well: Vanessa must not say all tasks succeeded when results are missing, incomplete or unverified.

Exit criteria: focused regression tests demonstrate that false success is impossible for the defined core actions.

### Phase 2 — Complete one voice-to-action vertical slice

Priority: P0. This is the main MVP milestone.

Connect the existing services through one actual user request:

1. Capture speech using the current push-to-talk model.
2. Show the transcript as a draft, then commit the final transcript.
3. Submit a command with its stable request identity and bounded context.
4. Have the orchestrator validate the intent and create a plan.
5. Apply policy and request approval when required.
6. Execute through an existing registered agent.
7. Verify the result and retain structured evidence.
8. Return the final task state to the voice session.
9. Speak an accurate summary and show the same result in the orb.

Start with three bounded scenarios, rather than a generic "do anything" assistant.

| Scenario | What must be proved                                                                               |
| -------- | ------------------------------------------------------------------------------------------------- |
| Windows  | Request a supported setting change, then read back and verify the actual state.                   |
| Browser  | Open an exact URL, verify the destination and page readiness, and report what was actually found. |
| Files    | Create a note in an approved location, write the requested content and verify the resulting file. |

Once these work individually, test a multi-action request such as: "Open YouTube, search for a playlist, and tell me which result you found." Vanessa should report a playlist as playing only when playback has genuinely been confirmed.

The existing `executeCommand()` path should remain the canonical submission route for this first slice. Keep `executePlan()` out of the critical path until direct plan execution or resumption has a clearly defined, tested contract.

Exit criteria: at least one real command can pass from speech to actual action, verification and spoken response, with failures correctly reported.

### Phase 3 — Make the conversational voice loop dependable

Priority: P1.

The deterministic Sarvam tests are a foundation, not the final audio acceptance test.

Build on the current provider/session architecture rather than replacing it:

- Retain draft-versus-committed transcript handling so partial recognition never triggers an action.
- Validate Sarvam ASR connection readiness, final transcript delivery, timeouts and reconnects.
- Stabilize interruption handling, microphone capture, playback queuing and cleanup.
- Keep the current TTS path configurable; use the provider already configured in the branch and preserve an explicit fallback rather than hard-coding a new provider.
- Make speech failures visible while retaining the text response.
- Check request identity and task state so retries or repeated transcripts do not execute the same action twice.
- Measure real end-to-end latency and test with a physical microphone and speaker.

Exit criteria: repeated real-device voice sessions work, spoken commands reach the orchestrator only when committed, and Vanessa can be interrupted without losing task status or replaying side effects.

### Phase 4 — Secure the execution boundary and agent contracts

Priority: P1. Run in parallel with Phases 1–3 where possible.

The existing audit identifies security work that must be resolved before enabling broad local autonomy, coding execution or remote commands.

- Replace direct, unrestricted shell construction with typed tools, validated parameters and safe argument passing.
- Harden developer/coding operations so prompts, paths and branch names cannot accidentally become PowerShell source.
- Restrict file operations to approved roots, including canonical path and symlink containment checks.
- Ensure approvals are tied to the precise action and target—not simply a general user confirmation.
- Test cancellation, duplicate requests, timeout and partial failure.
- Fix or disable the unauthenticated remote command and approval paths until proper session/device authentication is enforced.
- Replace misleading failure drills with tests that actually stop a service, interrupt a provider connection or inject the named failure.

Organize agent documentation into a central `AGENTS.md` index and individual contracts for the Windows, browser, file, developer/coding, testing, planner and memory agents. Each contract should define permitted tools, inputs, outputs, risk, resource locks, evidence, cancellation and tests.

Exit criteria: untrusted inputs cannot bypass the permission boundary, remote endpoints fail closed, and an agent cannot authorize itself or certify its own unverified result.

### Phase 5 — Build the Living Orb around real state

Priority: P1, after task events are trustworthy.

Keep the existing compact, floating-orb concept. Do not turn Vanessa into a dashboard.

The orb should reflect the backend's actual lifecycle:

- Idle and microphone-off
- Listening
- Transcribing
- Planning
- Executing
- Needs approval
- Verifying
- Succeeded
- Partial, failed or offline

Expand the orb only when needed to show the transcript, action in progress, approval request, evidence or recovery controls. Add consistent cancel behavior, visible microphone/privacy status, keyboard accessibility, reduced-motion support, DPI scaling and multi-monitor placement.

Do not spend this phase making animations appear intelligent while the underlying task state is inaccurate.

Exit criteria: a user can see what Vanessa heard, what she is doing, whether she needs permission, and what evidence supports her final answer.

### Phase 6 — Make tasks durable and recoverable

Priority: P1 after the first vertical slice proves the execution contract.

The current runner uses in-memory maps for active task and plan state. The existing checkpoint calls do not, by themselves, establish that the complete execution lifecycle is durably recoverable.

Implement a local durable task ledger, using SQLite unless inspection reveals an existing suitable persistence layer. Persist task state, dependencies, approvals, attempts, results, evidence and ordered lifecycle events.

Add idempotency, bounded retries, resource locks, dependency-failure propagation, cancellation and restart reconciliation. After a crash, Vanessa must inspect the actual system before resuming; it must not repeat a non-idempotent action just because the final result was not recorded.

Exit criteria: a task can be inspected after a restart, incomplete work is not falsely reported as complete, and ambiguous side effects require reconciliation rather than automatic repetition.

### Phase 7 — Add memory and enterprise engineering workflows

Priority: P2.

Once one-shot execution is reliable, build contextual task execution around it:

- Separate temporary conversation context, task working state, durable user-approved memory and project knowledge.
- Add source, timestamp and provenance to remembered facts, with user-visible inspection, editing and forgetting.
- Never store secrets in memory or let recalled information grant permission.
- Add engineering workflows that gather project context and logs, identify likely causes, prepare a patch in an isolated branch or worktree, run approved tests and present the resulting diff and evidence.
- Require explicit approval for externally visible operations, merges, deployments or production changes.

This becomes Vanessa's meaningful differentiator: not simply opening apps by voice, but performing bounded engineering and IT work with verifiable outcomes.

Exit criteria: a workflow produces a reproducible evidence trail, a reviewable artifact and accurate status for every step.

### Phase 8 — Enable the mobile companion

Priority: P2; do not make this a dependency for the desktop MVP.

The target remains a phone that can submit a task to the paired laptop and receive status or handle an approval. However, the current audit notes that loopback addresses cannot be used by a phone to reach the laptop, and remote command/approval authentication needs correction.

Only proceed once device pairing, scoped credentials, protected transport, replay protection, authorization and approval binding are complete. The desktop remains the authority for executing local actions.

Exit criteria: a paired phone can safely request an approved action and receive its real result; unauthenticated, expired or replayed requests are rejected.

## 4. Recommended six-day MVP sequence

Given the previously discussed tight build window, keep the target narrow: one working end-to-end voice task, a truthful result, and a polished minimal orb—not every planned agent and integration.

Day 1

Correct result semantics

Fix generic success inference and response fallbacks. Add focused tests for verified, failed, partial and unknown outcomes. Preserve green CI.

Day 2

Complete one Windows action

Drive one supported setting change through voice submission, orchestration, execution, actual read-back, and spoken confirmation.

Day 3

Verify browser and file tasks

Add successful and failing scenarios for exact navigation and approved file operations. Ensure simulation is never reported as real execution.

Day 4

Validate live voice

Test Sarvam ASR and the configured TTS path on real Windows hardware, including timeout, retry and interruption.

Day 5

Connect task progress to the orb

Show the actual task lifecycle, approval states, success evidence and clear recovery messages. Exercise one bounded multi-step request.

Day 6

Run the release acceptance gate

Test the packaged app, permissions, failure cases, cancellations, duplicate submissions and security regressions. Fix blockers before presenting the MVP as working.

This schedule is a proposed sequence, not a claim that every phase is guaranteed to fit the deadline. If the first end-to-end flow slips, defer advanced UI polish and extra agents instead of reducing verification.

## 5. What should explicitly be deferred

Until the first vertical slice is reliable, do not prioritize a full agent swarm, broad autonomous shell execution, persistent memory features, mobile remote control, complex enterprise connectors or a full visual redesign.

Those are later capabilities, not prerequisites for proving the product works.

## 6. The release gate

Vanessa's next MVP should only be considered ready when all of the following are true:

- A real voice command reaches the orchestrator and completes through a registered agent.
- The result is independently checked against an action-specific postcondition.
- Failed, partial and ambiguous outcomes are reported accurately.
- The user can interrupt speech, cancel a task and see the difference between those operations.
- Draft recognition cannot trigger an action, and repeated submissions do not duplicate side effects.
- The floating orb reflects real backend events instead of hardcoded success or progress.
- The new regression tests and existing CI gates pass.
- Live audio and Windows execution are recorded as a separate acceptance result from deterministic CI.

The existing [product and engineering blueprint](./vanessa-product-engineering-blueprint.md) remains the broader architectural reference. This revised sequence should guide the next implementation work on `Vanessa-Prototype-1-MAIN`, with `main` left untouched.

The strategic priority is simple: make Vanessa trustworthy at one complete task, then scale that reliability across agents, memory and enterprise workflows.
