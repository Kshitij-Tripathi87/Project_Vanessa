export * from "./agent.js";

export interface AuditEntry {
  id: string;
  timestamp: number | string;
  taskId?: string;
  source?: "voice" | "remote_pwa" | "desktop_hud" | "cli" | "system" | "desktop" | "phone";
  command?: string;
  agent: string;
  action: string;
  resource?: string;
  risk?: string;
  permission?: "allowed" | "approved_once" | "always_allowed" | "blocked" | "denied";
  status: "info" | "success" | "warn" | "error" | "blocked" | "approved";
  result?: any;
  details: Record<string, any> | string;
}

export interface ExecuteCommandPayload {
  command: string;
  language?: string;
  source?: "voice" | "desktop" | "phone";
  sentiment?: any;
}

export interface ExecuteCommandResult {
  status: "success" | "failed" | "awaiting_approval";
  spokenSummary: string;
  planId?: string;
  plan?: import("./agent.js").Plan;
  pendingTasks?: import("./agent.js").Task[];
  sentiment?: any;
}

export interface SystemStatus {
  orchestratorOnline: boolean;
  activeVoiceProvider: "elevenlabs" | "fish" | "mock";
  activeTasksCount: number;
  platform: "win32" | "darwin" | "linux";
  timestamp: number;
}

export type EventType =
  | "task:update"
  | "approval:required"
  | "approval:granted"
  | "approval:rejected"
  | "plan:created"
  | "plan:started"
  | "plan:completed"
  | "audit:log"
  | "system:status"
  | "voice:state"
  | "agent:message";

export interface VanessaEvent<T = any> {
  type: EventType;
  payload: T;
  timestamp: number;
}
