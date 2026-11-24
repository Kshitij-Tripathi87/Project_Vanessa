import { contextBridge, ipcRenderer } from "electron";
import type { ExecuteCommandPayload, VanessaEvent } from "@vanessa/shared";
import type { PersistedConversationState } from "@vanessa/protocol/conversation";

contextBridge.exposeInMainWorld("vanessa", {
  loadConversationHistory: () => ipcRenderer.invoke("vanessa:conversation-load"),
  saveConversationHistory: (state: PersistedConversationState, revision: number) =>
    ipcRenderer.invoke("vanessa:conversation-save", state, revision),
  clearConversationHistory: (revision: number) => ipcRenderer.invoke("vanessa:conversation-clear", revision),
  onHistoryFlushRequest: (callback: () => Promise<boolean>) => {
    const handler = async (_event: unknown, nonce: unknown) => {
      if (typeof nonce !== "string" || !/^[0-9a-f-]{36}$/.test(nonce)) return;
      let ok = false;
      try { ok = await callback() === true; } catch { /* report an undrained session */ }
      ipcRenderer.send("vanessa:history-flush-result", nonce, ok);
    };
    ipcRenderer.on("vanessa:history-flush-request", handler);
    return () => ipcRenderer.removeListener("vanessa:history-flush-request", handler);
  },
  onHistoryFlushCancelled: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("vanessa:history-flush-cancelled", handler);
    return () => ipcRenderer.removeListener("vanessa:history-flush-cancelled", handler);
  },

  executeCommand: (payload: ExecuteCommandPayload) =>
    ipcRenderer.invoke("vanessa:execute-command", payload),

  approveTask: (taskId: string) =>
    ipcRenderer.invoke("vanessa:approve-task", taskId),

  rejectTask: (taskId: string) =>
    ipcRenderer.invoke("vanessa:reject-task", taskId),

  cancelTask: (requestId?: string) =>
    ipcRenderer.invoke("vanessa:cancel-task", requestId),

  getMobileAudit: (limit?: number) =>
    ipcRenderer.invoke("vanessa:get-mobile-audit", limit),

  onEvent: (callback: (event: VanessaEvent) => void) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on("vanessa:event", handler);
    return () => {
      ipcRenderer.removeListener("vanessa:event", handler);
    };
  },

  onTriggerPTT: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("vanessa:trigger-ptt", handler);
    return () => {
      ipcRenderer.removeListener("vanessa:trigger-ptt", handler);
    };
  },

  onTriggerCancel: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("vanessa:trigger-cancel", handler);
    return () => {
      ipcRenderer.removeListener("vanessa:trigger-cancel", handler);
    };
  },

  resizeWindow: (size: { width: number; height: number }) =>
    ipcRenderer.invoke("vanessa:resize-window", size),

  dockCorner: (corner: "top-left" | "top-right" | "bottom-left" | "bottom-right") =>
    ipcRenderer.invoke("vanessa:dock-corner", corner),

  minimizeWindow: () => ipcRenderer.invoke("vanessa:minimize-window"),

  closeWindow: () => ipcRenderer.invoke("vanessa:close-window"),
});
