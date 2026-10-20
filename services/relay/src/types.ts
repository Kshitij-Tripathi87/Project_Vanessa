export type DeviceRole = "phone" | "laptop";

export type RelayMessage =
  | {
      type: "command";
      requestId: string;
      command: string;
      source: "phone";
      createdAt: string;
    }
  | {
      type: "task_update";
      requestId: string;
      taskId: string;
      status: "pending" | "running" | "awaiting_approval" | "success" | "failed";
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
    }
  | {
      type: "approval_response";
      requestId: string;
      taskId: string;
      approved: boolean;
    };
