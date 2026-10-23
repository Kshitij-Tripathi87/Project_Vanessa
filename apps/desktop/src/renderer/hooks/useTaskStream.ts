import { useEffect } from "react";
import { useVanessaStore } from "../stores/vanessaStore.js";
import { VanessaEvent } from "@vanessa/shared";


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
