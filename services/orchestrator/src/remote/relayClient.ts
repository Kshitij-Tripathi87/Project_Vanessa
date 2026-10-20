import WebSocket from "ws";

export type RelayMessage = {
  type: string;
  requestId?: string;
  command?: string;
  taskId?: string;
  approved?: boolean;
};

export class VanessaRelayClient {
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private isExplicitlyClosed = false;

  constructor(
    private readonly relayUrl: string,
    private readonly deviceToken: string,
    private readonly handlers: {
      onCommand: (input: { requestId: string; command: string }) => Promise<void>;
      onApproval: (input: { requestId: string; taskId: string; approved: boolean }) => Promise<void>;
    }
  ) {}

  connect() {
    this.isExplicitlyClosed = false;
    const url = `${this.relayUrl}?token=${this.deviceToken}`;
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      console.log("[Vanessa Relay Client] Connected outbound to relay:", this.relayUrl);
    });

    this.ws.on("message", async (raw) => {
      let message: RelayMessage;
      try {
        message = JSON.parse(raw.toString()) as RelayMessage;
      } catch {
        return;
      }

      if (message.type === "command" && message.requestId && message.command) {
        await this.handlers.onCommand({
          requestId: message.requestId,
          command: message.command,
        });
      }

      if (message.type === "approval_response" && message.requestId && message.taskId) {
        await this.handlers.onApproval({
          requestId: message.requestId,
          taskId: message.taskId,
          approved: Boolean(message.approved),
        });
      }
    });

    this.ws.on("close", () => {
      if (!this.isExplicitlyClosed) {
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      }
    });

    this.ws.on("error", (err) => {
      console.warn("[Vanessa Relay Client] Connection warning:", err.message);
    });
  }

  sendTaskUpdate(input: {
    requestId: string;
    taskId: string;
    status: string;
    message?: string;
    result?: unknown;
  }) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "task_update", ...input }));
    }
  }

  sendApprovalRequest(input: {
    requestId: string;
    taskId: string;
    title: string;
    detail: string;
    risk: "medium" | "high";
  }) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "approval_request", ...input }));
    }
  }

  close() {
    this.isExplicitlyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
