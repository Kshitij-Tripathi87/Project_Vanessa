import { VanessaEvent, ExecuteCommandPayload, ExecuteCommandResult, Task } from "@vanessa/shared";
import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "fish-agent": DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & { "agent-id"?: string },
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

  interface VanessaRemoteStatus {
    enabled: boolean;
    protocol?: number;
    transport?: string;
    host?: string | null;
    port?: number | null;
    scheme?: "ws" | "wss" | null;
    path?: string;
    connections?: number;
    tailscale?: boolean;
    error?: string;
  }

  interface VanessaRemotePairingWindow {
    type: "vanessa_remote_v2";
    version: 2;
    pcIp: string;
    port: number;
    scheme: "ws" | "wss";
    path: "/remote-v2";
    pairingId: string;
    pairingCode: string;
    expiresAt: number;
    pcKeyId: string;
    pcPublicKey: string;
    pcName: string;
  }

  interface VanessaRemotePendingPairing {
    pairingId: string;
    keyId: string;
    deviceHint: string;
    platform: "android" | "desktop" | "web" | "unknown";
    appVersion: string;
    requestedAt: number;
    expiresAt: number;
  }

  interface VanessaTrustedRemoteDevice {
    deviceId: string;
    keyId: string;
    deviceHint: string;
    platform: "android" | "desktop" | "web" | "unknown";
    appVersion: string;
    grantedScopes: string[];
    pairedAt: number;
    revoked: boolean;
  }

  interface Window {
    vanessa: {
      executeCommand: (payload: ExecuteCommandPayload) => Promise<ExecuteCommandResult>;
      approveTask: (taskId: string) => Promise<{ success: boolean; task?: Task; error?: string }>;
      rejectTask: (taskId: string) => Promise<{ success: boolean; task?: Task; error?: string }>;
      cancelTask: (requestId?: string) => Promise<{ success: boolean; message?: string; error?: string }>;
      getMobileAudit?: (limit?: number) => Promise<Array<{ seq: number; at: number; taskId: string; requestId: string; tool: string; args: string; tier: number; state: string; resultSummary?: string; durationMs?: number }>>;
      remoteV2Status: () => Promise<VanessaRemoteStatus>;
      remoteV2CreatePairing: () => Promise<VanessaRemotePairingWindow>;
      remoteV2PendingPairings: () => Promise<{ pairings: VanessaRemotePendingPairing[] }>;
      remoteV2ApprovePairing: (input: { pairingId: string; grantedScopes: string[] }) => Promise<{ success: boolean; deviceId?: string; grantedScopes?: string[] }>;
      remoteV2RejectPairing: (pairingId: string) => Promise<{ success: boolean }>;
      remoteV2Devices: () => Promise<{ devices: VanessaTrustedRemoteDevice[] }>;
      remoteV2RevokeDevice: (deviceId: string) => Promise<{ success: boolean }>;
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
        HTMLAttributes<HTMLElement> & { "agent-id"?: string },
        HTMLElement
      >;
    }
  }
}

export {};
