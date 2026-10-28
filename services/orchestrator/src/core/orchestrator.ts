import {
  CommandEnvelope,
  ExecuteCommandPayload,
  ExecuteCommandResult,
  Plan,
  SystemStatus,
  Task,
  createCommandRequest,
} from "@vanessa/shared";
import { planner } from "./planner.js";
import {
  activeTasks,
  approveTask as approveTaskRunner,
  rejectTask as rejectTaskRunner,
  runPlan,
  triggerKillSwitch,
  cancelTaskWithProof,
  type CancellationResolution,
} from "./taskRunner.js";
import { eventBus } from "./eventBus.js";
import { memoryPalace } from "../memory/memoryPalace.js";
import { narrator } from "./narrator.js";
import { formatLlmError } from "./llmDiagnostics.js";
import { modelRouter } from "./router.js";
import { cancelCodexTask } from "../agents/codex-task-runner.js";

export class VanessaOrchestrator {
  private requests = new Map<string, { controller: AbortController; plan?: Plan; updatedAt: number }>();

  async cancelRequest(requestId: string): Promise<{ cancelled: number; executionFinished: number; terminationUnconfirmed: number; planningOnly: boolean }> {
    let request = this.requests.get(requestId);
    if (!request) {
      // Keep a bounded, time-scoped cancellation tombstone. Otherwise a cancel
      // that arrives just before submit is forgotten and the same requestId can
      // start executing afterward.
      const controller = new AbortController();
      controller.abort();
      request = { controller, updatedAt: Date.now() };
      this.requests.set(requestId, request);
      return { cancelled: 0, executionFinished: 0, terminationUnconfirmed: 0, planningOnly: true };
    }
    request.controller.abort();
    const plannedTasks = request.plan?.tasks || [];
    const work: Promise<CancellationResolution>[] = [];
    for (const plannedTask of plannedTasks) {
      // runPlan owns cloned task records while execution is in flight.
      const activeTask = activeTasks.get(plannedTask.id);
      // Optional chaining made the equality true when both sides were undefined,
      // which allowed task to infer as possibly undefined.
      const task = activeTask && activeTask.parentId === request.plan?.id ? activeTask : plannedTask;
      if (!["pending", "running", "awaiting_approval", "termination_unconfirmed"].includes(task.status)) continue;
      work.push(cancelTaskWithProof(
        task,
        "Request cancellation was requested. Final state is based on process termination evidence."
      ));
    }
    const results = await Promise.all(work);
    return {
      cancelled: results.filter((result) => result === "cancelled").length,
      executionFinished: results.filter((result) => result === "execution_finished").length,
      terminationUnconfirmed: results.filter((result) => result === "termination_unconfirmed").length,
      planningOnly: plannedTasks.length === 0,
    };
  }
  constructor() {
    // Reconcile interrupted tasks from prior crashes on startup
    this.reconcileTasks();
  }

  reconcileTasks() {
    try {
      const summary = memoryPalace.reconcileInterruptedTasks();
      if (summary.requiresResolution.length > 0) {
        eventBus.emitEvent("audit:log", {
          id: `audit-${Date.now()}`,
          timestamp: Date.now(),
          agent: "orchestrator",
          action: "tasks.reconciliation_required",
          status: "warn",
          details: `Reconciliation: ${summary.requiresResolution.length} non-idempotent tasks require user resolution`,
        });
      }
    } catch {
      // ignore startup errors
    }
  }

  async executeCommand(payload: ExecuteCommandPayload): Promise<ExecuteCommandResult> {
    payload = createCommandRequest({ ...payload, source: payload.source || "desktop" });
    // Retain recent completed/approval requests for scoped cancellation, bounded
    // by the command envelope lifetime. Never cancel another desktop request.
    for (const [id, entry] of this.requests) {
      if (entry.updatedAt < Date.now() - 10 * 60_000) this.requests.delete(id);
    }
    const requestId = payload.requestId!;
    const existing = this.requests.get(requestId);
    if (existing) return this.executeAcceptedCommand(payload, existing);
    if (this.requests.size >= 1000) throw new Error("Too many recent requests; try again later.");
    const request = { controller: new AbortController(), updatedAt: Date.now() };
    this.requests.set(requestId, request);
    return this.executeAcceptedCommand(payload, request);
  }

  private async executeAcceptedCommand(payload: ExecuteCommandPayload, request: { controller: AbortController; plan?: Plan; updatedAt: number }): Promise<ExecuteCommandResult> {
    // Also normalize direct API/legacy callers, not just the two desktop clients.
    payload = createCommandRequest({ ...payload, source: payload.source || "desktop" });
    const { command, language = "en", sentiment, envelope, conversationContext = [] } = payload;
    const startTime = Date.now();
    const requestId = payload.requestId || envelope?.requestId;
    if (request.controller.signal.aborted) {
      const cancelled: ExecuteCommandResult = {
        status: "failed",
        requestId,
        spokenSummary: "Request cancelled before execution. No tasks were started.",
        verification: {
          verified: false,
          postconditions: ["The request was cancelled before task planning or execution."],
          outcome: "cancelled",
        },
      };
      eventBus.emitEvent("audit:log", {
        id: `request-cancelled-before-submit-${requestId}`,
        timestamp: startTime,
        agent: "orchestrator",
        action: "request.cancelled_before_submit",
        status: "cancelled",
        details: "A cancellation tombstone prevented a late or duplicate submission from starting planner work.",
      });
      return cancelled;
    }
    console.log(`[Orchestrator] received request=${requestId} source=${payload.source} characters=${command.length} historyTurns=${conversationContext.length}`);

    // 0. Desktop Durable Inbox: Validate schema, expiry and idempotency
    const idempotencyKey = payload.idempotencyKey || envelope?.idempotencyKey;
    if (idempotencyKey) {
      const envelopeRecord: CommandEnvelope = envelope || {
        requestId: `req-${Date.now()}`,
        idempotencyKey,
        originDeviceId: "desktop",
        command,
        createdAt: Date.now(),
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        schemaVersion: "0.3",
        source: payload.source || "desktop",
      };

      if (envelopeRecord.expiresAt && envelopeRecord.expiresAt < Date.now()) {
        return {
          status: "failed",
          spokenSummary: "Command rejected: Command envelope has expired.",
          requestId,
        };
      }

      const idemCheck = memoryPalace.checkAndRecordIdempotency(envelopeRecord);
      if (idemCheck.isDuplicate) {
        console.log(`[Orchestrator] duplicate request=${requestId} cached=${Boolean(idemCheck.cachedResult)} pending=${Boolean(idemCheck.isPending)}`);
        if (idemCheck.cachedResult) {
          return idemCheck.cachedResult;
        }
        if (idemCheck.isPending) {
          return {
            status: "accepted",
            spokenSummary: "Command is already being processed.",
            requestId,
          };
        }
      }
    }

    eventBus.emitEvent("audit:log", {
      id: `audit-${Date.now()}`,
      timestamp: startTime,
      agent: "orchestrator",
      action: "command_received",
      status: "info",
      details: { command, language, sentiment, requestId, idempotencyKey },
    });

    // 1. Generate task plan
    let plan: Plan;
    try {
      console.log(`[Planner] start request=${requestId}`);
      plan = await planner.createPlan(command, conversationContext, payload, request.controller.signal);
      console.log(`[Planner] ready request=${requestId} plan=${plan.id} elapsedMs=${Date.now() - startTime} tasks=${plan.tasks.map((task) => `${task.id}:${task.agent}/${task.action}`).join(",")}`);
    } catch (error) {
      const diagnostic = formatLlmError(error);
      console.error(`[Planner] failed request=${requestId} elapsedMs=${Date.now() - startTime} error=${diagnostic}; no tasks started.`);
      const result: ExecuteCommandResult = {
        status: "failed",
        requestId,
        spokenSummary: request.controller.signal.aborted
          ? "Request cancelled before execution. No tasks were started."
          : `I couldn't create a valid plan with ${modelRouter.activeProvider}. No tasks were started. Check the selected planner provider or try again.`,
        verification: {
          verified: false,
          postconditions: ["Planning failed before task execution."],
          outcome: "failed",
        },
      };
      eventBus.emitEvent("audit:log", {
        id: `planning-failed-${Date.now()}`,
        timestamp: Date.now(),
        agent: "orchestrator",
        action: "planning.failed",
        status: "error",
        details: `${modelRouter.activeProvider} planning ${request.controller.signal.aborted ? "cancelled" : "failed"}; request=${requestId} error=${diagnostic}; no task execution or keyword fallback was attempted.`,
      });
      if (idempotencyKey) memoryPalace.completeIdempotentCommand(idempotencyKey, "failed", result);
      return result;
    }

    // 2. Execute plan through parallel DAG task runner
    request.plan = plan;
    if (request.controller.signal.aborted) await this.cancelRequest(requestId!);
    const tasks = await runPlan(plan);
    plan.tasks = tasks;

    // 3. Inspect results to build spoken response
    const pendingApproval = tasks.filter((t) => t.status === "awaiting_approval");
    const failedTasks = tasks.filter((t) => t.status === "failed");
    const partialTasks = tasks.filter((t) => ["partial", "blocked", "expired", "cancelled", "termination_unconfirmed", "pending", "running", "planning", "cancel_requested"].includes(t.status));
    const successTasks = tasks.filter((t) => t.status === "success");

    let status: ExecuteCommandResult["status"] = "success";
    let spokenSummary = "";

    if (pendingApproval.length > 0) {
      status = "awaiting_approval";
      spokenSummary = narrator.narrateOutcome(command, tasks, language, sentiment);
    } else if (failedTasks.length > 0) {
      status = "failed";
      spokenSummary = narrator.narrateOutcome(command, tasks, language, sentiment);
    } else if (partialTasks.length > 0) {
      status = "partial";
      spokenSummary = narrator.narrateOutcome(command, tasks, language, sentiment);
    } else {
      status = "success";
      spokenSummary = this.generateSuccessSummary(command, successTasks, language, sentiment);
    }

    // Persist completed task and plan to SQLite Memory Palace (30-day retention)
    memoryPalace.storeMemory({
      type: "plan",
      title: command,
      content: spokenSummary,
      rawData: {
        planId: plan.id,
        tasks: tasks.map((t) => ({ id: t.id, action: t.action, status: t.status, summary: t.spokenSummary })),
        status,
      },
      agent: "orchestrator",
      status: status === "failed" || status === "partial" ? "failed" : "success",
      ttlDays: 30,
    });

    const finalResult: ExecuteCommandResult = {
      status,
      spokenSummary,
      requestId,
      planId: plan.id,
      plan,
      pendingTasks: pendingApproval,
      sentiment,
      verification: {
        verified: status === "success",
        postconditions: tasks.map((task) => task.verification?.details || task.verification?.postconditions?.[0] || `${task.action}: ${task.status}`),
        outcome: status === "success" ? "succeeded" : status === "partial" ? "partial" : status === "failed" ? "failed" : "partial",
        details: `Verified ${tasks.filter((task) => task.verification?.verified).length} of ${tasks.length} task(s).`,
      },
    };

    if (idempotencyKey) {
      memoryPalace.completeIdempotentCommand(idempotencyKey, status, finalResult);
    }

    console.log(`[Orchestrator] response request=${requestId} plan=${plan.id} status=${status} awaitingApproval=${pendingApproval.length} elapsedMs=${Date.now() - startTime}`);
    return finalResult;
  }

  async approve(taskId: string): Promise<Task | null> {
    return approveTaskRunner(taskId);
  }

  async reject(taskId: string): Promise<Task | null> {
    return rejectTaskRunner(taskId);
  }

  cancelAll(): Promise<void> {
    return triggerKillSwitch();
  }

  getSystemStatus(): SystemStatus {
    const activeTasksCount = [...activeTasks.values()].filter(
      (t) => t.status === "running" || t.status === "pending" || t.status === "awaiting_approval" || t.status === "termination_unconfirmed"
    ).length;

    return {
      orchestratorOnline: true,
      activeVoiceProvider: (process.env.VOICE_TTS_PROVIDER || process.env.VOICE_PROVIDER || "fish") as any,
      activeTasksCount,
      platform: process.platform as any,
      timestamp: Date.now(),
    };
  }

  private generateSuccessSummary(command: string, successTasks: Task[], language: string, sentiment?: any): string {
    const lower = command.toLowerCase();
    const prefix = sentiment?.urgency === "critical" ? "Immediate status: " : sentiment?.emotion === "frustrated" ? "Understood. " : "";

    if (successTasks.some((task) => task.action === "codex.open")) {
      return `${prefix}${successTasks.map((task) => task.spokenSummary || `${task.action} returned a result.`).join(" ")}`;
    }

    if (language === "hi" || language === "hinglish") {
      if (lower.includes("wifi") || lower.includes("wi-fi")) {
        return `${prefix}Wi-Fi adapter restart ho gaya hai aur YouTube open kar diya hai.`;
      }
      if (lower.includes("bluetooth")) {
        return `${prefix}Bluetooth on kar diya hai aur tasks run ho gaye hain.`;
      }
      return `${prefix}Aapka task complete ho gaya hai.`;
    }

    if (successTasks.length === 1) {
      const t = successTasks[0];
      if (t.result?.content) return `${prefix}${t.result.content}`;
      if (t.spokenSummary) return `${prefix}${t.spokenSummary}`;
      if (t.action.includes("wifi")) return `${prefix}Wi-Fi adapter has been restarted and connectivity is verified.`;
      if (t.action.includes("youtube")) return `${prefix}Opened YouTube and started playback.`;
      if (t.action.includes("claude")) return `${prefix}Claude Code has been started in your terminal.`;
      if (t.action.includes("drive")) return `${prefix}Report uploaded to Google Drive. The share link is ready.`;
      if (t.action.includes("schedule")) return `${prefix}Everyday task schedule has been registered in Vanessa.`;
      if (t.action.includes("memory")) return `${prefix}Saved to Vanessa persistent memory.`;
      if (t.action.includes("vanessa") || t.action.includes("jarvis")) return `${prefix}Vanessa completed the system action successfully.`;
    }

    const agentSummaries = successTasks.map((t) => t.spokenSummary).filter(Boolean);
    if (agentSummaries.length > 0) {
      return `${prefix}${agentSummaries.join(" ")}`;
    }

    if (successTasks.length > 1) {
      const actions = successTasks.map((t) => t.action.split(".")[1] || t.action);
      return `${prefix}Done. Successfully completed ${actions.join(" and ")}.`;
    }

    return `${prefix}No verifiable completion summary is available. Check the task evidence and final statuses before treating this request as complete.`;
  }
}

export const orchestrator = new VanessaOrchestrator();
