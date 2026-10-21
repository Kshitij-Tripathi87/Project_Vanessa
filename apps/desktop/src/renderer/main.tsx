import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import "./index.css";

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
    executeCommand: async (payload) => {
      const res = await fetch("http://127.0.0.1:4319/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return res.json();
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
    cancelTask: async () => {
      const res = await fetch("http://127.0.0.1:4319/api/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
