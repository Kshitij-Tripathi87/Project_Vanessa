export type AgentName =
  | "memory"
  | "coding"
  | "it_ops"
  | "knowledge"
  | "testing"
  | "windows"
  | "browser"
  | "files"
  | "system"
  | "developer"
  | "cloud"
  | "vanessa"
  | "jarvis"
  | "openjarvis"
  | "incident";

export type AgentStatus =
  | "completed"
  | "partial"
  | "failed"
  | "blocked"
  | "awaiting_approval";

export type TaskLifecycleState =
  | "received"
  | "accepted"
  | "planning"
  | "queued"
  | "running"
  | "awaiting_approval"
  | "verifying"
  | "succeeded"
  | "partial"
  | "failed"
  | "blocked"
  | "cancelled"
  | "expired"
  | "interrupted"
  | "reconciling";

export type TaskStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "success"
  | "failed"
  | "cancelled"
  | "received"
  | "accepted"
  | "planning"
  | "queued"
  | "verifying"
  | "succeeded"
  | "partial"
  | "blocked"
  | "expired"
  | "interrupted"
  | "reconciling";

export type RiskLevel = "low" | "medium" | "high";

export type PermissionStatus = "allowed" | "confirm" | "blocked";

export interface AgentEvidence {
  description: string;
  source?: string;
  timestamp?: string;
  confidence?: number;
  data?: unknown;
}

export interface AgentVerification {
  passed: boolean;
  details: string;
}

export interface TaskVerificationResult {
  verified: boolean;
  postconditions: string[];
  exitCode?: number;
  artifacts?: string[];
  outcome: "succeeded" | "partial" | "failed" | "blocked";
  details?: string;
}

export interface AgentTask {
  taskId: string;
  parentTaskId?: string;
  objective: string;
  action?: string;
  params?: Record<string, any>;
  context?: unknown[];
  allowedTools: string[];
  dependsOn: string[];
  acceptanceCriteria: string[];
  deadlineMs?: number;
  isIdempotent?: boolean;
}

export interface CriticVerdict {
  passed: boolean;
  score: number;
  feedback: string;
  proof?: string;
  invariantsPreserved?: boolean;
}

export interface SkillDefinition {
  name: string;
  description: string;
  agent: AgentName | string;
  locks?: string[];
  allowedTools?: string[];
  jobType?: "action" | "goal";
  invariants?: string[];
  instructions?: string;
  objective?: string;
  steps?: string[];
  filePath?: string;
}

export interface Task {
  id: string;
  parentId?: string;
  idempotencyKey?: string;
  agent: AgentName;
  action: string;
  params: Record<string, any>;
  dependsOn: string[];
  status: TaskStatus;
  lifecycleState?: TaskLifecycleState;
  isIdempotent?: boolean;
  jobType?: "action" | "goal";
  skillName?: string;
  critic?: CriticVerdict;
  verification?: TaskVerificationResult;
  risk?: RiskLevel;
  result?: any;
  error?: string;
  requestId?: string;
  spokenSummary?: string;
  allowedTools?: string[];
  acceptanceCriteria?: string[];
  evidence?: AgentEvidence[];
  artifacts?: string[];
  startedAt?: number;
  completedAt?: number;
  approvalExpiresAt?: number;
}

export interface RequestContextSummary {
  domains: string[];
  primaryDomain: string;
  targetDevice: {
    kind: string;
    deviceId?: string;
    reason: string;
  };
  browserIntent: string;
  entities: {
    url?: string;
    searchQuery?: string;
    videoQuery?: string;
    targetApp?: string;
  };
  notes: string[];
}

export interface Plan {
  id: string;
  command: string;
  source?: "voice" | "desktop" | "phone";
  intent?: "single_task" | "multi_task" | string;
  risk: RiskLevel;
  tasks: Task[];
  createdAt?: number;
  completedAt?: number;
  requestId?: string;
  /** Derived routing hints; policy and device authorization must still be revalidated at execution time. */
  contextualization?: RequestContextSummary;
}

export interface AgentMessage {
  from: AgentName;
  to: AgentName | "orchestrator";
  type: "task_result" | "request_context" | "request_permission" | "handoff" | "error";
  taskId: string;
  payload: unknown;
}

export interface AgentRunContext {
  planId?: string;
  command?: string;
  workingMemory?: Record<string, any>;
  task?: Task;
}

export interface AgentResult {
  taskId?: string;
  agentId?: string;
  status?: AgentStatus;
  success: boolean;
  summary?: string;
  spokenSummary: string;
  evidence?: AgentEvidence[];
  artifacts?: string[];
  verification?: AgentVerification;
  error?: string;
  data?: unknown;
  needsContext?: {
    from: "memory" | "browser" | "files" | "system";
    query: string;
  };
  requiresApproval?: {
    title: string;
    detail: string;
  };
}

export interface SpecialistAgent {
  id: string;
  capabilities: string[];
  allowedTools: string[];
  execute(
    actionOrTask: string | AgentTask,
    paramsOrContext?: Record<string, any> | AgentRunContext,
    context?: AgentRunContext
  ): Promise<AgentResult>;
}

export interface CapabilityAgent {
  name: string;
  execute: (
    action: string,
    params: Record<string, any>,
    context?: AgentRunContext
  ) => Promise<AgentResult | any>;
}

// Shared Task/Event/Result Contracts (per PDF §7)
export interface TaskRequest {
  schemaVersion: number;
  requestId: string;
  taskId: string;
  parentTaskId?: string;
  authenticatedUserId: string;
  originDeviceId: string;
  targetDeviceId: string;
  source: "desktop_voice" | "mobile_voice" | "desktop_text" | "mobile_text" | "shortcut";
  commandText: string;
  transcriptRef?: string;
  createdAt: number;
  expiresAt: number;
  idempotencyKey: string;
  locale: string;
  privacyFlags: {
    logRawAudio: boolean;
    logFullTranscript: boolean;
  };
  requestedCapability?: string;
  workspaceScope?: string;
  policyDecisionRef?: string;
}

export type TaskEventType =
  | "task.accepted"
  | "task.planned"
  | "agent.started"
  | "tool.started"
  | "tool.completed"
  | "approval.required"
  | "verification.started"
  | "verification.completed"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "task.expired"
  | "task.recovered";

export interface TaskEvent {
  type: TaskEventType;
  taskId: string;
  requestId: string;
  sequence: number;
  timestamp: number;
  schemaVersion: number;
  payload: Record<string, any>;
}

export interface ToolCall {
  toolId: string;
  args: Record<string, any>;
  startedAt: number;
  completedAt?: number;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  artifacts?: string[];
  error?: { code: string; message: string; retryable: boolean };
}

export interface PolicyDecision {
  decision: "allow" | "require_approval" | "deny";
  reason: string;
  riskLevel: "low" | "medium" | "high";
  requiredApprovers?: string[];
  expiresAt?: number;
}

export interface VerificationResult {
  verified: boolean;
  postconditions: string[];
  exitCode?: number;
  artifacts?: string[];
  outcome: "succeeded" | "partial" | "failed" | "blocked";
  details?: string;
  checks: Array<{
    criterion: string;
    passed: boolean;
    evidence: string;
  }>;
}

export interface AgentTask {
  taskId: string;
  parentTaskId?: string;
  objective: string;
  contextRefs: string[];
  allowedTools: string[];
  dependsOn: string[];
  acceptanceCriteria: string[];
  workspaceId?: string;
  timeoutMs: number;
  schemaVersion: number;
}

export interface StructuredAgentResult {
  taskId: string;
  agentId: string;
  status: TaskStatus;
  summary: string;
  evidence: Array<{ description: string; source?: string; timestamp?: string }>;
  artifacts: string[];
  verification: VerificationResult;
  error?: { code: string; message: string; retryable: boolean };
  toolCalls?: ToolCall[];
}
