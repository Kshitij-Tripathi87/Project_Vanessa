import { useEffect, useRef } from "react";
import { TaskStage, useVanessaStore } from "../stores/vanessaStore.js";
import { VanessaEvent } from "@vanessa/shared";

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
      return { stage: "completed", message: "Done — result verified." };
    case "failed":
    case "blocked":
    case "expired":
    case "partial":
      return { stage: "failed", message: "The task could not be fully completed." };
    case "cancelled":
    case "interrupted":
      return { stage: "cancelled", message: "Task stopped." };
    default:
      return null;
  }
}


export function useTaskStream() {
  const {
    updateTask,
    setPendingApproval,
    addAuditLog,
    setActivePlan,
    setVoiceState,
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
      switch (event.type) {
        case "task:update":
          updateTask(event.payload);
          setCurrentTaskId(event.payload.id);
          if (event.payload.requestId) setCurrentRequestId(event.payload.requestId);
          {
            const lifecycle = stageForStatus(event.payload.lifecycleState || event.payload.status);
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
          setTaskStage("cancelled", "You declined this action.");
          break;
        case "plan:created":
          setActivePlan(event.payload);
          setCurrentRequestId(event.payload.tasks?.find((task: any) => task.requestId)?.requestId || null);
          setTaskStage("planning", "Plan created. Preparing the next step.");
          setVoiceState("thinking");
          break;
        case "plan:started":
          setTaskStage("executing", "Working on it.");
          setVoiceState("executing");
          break;
        case "plan:completed":
          setTaskStage("completed", "Done — result verified.");
          setVoiceState("responding");
          break;
        case "task.failed":
          setTaskStage("failed", event.payload.error || "The task failed.");
          setVoiceState("error");
          break;
        case "task.cancelled":
          setTaskStage("cancelled", event.payload.reason || "Task stopped.");
          setVoiceState("interrupted");
          break;
        case "verification.completed":
          setTaskStage(event.payload.verified === false ? "failed" : "verifying", event.payload.verified === false ? "Verification failed." : "Checking the result.");
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
  }, [updateTask, setPendingApproval, addAuditLog, setActivePlan, setVoiceState, setTaskStage, setCurrentRequestId, setCurrentTaskId]);
}
