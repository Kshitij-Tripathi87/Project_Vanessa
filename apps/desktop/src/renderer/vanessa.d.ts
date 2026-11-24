import { VanessaEvent, ExecuteCommandPayload, ExecuteCommandResult, Task } from "@vanessa/shared";
import type { LocalConversationLoadResult, LocalConversationMutationResult, PersistedConversationState } from "@vanessa/protocol/conversation";
import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "fish-agent": DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & {
          "agent-id"?: string;
        },
        HTMLElement
      >;
    }
  }
}

declare global {
  interface VanessaControlStatus {
    success: boolean;
    orchestratorOnline: boolean;
    orchestratorPort: number;
    activeTasksCount: number;
    platform: string;
    autonomousMode?: boolean;
    allowedFolders: string[];
    checkedAt: number;
    errors: string[];
  }

  interface Window {
    vanessa: {
      loadConversationHistory?: () => Promise<LocalConversationLoadResult>;
      saveConversationHistory?: (state: PersistedConversationState, revision: number) => Promise<LocalConversationMutationResult>;
      clearConversationHistory?: (revision: number) => Promise<LocalConversationMutationResult>;
      onHistoryFlushRequest?: (callback: () => Promise<boolean>) => () => void;
      onHistoryFlushCancelled?: (callback: () => void) => () => void;
      executeCommand: (payload: ExecuteCommandPayload) => Promise<ExecuteCommandResult>;
      approveTask: (taskId: string) => Promise<{ success: boolean; task?: Task; error?: string }>;
      rejectTask: (taskId: string) => Promise<{ success: boolean; task?: Task; error?: string }>;
      cancelTask: (requestId?: string) => Promise<{
        success: boolean;
        cancelled?: number;
        executionFinished?: number;
        terminationUnconfirmed?: number;
        planningOnly?: boolean | number;
        message?: string;
        error?: string;
      }>;
      getMobileAudit?: (limit?: number) => Promise<Array<{ seq: number; at: number; taskId: string; requestId: string; tool: string; args: string; tier: number; state: string; resultSummary?: string; durationMs?: number }>>;
      onEvent: (callback: (event: VanessaEvent) => void) => () => void;
      onTriggerPTT?: (callback: () => void) => () => void;
      onTriggerCancel?: (callback: () => void) => () => void;
      resizeWindow?: (size: { width: number; height: number }) => Promise<{ success: boolean }>;
      dockCorner?: (corner: "top-left" | "top-right" | "bottom-left" | "bottom-right") => Promise<{ success: boolean; corner?: string; x?: number; y?: number }>;
      minimizeWindow?: () => Promise<{ success: boolean }>;
      closeWindow?: () => Promise<{ success: boolean }>;
    };
  }

  namespace JSX {
    interface IntrinsicElements {
      "fish-agent": DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & {
          "agent-id"?: string;
        },
        HTMLElement
      >;
    }
  }
}

export {};
