import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import "./index.css";
import { submitCommandRequest } from "@vanessa/shared";

// Polyfill window.vanessa for browser preview when not inside Electron
if (typeof window !== "undefined" && !window.vanessa) {
  const eventListeners: Array<(event: any) => void> = [];
  
  function connectWebSocket() {
    try {
      const ws = new WebSocket("ws://127.0.0.1:4319/events");
      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          eventListeners.forEach((fn) => fn(parsed));
        } catch {}
      };
      ws.onclose = () => {
        setTimeout(connectWebSocket, 2000);
      };
    } catch {
      setTimeout(connectWebSocket, 2000);
    }
  }

  connectWebSocket();

  window.vanessa = {
    getControlStatus: async () => {
      const baseUrl = "http://127.0.0.1:4139";
      const readJson = async (route: string) => {
        try {
          const response = await fetch(baseUrl + route, { signal: AbortSignal.timeout(1500) });
          return { ok: response.ok, data: await response.json().catch(() => ({})) };
        } catch {
          return { ok: false, data: {} };
        }
      };
      const [health, privacy, mode] = await Promise.all([
        readJson("/health"),
        readJson("/api/privacy"),
        readJson("/api/mode"),
      ]);
      const system = health.data?.system || {};
      const orchestratorOnline = health.ok &&
        health.data?.status === "online" &&
        health.data?.service === "vanessa-orchestrator";
      const errors: string[] = [];
      if (!orchestratorOnline) errors.push("The Vanessa orchestrator health check did not pass.");
      if (!privacy.ok) errors.push("Folder authorization status could not be loaded.");
      if (!mode.ok || typeof mode.data?.autonomous !== "boolean") errors.push("Execution policy mode could not be confirmed.");
      return {
        success: orchestratorOnline,
        orchestratorOnline,
        orchestratorPort: 4139,
        activeTasksCount: Number.isFinite(system.activeTasksCount) ? system.activeTasksCount : 0,
        platform: typeof system.platform === "string" ? system.platform : "unknown",
        autonomousMode: typeof mode.data?.autonomous === "boolean" ? mode.data.autonomous : undefined,
        allowedFolders: Array.isArray(privacy.data?.allowedFolders)
          ? privacy.data.allowedFolders.filter((item: unknown): item is string => typeof item === "string")
          : [],
        checkedAt: Date.now(),
        errors,
      };
    },
    addAllowedFolder: async (folderPath) => {
      try {
        const response = await fetch("http://127.0.0.1:4139/api/privacy/folders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folderPath }),
          signal: AbortSignal.timeout(2500),
        });
        const data = await response.json().catch(() => ({}));
        const allowedFolders = Array.isArray(data?.allowedFolders)
          ? data.allowedFolders.filter((item: unknown): item is string => typeof item === "string")
          : [];
        if (!response.ok || data?.success !== true) {
          return { success: false, allowedFolders, error: "The folder was not added. Confirm it exists and is a directory." };
        }
        return { success: true, allowedFolders };
      } catch {
        return { success: false, error: "Could not reach Vanessa to update the approved folder list." };
      }
    },
    executeCommand: async (payload) => {
      return submitCommandRequest("http://127.0.0.1:4319", {
        ...payload,
        source: "desktop",
      });
    },
    approveTask: async (taskId) => {
      const res = await fetch("http://127.0.0.1:4319/api/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId }),
      });
      return res.json();
    },
    rejectTask: async (taskId) => {
      const res = await fetch("http://127.0.0.1:4319/api/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId }),
      });
      return res.json();
    },
    cancelTask: async (requestId) => {
      const endpoint = requestId ? "/api/cancel/request" : "/api/cancel";
      const res = await fetch(`http://127.0.0.1:4319${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestId ? JSON.stringify({ requestId }) : undefined,
      });
      return res.json();
    },
    onEvent: (callback) => {
      eventListeners.push(callback);
      return () => {
        const idx = eventListeners.indexOf(callback);
        if (idx !== -1) eventListeners.splice(idx, 1);
      };
    },
  };
}

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
