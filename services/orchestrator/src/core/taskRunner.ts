import { AgentTask, Plan, Task } from "@vanessa/shared";
import { eventBus } from "./eventBus.js";
import { permissionGuard } from "./permissionGuard.js";
import { agentRegistry } from "../agents/registry.js";
import { workingMemory } from "./workingMemory.js";

// Active in-memory map of running and paused tasks
export const activeTasks = new Map<string, Task>();
export const activePlanMap = new Map<string, Plan>();

let isKillSwitchEngaged = false;

export function triggerKillSwitch() {
  isKillSwitchEngaged = true;
  for (const task of activeTasks.values()) {
    if (task.status === "running" || task.status === "pending" || task.status === "awaiting_approval") {
      task.status = "cancelled";
      task.error = "Operation cancelled by emergency kill-switch";
      task.completedAt = Date.now();
      eventBus.emitEvent("task:update", task);
    }
  }
  eventBus.emitEvent("audit:log", {
    id: `kill-${Date.now()}`,
    timestamp: Date.now(),
    agent: "orchestrator",
    action: "kill_switch",
    status: "warn",
    details: "Emergency kill switch triggered. All active and pending tasks terminated.",
  });
  // Reset switch for future commands
  setTimeout(() => {
    isKillSwitchEngaged = false;
  }, 1000);
}

export function resolveParams(params: Record<string, any>, allTasks: Task[]): Record<string, any> {
  const serialized = JSON.stringify(params || {});
  const resolved = serialized.replace(
    /"\$([a-zA-Z0-9_]+)\.result\.(.+?)"/g,
    (_match, taskId, path) => {
      const parent = allTasks.find((t) => t.id === taskId);
      if (!parent?.result) {
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

  eventBus.emitEvent("approval:granted", { taskId });
  task.status = "running";
  task.startedAt = Date.now();
  eventBus.emitEvent("task:update", task);

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

    const agentTask: AgentTask = {
      taskId: task.id,
      parentTaskId: task.parentId,
      objective: task.action,
      action: task.action,
      params: resolvedParams,
      allowedTools: task.allowedTools || agent.allowedTools || [],
      dependsOn: task.dependsOn || [],
      acceptanceCriteria: task.acceptanceCriteria || [],
      deadlineMs: 30000,
      context: [workingMemory.getSnapshot()],
    };

    const result = await agent.execute(task.action, resolvedParams, {
      planId: plan.id,
      command: plan.command,
      workingMemory: workingMemory.getSnapshot(),
      task,
      agentTask,
    });

    if (result && typeof result === "object") {
      task.result = result.data !== undefined ? result.data : result;
      if (result.spokenSummary) {
        task.spokenSummary = result.spokenSummary;
      }
      if (result.evidence) {
        task.evidence = result.evidence;
      }
      if (result.artifacts) {
        task.artifacts = result.artifacts;
      }
      if (result.verification) {
        task.verification = result.verification;
      }
    } else {
      task.result = result;
    }
    task.status = "success";
    task.completedAt = Date.now();
    workingMemory.recordTaskResult(task);
  } catch (err) {
    task.status = "failed";
    task.error = (err as Error).message;
    task.completedAt = Date.now();
  }

  eventBus.emitEvent("task:update", task);
  return task;
}

export async function rejectTask(taskId: string): Promise<Task | null> {
  const task = activeTasks.get(taskId);
  if (!task || task.status !== "awaiting_approval") {
    return null;
  }
  task.status = "failed";
  task.error = "User declined confirmation.";
  task.completedAt = Date.now();
  eventBus.emitEvent("approval:rejected", { taskId });
  eventBus.emitEvent("task:update", task);
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
  isKillSwitchEngaged = false;
  activePlanMap.set(plan.id, plan);
  workingMemory.setActivePlan(plan);
  eventBus.emitEvent("plan:started", plan);

  const tasks = new Map<string, Task>(plan.tasks.map((t: Task) => [t.id, { ...t }]));
  for (const t of tasks.values()) {
    activeTasks.set(t.id, t);
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
      task.error = "Cancelled by kill switch";
      eventBus.emitEvent("task:update", task);
      return;
    }

    task.status = "running";
    task.startedAt = Date.now();
    eventBus.emitEvent("task:update", task);

    // Resolve dynamic parameter dependencies from completed tasks: "$<taskId>.result.<path>"
    const allTaskList = [...tasks.values()];
    const resolvedParams = resolveParams(task.params, allTaskList);
    task.params = resolvedParams;

    const permission = permissionGuard.check(task);
    if (permission === "blocked") {
      task.status = "failed";
      task.error = "Blocked by safety policy.";
      task.completedAt = Date.now();
      eventBus.emitEvent("task:update", task);
      return;
    }

    if (permission === "confirm") {
      task.status = "awaiting_approval";
      eventBus.emitEvent("approval:required", task);
      eventBus.emitEvent("task:update", task);
      return;
    }

    try {
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

      const agentTask: AgentTask = {
        taskId: task.id,
        parentTaskId: task.parentId,
        objective: task.action,
        action: task.action,
        params: resolvedParams,
        allowedTools: task.allowedTools || agent.allowedTools || [],
        dependsOn: task.dependsOn || [],
        acceptanceCriteria: task.acceptanceCriteria || [],
        deadlineMs: 30000,
        context: [workingMemory.getSnapshot()],
      };

      const result = await agent.execute(task.action, resolvedParams, {
        planId: plan.id,
        command: plan.command,
        workingMemory: workingMemory.getSnapshot(),
        task,
        agentTask,
      });

      if (result && typeof result === "object") {
        task.result = result.data !== undefined ? result.data : result;
        if (result.spokenSummary) {
          task.spokenSummary = result.spokenSummary;
        }
        if (result.evidence) {
          task.evidence = result.evidence;
        }
        if (result.artifacts) {
          task.artifacts = result.artifacts;
        }
        if (result.verification) {
          task.verification = result.verification;
        }
      } else {
        task.result = result;
      }
      task.status = "success";
      task.completedAt = Date.now();
      workingMemory.recordTaskResult(task);
    } catch (err) {
      task.status = "failed";
      task.error = (err as Error).message;
      task.completedAt = Date.now();
    }

    eventBus.emitEvent("task:update", task);
  };

  while (
    [...tasks.values()].some(
      (t) =>
        t.status !== "success" &&
        t.status !== "failed" &&
        t.status !== "cancelled" &&
        t.status !== "awaiting_approval"
    )
  ) {
    const ready = nextTasks();
    if (!ready.length) break;
    // Execute ready tasks in parallel
    await Promise.all(ready.map(runTask));
  }

  // Check if all done
  const allTasks = [...tasks.values()];
  const allDone = allTasks.every(
    (t) => t.status === "success" || t.status === "failed" || t.status === "cancelled"
  );
  if (allDone) {
    plan.completedAt = Date.now();
    eventBus.emitEvent("plan:completed", plan);
  }

  return allTasks;
}
