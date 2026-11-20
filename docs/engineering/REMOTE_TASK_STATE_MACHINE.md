# Remote task state machine

**Status:** implemented in `apps/android/app/src/main/java/com/vanessa/mobile/ui/state/RemoteTaskUi.kt`.
**Tests:** `apps/android/app/src/test/java/com/vanessa/mobile/ui/state/RemoteTaskUiTest.kt` (59 cases, run by `debug-apk`).
**Scope:** what the phone is allowed to say about a task running on a paired Windows PC.

This document exists because two implementations of "is this the same task?" grew
side by side — one in a draft branch, one on `main` — and they disagreed. There is
now one mechanism, and this file describes it so the next change does not
reintroduce a second.

## The rule above all others

> The UI never manufactures task state. It renders what the local runtime or the
> authenticated PC reports.

Every refusal below is that rule taking a specific shape.

## Phases

| Phase | Meaning | Carries identity |
|---|---|---|
| `Idle` | Nothing submitted on this connection, or the last run was dismissed | — |
| `Submitted(capability, requestId)` | Frame written (or about to be), no acceptance yet | request |
| `Running(stateLabel, summary, percentComplete, steps, taskId, requestId, …)` | The PC is working | task + request |
| `AwaitingApproval(approval, requestId)` | The PC is waiting on a signed decision | task (from approval) + request |
| `Finished(outcome)` | A terminal result arrived | — |
| `Failed(message, retryable, correlation)` | A protocol/task error, **not** an outcome | optional |
| `Recovering(detail, taskId, requestId)` | A session is being re-established | optional |
| `Unrecoverable(title, message)` | The PC answered with too little to rebuild the screen | — |

`Finished.outcome` carries `ResultStatus` and `VerificationStatus` separately, and
`OutcomeTone` is derived from both. `succeeded` + `not_available` renders as
**unverified**, never as success.

## Correlation

One helper set, used by live events, replayed events, snapshots and recovery:

```kotlin
correlationOf(phase)                        // Correlation(taskId, requestId)
matchesActiveTask(phase, incomingTaskId)    // strict: known and equal
matchesSubmittedRequest(phase, incomingRequestId)
mayAdoptTask(phase, incomingTaskId)         // nothing tracked yet, or equal
```

The split between `matchesActiveTask` and `mayAdoptTask` is the whole design:

- **Strict** is for anything describing work in progress (`task.progress`,
  `task.result`, `task.cancel_ack`, `task.confirmation_required`). Those may
  never *create* the active task.
- **Adoptive** is only for authoritative PC statements (`task.snapshot`,
  `sync.event`), which are the one source allowed to establish identity.

### Why `Recovering` carries identity

Recovery previously had no task identity at all, so a replayed event arriving
mid-recovery could install an unrelated task as the active one. `Recovering` now
carries the `taskId`/`requestId` of whatever it replaced, and both travel through
`onSaveInstanceState`. A replay for that task is accepted; a replay for any other
task is refused until the PC's snapshot says otherwise.

## Transition table

Live events, all of which require an established correlation first:

| Event | From | Outcome |
|---|---|---|
| `task.accepted` | `Submitted` | `Running`, only if `requestId` matches |
| `task.progress` | `Running` | `Running`, only if `taskId` matches |
| `task.confirmation_required` | `Running` | `AwaitingApproval`, only if the approval's `taskId` matches and the approval is complete |
| `task.cancel_ack` | `Running` | `Running` + acknowledgement, only if `taskId` matches |
| `task.result` | `Running` / `AwaitingApproval` | `Finished`, only if `taskId` matches |
| `task.error` | `Submitted` | `Failed`, only when the payload carries **no** task ID |
| `task.error` | `Running` / `AwaitingApproval` | `Failed` + correlation, only if `taskId` matches |
| `protocol.error` | any | `Failed`, correlation only if the error named a known task |
| `sync.snapshot` | any | see recovery below |
| `sync.event` / `task.snapshot` | any | adopted only when permitted by `mayAdoptTask` |
| `sync.complete` | `Recovering` | `Idle` |
| anything else | any | unchanged |

## Invariants, and where each one lives

| Invariant | Enforced by |
|---|---|
| A delayed acceptance for an old request is ignored | `matchesSubmittedRequest` in `task.accepted` |
| Progress for another task is ignored | `matchesActiveTask` in `task.progress` |
| Results and errors for another task are ignored | `matchesActiveTask` in `task.result` / `task.error` |
| Progress cannot precede acceptance | `task.progress` requires `Running` |
| Approval cannot precede acceptance | `task.confirmation_required` requires `Running` |
| An approval without a complete binding is not offered | `parsePendingApproval` returns null without `approvalId`, `taskId`, `actionHash`, `deviceId`, `expiresAt > 0` |
| A percentage the PC did not send is never shown | `percentComplete` is `null` unless `percentComplete` arrived; a later event without one **keeps** the last genuine value |
| Steps are the PC's own summaries, de-duplicated | `appendStep` |
| A cancellation acknowledgement is not a result | only `task.result` produces `Finished` |
| A restored approval must be complete | `decodeRemoteTaskPhase` returns `Unrecoverable` if any binding field is missing |
| Unreadable saved state cannot become actionable | decode falls back to `Idle` |
| A dropped connection is not a task outcome | `phaseOnConnectionChange` → `Recovering` for `Running`/`Submitted`; a pending approval is left alone because it has its own expiry |
| A terminal snapshot is unverified | `recoverFromSnapshot` always sets `VerificationStatus.UNKNOWN` |
| A history gap is not guessed at | `historyGap` → `Unrecoverable` |
| `awaiting_approval` cannot be restored into a signable screen | → `Unrecoverable` with PC-side resolution |

## Submission race

`RemoteControlActivity.runRemoteTask` generates the request ID, **publishes
`Submitted(capability, requestId)` before writing the signed frame**, and passes
that same ID into `RemoteV2BridgeClient.submitTask(requestId = …)`, which rejects
anything that is not a canonical UUID. A failure only replaces the screen if the
phase is still that same request, so a late exception from an older submission
cannot overwrite a newer task.

## Ordering: what this reducer does not do

The protocol does not give the phone a global, monotonic ordering across
snapshots and events. `safePayload`/`eventSeq` exist per event, and
`sync.snapshot` carries `historyGap`, but there is no snapshot timestamp that can
be compared against a live event to decide which is newer.

So this reducer **does not pretend to order them**. Its rules are:

- Live events must correlate to the active task.
- Snapshots may establish identity, and are only adopted when they do not
  contradict it.
- Per-task event sequences are used to order a replay batch against itself
  (`eventsFor` sorts by `eventSeq`), never against live events.

If the protocol later carries `snapshotAt` plus a per-task `lastEventSeq` on the
wire, stale-snapshot rejection can become a real comparison instead of a
correlation check. Until then, claiming "the older snapshot was rejected because
it was older" would be a fiction the code cannot support.

## Deliberate non-goals

- **No client-side progress interpolation.** No timer advances a percentage.
- **No optimistic success.** A result without a verification block is unverified.
- **No client-side expiry of a live approval.** Expiry is enforced where the
  signature is produced and verified; the countdown is a display, not a guard.
