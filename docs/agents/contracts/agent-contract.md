# Common Runtime Agent Contract

A specialist is an executable capability boundary, not only a prompt or UI label. The orchestrator owns overall state; each specialist owns only its assigned work.

## Inputs
Every task identifies request/plan/task IDs, objective, registered action, validated parameters, target device, authorized context references, effective tool allowlist, dependencies, acceptance criteria, workspace/resource scope, deadline, idempotency classification and cancellation signal.

## Results
Return task ID, agent ID, status (`completed`, `partial`, `failed`, `blocked`, `awaiting_approval`), summary, evidence, artifacts and verification. Preserve real exit codes, process outcomes and external IDs.

## Rules
- An agent cannot mark the parent plan complete.
- Only the orchestrator advances DAG state.
- Launching a browser/terminal/process is not completion.
- Evidence needs a source; hypothesis is not verified fact.
- Missing required verification means partial/unverified.
- Failed dependencies block descendants unless an explicit safe alternative exists.
- Effective permissions are the intersection of registry, agent allowlist, task scope and policy.
- Validate parameters immediately before each side effect.

## Lifecycle and recovery
Queued → running → verifying → completed/partial/failed, with blocked, approval, cancelled, expired, interrupted and reconciling states. Persist and audit transitions. On restart, reconcile real state before retrying; retry only transient errors with bounded backoff. Never blindly replay uncertain non-idempotent work.

## Tests
Each agent needs schema/unit tests, adapter tests, a real side-effect acceptance test, denied-permission tests, timeout/cancellation tests and end-to-end coverage. Mark FAKE=1 as simulated.
