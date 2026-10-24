import { VanessaEvent, ExecuteCommandPayload, ExecuteCommandResult, Task, DockPosition } from "@vanessa/shared";
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
  interface Window {
    vanessa: {
      executeCommand: (payload: ExecuteCommandPayload) => Promise<ExecuteCommandResult>;
      approveTask: (taskId: string) => Promise<{ success: boolean; task?: Task; error?: string }>;
      rejectTask: (taskId: string) => Promise<{ success: boolean; task?: Task; error?: string }>;
      cancelTask: (taskId?: string) => Promise<{ success: boolean; message?: string; error?: string }>;
      onEvent: (callback: (event: VanessaEvent) => void) => () => void;
      onTriggerPTT?: (callback: () => void) => () => void;
      onTriggerCancel?: (callback: () => void) => () => void;
      resizeWindow?: (size: { width: number; height: number }) => Promise<{ success: boolean }>;
      getDockPosition?: () => Promise<{ success: boolean; dockPosition?: DockPosition }>;
      dockCorner?: (position: DockPosition) => Promise<{ success: boolean; dockPosition?: DockPosition; x?: number; y?: number }>;
      showWindow?: () => Promise<{ success: boolean }>;
      onOpenChat?: (callback: () => void) => () => void;
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
