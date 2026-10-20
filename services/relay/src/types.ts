export type DeviceRole = "phone" | "laptop";

export type RelayMessage =
  | {
      type: "command";
      requestId: string;
      idempotencyKey?: string;
      command: string;
      source: "phone";
      createdAt: string;
    }
  | {
      type: "task_update";
      requestId: string;
      taskId: string;
      status: "pending" | "running" | "awaiting_approval" | "success" | "failed";
      sequence?: number;
      message?: string;
      result?: unknown;
    }
  | {
      type: "approval_request";
      requestId: string;
      taskId: string;
      title: string;
      detail: string;
      risk: "medium" | "high";
      sequence?: number;
    }
  | {
      type: "approval_response";
      requestId: string;
      taskId: string;
      approved: boolean;
    }
  | {
      type: "resume";
      lastSeenSequence: number;
      requestId?: string;
    }
  | {
      type: "replay_complete";
      lastSequence: number;
    };

