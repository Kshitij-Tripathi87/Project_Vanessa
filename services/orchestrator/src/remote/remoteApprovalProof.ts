import { createPublicKey, verify } from "node:crypto";
import {
  canonicalize,
  computeKeyId,
  normalizeIdentityPublicKey,
  isSupportedIdentityKey,
} from "@vanessa/protocol";
import type { RemoteApprovalProofContext, RemoteApprovalProofVerifier } from "./remoteTaskService.js";

/**
 * Verify proof from a distinct Android Keystore key. This key is created with
 * per-operation strong-biometric authentication and never doubles as the
 * device session identity. The signature binds every security-relevant field.
 */
export const verifyRemoteBiometricApproval: RemoteApprovalProofVerifier = async ({
  device,
  response,
  proof,
}: RemoteApprovalProofContext): Promise<boolean> => {
  if (!device.approvalPublicKeySpki || !device.approvalKeyId || !proof ||
      typeof proof !== "object" || Array.isArray(proof)) return false;

  const candidate = proof as Record<string, unknown>;
  if (candidate.approvalKeyId !== device.approvalKeyId ||
      typeof candidate.signature !== "string" ||
      !/^[A-Za-z0-9_-]{16,200}$/.test(candidate.signature)) return false;

  if (response.decision !== "approved" || response.method !== "biometric_strong") return false;
  const now = Date.now();
  if (!Number.isSafeInteger(response.approvedAt) ||
      response.approvedAt > now + 5_000 || now - response.approvedAt > 30_000) return false;

  try {
    const key = normalizeIdentityPublicKey(device.approvalPublicKeySpki);
    if (!isSupportedIdentityKey(key) || computeKeyId(key) !== device.approvalKeyId) return false;
    const publicKey = createPublicKey({
      key: Buffer.from(device.approvalPublicKeySpki, "base64url"),
      format: "der",
      type: "spki",
    });
    const signedFields = {
      approvalId: response.approvalId,
      taskId: response.taskId,
      actionHash: response.actionHash,
      decision: response.decision,
      approvedAt: response.approvedAt,
      method: response.method,
    };
    const message = Buffer.from(canonicalize(signedFields), "utf8");
    const signature = Buffer.from(candidate.signature, "base64url");
    return verify("sha256", message, publicKey, signature);
  } catch {
    return false;
  }
};
