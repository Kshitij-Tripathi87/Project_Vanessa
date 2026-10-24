import { app, ipcMain, BrowserWindow, screen } from "electron";
import WebSocket from "ws";
import * as path from "node:path";
import type { DockPosition, ExecuteCommandPayload } from "@vanessa/shared";
import { calculateDockPosition, isDockPosition, readDockPosition, writeDockPosition } from "./docking.js";

// The Electron main build is CommonJS; load the ESM shared package once.
const commandClient = import("@vanessa/shared");

const getOrchestratorUrl = () => process.env.ORCHESTRATOR_URL || ("http://127.0.0.1:" + (process.env.VANESSA_PORT || "4139"));
const getOrchestratorWsUrl = () => process.env.ORCHESTRATOR_WS || ("ws://127.0.0.1:" + (process.env.VANESSA_PORT || "4139") + "/events");
const WINDOW_MARGIN = 16;

let wsClient: WebSocket | null = null;

export function registerIpcHandlers(mainWindow: BrowserWindow) {
  const settingsPath = path.join(app.getPath("userData"), "dock-preference.json");
  let dockPosition: DockPosition = readDockPosition(settingsPath, "bottom-right");

  const redock = () => {
    if (mainWindow.isDestroyed()) return;
    const display = screen.getDisplayMatching(mainWindow.getBounds());
    const [width, height] = mainWindow.getSize();
    const position = calculateDockPosition(display.workArea, [width, height], dockPosition, WINDOW_MARGIN);
    mainWindow.setPosition(position.x, position.y, true);
    return position;
  };

  ipcMain.handle("vanessa:execute-command", async (_, payload: ExecuteCommandPayload) => {
    try {
      const { submitCommandRequest } = await commandClient;
      return await submitCommandRequest(getOrchestratorUrl(), {
        ...payload,
        source: "desktop",
        originDeviceId: process.env.VANESSA_DEVICE_ID || "desktop-local",
      });
    } catch (err: any) {
      return { status: "failed", spokenSummary: "Connection to orchestrator failed: " + err.message };
    }
  });

  ipcMain.handle("vanessa:approve-task", async (_, taskId: string) => {
    try {
      const res = await fetch(getOrchestratorUrl() + "/api/approve", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskId }),
      });
      return await res.json();
    } catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle("vanessa:reject-task", async (_, taskId: string) => {
    try {
      const res = await fetch(getOrchestratorUrl() + "/api/reject", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskId }),
      });
      return await res.json();
    } catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle("vanessa:cancel-task", async () => {
    try {
      const res = await fetch(getOrchestratorUrl() + "/api/cancel", { method: "POST", headers: { "Content-Type": "application/json" } });
      return await res.json();
    } catch (err: any) { return { success: false, error: err.message }; }
  });

  ipcMain.handle("vanessa:resize-window", (_, payload: { width: number; height: number }) => {
    if (mainWindow.isDestroyed()) return { success: false };
    const width = Math.max(90, Math.min(760, Math.round(Number(payload?.width) || 90)));
    const height = Math.max(90, Math.min(820, Math.round(Number(payload?.height) || 90)));
    mainWindow.setSize(width, height, true);
    const position = redock();
    return { success: true, width, height, ...position };
  });

  ipcMain.handle("vanessa:get-dock-position", () => ({ success: true, dockPosition }));

  ipcMain.handle("vanessa:dock-corner", (_, requestedPosition: DockPosition) => {
    if (mainWindow.isDestroyed() || !isDockPosition(requestedPosition)) {
      return { success: false, error: "Unknown docking position." };
    }
    dockPosition = requestedPosition;
    writeDockPosition(settingsPath, dockPosition);
    const position = redock();
    return { success: true, dockPosition, ...position };
  });

  ipcMain.handle("vanessa:show-window", () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      return { success: true };
    }
    return { success: false };
  });

  ipcMain.handle("vanessa:minimize-window", () => {
    if (!mainWindow.isDestroyed()) mainWindow.hide();
    return { success: true };
  });

  // "Close" in the UI means hide to background; Quit is deliberately in the tray menu.
  ipcMain.handle("vanessa:close-window", () => {
    if (!mainWindow.isDestroyed()) mainWindow.hide();
    return { success: true };
  });

  function initWebSocket() {
    if (mainWindow.isDestroyed()) return;
    try {
      wsClient = new WebSocket(getOrchestratorWsUrl());
      wsClient.on("message", (data: any) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (!mainWindow.isDestroyed()) mainWindow.webContents.send("vanessa:event", parsed);
        } catch { /* Ignore malformed event frames. */ }
      });
      wsClient.on("close", () => {
        if (!mainWindow.isDestroyed()) setTimeout(initWebSocket, 2000);
      });
      wsClient.on("error", () => { wsClient?.close(); });
    } catch {
      if (!mainWindow.isDestroyed()) setTimeout(initWebSocket, 3000);
    }
  }
  initWebSocket();
}
