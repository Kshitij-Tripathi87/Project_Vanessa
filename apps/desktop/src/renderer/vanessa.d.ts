import { VanessaEvent, ExecuteCommandPayload, ExecuteCommandResult, Task } from "@vanessa/shared";
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
      executeCommand: (payload: ExecuteCommandPayload) => Promise<ExecuteCommandResult>;
      approveTask: (taskId: string) => Promise<{ success: boolean; task?: Task; error?: string }>;
      rejectTask: (taskId: string) => Promise<{ success: boolean; task?: Task; error?: string }>;
      cancelTask: (requestId?: string) => Promise<{ success: boolean; message?: string; error?: string }>;
      getMobileAudit?: (limit?: number) => Promise<Array<{ seq: number; at: number; taskId: string; requestId: string; tool: string; args: string; tier: number; state: string; resultSummary?: string; durationMs?: number }>>;
      createRemoteV2PairingWindow: () => Promise<{
        pairingId?: string; expiresAt?: number; endpoint?: string; pcKeyId?: string;
        pcPublicKey?: string; qrPayload?: string; error?: string;
      }>;
      getRemoteV2PendingPairings: () => Promise<Array<{
        pairingId: string; keyId: string; deviceHint: string; platform: string;
        appVersion: string; biometricApprovalAvailable: boolean; requestedAt: number; expiresAt: number;
      }> | { error: string }>;
      getRemoteV2Devices: () => Promise<Array<{
        deviceId: string; deviceHint: string; platform: string; appVersion: string;
        grantedScopes: string[]; pairedAt: number; revoked: boolean; biometricApprovalAvailable: boolean;
      }> | { error: string }>;
      approveRemoteV2Pairing: (pairingId: string, scopes: string[]) => Promise<{ success?: boolean; error?: string }>;
      rejectRemoteV2Pairing: (pairingId: string) => Promise<{ success?: boolean; error?: string }>;
      revokeRemoteV2Device: (deviceId: string) => Promise<{ success?: boolean; error?: string }>;
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
