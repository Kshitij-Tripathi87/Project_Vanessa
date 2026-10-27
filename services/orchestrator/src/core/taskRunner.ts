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
import { resolveManagedAction } from "./actionRegistry.js";
import { createHash } from "node:crypto";
import * as path from "node:path";
export { recordAgentResult } from "./agentResult.js";

// Active in-memory map of running and paused tasks
export const activeTasks = new Map<string, Task>();
export const activePlanMap = new Map<string, Plan>();

let isKillSwitchEngaged = false;

const APPROVAL_POLICY_VERSION = "trustworthy-execution-v1";

function stableJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeApprovalDigest(task: Task, expiresAt: number): string {
  const params = task.params || {};
  const managed = resolveManagedAction(task.action, params);
  const binding = {
    policyVersion: APPROVAL_POLICY_VERSION,
    taskId: task.id,
    actionId: task.action,
    normalizedArgs: params,
    target: params.workspacePath || params.worktreePath || params.workspaceId || params.targetPath ||
      params.path || params.deviceId || params.resource || task.agent,
    baseCommit: params.baseCommit || params.expectedBaseCommit || null,
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


export async function cancelTaskWithProof(task: Task, reason: string): Promise<"cancelled" | "termination_unconfirmed"> {
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
    const result = await processSupervisor.cancel(task.id);
    const stopped = Boolean(result && (
      (result.status === "cancelled" && result.terminationVerified === true) ||
      (result.status === "timed_out" && result.terminationVerified === true) ||
      result.status === "exited"
    ));
    if (!stopped) {
      markTerminationUnconfirmed(
        task,
        result?.error || "Vanessa cannot prove this task's process tree has stopped. Conflicting resource locks remain held."
      );
      return "termination_unconfirmed";
    }

    task.status = "cancelled";
    task.lifecycleState = "cancelled";
    task.error = reason;
    task.completedAt = Date.now();
    task.verification = {
      verified: true,
      postconditions: ["Process supervisor confirmed the managed process stopped."],
      exitCode: result?.exitCode ?? undefined,
      outcome: "cancelled",
      details: `Process status: ${result?.status}; cancellation verified.`,
    };
    resourceLockManager.releaseAllForTask(task.id);
    memoryPalace.recordTaskCheckpoint(task, task.parentId);
    eventBus.emitEvent("task.cancelled", { taskId: task.id, agentId: task.agent, reason });
    eventBus.emitEvent("task:update", task);
    return "cancelled";
  } catch (error: any) {
    markTerminationUnconfirmed(
      task,
      `Termination could not be verified: ${typeof error?.message === "string" ? error.message : "unknown error"}`
    );
    return "termination_unconfirmed";
  }
}

export async function triggerKillSwitch(): Promise<void> {
  isKillSwitchEngaged = true;
  const checks: Promise<"cancelled" | "termination_unconfirmed">[] = [];
  for (const task of activeTasks.values()) {
    if (["running", "pending", "awaiting_approval", "termination_unconfirmed"].includes(task.status)) {
      checks.push(cancelTaskWithProof(task, "Cancellation requested by emergency kill switch."));
    }
  }
  const results = await Promise.all(checks);
  const unconfirmed = results.filter((result) => result === "termination_unconfirmed").length;
  eventBus.emitEvent("audit:log", {
    id: `kill-${Date.now()}`,
    timestamp: Date.now(),
    agent: "orchestrator",
    action: "kill_switch",
    status: unconfirmed ? "warn" : "success",
    details: unconfirmed
      ? `Emergency kill switch completed with ${unconfirmed} unconfirmed process termination(s). Locks were retained; new work remains blocked.`
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
  const currentApprovalDigest = task.approvalExpiresAt
    ? computeApprovalDigest(task, task.approvalExpiresAt)
    : "";
  const approvalInvalid = !task.approvalDigest ||
    task.approvalPolicyVersion !== APPROVAL_POLICY_VERSION ||
    task.approvalConsumedAt !== undefined ||
    currentApprovalDigest !== task.approvalDigest;
  if (isKillSwitchEngaged || !dependenciesReady || permission === "blocked" || approvalInvalid) {
    task.status = isKillSwitchEngaged ? "cancelled" : "blocked";
    task.lifecycleState = isKillSwitchEngaged ? "cancelled" : "blocked";
    task.error = isKillSwitchEngaged
      ? "Approval cancelled by emergency kill switch."
      : !dependenciesReady
      ? "Approval expired because prerequisite tasks are not verified as successful."
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

    await resourceLockManager.acquireSlot();
    acquiredSlot = true;
    for (const l of locks) {
      await resourceLockManager.acquireLock(l, task.id);
      acquiredLocks.push(l);
    }

    // Cancellation may arrive while waiting for a slot/lock.
    if (task.status === "cancelled" || task.status === "termination_unconfirmed") return task;
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

    const result = await agent.execute(task.action, resolvedParams, {
        planId: plan.id,
        command: plan.command,
        workingMemory: workingMemory.getSnapshot(),
        task,
        agentTask,
      });

      if (task.status === "termination_unconfirmed" || task.verification?.outcome === "termination_unconfirmed") {
        // Do not overwrite an unresolved process state with a convenient terminal status.
        memoryPalace.recordTaskCheckpoint(task, plan.id);
        eventBus.emitEvent("task:update", task);
        return;
      }
      if (isKillSwitchEngaged || (task.status as string) === "cancelled") {
        task.status = "cancelled";
        task.lifecycleState = "cancelled";
        task.error = task.error || "Operation was cancelled while the agent was running.";
        task.completedAt = Date.now();
        task.verification = { verified: false, postconditions: ["Execution was cancelled before verification."], exitCode: undefined, outcome: "cancelled" };
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
    if (task.verification?.outcome !== "termination_unconfirmed" && task.status !== "termination_unconfirmed") {
      for (const l of acquiredLocks) {
        resourceLockManager.releaseLock(l, task.id);
      }
    }
    if (acquiredSlot) resourceLockManager.releaseSlot();
  }

  eventBus.emitEvent("task:update", task);
  const parentPlan = activePlanMap.get(task.parentId || "");
  if (parentPlan && (task.status === "success" || task.status === "partial" || task.status === "failed" || task.status === "expired")) {
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
  return "All requested tasks have completed successfully.";
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
    if (permission === "blocked") {
      task.status = "blocked";
      task.lifecycleState = "blocked";
      task.error = "Blocked by the canonical execution policy. No process was started.";
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
      task.approvalDigest = computeApprovalDigest(task, task.approvalExpiresAt);
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

    await resourceLockManager.acquireSlot();
    const locks = resolveTaskLocks(task);
    for (const l of locks) {
      await resourceLockManager.acquireLock(l, task.id);
    }

    try {
      if ((task.status as string) === "cancelled") return;
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

      const result = await agent.execute(task.action, resolvedParams, {
        planId: plan.id,
        command: plan.command,
        workingMemory: workingMemory.getSnapshot(),
        task,
        agentTask,
      });

      if (task.status === "termination_unconfirmed" || task.verification?.outcome === "termination_unconfirmed") {
        // Cancellation requested but the supervisor could not prove that the
        // process tree stopped. Never downgrade this to cancelled/success.
        memoryPalace.recordTaskCheckpoint(task, plan.id);
        eventBus.emitEvent("task:update", task);
        return;
      }
      if (isKillSwitchEngaged || (task.status as string) === "cancelled") {
        task.status = "cancelled";
        task.lifecycleState = "cancelled";
        task.error = task.error || "Operation was cancelled while the agent was running.";
        task.completedAt = Date.now();
        task.verification = {
          verified: false,
          postconditions: ["Cancellation was requested. Process termination is only verified when the supervisor has supplied termination evidence."],
          exitCode: undefined,
          outcome: "cancelled",
        };
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
      if (task.status !== "termination_unconfirmed" && task.verification?.outcome !== "termination_unconfirmed") {
        for (const l of locks) {
          resourceLockManager.releaseLock(l, task.id);
        }
      }
      // A worker slot is a scheduler capacity token, not the resource itself;
      // the conflicting resource locks stay held for unresolved processes.
      resourceLockManager.releaseSlot();
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
      dependency && ["failed", "partial", "blocked", "cancelled", "expired"].includes(dependency.status)
    );
    const missingDependency = (task.dependsOn || []).some((id) => !tasks.has(id));
    if (task.status === "pending" && (dependencyFailed || missingDependency)) {
      task.status = "blocked";
      task.lifecycleState = "blocked";
      task.error = "A prerequisite did not complete with verified success.";
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
