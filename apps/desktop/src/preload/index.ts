import { contextBridge, ipcRenderer } from "electron";
import type { ExecuteCommandPayload, VanessaEvent } from "@vanessa/shared";

contextBridge.exposeInMainWorld("vanessa", {
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

  remoteV2Status: () => ipcRenderer.invoke("vanessa:remote-v2-status"),
  remoteV2CreatePairing: () => ipcRenderer.invoke("vanessa:remote-v2-create-pairing"),
  remoteV2PendingPairings: () => ipcRenderer.invoke("vanessa:remote-v2-pending-pairings"),
  remoteV2ApprovePairing: (input: { pairingId: string; grantedScopes: string[] }) =>
    ipcRenderer.invoke("vanessa:remote-v2-approve-pairing", input),
  remoteV2RejectPairing: (pairingId: string) =>
    ipcRenderer.invoke("vanessa:remote-v2-reject-pairing", pairingId),
  remoteV2Devices: () => ipcRenderer.invoke("vanessa:remote-v2-devices"),
  remoteV2RevokeDevice: (deviceId: string) =>
    ipcRenderer.invoke("vanessa:remote-v2-revoke-device", deviceId),

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
