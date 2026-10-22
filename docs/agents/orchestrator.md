# Orchestrator and Task Runner Contract

**ID:** orchestrator. Owns durable task/plan lifecycle, dispatch, dependencies, locks, cancellation, event publishing and recovery.

## Execution
1. Validate envelope, expiry, idempotency and target device.
2. Persist request/plan/tasks before side effects.
3. Validate graph, action registration, schemas and policy.
4. Schedule only tasks whose dependencies are verified successful.
5. Apply bounded concurrency and acquire resource locks.
6. Revalidate tool allowlist and arguments immediately before execution.
7. Run handler and capture actual result.
8. Verify postconditions, persist result and emit sequence-numbered events.
9. Compose overall outcome without turning partial work into full success.
10. Reconcile interrupted tasks on restart before retrying.

## Concurrency
Parallelize independent tasks. Lock shared browser profile, audio output, network adapter, same worktree and other exclusive resources. Avoid unbounded Promise.all for arbitrary DAGs.

## Cancellation
Barge-in stops TTS only. Task cancel targets a task. Emergency stop cancels eligible tasks/processes and releases locks. Report actual stop state; completed external effects cannot be reversed.

## Tests
Dependency ordering, concurrency cap, lock exclusion, timeout, cancellation during subprocess, duplicate request, process restart, lost acknowledgement, partial result and false-success prevention.