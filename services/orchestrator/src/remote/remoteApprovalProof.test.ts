import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { canonicalize, computeKeyId } from "@vanessa/protocol";
import type { TrustedRemoteDevice } from "./remotePairingRegistry.js";
import { verifyRemoteBiometricApproval } from "./remoteApprovalProof.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicKeySpki = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const approvalKeyId = computeKeyId(publicKeySpki);
const DEVICE_ID = "11112222-3333-4444-8555-666677778888";
const TASK_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APPROVAL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACTION_HASH = "c".repeat(64);

function device(overrides: Partial<TrustedRemoteDevice> = {}): TrustedRemoteDevice {
  return {
    deviceId: DEVICE_ID,
    keyId: "phone_key_id_123456",
    publicKeySpki,
    approvalPublicKeySpki: publicKeySpki,
    approvalKeyId,
    deviceHint: "android-test",
    platform: "android",
    appVersion: "0.1.0",
    grantedScopes: ["files.delete"],
    pairedAt: Date.now(),
    revoked: false,
    ...overrides,
  };
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    approvalId: APPROVAL_ID,
    taskId: TASK_ID,
    actionHash: ACTION_HASH,
    decision: "approved" as const,
    approvedAt: Date.now(),
    method: "biometric_strong",
    ...overrides,
  };
}

function makeProof(input: ReturnType<typeof response>, key = privateKey) {
  const signedFields = {
    approvalId: input.approvalId,
    taskId: input.taskId,
    actionHash: input.actionHash,
    decision: input.decision,
    approvedAt: input.approvedAt,
    method: input.method,
  };
  const signature = sign("sha256", Buffer.from(canonicalize(signedFields), "utf8"), key);
  return { approvalKeyId, signature: signature.toString("base64url") };
}

test("accepts a valid action-bound strong-biometric signature", async () => {
  const approval = response();
  assert.equal(await verifyRemoteBiometricApproval({
    device: device(),
    response: approval as any,
    proof: makeProof(approval),
  }), true);
});

test("rejects an altered action hash even when the signature is otherwise valid", async () => {
  const approval = response();
  const proof = makeProof(approval);
  assert.equal(await verifyRemoteBiometricApproval({
    device: device(),
    response: { ...approval, actionHash: "d".repeat(64) } as any,
    proof,
  }), false);
});

test("rejects proof from an unregistered biometric key", async () => {
  const approval = response();
  const differentKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const proof = makeProof(approval, differentKey.privateKey);
  assert.equal(await verifyRemoteBiometricApproval({
    device: device(),
    response: approval as any,
    proof,
  }), false);
});

test("rejects old, future, denied or incorrectly labelled approvals", async () => {
  const base = response();
  const proof = makeProof(base);
  assert.equal(await verifyRemoteBiometricApproval({
    device: device(),
    response: { ...base, approvedAt: Date.now() - 60_000 } as any,
    proof,
  }), false);
  assert.equal(await verifyRemoteBiometricApproval({
    device: device(),
    response: { ...base, approvedAt: Date.now() + 30_000 } as any,
    proof,
  }), false);
  assert.equal(await verifyRemoteBiometricApproval({
    device: device(),
    response: { ...base, decision: "denied" } as any,
    proof,
  }), false);
  assert.equal(await verifyRemoteBiometricApproval({
    device: device(),
    response: { ...base, method: "device_session" } as any,
    proof,
  }), false);
});

test("rejects missing, mismatched, or malformed approval-key registrations", async () => {
  const approval = response();
  const proof = makeProof(approval);
  assert.equal(await verifyRemoteBiometricApproval({
    device: device({ approvalKeyId: undefined, approvalPublicKeySpki: undefined }),
    response: approval as any,
    proof,
  }), false);
  assert.equal(await verifyRemoteBiometricApproval({
    device: device({ approvalKeyId: "another_key_id_12345" }),
    response: approval as any,
    proof,
  }), false);
  assert.equal(await verifyRemoteBiometricApproval({
    device: device(),
    response: approval as any,
    proof: { approvalKeyId, signature: "not-a-signature" },
  }), false);
});
