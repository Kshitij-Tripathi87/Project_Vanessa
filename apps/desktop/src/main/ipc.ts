import { ipcMain, BrowserWindow, IpcMainInvokeEvent, screen } from "electron";
import WebSocket from "ws";
import type { ExecuteCommandPayload, VanessaEvent } from "@vanessa/shared";
import { calculateDockPosition, type DockCorner } from "./windowLayout.js";
import { resolveOrchestratorHttpUrl, resolveOrchestratorWebSocketUrl } from "./runtimeConfig.js";
import { getRemoteAdminToken } from "./runtimeServices.js";

// The Electron main build is CommonJS; load the ESM shared package once.
const commandClient = import("@vanessa/shared");


let wsClient: WebSocket | null = null;
let lastEventSequence = 0;
let lastEventStreamId: string | null = null;
let dockedCorner: DockCorner = "bottom-right";

function positionWindowAtCorner(
  mainWindow: BrowserWindow,
  corner: DockCorner,
  requestedSize?: { width: number; height: number },
) {
  const display = screen.getDisplayMatching(mainWindow.getBounds());
  const [currentWidth, currentHeight] = mainWindow.getSize();
  const position = calculateDockPosition(
    display.workArea,
    requestedSize || { width: currentWidth, height: currentHeight },
    corner,
    24,
  );
  mainWindow.setPosition(position.x, position.y, true);
  return position;
}

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
      return await submitCommandRequest(resolveOrchestratorHttpUrl(process.env), {
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
      const res = await fetch(`${resolveOrchestratorHttpUrl(process.env)}/api/approve`, {
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
      const res = await fetch(`${resolveOrchestratorHttpUrl(process.env)}/api/reject`, {
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
      const res = await fetch(`${resolveOrchestratorHttpUrl(process.env)}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: taskId ? JSON.stringify({ requestId: taskId }) : undefined,
      });
      return await res.json();
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("vanessa:get-mobile-audit", async (event, limit: unknown = 100) => {
    assertTrustedRenderer(event, mainWindow);
    const count = typeof limit === "number" && Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 100;
    try {
      const response = await fetch(`${resolveOrchestratorHttpUrl(process.env)}/api/mobile/audit?limit=${count}`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) return [];
      const rows = await response.json();
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }
  });

  // 4. Resize and dock the floating window. Reposition immediately after
  // resizing so the expanded panel stays visible on the selected display.
  ipcMain.handle("vanessa:resize-window", (event, payload: { width: number; height: number }) => {
    assertTrustedRenderer(event, mainWindow);
    if (!payload || !Number.isInteger(payload.width) || !Number.isInteger(payload.height) || payload.width < 70 || payload.width > 900 || payload.height < 70 || payload.height > 900) {
      return { success: false };
    }
    if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
    mainWindow.setSize(payload.width, payload.height);
    const position = positionWindowAtCorner(mainWindow, dockedCorner, payload);
    return { success: true, corner: dockedCorner, ...position };
  });

  ipcMain.handle("vanessa:dock-corner", (event, corner: DockCorner) => {
    assertTrustedRenderer(event, mainWindow);
    if (!["top-left", "top-right", "bottom-left", "bottom-right"].includes(corner)) return { success: false };
    if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
    dockedCorner = corner;
    const position = positionWindowAtCorner(mainWindow, dockedCorner);
    return { success: true, corner: dockedCorner, ...position };
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

  async function remoteV2Api(path: string, method = "GET", body?: unknown) {
    const token = getRemoteAdminToken();
    if (!token) return { success: false, enabled: false, error: "Remote v2 is disabled or the PC identity is unavailable." };
    const response = await fetch(`${resolveOrchestratorHttpUrl(process.env)}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-vanessa-admin-token": token,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((payload as { error?: string }).error || `Remote v2 request failed (${response.status}).`);
    return payload;
  }

  ipcMain.handle("vanessa:remote-v2-status", async (event) => {
    assertTrustedRenderer(event, mainWindow);
    try { return await remoteV2Api("/api/remote-v2/status"); }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : "Status unavailable." }; }
  });

  ipcMain.handle("vanessa:remote-v2-create-pairing", async (event) => {
    assertTrustedRenderer(event, mainWindow);
    try { return await remoteV2Api("/api/remote-v2/pairing/window", "POST", {}); }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : "Could not create pairing code." }; }
  });

  ipcMain.handle("vanessa:remote-v2-pending-pairings", async (event) => {
    assertTrustedRenderer(event, mainWindow);
    try { return await remoteV2Api("/api/remote-v2/pairing/pending"); }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : "Could not load pending pairings." }; }
  });

  ipcMain.handle("vanessa:remote-v2-approve-pairing", async (event, pairingId: unknown, scopes: unknown) => {
    assertTrustedRenderer(event, mainWindow);
    if (typeof pairingId !== "string" || !/^pair_[a-f0-9]{24}$/.test(pairingId) ||
        !Array.isArray(scopes) || scopes.length > 10 ||
        scopes.some((scope) => typeof scope !== "string" || scope.length > 64)) {
      return { success: false, error: "Pairing approval request is invalid." };
    }
    try { return await remoteV2Api(`/api/remote-v2/pairing/${pairingId}/approve`, "POST", { scopes }); }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : "Could not approve pairing." }; }
  });

  ipcMain.handle("vanessa:remote-v2-reject-pairing", async (event, pairingId: unknown) => {
    assertTrustedRenderer(event, mainWindow);
    if (typeof pairingId !== "string" || !/^pair_[a-f0-9]{24}$/.test(pairingId)) {
      return { success: false, error: "Pairing ID is invalid." };
    }
    try { return await remoteV2Api(`/api/remote-v2/pairing/${pairingId}/reject`, "POST", {}); }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : "Could not reject pairing." }; }
  });

  // Connect to WebSocket stream and forward to Renderer
  function initWebSocket() {
    try {
      const eventsUrl = new URL(resolveOrchestratorWebSocketUrl(process.env));
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
