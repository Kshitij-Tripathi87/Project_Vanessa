import { useEffect } from "react";
import { useVanessaStore } from "../stores/vanessaStore.js";
import { VanessaEvent } from "@vanessa/shared";

declare global {
  interface Window {
    vanessa: {
      executeCommand: (payload: { command: string; language?: string }) => Promise<any>;
      approveTask: (taskId: string) => Promise<any>;
      rejectTask: (taskId: string) => Promise<any>;
      cancelTask: (taskId?: string) => Promise<any>;
      onEvent: (callback: (event: VanessaEvent) => void) => () => void;
      onTriggerPTT?: (callback: () => void) => () => void;
      onTriggerCancel?: (callback: () => void) => () => void;
      resizeWindow?: (size: { width: number; height: number }) => Promise<any>;
      dockCorner?: (corner: "top-left" | "top-right" | "bottom-left" | "bottom-right") => Promise<any>;
      minimizeWindow?: () => Promise<any>;
      closeWindow?: () => Promise<any>;
    };
  }
}

export function useTaskStream() {
  const { updateTask, setPendingApproval, addAuditLog, setActivePlan, setVoiceState } =
    useVanessaStore();

  useEffect(() => {
    if (!window.vanessa?.onEvent) return;

    const unsubscribe = window.vanessa.onEvent((event: VanessaEvent) => {
      switch (event.type) {
        case "task:update":
          updateTask(event.payload);
          break;
        case "approval:required":
          setPendingApproval(event.payload);
          break;
        case "approval:granted":
        case "approval:rejected":
          setPendingApproval(null);
          break;
        case "plan:created":
          setActivePlan(event.payload);
          setVoiceState("executing");
          break;
        case "plan:completed":
          setVoiceState("idle");
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
  }, [updateTask, setPendingApproval, addAuditLog, setActivePlan, setVoiceState]);
}
