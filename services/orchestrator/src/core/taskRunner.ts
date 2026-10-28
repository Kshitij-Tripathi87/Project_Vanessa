import { AgentTask, Plan, Task } from "@vanessa/shared";
import { eventBus } from "./eventBus.js";
import { permissionGuard } from "./permissionGuard.js";
import { agentRegistry } from "../agents/registry.js";
import { workingMemory } from "./workingMemory.js";
import { memoryPalace } from "../memory/memoryPalace.js";
import { resourceLockManager } from "./resourceLocks.js";
import { skillsRuntime } from "../skills/skillsRuntime.js";
import { criticEngine } from "./critic.js";
import { recordAgentResult } from "./agentResult.js";
import { cancelCodexTask } from "../agents/codex-task-runner.js";
import { processSupervisor } from "./processSupervisor.js";
import { catalogAccepts, getCatalogAction } from "../agents/agentCatalog.js";
import { resolveManagedAction } from "./actionRegistry.js";
import { repairWorkspaceService } from "./repairWorkspace.js";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
export { recordAgentResult } from "./agentResult.js";

// Active in-memory map of running and paused tasks
export const activeTasks = new Map<string, Task>();
export const activePlanMap = new Map<string, Plan>();

let isKillSwitchEngaged = false;

const APPROVAL_POLICY_VERSION = "trustworthy-execution-v1";

function matchesReviewedActionContract(task: Task, params: Record<string, any>): boolean {
  const spec = getCatalogAction(task.agent, task.action);
  if (!spec?.selectable || !catalogAccepts(task.agent, task.action, params)) return false;

  // The planner is not the authority for risk or allowed tools. These fields
  // must exactly match the reviewed catalog or the task is rejected before
  // approval can be requested and again immediately before execution.
  if (task.risk !== spec.risk || !Array.isArray(task.allowedTools)) return false;
  if (task.allowedTools.length !== spec.tools.length) return false;
  return spec.tools.every((tool, index) => task.allowedTools![index] === tool);
}

function stableJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function captureRepairRepositorySnapshot() {
  const git = (args: string[]) => execFileSync("git", args, {
    cwd: process.cwd(),
    timeout: 3000,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 128 * 1024,
  });
  const repositoryRoot = path.resolve(git(["rev-parse", "--show-toplevel"]).trim());
  const branch = git(["branch", "--show-current"]).trim();
  const baseCommit = git(["rev-parse", "HEAD"]).trim();
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!repositoryRoot || !branch || !baseCommit) {
    throw new Error("Repository identity is incomplete.");
  }
  if (status.trim()) {
    throw new Error("Repair approval is blocked because the base checkout is dirty.");
  }
  return {
    repositoryRoot,
    branch,
    baseCommit,
    workingTreeDigest: createHash("sha256").update(status).digest("hex"),
    targetRelativePath: "packages/incident-lab/src/checkout.ts",
    patchContract: "incident-lab.checkout-promo-null-guard.v1",
  };
}

export function computeApprovalDigest(task: Task, expiresAt: number): string {
  const params = task.params || {};
  const managed = resolveManagedAction(task.action, params);
  let repositoryBinding: Record<string, any> | null = null;

  if (["coding.prepare_patch", "incident.prepare_and_verify"].includes(task.action)) {
    let observed: ReturnType<typeof captureRepairRepositorySnapshot>;
    try {
      observed = captureRepairRepositorySnapshot();
    } catch (error: any) {
      throw new Error(`Cannot bind approval to a clean repository and base commit: ${error?.message || "Git inspection failed"}`);
    }

    // Capture the approved snapshot once. Recomputations include both the
    // immutable snapshot and current observation, so changing branch, HEAD,
    // or working-tree state invalidates a previously issued approval.
    if (!task.approvalBaseCommit) {
      task.approvalRepositoryRoot = observed.repositoryRoot;
      task.approvalBranch = observed.branch;
      task.approvalBaseCommit = observed.baseCommit;
      task.approvalWorkingTreeDigest = observed.workingTreeDigest;
      task.approvalTarget = observed.targetRelativePath;
      task.approvalPatchContract = observed.patchContract;
    }

    repositoryBinding = {
      approvedRepositoryRoot: task.approvalRepositoryRoot,
      approvedBranch: task.approvalBranch,
      approvedBaseCommit: task.approvalBaseCommit,
      approvedWorkingTreeDigest: task.approvalWorkingTreeDigest,
      approvedTarget: task.approvalTarget,
      approvedPatchContract: task.approvalPatchContract,
      observed,
    };
  } else if (task.action === "testing.run_incident_lab") {
    const workspace = typeof params.workspaceId === "string"
      ? repairWorkspaceService.getWorkspace(params.workspaceId)
      : undefined;
    if (!workspace || typeof params.expectedDiffHash !== "string") {
      throw new Error("Test approval cannot be bound without a registered worktree and patch digest.");
    }
    repositoryBinding = {
      repositoryRoot: workspace.repositoryRoot,
      worktreePath: workspace.worktreePath,
      workspaceId: workspace.taskId,
      baseCommit: workspace.baseCommit,
      branch: workspace.branchName,
      targetRelativePath: "packages/incident-lab/src/checkout.ts",
      expectedDiffHash: params.expectedDiffHash,
    };
  }

  const binding = {
    policyVersion: APPROVAL_POLICY_VERSION,
    taskId: task.id,
    actionId: task.action,
    normalizedArgs: params,
    target: repositoryBinding || params.workspacePath || params.worktreePath || params.workspaceId ||
      params.targetPath || params.path || params.deviceId || params.resource || task.agent,
    baseCommit: params.baseCommit || params.expectedBaseCommit || task.approvalBaseCommit ||
      repositoryBinding?.baseCommit || repositoryBinding?.approvedBaseCommit || null,
    sideEffectClass: managed.sideEffectClass || "unclassified",
    risk: task.risk || "medium",
    expiresAt,
  };
  return createHash("sha256").update(stableJson(binding)).digest("hex");
}

function markTerminationUnconfirmed(task: Task, reason: string) {
  task.status = "termination_unconfirmed";
  task.lifecycleState = "termination_unconfirmed";
  task.error = reason;
  task.completedAt = Date.now();
  task.verification = {
    verified: false,
    postconditions: [reason, "Execution locks remain held until termination can be verified."],
    outcome: "termination_unconfirmed",
    details: reason,
  };
  memoryPalace.recordTaskCheckpoint(task, task.parentId);
  eventBus.emitEvent("audit:log", {
    id: `termination-unconfirmed-${Date.now()}`,
    timestamp: Date.now(),
    taskId: task.id,
    agent: task.agent,
    action: task.action,
    risk: "high",
    permission: "blocked",
    status: "warn",
    details: reason,
  });
  eventBus.emitEvent("task:update", task);
}

export function getDeclaredLock(action: string): string | null {
  const lower = action.toLowerCase();
  if (lower.includes("wifi") || lower.includes("adapter") || lower.includes("network")) {
    return "network-adapter";
  }
  if (lower.includes("youtube") || lower.includes("browser") || lower.includes("chrome")) {
    return "browser-profile";
  }
  if (lower.includes("audio") || lower.includes("tts") || lower.includes("voice.speak")) {
    return "audio";
  }
  return null;
}

export function resolveTaskLocks(task: Task): string[] {
  const locks: string[] = [];
  const decl = getDeclaredLock(task.action);
  if (decl) locks.push(decl);

  // Preserve an execution resource lock when a managed child process is
  // unresolved. A named worktree gets a per-worktree lock; repair creation is
  // serialized against the shared repository boundary.
  if (task.action === "testing.run_incident_lab") {
    const workspaceId = typeof task.params?.workspaceId === "string" ? task.params.workspaceId : "";
    if (workspaceId) locks.push(`repair-workspace:${workspaceId}`);
  } else if (["coding.prepare_patch", "incident.prepare_and_verify", "incident.investigate"].includes(task.action)) {
    locks.push(`repair-repository:${path.resolve(typeof task.params?.repositoryRoot === "string" ? task.params.repositoryRoot : process.cwd())}`);
  } else if (task.action === "terminal.run_command") {
    locks.push("arbitrary-terminal-execution");
  }

  if (task.skillName) {
    const skill = skillsRuntime.getSkill(task.skillName);
    if (skill?.locks) {
      for (const l of skill.locks) {
        if (!locks.includes(l)) locks.push(l);
      }
    }
  }
  return locks;
}


export type CancellationResolution = "cancelled" | "execution_finished" | "termination_unconfirmed";

const cancellationInFlight = new Map<string, Promise<CancellationResolution>>();

export function cancelTaskWithProof(
  task: Task,
  reason: string,
  supervisor: Pick<typeof processSupervisor, "cancel"> = processSupervisor,
): Promise<CancellationResolution> {
  const existing = cancellationInFlight.get(task.id);
  if (existing) return existing;

  const operation = cancelTaskWithProofInternal(task, reason, supervisor).finally(() => {
    if (cancellationInFlight.get(task.id) === operation) cancellationInFlight.delete(task.id);
  });
  cancellationInFlight.set(task.id, operation);
  return operation;
}

async function cancelTaskWithProofInternal(
  task: Task,
  reason: string,
  supervisor: Pick<typeof processSupervisor, "cancel">,
): Promise<CancellationResolution> {
  const hasStarted = task.startedAt !== undefined && task.status !== "pending" && task.status !== "awaiting_approval";
  if (!hasStarted) {
    task.status = "cancelled";
    task.lifecycleState = "cancelled";
    task.error = reason;
    task.completedAt = Date.now();
    task.verification = {
      verified: true,
      postconditions: ["Task was cancelled before executable work started."],
      outcome: "cancelled",
      details: "No process needed termination.",
    };
    resourceLockManager.releaseAllForTask(task.id);
    memoryPalace.recordTaskCheckpoint(task, task.parentId);
    eventBus.emitEvent("task.cancelled", { taskId: task.id, agentId: task.agent, reason });
    eventBus.emitEvent("task:update", task);
    return "cancelled";
  }

  const originalState = {
    status: task.status,
    lifecycleState: task.lifecycleState,
    error: task.error,
    verification: task.verification,
    completedAt: task.completedAt,
  };
  task.lifecycleState = "cancel_requested";
  task.error = reason;
  task.verification = {
    verified: false,
    postconditions: ["Cancellation was requested; process termination has not been verified."],
    outcome: "termination_unconfirmed",
    details: reason,
  };
  eventBus.emitEvent("task:update", task);

  try {
    if (task.agent === "developer" && task.action === "codex.run_task") {
      // Codex has a separate cancellation channel, but it does not provide process-tree proof.
      void cancelCodexTask(task.id);
    }
    const result = await supervisor.cancel(
      task.id,
      task.action === "testing.run_incident_lab" ? task.action : undefined,
    );

    // A terminal process result that is not itself a verified cancellation means
    // the operation won the race. Preserve that result instead of relabeling it
    // cancelled (particularly for a completed test run or a timeout).
    const executionAlreadyFinished = Boolean(
      result &&
      result.status !== "cancelled" &&
      result.status !== "termination_unconfirmed" &&
      result.terminationVerified === true
    );
    if (executionAlreadyFinished) {
      // The agent may already have advanced the task to verification or a
      // terminal state while this await settled. Only restore the pre-request
      // snapshot when the task is still in our cancellation transition.
      if (task.lifecycleState === "cancel_requested" && task.status === originalState.status) {
        task.status = originalState.status;
        task.lifecycleState = originalState.lifecycleState;
        task.error = originalState.error;
        task.verification = originalState.verification;
        task.completedAt = originalState.completedAt;
      }
      eventBus.emitEvent("task:update", task);
      return "execution_finished";
    }

    if (!result || result.status !== "cancelled" || result.terminationVerified !== true) {
      markTerminationUnconfirmed(
        task,
        result?.error || "Vanessa cannot prove this task's process tree has stopped. Conflicting resource locks remain held.",
      );
      return "termination_unconfirmed";
    }

    task.status = "cancelled";
    task.lifecycleState = "cancelled";
    task.error = reason;
    task.completedAt = Date.now();
    task.verification = {
      verified: true,
      postconditions: [result.processStarted
        ? "Process supervisor verified the managed process tree stopped."
        : "Process supervisor confirmed cancellation before process launch; no managed process was started."],
      exitCode: result.exitCode ?? undefined,
      outcome: "cancelled",
      details: result.error || `Process status: ${result.status}; cancellation verified.`,
    };
    resourceLockManager.releaseAllForTask(task.id);
    memoryPalace.recordTaskCheckpoint(task, task.parentId);
    eventBus.emitEvent("task.cancelled", { taskId: task.id, agentId: task.agent, reason });
    eventBus.emitEvent("task:update", task);
    return "cancelled";
  } catch (error: any) {
    markTerminationUnconfirmed(
      task,
      `Termination could not be verified: ${typeof error?.message === "string" ? error.message : "unknown error"}`,
    );
    return "termination_unconfirmed";
  }
}

export async function triggerKillSwitch(): Promise<void> {
  isKillSwitchEngaged = true;
  const checks: Promise<CancellationResolution>[] = [];
  for (const task of activeTasks.values()) {
    if (["running", "pending", "awaiting_approval", "termination_unconfirmed"].includes(task.status)) {
      checks.push(cancelTaskWithProof(task, "Cancellation requested by emergency kill switch."));
    }
  }
  const results = await Promise.all(checks);
  const unconfirmed = results.filter((result) => result === "termination_unconfirmed").length;
  const executionFinished = results.filter((result) => result === "execution_finished").length;
  eventBus.emitEvent("audit:log", {
    id: `kill-${Date.now()}`,
    timestamp: Date.now(),
    agent: "orchestrator",
    action: "kill_switch",
    status: unconfirmed ? "warn" : "success",
    details: unconfirmed
      ? `Emergency kill switch completed with ${unconfirmed} unconfirmed process termination(s) and ${executionFinished} operation(s) that had already produced terminal process evidence. Unconfirmed locks were retained; new work remains blocked.`
      : executionFinished
        ? `Emergency cancellation completed. Running processes were verified stopped or had already produced terminal process evidence; ${executionFinished} operation(s) were left to report their actual result rather than being relabeled cancelled.`
        : "Emergency cancellation completed. Every running managed process was verified stopped; queued tasks were cancelled before execution.",
  });
  if (unconfirmed === 0) isKillSwitchEngaged = false;
}

export function resolveParams(params: Record<string, any>, allTasks: Task[]): Record<string, any> {
  const serialized = JSON.stringify(params || {});
  const resolved = serialized.replace(
    /"\$([a-zA-Z0-9_]+)\.result\.(.+?)"/g,
    (_match, taskId, path) => {
      const parent = allTasks.find((t) => t.id === taskId);
      if (!parent || parent.result === undefined || parent.result === null) {
        return '""';
      }
      const value = path
        .split(".")
        .reduce((current: any, key: string) => current?.[key], parent.result);
      return JSON.stringify(value ?? "");
    }
  );
  try {
    return JSON.parse(resolved);
  } catch {
    return params;
  }
}

export async function approveTask(taskId: string): Promise<Task | null> {
  const task = activeTasks.get(taskId);
  if (!task || task.status !== "awaiting_approval") {
    return null;
  }

  if (task.approvalExpiresAt && task.approvalExpiresAt <= Date.now()) {
    task.status = "expired";
    task.lifecycleState = "expired";
    task.error = "Approval expired. Submit the command again to request a fresh approval.";
    task.completedAt = Date.now();
    memoryPalace.recordTaskCheckpoint(task, task.parentId);
    eventBus.emitEvent("audit:log", {
      id: `approval-expired-${Date.now()}`,
      timestamp: Date.now(),
      taskId: task.id,
      agent: task.agent,
      action: task.action,
      risk: task.risk || "medium",
      permission: "expired",
      status: "expired",
      details: "The one-time approval request expired before the user responded.",
    });
    eventBus.emitEvent("task:update", task);
    return task;
  }

  const dependenciesReady = (task.dependsOn || []).every((id) => activeTasks.get(id)?.status === "success");
  const permission = permissionGuard.check(task, false);
  const catalogAllowed = matchesReviewedActionContract(task, task.params || {});
  let currentApprovalDigest = "";
  let approvalDigestError = "";
  try {
    currentApprovalDigest = task.approvalExpiresAt
      ? computeApprovalDigest(task, task.approvalExpiresAt)
      : "";
  } catch (error: any) {
    approvalDigestError = typeof error?.message === "string"
      ? error.message
      : "The approved operation could not be revalidated against the current repository state.";
  }
  const approvalInvalid = Boolean(approvalDigestError) ||
    !task.approvalDigest ||
    task.approvalPolicyVersion !== APPROVAL_POLICY_VERSION ||
    task.approvalConsumedAt !== undefined ||
    currentApprovalDigest !== task.approvalDigest;
  if (isKillSwitchEngaged || !dependenciesReady || permission === "blocked" || !catalogAllowed || approvalInvalid) {
    task.status = isKillSwitchEngaged ? "cancelled" : "blocked";
    task.lifecycleState = isKillSwitchEngaged ? "cancelled" : "blocked";
    task.error = isKillSwitchEngaged
      ? "Approval cancelled by emergency kill switch."
      : !dependenciesReady
      ? "Approval rejected because prerequisite tasks are not verified as successful."
      : permission === "blocked"
        ? "Approval rejected because the canonical execution policy blocks this task."
        : !catalogAllowed
          ? "Approval rejected because the action or parameters are not accepted by the reviewed, selectable agent catalog."
          : approvalDigestError
            ? `Approval rejected because the target could not be safely revalidated: ${approvalDigestError}`
            : approvalInvalid
              ? "Approval binding is missing, expired, reused, or no longer matches the exact operation."
              : "Approval rejected because the safety policy now blocks this task.";
    task.completedAt = Date.now();
    memoryPalace.recordTaskCheckpoint(task, task.parentId);
    eventBus.emitEvent("audit:log", {
      id: `approval-blocked-${Date.now()}`,
      timestamp: Date.now(),
      taskId: task.id,
      agent: task.agent,
      action: task.action,
      risk: task.risk || "medium",
      permission: "blocked",
      status: task.status,
      details: task.error,
    });
    eventBus.emitEvent("task:update", task);
    return task;
  }

  task.approvalConsumedAt = Date.now();
  task.approvalPolicyVersion = APPROVAL_POLICY_VERSION;
  eventBus.emitEvent("approval:granted", { taskId });
  eventBus.emitEvent("audit:log", {
    id: `approval-granted-${Date.now()}`,
    timestamp: Date.now(),
    taskId: task.id,
    agent: task.agent,
    action: task.action,
    risk: task.risk || "medium",
    permission: "approved_once",
    status: "approved",
    details: "User approved this task once; approval is not retained for future tasks.",
  });
  task.status = "running";
  task.lifecycleState = "running";
  task.startedAt = Date.now();
  memoryPalace.recordTaskCheckpoint(task, task.parentId);
  eventBus.emitEvent("task:update", task);

  const locks = resolveTaskLocks(task);
  const acquiredLocks: string[] = [];
  let acquiredSlot = false;
  const managedTestAction = task.action === "testing.run_incident_lab";
  let managedReservationCreated = false;

  try {
    const agent = agentRegistry[task.agent];
    if (!agent) {
      throw new Error(`No agent registered for ${task.agent}`);
    }

    // Tool permission verification
    if (agent.allowedTools && task.allowedTools && task.allowedTools.length > 0) {
      const unauthorized = task.allowedTools.filter((tool: string) => !agent.allowedTools.includes(tool));
      if (unauthorized.length > 0) {
        throw new Error(
          `Security violation: Agent '${task.agent}' is not authorized to use tool(s): ${unauthorized.join(", ")}`
        );
      }
    }

    const plan = activePlanMap.get(task.parentId || "") || { id: "p", command: "" };
    const allTaskList = [...activeTasks.values()];
    const resolvedParams = resolveParams(task.params, allTaskList);
    task.params = resolvedParams;

    const skill = task.skillName ? skillsRuntime.getSkill(task.skillName) : skillsRuntime.matchSkill(task.action);

    const agentTask: AgentTask = {
      taskId: task.id,
      parentTaskId: task.parentId,
      objective: task.action,
      action: task.action,
      params: resolvedParams,
      allowedTools: task.allowedTools || agent.allowedTools || [],
      dependsOn: task.dependsOn || [],
      acceptanceCriteria: task.acceptanceCriteria || (skill?.objective ? [skill.objective] : []),
      deadlineMs: 30000,
      context: [
        workingMemory.getSnapshot(),
        ...(skill ? [{ type: "skill_instructions", skill: skill.name, instructions: skill.instructions }] : []),
      ],
    };

    // Register the managed action before any asynchronous scheduler/lock wait.
    // A cancellation while queued can now be proven to have launched no child.
    if (managedTestAction) {
      processSupervisor.reserve(task.id, task.action);
      managedReservationCreated = true;
    }
    const slotAcquired = await resourceLockManager.acquireSlot(task.id);
    if (!slotAcquired) return task;
    acquiredSlot = true;
    for (const l of locks) {
      const lockAcquired = await resourceLockManager.acquireLock(l, task.id);
      if (!lockAcquired) return task;
      if (resourceLockManager.getHeldLocks()[l] === task.id && !acquiredLocks.includes(l)) {
        acquiredLocks.push(l);
      }
      if (
        (task.status as string) === "cancelled" ||
        (task.status as string) === "termination_unconfirmed" ||
        (task.lifecycleState as string) === "cancel_requested"
      ) return task;
    }

    // Cancellation may arrive while waiting for a slot/lock. Check the
    // request state as well as the terminal status so no executor can launch
    // during the async process-termination handshake.
    if (
      (task.status as string) === "cancelled" ||
      (task.status as string) === "termination_unconfirmed" ||
      (task.lifecycleState as string) === "cancel_requested"
    ) return task;
    const finalPermission = permissionGuard.check(task, false);
    if (finalPermission === "blocked" || !matchesReviewedActionContract(task, resolvedParams)) {
      throw new Error("Execution was blocked because the action policy or reviewed parameter contract changed before launch.");
    }
    if (
      task.approvalDigest &&
      (task.approvalPolicyVersion !== APPROVAL_POLICY_VERSION ||
        task.approvalConsumedAt === undefined ||
        task.approvalExpiresAt === undefined ||
        task.approvalExpiresAt <= Date.now() ||
        computeApprovalDigest(task, task.approvalExpiresAt) !== task.approvalDigest)
    ) {
      throw new Error("Approval binding changed or expired before process launch.");
    }

    let result: any;
    result = await agent.execute(task.action, resolvedParams, {
      planId: plan.id,
      command: plan.command,
      workingMemory: workingMemory.getSnapshot(),
      task,
      agentTask,
    });

    const managedProcessStatus = managedTestAction ? result?.data?.processStatus : undefined;
    const managedProcessTerminationVerified = result?.data?.terminationVerified === true;

    // The process supervisor is authoritative for managed test lifecycle. Do
    // not let a cancellation race overwrite an unconfirmed process tree or
    // treat a timed-out/exited process as a successful cancellation.
    if (managedTestAction && managedProcessStatus === "termination_unconfirmed") {
      markTerminationUnconfirmed(
        task,
        typeof result?.summary === "string" && result.summary.trim()
          ? result.summary
          : "The test process tree could not be verified as stopped. Conflicting resource locks remain held.",
      );
      return task;
    }

    if (managedTestAction && managedProcessStatus === "cancelled" && managedProcessTerminationVerified) {
      task.status = "cancelled";
      task.lifecycleState = "cancelled";
      task.error = "The managed test process was cancelled and its termination was verified.";
      task.completedAt = Date.now();
      task.result = result?.data ?? result;
      task.evidence = Array.isArray(result?.evidence) ? result.evidence : [];
      task.artifacts = Array.isArray(result?.artifacts) ? result.artifacts : [];
      task.spokenSummary = result?.spokenSummary || task.error;
      task.verification = {
        verified: true,
        postconditions: ["The process supervisor reported cancellation with terminationVerified=true."],
        exitCode: result?.data?.exitStatus ?? undefined,
        outcome: "cancelled",
        details: `Managed process status: ${managedProcessStatus}; termination verified.`,
      };
      memoryPalace.recordTaskCheckpoint(task, plan.id);
      eventBus.emitEvent("task:update", task);
      return task;
    }

    const managedExecutionFinishedWithoutCancellation =
      managedTestAction &&
      ["exited", "timed_out", "spawn_failed", "orphaned_processes"].includes(managedProcessStatus) &&
      managedProcessTerminationVerified;

    if (
      managedExecutionFinishedWithoutCancellation &&
      (task.lifecycleState as string) === "cancel_requested" &&
      (task.status as string) !== "termination_unconfirmed"
    ) {
      // The operation reached a verified terminal process state before the
      // cancellation handshake won. Let its actual exit/report determine the
      // task outcome rather than allowing the kill-switch flag to relabel it.
      task.lifecycleState = "verifying";
      task.error = undefined;
      task.verification = undefined;
    }

      if ((task.status as string) === "termination_unconfirmed" || task.verification?.outcome === "termination_unconfirmed") {
        // Do not overwrite an unresolved process state with a convenient terminal status.
        memoryPalace.recordTaskCheckpoint(task, plan.id);
        eventBus.emitEvent("task:update", task);
        return task;
      }
      if ((isKillSwitchEngaged && !managedExecutionFinishedWithoutCancellation) || ((task.status as string) === "cancelled" && !managedExecutionFinishedWithoutCancellation)) {
        task.status = "cancelled";
        task.lifecycleState = "cancelled";
        task.error = task.error || "Operation was cancelled while the agent was running.";
        task.completedAt = Date.now();
        // Preserve verified process/no-process termination evidence written by
        // cancelTaskWithProof; do not downgrade it after the agent returns.
        if (!(task.verification?.outcome === "cancelled" && task.verification?.verified === true)) {
          task.verification = {
            verified: false,
            postconditions: ["Cancellation was requested; termination proof is unavailable in this result."],
            exitCode: undefined,
            outcome: "cancelled",
          };
        }
        memoryPalace.recordTaskCheckpoint(task, task.parentId);
        eventBus.emitEvent("task:update", task);
        return task;
      }

      task.lifecycleState = "verifying";
      eventBus.emitEvent("task:update", task);

    let outcome = recordAgentResult(task, result);

    // Critic Evaluation
    const verdict = criticEngine.evaluate(task, skill);
    task.critic = verdict;
    if (!verdict.passed && outcome === "success") {
      outcome = "failed";
      task.error = task.error || verdict.feedback;
    } else if (!verdict.passed) {
      task.error = task.error || verdict.feedback;
    }
    if (verdict.proof) {
      task.evidence = [...(task.evidence || []), { description: verdict.proof, source: "critic", timestamp: new Date().toISOString() }];
    }

    task.status = outcome;
    task.lifecycleState = outcome === "success" ? "succeeded" : outcome;
    if (outcome === "failed") task.error = task.error || "Verification postconditions failed.";
    task.completedAt = Date.now();
    memoryPalace.recordTaskCheckpoint(task, plan.id);
    workingMemory.recordTaskResult(task);
  } catch (err) {
    task.status = "failed";
    task.lifecycleState = "failed";
    task.error = (err as Error).message;
    task.completedAt = Date.now();
    task.verification = {
      verified: false,
      postconditions: ["Approved task crashed during execution"],
      exitCode: 1,
      outcome: "failed",
    };
    memoryPalace.recordTaskCheckpoint(task, task.parentId);
  } finally {
    if (managedTestAction && managedReservationCreated) {
      processSupervisor.releaseReservationIfUnused(task.id);
    }
    if (task.verification?.outcome !== "termination_unconfirmed" && (task.status as string) !== "termination_unconfirmed") {
      for (const l of acquiredLocks) resourceLockManager.releaseLock(l, task.id);
    }
    if (acquiredSlot) resourceLockManager.releaseSlot();
  }

  eventBus.emitEvent("task:update", task);
  const parentPlan = activePlanMap.get(task.parentId || "");
  if (parentPlan && (task.status === "success" || task.status === "partial" || task.status === "failed" || (task.status as string) === "expired")) {
    await runPlan(parentPlan);
  }
  return task;
}

export async function rejectTask(taskId: string): Promise<Task | null> {
  const task = activeTasks.get(taskId);
  if (!task || task.status !== "awaiting_approval") {
    return null;
  }
  task.status = "failed";
  task.lifecycleState = "blocked";
  task.error = "User declined confirmation.";
  task.completedAt = Date.now();
  memoryPalace.recordTaskCheckpoint(task, task.parentId);
  eventBus.emitEvent("approval:rejected", { taskId });
  eventBus.emitEvent("audit:log", {
    id: `approval-rejected-${Date.now()}`,
    timestamp: Date.now(),
    taskId: task.id,
    agent: task.agent,
    action: task.action,
    risk: task.risk || "medium",
    permission: "rejected",
    status: "blocked",
    details: "User declined the one-time approval request.",
  });
  eventBus.emitEvent("task:update", task);
  const parentPlan = activePlanMap.get(task.parentId || "");
  if (parentPlan) await runPlan(parentPlan);
  return task;
}

export function composeResponse(tasks: Task[]): string {
  const awaiting = tasks.filter((t) => t.status === "awaiting_approval");
  if (awaiting.length) {
    return "I need your approval to continue.";
  }
  const failed = tasks.filter((t) => t.status === "failed");
  if (failed.length) {
    return `${failed.length} task failed. ${failed[0].error ?? ""}`;
  }
  const summaries = tasks.map((t) => t.spokenSummary).filter(Boolean);
  if (summaries.length > 0) {
    return summaries.join(" ");
  }
  return "No verifiable completion summary is available. Check task evidence and final statuses before treating the request as complete.";
}

export async function runPlan(plan: Plan): Promise<Task[]> {
  activePlanMap.set(plan.id, plan);
  workingMemory.setActivePlan(plan);
  eventBus.emitEvent("plan:started", plan);

  const tasks = new Map<string, Task>(plan.tasks.map((t: Task) => [t.id, { ...t }]));
  for (const t of tasks.values()) {
    t.parentId = t.parentId || plan.id;
    t.lifecycleState = t.lifecycleState || "planning";
    t.isIdempotent = t.isIdempotent ?? (t.action.startsWith("read") || t.action.includes("status") || t.action.includes("check") || t.action.includes("inspect"));
    activeTasks.set(t.id, t);
    memoryPalace.recordTaskCheckpoint(t, plan.id);
  }

  const nextTasks = () =>
    [...tasks.values()].filter(
      (t: Task) =>
        t.status === "pending" &&
        t.dependsOn.every((id: string) => tasks.get(id)?.status === "success")
    );

  const runTask = async (task: Task) => {
    if (isKillSwitchEngaged) {
      task.status = "cancelled";
      task.lifecycleState = "cancelled";
      task.error = "Cancelled by kill switch";
      memoryPalace.recordTaskCheckpoint(task, plan.id);
      eventBus.emitEvent("task.cancelled", { taskId: task.id, agentId: task.agent, reason: task.error });
      eventBus.emitEvent("task:update", task);
      return;
    }

    task.status = "running";
    task.lifecycleState = "running";
    task.startedAt = Date.now();
    memoryPalace.recordTaskCheckpoint(task, plan.id);
    eventBus.emitEvent("task:update", task);
    eventBus.emitEvent("agent.started", { taskId: task.id, agentId: task.agent, action: task.action, startedAt: task.startedAt });

    // Resolve dynamic parameter dependencies from completed tasks: "$<taskId>.result.<path>"
    const allTaskList = [...tasks.values()];
    const resolvedParams = resolveParams(task.params, allTaskList);
    task.params = resolvedParams;
    eventBus.emitEvent("tool.started", { taskId: task.id, agentId: task.agent, tool: task.action, params: resolvedParams });

    const permission = permissionGuard.check(task);
    const catalogAllowed = matchesReviewedActionContract(task, resolvedParams);
    if (permission === "blocked" || !catalogAllowed) {
      task.status = "blocked";
      task.lifecycleState = "blocked";
      task.error = permission === "blocked"
        ? "Blocked by the canonical execution policy. No process was started."
        : "Blocked because the action or parameters are not accepted by the reviewed, selectable agent catalog. No process was started.";
      task.completedAt = Date.now();
      task.verification = {
        verified: false,
        postconditions: [task.error],
        outcome: "blocked",
        details: task.error,
      };
      memoryPalace.recordTaskCheckpoint(task, plan.id);
      eventBus.emitEvent("audit:log", {
        id: `policy-denied-${Date.now()}`,
        timestamp: Date.now(),
        taskId: task.id,
        agent: task.agent,
        action: task.action,
        risk: task.risk || "high",
        permission: "blocked",
        status: "blocked",
        details: task.error,
      });
      eventBus.emitEvent("task:update", task);
      return;
    }

    if (permission === "confirm") {
      task.status = "awaiting_approval";
      task.lifecycleState = "awaiting_approval";
      task.approvalExpiresAt = Date.now() + 5 * 60_000;
      task.approvalPolicyVersion = APPROVAL_POLICY_VERSION;
      task.approvalConsumedAt = undefined;
      try {
        task.approvalDigest = computeApprovalDigest(task, task.approvalExpiresAt);
      } catch (error: any) {
        task.status = "blocked";
        task.lifecycleState = "blocked";
        task.error = typeof error?.message === "string"
          ? `Approval request was blocked: ${error.message}`
          : "Approval request was blocked because the target could not be safely validated.";
        task.completedAt = Date.now();
        task.verification = {
          verified: false,
          postconditions: [task.error, "No approval was requested and no process was started."],
          outcome: "blocked",
          details: task.error,
        };
        memoryPalace.recordTaskCheckpoint(task, plan.id);
        eventBus.emitEvent("audit:log", {
          id: `approval-create-blocked-${Date.now()}`,
          timestamp: Date.now(),
          taskId: task.id,
          agent: task.agent,
          action: task.action,
          risk: task.risk || "high",
          permission: "blocked",
          status: "blocked",
          details: task.error,
        });
        eventBus.emitEvent("task:update", task);
        return;
      }
      memoryPalace.recordTaskCheckpoint(task, plan.id);
      eventBus.emitEvent("approval:required", task);
      eventBus.emitEvent("task:update", task);

      const expirationTimer = setTimeout(() => {
        const pendingTask = activeTasks.get(task.id);
        if (pendingTask?.status !== "awaiting_approval" || !pendingTask.approvalExpiresAt || pendingTask.approvalExpiresAt > Date.now()) {
          return;
        }
        pendingTask.status = "expired";
        pendingTask.lifecycleState = "expired";
        pendingTask.error = "Approval expired. Submit the command again to request a fresh approval.";
        pendingTask.completedAt = Date.now();
        memoryPalace.recordTaskCheckpoint(pendingTask, plan.id);
        eventBus.emitEvent("audit:log", {
          id: `approval-expired-${Date.now()}`,
          timestamp: Date.now(),
          taskId: pendingTask.id,
          agent: pendingTask.agent,
          action: pendingTask.action,
          risk: pendingTask.risk || "medium",
          permission: "expired",
          status: "expired",
          details: "The one-time approval request expired before the user responded.",
        });
        eventBus.emitEvent("task:update", pendingTask);
        const parentPlan = activePlanMap.get(plan.id);
        if (parentPlan) void runPlan(parentPlan);
      }, Math.max(0, task.approvalExpiresAt - Date.now()));
      expirationTimer.unref?.();
      return;
    }

    // Snapshot the exact authorized operation before asynchronous lock waits.
    // Any mutation while queued invalidates this execution attempt.
    const executionActionId = task.action;
    const executionParamsJson = stableJson(resolvedParams);
    const executionRisk = task.risk;
    const executionAllowedToolsJson = stableJson(task.allowedTools || []);

    const locks = resolveTaskLocks(task);
    const acquiredLocks: string[] = [];
    const managedTestAction = task.action === "testing.run_incident_lab";
    let managedReservationCreated = false;
    let acquiredSlot = false;

    try {
      if (managedTestAction) {
        processSupervisor.reserve(task.id, task.action);
        managedReservationCreated = true;
      }
      const slotAcquired = await resourceLockManager.acquireSlot(task.id);
      if (!slotAcquired) return;
      acquiredSlot = true;
      for (const l of locks) {
        const lockAcquired = await resourceLockManager.acquireLock(l, task.id);
        if (!lockAcquired) return;
        if (resourceLockManager.getHeldLocks()[l] === task.id && !acquiredLocks.includes(l)) {
          acquiredLocks.push(l);
        }
        if (
          (task.status as string) === "cancelled" ||
          (task.status as string) === "termination_unconfirmed" ||
          (task.lifecycleState as string) === "cancel_requested"
        ) return;
      }
      if (
        (task.status as string) === "cancelled" ||
        (task.status as string) === "termination_unconfirmed" ||
        (task.lifecycleState as string) === "cancel_requested"
      ) return;
      const finalPermission = permissionGuard.check(task, false);
      const operationBindingChanged =
        task.action !== executionActionId ||
        stableJson(task.params || {}) !== executionParamsJson ||
        task.risk !== executionRisk ||
        stableJson(task.allowedTools || []) !== executionAllowedToolsJson;
      if (
        finalPermission === "blocked" ||
        finalPermission === "confirm" ||
        operationBindingChanged ||
        !matchesReviewedActionContract(task, resolvedParams)
      ) {
        throw new Error("Execution was blocked because authorization, arguments, target action, risk, or allowed tools changed before launch.");
      }
      const agent = agentRegistry[task.agent];
      if (!agent) {
        throw new Error(`Unknown agent: ${task.agent}`);
      }

      // Tool authorization policy verification
      if (agent.allowedTools && task.allowedTools && task.allowedTools.length > 0) {
        const unauthorized = task.allowedTools.filter((tool: string) => !agent.allowedTools.includes(tool));
        if (unauthorized.length > 0) {
          throw new Error(
            `Security violation: Agent '${task.agent}' is not authorized to use tool(s): ${unauthorized.join(", ")}`
          );
        }
      }

      const skill = task.skillName ? skillsRuntime.getSkill(task.skillName) : skillsRuntime.matchSkill(task.action);

      const agentTask: AgentTask = {
        taskId: task.id,
        parentTaskId: task.parentId,
        objective: task.action,
        action: task.action,
        params: resolvedParams,
        allowedTools: task.allowedTools || agent.allowedTools || [],
        dependsOn: task.dependsOn || [],
        acceptanceCriteria: task.acceptanceCriteria || (skill?.objective ? [skill.objective] : []),
        deadlineMs: 30000,
        context: [
          workingMemory.getSnapshot(),
          ...(skill ? [{ type: "skill_instructions", skill: skill.name, instructions: skill.instructions }] : []),
        ],
      };

      const result: any = await agent.execute(task.action, resolvedParams, {
        planId: plan.id,
        command: plan.command,
        workingMemory: workingMemory.getSnapshot(),
        task,
        agentTask,
      });

      if ((task.status as string) === "termination_unconfirmed" || task.verification?.outcome === "termination_unconfirmed") {
        // Cancellation requested but the supervisor could not prove that the
        // process tree stopped. Never downgrade this to cancelled/success.
        memoryPalace.recordTaskCheckpoint(task, plan.id);
        eventBus.emitEvent("task:update", task);
        return task;
      }
      if (isKillSwitchEngaged || (task.status as string) === "cancelled") {
        task.status = "cancelled";
        task.lifecycleState = "cancelled";
        task.error = task.error || "Operation was cancelled while the agent was running.";
        task.completedAt = Date.now();
        if (!(task.verification?.outcome === "cancelled" && task.verification?.verified === true)) {
          task.verification = {
            verified: false,
            postconditions: ["Cancellation was requested; termination proof is unavailable in this result."],
            exitCode: undefined,
            outcome: "cancelled",
          };
        }
        memoryPalace.recordTaskCheckpoint(task, plan.id);
        eventBus.emitEvent("task:update", task);
        return;
      }

      task.lifecycleState = "verifying";
      eventBus.emitEvent("task:update", task);

      let outcome = recordAgentResult(task, result);

      // Critic Evaluation
      const verdict = criticEngine.evaluate(task, skill);
      task.critic = verdict;
      if (!verdict.passed && outcome === "success") {
        outcome = "failed";
        task.error = task.error || verdict.feedback;
      } else if (!verdict.passed) {
        task.error = task.error || verdict.feedback;
      }
      if (verdict.proof) {
        task.evidence = [...(task.evidence || []), { description: verdict.proof, source: "critic", timestamp: new Date().toISOString() }];
      }

      // Structured execution events
      eventBus.emitEvent("tool.completed", {
        taskId: task.id,
        agentId: task.agent,
        tool: task.action,
        exitCode: task.verification?.exitCode ?? (outcome === "success" ? 0 : 1),
      });

      eventBus.emitEvent("verification.completed", {
        taskId: task.id,
        agentId: task.agent,
        verification: task.verification,
        passed: outcome === "success",
      });

      if (outcome !== "success") {
        task.status = outcome;
        task.lifecycleState = outcome;
        if (outcome === "failed") task.error = task.error || "Verification postconditions failed.";
        if (outcome === "failed") {
          eventBus.emitEvent("task.failed", { taskId: task.id, agentId: task.agent, error: task.error });
        }
      } else {
        task.status = "success";
        task.lifecycleState = "succeeded";
        eventBus.emitEvent("agent.completed", {
          taskId: task.id,
          agentId: task.agent,
          outcome: "succeeded",
          spokenSummary: task.spokenSummary,
        });
      }
      task.completedAt = Date.now();
      memoryPalace.recordTaskCheckpoint(task, plan.id);
      workingMemory.recordTaskResult(task);
    } catch (err) {
      task.status = "failed";
      task.lifecycleState = "failed";
      task.error = (err as Error).message;
      task.completedAt = Date.now();
      task.verification = {
        verified: false,
        postconditions: ["Task crashed during execution"],
        exitCode: 1,
        outcome: "failed",
      };
      eventBus.emitEvent("task.failed", { taskId: task.id, agentId: task.agent, error: task.error });
      memoryPalace.recordTaskCheckpoint(task, plan.id);
    } finally {
      if (managedTestAction && managedReservationCreated) {
        processSupervisor.releaseReservationIfUnused(task.id);
      }
      if ((task.status as string) !== "termination_unconfirmed" && task.verification?.outcome !== "termination_unconfirmed") {
        for (const l of acquiredLocks) resourceLockManager.releaseLock(l, task.id);
      }
      // A worker slot is a scheduler capacity token, not the resource itself;
      // the conflicting resource locks stay held for unresolved processes.
      if (acquiredSlot) resourceLockManager.releaseSlot();
    }

    eventBus.emitEvent("task:update", task);
  };

  while (
    [...tasks.values()].some(
      (t) =>
        t.status !== "success" &&
        t.status !== "failed" &&
        t.status !== "cancelled" &&
        t.status !== "partial" &&
        t.status !== "blocked" &&
        t.status !== "expired" &&
        t.status !== "awaiting_approval"
    )
  ) {
    const ready = nextTasks();
    if (!ready.length) break;
    // Execute ready tasks in parallel
    await Promise.all(ready.map(runTask));
  }

  for (const task of tasks.values()) {
    const dependencies = (task.dependsOn || []).map((id) => tasks.get(id));
    const dependencyFailed = dependencies.some((dependency) =>
      dependency && ["failed", "partial", "blocked", "cancelled", "expired", "termination_unconfirmed"].includes(dependency.status)
    );
    const missingDependency = (task.dependsOn || []).some((id) => !tasks.has(id));
    const waitingForApproval = dependencies.some((dependency) => dependency?.status === "awaiting_approval");
    const unresolvedDependency = dependencies.some((dependency) => dependency && dependency.status !== "success" && dependency.status !== "awaiting_approval");
    const orphanedPending = dependencies.length === 0 || dependencies.every((dependency) => dependency?.status === "success") === false;
    if (task.status === "pending" && !waitingForApproval && (dependencyFailed || missingDependency || unresolvedDependency || orphanedPending)) {
      task.status = "blocked";
      task.lifecycleState = "blocked";
      task.error = missingDependency
        ? "A declared prerequisite does not exist."
        : dependencyFailed
          ? "A prerequisite did not complete with verified success."
          : "Task remained unschedulable after dependency evaluation; no operation was executed.";
      task.completedAt = Date.now();
      task.verification = { verified: false, postconditions: [task.error], exitCode: 1, outcome: "blocked" };
      memoryPalace.recordTaskCheckpoint(task, plan.id);
      eventBus.emitEvent("task:update", task);
    }
  }

  // Check if all done
  const allTasks = [...tasks.values()];
  plan.tasks = allTasks;
  const allDone = allTasks.every(
    (t) => t.status === "success" || t.status === "failed" || t.status === "cancelled" || t.status === "partial" || t.status === "blocked" || t.status === "expired"
  );
  if (allDone) {
    plan.completedAt = Date.now();
    eventBus.emitEvent("plan:completed", plan);
  }

  return allTasks;
}
