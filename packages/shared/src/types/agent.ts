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
