import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("vanessa", {
  executeCommand: (payload: { command: string; language?: string }) =>
    ipcRenderer.invoke("vanessa:execute-command", payload),

  approveTask: (taskId: string) =>
    ipcRenderer.invoke("vanessa:approve-task", taskId),

  rejectTask: (taskId: string) =>
    ipcRenderer.invoke("vanessa:reject-task", taskId),

  cancelTask: (taskId?: string) =>
    ipcRenderer.invoke("vanessa:cancel-task", taskId),

  onEvent: (callback: (event: any) => void) => {
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
