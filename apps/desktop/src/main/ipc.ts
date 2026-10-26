import { ipcMain, BrowserWindow, IpcMainInvokeEvent, screen } from "electron";
import WebSocket from "ws";
import type { ExecuteCommandPayload, VanessaEvent } from "@vanessa/shared";

// The Electron main build is CommonJS; load the ESM shared package once.
const commandClient = import("@vanessa/shared");

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || "http://127.0.0.1:4319";
const WS_URL = process.env.ORCHESTRATOR_WS || "ws://127.0.0.1:4319/events";

let wsClient: WebSocket | null = null;
let lastEventSequence = 0;
let lastEventStreamId: string | null = null;

function assertTrustedRenderer(event: IpcMainInvokeEvent, mainWindow: BrowserWindow) {
  if (mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error("Untrusted renderer sender.");
  }
}

function assertTaskId(taskId: unknown): asserts taskId is string {
  if (typeof taskId !== "string" || !/^[a-zA-Z0-9:_-]{1,160}$/.test(taskId)) {
    throw new Error("Invalid task ID.");
  }
}

export function registerIpcHandlers(mainWindow: BrowserWindow) {
  // 1. Execute Command
  ipcMain.handle("vanessa:execute-command", async (event, payload: ExecuteCommandPayload) => {
    assertTrustedRenderer(event, mainWindow);
    if (!payload || typeof payload.command !== "string" || payload.command.trim().length === 0 || payload.command.length > 20_000) {
      return { status: "failed", spokenSummary: "That request is empty or too long." };
    }
    try {
      const { submitCommandRequest } = await commandClient;
      return await submitCommandRequest(ORCHESTRATOR_URL, {
        ...payload,
        source: "desktop",
        originDeviceId: process.env.VANESSA_DEVICE_ID || "desktop-local",
      });
    } catch (err: any) {
      return { status: "failed", spokenSummary: `Connection to orchestrator failed: ${err.message}` };
    }
  });

  // 2. Approve Task
  ipcMain.handle("vanessa:approve-task", async (event, taskId: string) => {
    assertTrustedRenderer(event, mainWindow);
    assertTaskId(taskId);
    try {
      const res = await fetch(`${ORCHESTRATOR_URL}/api/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId }),
      });
      return await res.json();
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("vanessa:reject-task", async (event, taskId: string) => {
    assertTrustedRenderer(event, mainWindow);
    assertTaskId(taskId);
    try {
      const res = await fetch(`${ORCHESTRATOR_URL}/api/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId }),
      });
      return await res.json();
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 3. Cancel Task / Emergency Kill-Switch
  ipcMain.handle("vanessa:cancel-task", async (event, taskId?: string) => {
    assertTrustedRenderer(event, mainWindow);
    if (taskId !== undefined) assertTaskId(taskId);
    try {
      const endpoint = taskId ? "/api/cancel/request" : "/api/cancel";
      const res = await fetch(`${ORCHESTRATOR_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: taskId ? JSON.stringify({ requestId: taskId }) : undefined,
      });
      return await res.json();
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 4. Window Resize (Compact Orb vs Expanded Drawer)
  ipcMain.handle("vanessa:resize-window", (event, payload: { width: number; height: number }) => {
    assertTrustedRenderer(event, mainWindow);
    if (!payload || !Number.isInteger(payload.width) || !Number.isInteger(payload.height) || payload.width < 70 || payload.width > 900 || payload.height < 70 || payload.height > 900) {
      return { success: false };
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setSize(payload.width, payload.height);
    }
    return { success: true };
  });

  // 5. Dock to Screen Corner (bottom-right, top-right, bottom-left, top-left)
  ipcMain.handle("vanessa:dock-corner", (event, corner: "top-left" | "top-right" | "bottom-left" | "bottom-right") => {
    assertTrustedRenderer(event, mainWindow);
    if (!["top-left", "top-right", "bottom-left", "bottom-right"].includes(corner)) return { success: false };
    if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
    const { x: workAreaX, y: workAreaY, width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workArea;
    const [winWidth, winHeight] = mainWindow.getSize();
    const margin = 24;

    let x = workAreaX + screenWidth - winWidth - margin;
    let y = workAreaY + screenHeight - winHeight - margin;

    switch (corner) {
      case "top-left":
        x = workAreaX + margin;
        y = workAreaY + margin;
        break;
      case "top-right":
        x = workAreaX + screenWidth - winWidth - margin;
        y = workAreaY + margin;
        break;
      case "bottom-left":
        x = workAreaX + margin;
        y = workAreaY + screenHeight - winHeight - margin;
        break;
      case "bottom-right":
      default:
        x = workAreaX + screenWidth - winWidth - margin;
        y = workAreaY + screenHeight - winHeight - margin;
        break;
    }

    mainWindow.setPosition(x, y, true);
    return { success: true, corner, x, y };
  });

  // 5. Window Controls
  ipcMain.handle("vanessa:minimize-window", (event) => {
    assertTrustedRenderer(event, mainWindow);
    mainWindow?.minimize();
    return { success: true };
  });

  ipcMain.handle("vanessa:close-window", (event) => {
    assertTrustedRenderer(event, mainWindow);
    mainWindow?.close();
    return { success: true };
  });

  // Connect to WebSocket stream and forward to Renderer
  function initWebSocket() {
    try {
      const eventsUrl = new URL(WS_URL);
      eventsUrl.searchParams.set("since", String(lastEventSequence));
      if (lastEventStreamId) eventsUrl.searchParams.set("streamId", lastEventStreamId);
      wsClient = new WebSocket(eventsUrl.toString());

      wsClient.on("message", (data: any) => {
        try {
           const parsed = JSON.parse(data.toString());
           if (parsed.type === "system:status" && typeof parsed.payload?.eventStreamId === "string") {
             const nextStreamId = parsed.payload.eventStreamId as string;
             if (lastEventStreamId && lastEventStreamId !== nextStreamId) lastEventSequence = 0;
             lastEventStreamId = nextStreamId;
           }
           if (typeof parsed.sequence === "number") {
             lastEventSequence = Math.max(lastEventSequence, parsed.sequence);
           }
          if (!mainWindow.isDestroyed()) {
             mainWindow.webContents.send("vanessa:event", parsed as VanessaEvent);
          }
        } catch {
          // Ignore malformed
        }
      });

      wsClient.on("close", () => {
        setTimeout(initWebSocket, 2000);
      });

      wsClient.on("error", () => {
        wsClient?.close();
      });
    } catch {
      setTimeout(initWebSocket, 3000);
    }
  }

  initWebSocket();
}
