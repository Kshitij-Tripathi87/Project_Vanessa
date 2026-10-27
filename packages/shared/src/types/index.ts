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

export interface CommandEnvelope {
  requestId: string;
  idempotencyKey: string;
  originDeviceId: string;
  targetDeviceId?: string;
  command: string;
  createdAt: number;
  expiresAt: number;
  schemaVersion: string;
  source: "voice" | "desktop" | "phone" | "relay" | "desktop_hud" | "remote_pwa";
  language?: string;
  sentiment?: any;
}

export interface RelaySequenceEvent<T = any> {
  sequence: number;
  eventId: string;
  timestamp: number;
  type: EventType;
  payload: T;
  cursor?: string;
}

export interface ExecuteCommandPayload {
  command: string;
  requestId?: string;
  language?: string;
  source?: "voice" | "desktop" | "phone" | "relay";
  sentiment?: any;
  conversationContext?: ConversationTurn[];
  envelope?: CommandEnvelope;
  idempotencyKey?: string;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ExecuteCommandResult {
  status: "success" | "failed" | "partial" | "awaiting_approval" | "accepted";
  spokenSummary: string;
  requestId?: string;
  planId?: string;
  plan?: import("./agent.js").Plan;
  pendingTasks?: import("./agent.js").Task[];
  sentiment?: any;
  verification?: import("./agent.js").TaskVerificationResult;
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
  | "agent:message"
  | "codex:progress"
  | "agent.started"
  | "tool.started"
  | "tool.completed"
  | "agent.completed"
  | "verification.completed"
  | "task.failed"
  | "task.cancelled";

export interface VanessaEvent<T = any> {
  type: EventType;
  payload: T;
  timestamp: number;
  /** Monotonic stream metadata used by reconnecting desktop clients. */
  sequence?: number;
  eventId?: string;
  requestId?: string;
  taskId?: string;
}
