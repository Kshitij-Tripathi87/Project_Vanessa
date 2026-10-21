import { ipcMain, BrowserWindow, screen } from "electron";
import WebSocket from "ws";

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || "http://127.0.0.1:4319";
const WS_URL = process.env.ORCHESTRATOR_WS || "ws://127.0.0.1:4319/events";

let wsClient: WebSocket | null = null;

export function registerIpcHandlers(mainWindow: BrowserWindow) {
  // 1. Execute Command
  ipcMain.handle("vanessa:execute-command", async (_, payload: { command: string; language?: string }) => {
    try {
      const res = await fetch(`${ORCHESTRATOR_URL}/api/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return await res.json();
    } catch (err: any) {
      return { status: "failed", spokenSummary: `Connection to orchestrator failed: ${err.message}` };
    }
  });

  // 2. Approve Task
  ipcMain.handle("vanessa:approve-task", async (_, taskId: string) => {
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

  ipcMain.handle("vanessa:reject-task", async (_, taskId: string) => {
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
  ipcMain.handle("vanessa:cancel-task", async () => {
    try {
      const res = await fetch(`${ORCHESTRATOR_URL}/api/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      return await res.json();
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 4. Window Resize (Compact Orb vs Expanded Drawer)
  ipcMain.handle("vanessa:resize-window", (_, payload: { width: number; height: number }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setSize(payload.width, payload.height);
    }
    return { success: true };
  });

  // 5. Dock to Screen Corner (bottom-right, top-right, bottom-left, top-left)
  ipcMain.handle("vanessa:dock-corner", (_, corner: "top-left" | "top-right" | "bottom-left" | "bottom-right") => {
    if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
    const [winWidth, winHeight] = mainWindow.getSize();
    const margin = 24;

    let x = screenWidth - winWidth - margin;
    let y = screenHeight - winHeight - margin;

    switch (corner) {
      case "top-left":
        x = margin;
        y = margin;
        break;
      case "top-right":
        x = screenWidth - winWidth - margin;
        y = margin;
        break;
      case "bottom-left":
        x = margin;
        y = screenHeight - winHeight - margin;
        break;
      case "bottom-right":
      default:
        x = screenWidth - winWidth - margin;
        y = screenHeight - winHeight - margin;
        break;
    }

    mainWindow.setPosition(x, y, true);
    return { success: true, corner, x, y };
  });

  // 5. Window Controls
  ipcMain.handle("vanessa:minimize-window", () => {
    mainWindow?.minimize();
    return { success: true };
  });

  ipcMain.handle("vanessa:close-window", () => {
    mainWindow?.close();
    return { success: true };
  });

  // Connect to WebSocket stream and forward to Renderer
  function initWebSocket() {
    try {
      wsClient = new WebSocket(WS_URL);

      wsClient.on("message", (data: any) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send("vanessa:event", parsed);
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
