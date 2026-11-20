# Agent orchestration

**Status:** implemented, in `services/orchestrator`. This document describes the
control flow that exists, and marks clearly where it differs from the target
architecture in the product brief.

## The loop that exists

```
request
  └─ VanessaOrchestrator              core/orchestrator.ts
       ├─ router / agentRouting       core/router.ts, core/agentRouting.ts
       ├─ VanessaPlanner              core/planner.ts          → Plan (tasks)
       ├─ PermissionGuard             core/permissionGuard.ts  → allowed | confirm | denied
       ├─ runPlan                     core/taskRunner.ts       → executes tasks
       │    ├─ resolveTaskLocks       resourceLocks.ts         → no two tasks own the same resource
       │    ├─ computeApprovalDigest  digest bound to task + expiry
       │    └─ agent handlers         agents/*.agent.ts
       ├─ CriticEngine                core/critic.ts           → independent assessment
       └─ recordAgentResult           core/agentResult.ts      → success | partial | failed | blocked
```

Concrete properties worth knowing before changing any of it:

- **Cancellation keeps a tombstone.** A cancel that arrives before submit is
  remembered for a bounded window; otherwise the same `requestId` could start
  executing afterwards. `cancelRequest` reports `cancelled`,
  `executionFinished`, `terminationUnconfirmed` and `planningOnly` separately,
  because "we asked" and "it stopped" are different facts.
- **Approval is digest-bound.** `computeApprovalDigest(task, expiresAt)` binds the
  approval to the task and a deadline. `approveTask`/`rejectTask` are separate
  entry points, matching the phone's separate approve and cancel actions.
- **Locks are declared, not inferred.** `getDeclaredLock(action)` and
  `resolveTaskLocks(task)` decide which resources a task may hold.
- **Autonomy is explicit.** `PermissionGuard.autonomousMode` is off unless
  `AUTONOMOUS_MODE=true`; high-risk actions require confirmation by default.

## The five-stage journey from the brief, mapped

| Brief stage | Reality |
|---|---|
| Request received | `VanessaOrchestrator` → per-request `AbortController` and entry |
| Intent and context | `agentRouting.ts` + `contextBuilder.ts`; there is no separate Intent agent |
| Planning | `VanessaPlanner` produces a `Plan` of `Task`s |
| Policy | `PermissionGuard` (+ `privacy.ts`) decides allow / confirm / deny |
| Execution | `runPlan` with locks, digests, per-agent handlers |
| Verification | `CriticEngine`, then `recordAgentResult` |
| Recovery | no dedicated service; cancellation tombstones and idempotency keys are what exist |

## Storage

**SQLite via `node:sqlite`** — `memory/memoryPalace.ts` and
`core/mobileTaskEngine.ts`. The brief's diagram lists PostgreSQL and Redis; neither
is a dependency of this service. Replacing SQLite is a real migration, not a
diagram change, and nothing in the current tests requires it.

## Rules

1. **No agent acquires authority by existing.** Authority comes from
   `PermissionGuard` and the approval digest.
2. **Execution evidence is not verification.** A completed CLI turn, a launched
   window or a written file is evidence; `recordAgentResult` may still return
   `partial`.
3. **Blocked is a state, not an omission.** An action that cannot be safely run
   is listed in the catalog with `selectable: false` and a reason. See
   `AGENT_REGISTRY.md`.
4. **One correlation mechanism per layer.** The orchestrator correlates by
   `requestId`/`taskId`; the phone does the same through `correlationOf`. Neither
   invents an ordering the protocol does not carry.
