import { createHash, verify as verifySignature } from "node:crypto";

import {
  canonicalize,
  computeKeyId,
  isSupportedIdentityKey,
  normalizeIdentityPublicKey,
  safeParseRemotePayload,
  type RemotePayloadFor,
  type RemoteProtocolErrorCode,
  type RemoteTaskState,
} from "@vanessa/protocol";

import type { TrustedRemoteDevice, RemotePairingRegistry } from "./remotePairingRegistry.js";
import {
  createRemoteTargetDescriptor,
  MobileTaskEngine,
  REMOTE_POLICY_VERSION,
} from "../core/mobileTaskEngine.js";

export type RemoteApprovalProofContext = {
  device: TrustedRemoteDevice;
  response: RemotePayloadFor<"task.confirmation_response">;
  proof: RemotePayloadFor<"task.confirmation_response">["approvalProof"];
};

function verifyDeviceApprovalProof(context: RemoteApprovalProofContext, now: number): boolean {
  const { device, response, proof } = context;
  if (!proof || !device.approvalPublicKeySpki) return false;
  if (proof.keyId !== computeKeyId(device.approvalPublicKeySpki)) return false;
  if (!Number.isSafeInteger(proof.signedAt) || proof.signedAt !== response.approvedAt) return false;
  if (Math.abs(now - proof.signedAt) > 60_000) return false;
  let publicKey;
  try { publicKey = normalizeIdentityPublicKey(device.approvalPublicKeySpki); } catch { return false; }
  if (!isSupportedIdentityKey(publicKey)) return false;
  const binding = {
    taskId: response.taskId,
    approvalId: response.approvalId,
    actionHash: response.actionHash,
    decision: "approved" as const,
    approvedAt: response.approvedAt,
    method: "biometric_strong" as const,
  };
  try {
    return verifySignature("sha256", Buffer.from(canonicalize(binding), "utf8"), publicKey,
      Buffer.from(proof.signature, "base64url"));
  } catch { return false; }
}

/**
 * Verifies a separate, hardware-backed proof from the phone's biometric-bound
 * approval key. The v2 envelope signature authenticates the device/session;
 * it is deliberately NOT treated as proof that the user passed biometrics.
 */
export type RemoteApprovalProofVerifier = (context: RemoteApprovalProofContext) => Promise<boolean>;

export type RemoteTaskServiceOptions = {
  now?: () => number;
  verifyApprovalProof?: RemoteApprovalProofVerifier;
};

export type RemoteTaskSubmission = {
  accepted: RemotePayloadFor<"task.accepted">;
  confirmationRequired?: RemotePayloadFor<"task.confirmation_required">;
};

const TIER_TO_STATE: Record<string, RemoteTaskState> = {
  queued: "queued",
  validating: "validating",
  awaiting_confirm: "awaiting_approval",
  running: "running",
  verifying: "verifying",
  done: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  timed_out: "timed_out",
};

function serviceError(code: RemoteProtocolErrorCode, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** Stable approval identity across retries/reconnects for the same durable task. */
function approvalIdForTask(taskId: string): string {
  const bytes = createHash("sha256").update(`vanessa:approval:${taskId}`, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function mapTaskState(state: string): RemoteTaskState {
  return TIER_TO_STATE[state] ?? "unknown";
}

/**
 * Protocol-v2 adapter for the existing durable PC task engine.
 *
 * The caller must supply the keyId obtained from an already-authenticated
 * RemoteSessionGuard. Device identity and scopes are resolved again from the
 * PC-owned pairing registry; neither is accepted from the message payload.
 */
export class RemoteTaskService {
  private readonly now: () => number;

  constructor(
    private readonly engine: MobileTaskEngine,
    private readonly pairings: Pick<RemotePairingRegistry, "getTrustedDeviceByKeyId">,
    private readonly options: RemoteTaskServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  manifestSnapshot(keyId: string): RemotePayloadFor<"manifest.snapshot"> {
    const device = this.requireTrustedDevice(keyId);
    const granted = new Set(device.grantedScopes);
    const capabilities = this.engine.getRemoteCapabilities()
      .filter((capability) => capability.scopes.every((scope) => granted.has(scope)));
    const manifestVersion = createHash("sha256")
      .update(canonicalize(capabilities), "utf8")
      .digest("hex")
      .slice(0, 32);

    return {
      manifestVersion,
      generatedAt: this.now(),
      capabilities,
      policyVersion: REMOTE_POLICY_VERSION,
    };
  }

  async submitTask(keyId: string, value: unknown): Promise<RemoteTaskSubmission> {
    const parsed = safeParseRemotePayload("task.submit", value);
    if (!parsed.success) serviceError("INVALID_PAYLOAD", "Task submission payload is invalid.");

    const device = this.requireTrustedDevice(keyId);
    const payload = parsed.data;
    const capability = this.engine.getRemoteCapabilities().find((entry) => entry.name === payload.capability);
    if (!capability) serviceError("CAPABILITY_DISABLED", "The requested PC capability is not available.");

    const granted = new Set(device.grantedScopes);
    if (!capability.scopes.every((scope) => granted.has(scope))) {
      serviceError("SCOPE_REQUIRED", "This paired device has not been granted the required capability scope.");
    }

    const submitted = await this.engine.submit({
      requestId: payload.requestId,
      idempotencyKey: payload.idempotencyKey,
      tool: capability.name,
      args: payload.canonicalArguments,
      deviceId: device.deviceId,
    });

    const accepted: RemotePayloadFor<"task.accepted"> = {
      requestId: submitted.requestId,
      taskId: submitted.taskId,
      state: "accepted",
      taskVersion: 1,
      eventSeq: 0,
      acceptedAt: submitted.acceptedAt,
    };

    if (capability.tier !== "T2" || !submitted.actionHash || !submitted.expiresAt) {
      return { accepted };
    }

    const approval = {
      approvalId: approvalIdForTask(submitted.taskId),
      taskId: submitted.taskId,
      taskVersion: 1,
      deviceId: device.deviceId,
      capability: capability.name,
      capabilityVersion: capability.version,
      consequence: (submitted.summary ?? capability.description).slice(0, 500),
      target: createRemoteTargetDescriptor(capability.name, payload.canonicalArguments),
      actionHash: submitted.actionHash,
      policyVersion: REMOTE_POLICY_VERSION,
      expiresAt: submitted.expiresAt,
    };

    return {
      accepted,
      confirmationRequired: { approval, eventSeq: 0 },
    };
  }

  async cancelTask(keyId: string, value: unknown): Promise<RemotePayloadFor<"task.cancel_ack">> {
    const parsed = safeParseRemotePayload("task.cancel", value);
    if (!parsed.success) serviceError("INVALID_PAYLOAD", "Task cancellation payload is invalid.");

    const device = this.requireTrustedDevice(keyId);
    const task = this.engine.getTask(parsed.data.taskId);
    if (!task || task.requestId !== parsed.data.requestId) {
      serviceError("TASK_NOT_FOUND", "Task was not found for this request.");
    }

    await this.engine.cancel(parsed.data.taskId, device.deviceId);
    const updated = this.engine.getTask(parsed.data.taskId);
    const state = mapTaskState(updated?.state ?? "unknown");
    const outcome = state === "cancelled"
      ? "cancelled"
      : state === "succeeded" || state === "failed" || state === "timed_out"
        ? "completed"
        : "partially_effective";

    return {
      taskId: parsed.data.taskId,
      outcome,
      state,
      ...(outcome === "partially_effective" ? { detail: "Cancellation was requested; the task engine has not yet confirmed termination." } : {}),
    };
  }

  async confirmTask(keyId: string, value: unknown, proof?: unknown): Promise<void> {
    const parsed = safeParseRemotePayload("task.confirmation_response", value);
    if (!parsed.success) serviceError("INVALID_PAYLOAD", "Task confirmation payload is invalid.");

    const device = this.requireTrustedDevice(keyId);
    const task = this.engine.getTask(parsed.data.taskId);
    if (!task || task.state !== "awaiting_confirm") {
      serviceError("TASK_NOT_FOUND", "Task is not awaiting approval for this device.");
    }
    if (parsed.data.approvalId !== approvalIdForTask(parsed.data.taskId)) {
      serviceError("CONFIRMATION_MISMATCH", "Approval identifier does not match the task.");
    }

    if (parsed.data.decision === "approved") {
      if (parsed.data.method !== "biometric_strong") {
        serviceError("PERMISSION_DENIED", "A strong biometric approval method is required for remote destructive actions.");
      }
      const context: RemoteApprovalProofContext = {
        device,
        response: parsed.data,
        proof: parsed.data.approvalProof,
      };
      const verified = this.options.verifyApprovalProof
        ? await this.options.verifyApprovalProof(context)
        : verifyDeviceApprovalProof(context, this.now());
      if (!verified) {
        serviceError("PERMISSION_DENIED", "The phone did not provide a valid biometric-bound approval proof.");
      }
    }

    await this.engine.confirm({
      taskId: parsed.data.taskId,
      approved: parsed.data.decision === "approved",
      actionHash: parsed.data.actionHash,
      deviceId: device.deviceId,
    });
  }

  private requireTrustedDevice(keyId: string): TrustedRemoteDevice {
    const device = this.pairings.getTrustedDeviceByKeyId(keyId);
    if (!device) serviceError("UNKNOWN_KEY", "The phone identity is not paired with this PC.");
    if (device.revoked) serviceError("REVOKED_DEVICE", "This phone has been revoked on the PC.");
    return device;
  }
}
