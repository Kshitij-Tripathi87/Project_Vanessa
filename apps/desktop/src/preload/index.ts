import { contextBridge, ipcRenderer } from "electron";
import type { DockPosition, ExecuteCommandPayload } from "@vanessa/shared";

contextBridge.exposeInMainWorld("vanessa", {
  getControlStatus: () => ipcRenderer.invoke("vanessa:get-control-status"),
  addAllowedFolder: (folderPath: string) => ipcRenderer.invoke("vanessa:add-allowed-folder", folderPath),
  executeCommand: (payload: ExecuteCommandPayload) => ipcRenderer.invoke("vanessa:execute-command", payload),
  approveTask: (taskId: string) => ipcRenderer.invoke("vanessa:approve-task", taskId),
  rejectTask: (taskId: string) => ipcRenderer.invoke("vanessa:reject-task", taskId),
  cancelTask: (taskId?: string) => ipcRenderer.invoke("vanessa:cancel-task", taskId),
  onEvent: (callback: (event: any) => void) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on("vanessa:event", handler);
    return () => ipcRenderer.removeListener("vanessa:event", handler);
  },
  onTriggerPTT: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("vanessa:trigger-ptt", handler);
    return () => ipcRenderer.removeListener("vanessa:trigger-ptt", handler);
  },
  onTriggerCancel: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("vanessa:trigger-cancel", handler);
    return () => ipcRenderer.removeListener("vanessa:trigger-cancel", handler);
  },
  onOpenChat: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("vanessa:open-chat", handler);
    return () => ipcRenderer.removeListener("vanessa:open-chat", handler);
  },
  resizeWindow: (size: { width: number; height: number }) => ipcRenderer.invoke("vanessa:resize-window", size),
  getDockPosition: () => ipcRenderer.invoke("vanessa:get-dock-position"),
  dockCorner: (position: DockPosition) => ipcRenderer.invoke("vanessa:dock-corner", position),
  showWindow: () => ipcRenderer.invoke("vanessa:show-window"),
  minimizeWindow: () => ipcRenderer.invoke("vanessa:minimize-window"),
  closeWindow: () => ipcRenderer.invoke("vanessa:close-window"),
});
