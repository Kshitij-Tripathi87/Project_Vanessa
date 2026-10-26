import { useEffect, useRef } from "react";
import { TaskStage, useVanessaStore } from "../stores/vanessaStore.js";
import type { Plan, Task, VanessaEvent } from "@vanessa/shared";

function stageForStatus(status: string): { stage: TaskStage; message: string } | null {
  switch (status) {
    case "received":
    case "accepted":
      return { stage: "accepted", message: "Request received." };
    case "planning":
      return { stage: "planning", message: "Working out the safest way to help." };
    case "pending":
    case "queued":
    case "running":
      return { stage: "executing", message: "Working on it." };
    case "awaiting_approval":
      return { stage: "executing", message: "I need your approval before continuing." };
    case "verifying":
      return { stage: "verifying", message: "Checking that the result is real." };
    case "success":
    case "succeeded":
      return { stage: "verifying", message: "Step finished. Checking the overall result." };
    case "failed":
    case "blocked":
    case "expired":
    case "partial":
      return { stage: "executing", message: "A step needs attention. Checking the overall result." };
    case "cancelled":
    case "interrupted":
      return { stage: "cancelled", message: "Task stopped." };
    default:
      return null;
  }
}


function terminalPlanOutcome(planValue: unknown): { stage: TaskStage; message: string; approval: Task | null } {
  const plan = planValue as Plan | null;
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  if (tasks.length === 0) return { stage: "failed", message: "Task ended without a verifiable result.", approval: null };
  const stateOf = (task: Task) => {
    if (["success", "succeeded", "failed", "partial", "blocked", "expired", "cancelled", "interrupted", "awaiting_approval"].includes(task.status)) return task.status;
    return task.lifecycleState || task.status;
  };
  const approval = tasks.find((task) => stateOf(task) === "awaiting_approval") || null;
  if (approval) return { stage: "executing", message: "I need your approval before continuing.", approval };
  const states = tasks.map(stateOf);
  if (states.every((status) => status === "cancelled" || status === "interrupted")) {
    return { stage: "cancelled", message: "Task stopped.", approval: null };
  }
  const incomplete = tasks.filter((task) => !["success", "succeeded"].includes(stateOf(task)));
  const unverified = tasks.filter((task) => ["success", "succeeded"].includes(stateOf(task)) && task.verification?.verified !== true);
  if (incomplete.length > 0) {
    const hasSuccess = tasks.some((task) => ["success", "succeeded"].includes(stateOf(task)));
    const hasPartial = states.some((status) => status === "partial");
    if (hasSuccess || hasPartial) return { stage: "partial", message: "Partially completed. Review the task results.", approval: null };
    return { stage: "failed", message: "The task did not complete successfully.", approval: null };
  }
  if (unverified.length > 0) return { stage: "failed", message: "The action finished, but verification evidence is missing.", approval: null };
  return { stage: "completed", message: "Done — result verified.", approval: null };
}

export function useTaskStream() {
  const {
    updateTask,
    setPendingApproval,
    addAuditLog,
    setActivePlan,
    setTaskStage,
    setCurrentRequestId,
    setCurrentTaskId,
  } =
    useVanessaStore();
  const seenEvents = useRef(new Set<string>());

  useEffect(() => {
    if (!window.vanessa?.onEvent) return;

    const unsubscribe = window.vanessa.onEvent((event: VanessaEvent) => {
      if (event.eventId) {
        if (seenEvents.current.has(event.eventId)) return;
        seenEvents.current.add(event.eventId);
        if (seenEvents.current.size > 1000) {
          const oldest = seenEvents.current.values().next().value;
          if (oldest) seenEvents.current.delete(oldest);
        }
      }
      if (event.requestId) setCurrentRequestId(event.requestId);
      switch (event.type) {
        case "task:update":
          updateTask(event.payload);
          setCurrentTaskId(event.payload.id);
          if (event.payload.requestId) setCurrentRequestId(event.payload.requestId);
          {
            const status = ["success", "succeeded", "failed", "partial", "blocked", "expired", "cancelled", "interrupted", "awaiting_approval"].includes(event.payload.status)
              ? event.payload.status
              : event.payload.lifecycleState || event.payload.status;
            const lifecycle = stageForStatus(status);
            if (lifecycle) setTaskStage(lifecycle.stage, lifecycle.message);
          }
          break;
        case "approval:required":
          setPendingApproval(event.payload);
          setCurrentTaskId(event.payload.id);
          if (event.payload.requestId) setCurrentRequestId(event.payload.requestId);
          setTaskStage("executing", "I need your approval before continuing.");
          break;
        case "approval:granted":
          setTaskStage("executing", "Approval received. Continuing the task.");
          setPendingApproval(null);
          break;
        case "approval:rejected":
          setPendingApproval(null);
          setTaskStage("executing", "Action declined. Checking the remaining work.");
          break;
        case "plan:created":
          setActivePlan(event.payload);
          setTaskStage("planning", "Plan created. Preparing the next step.");
          break;
        case "plan:started":
          setTaskStage("executing", "Working on it.");
          break;
        case "plan:completed": {
          const outcome = terminalPlanOutcome(event.payload);
          setTaskStage(outcome.stage, outcome.message);
          setPendingApproval(outcome.approval);
          break;
        }
        case "task.failed":
          setTaskStage("executing", "A step failed. Checking the overall result.");
          break;
        case "task.cancelled":
          setTaskStage("cancelled", event.payload.reason || "Task stopped.");
          break;
        case "verification.completed":
          setTaskStage(event.payload.verified === false ? "executing" : "verifying", event.payload.verified === false ? "A step did not pass verification. Checking remaining work." : "Checking the result.");
          break;
        case "audit:log":
          addAuditLog(event.payload);
          break;
        default:
          break;
      }
    });

    return () => {
      unsubscribe();
    };
  }, [updateTask, setPendingApproval, addAuditLog, setActivePlan, setTaskStage, setCurrentRequestId, setCurrentTaskId]);
}
