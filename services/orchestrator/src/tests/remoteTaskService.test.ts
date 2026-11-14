import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { z } from "zod";

import type { TrustedRemoteDevice, RemotePairingRegistry } from "../remote/remotePairingRegistry.js";
import { RemoteTaskService } from "../remote/remoteTaskService.js";
import { MobileTaskEngine } from "../core/mobileTaskEngine.js";
import type { MobileTool } from "../core/mobileToolRegistry.js";

const PHONE_KEY_ID = "phone_key_id_123456";
const PHONE_DEVICE_ID = "11112222-3333-4444-8555-666677778888";

function trustedDevice(scopes: string[], overrides: Partial<TrustedRemoteDevice> = {}): TrustedRemoteDevice {
  return {
    deviceId: PHONE_DEVICE_ID,
    keyId: PHONE_KEY_ID,
    publicKeySpki: "test-public-key",
    deviceHint: "pixel-test-device",
    platform: "android",
    appVersion: "0.1.0",
    grantedScopes: scopes,
    pairedAt: 1_760_000_000_000,
    revoked: false,
    ...overrides,
  };
}

function pairings(device: TrustedRemoteDevice): Pick<RemotePairingRegistry, "getTrustedDeviceByKeyId"> {
  return {
    getTrustedDeviceByKeyId: (keyId: string) => keyId === device.keyId ? device : undefined,
  };
}

function systemStatusTool(): MobileTool {
  const schema = z.object({ metric: z.enum(["battery", "cpu", "all"]).default("all") }).strict();
  return {
    name: "system_status",
    description: "Read PC status for the paired phone.",
    argsSchema: schema,
    manifestSchema: {
      type: "object",
      properties: { metric: { type: "string", enum: ["battery", "cpu", "all"], default: "all" } },
      additionalProperties: false,
    },
    tier: 0,
    timeoutMs: 1000,
    idempotent: true,
    queue: "read",
    handler: async ({ metric }: { metric: string }) => ({ metric, hostname: "test-pc" }),
    verifier: async (_args: unknown, result: unknown) => typeof (result as any)?.hostname === "string",
  };
}

function deleteTool(): MobileTool {
  const schema = z.object({ path: z.string().min(1) }).strict();
  return {
    name: "delete_file",
    description: "Move one file to the Windows Recycle Bin.",
    argsSchema: schema,
    manifestSchema: {
      type: "object",
      properties: { path: { type: "string", minLength: 1 } },
      required: ["path"],
      additionalProperties: false,
    },
    tier: 2,
    timeoutMs: 1000,
    idempotent: false,
    queue: "ui",
    confirmSummary: ({ path: target }: { path: string }) => `Move ${target} to the Recycle Bin`,
    handler: async ({ path: target }: { path: string }) => ({ movedToRecycleBin: true, fileName: path.basename(target) }),
    verifier: async (_args: unknown, result: unknown) => (result as any)?.movedToRecycleBin === true,
  };
}

async function withEngine(
  tools: MobileTool[],
  run: (engine: MobileTaskEngine) => Promise<void>,
): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vanessa-remote-task-service-"));
  const engine = new MobileTaskEngine({ dbPath: path.join(directory, "tasks.db"), tools });
  try {
    await run(engine);
  } finally {
    engine.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const waitFor = async (check: () => boolean, timeoutMs = 1500): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for remote task state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("manifest is derived from PC capabilities and filtered by the trusted device scopes", async () => {
  const device = trustedDevice(["system.read"]);
  await withEngine([systemStatusTool(), deleteTool()], async (engine) => {
    const service = new RemoteTaskService(engine, pairings(device), { now: () => 1_800_000_000_000 });
    const manifest = service.manifestSnapshot(PHONE_KEY_ID);
    assert.equal(manifest.policyVersion, "mobile-policy-v1");
    assert.deepEqual(manifest.capabilities.map((capability) => capability.name), ["system_status"]);
    assert.equal(manifest.capabilities[0].tier, "T0");
    assert.deepEqual(manifest.capabilities[0].scopes, ["system.read"]);
    assert.equal(manifest.generatedAt, 1_800_000_000_000);
  });
});

test("task submission resolves device identity and permission scopes on the PC", async () => {
  const device = trustedDevice(["system.read"]);
  await withEngine([systemStatusTool()], async (engine) => {
    const service = new RemoteTaskService(engine, pairings(device));
    const result = await service.submitTask(PHONE_KEY_ID, {
      requestId,
      idempotencyKey: "phone-request-0001",
      capability: "system_status",
      canonicalArguments: { metric: "cpu" },
    });
    assert.equal(result.accepted.requestId, requestId);
    assert.equal(result.accepted.state, "accepted");
    assert.match(result.accepted.taskId, /^[0-9a-f-]{36}$/);
    await waitFor(() => engine.getTask(result.accepted.taskId)?.state === "done");
    assert.equal(engine.getTask(result.accepted.taskId)?.result && (engine.getTask(result.accepted.taskId)?.result as any).metric, "cpu");
    assert.equal(engine.recentAudit()[0]?.deviceId, PHONE_DEVICE_ID);

    const retried = await service.submitTask(PHONE_KEY_ID, {
      requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      idempotencyKey: "phone-request-0001",
      capability: "system_status",
      canonicalArguments: { metric: "cpu" },
    });
    assert.equal(retried.accepted.taskId, result.accepted.taskId);
    assert.equal(retried.accepted.requestId, requestId);
    assert.equal(retried.accepted.acceptedAt, result.accepted.acceptedAt);
  });
});

test("the same remote idempotency key cannot be rebound to changed arguments", async () => {
  const device = trustedDevice(["system.read"]);
  await withEngine([systemStatusTool()], async (engine) => {
    const service = new RemoteTaskService(engine, pairings(device));
    await service.submitTask(PHONE_KEY_ID, {
      requestId,
      idempotencyKey: "phone-request-0002",
      capability: "system_status",
      canonicalArguments: { metric: "battery" },
    });
    await assert.rejects(service.submitTask(PHONE_KEY_ID, {
      requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      idempotencyKey: "phone-request-0002",
      capability: "system_status",
      canonicalArguments: { metric: "cpu" },
    }), { code: "IDEMPOTENCY_CONFLICT" });
  });
});

test("ungranted scopes, unknown identities and revoked devices fail closed", async () => {
  const noScopes = trustedDevice([]);
  const revoked = { ...trustedDevice(["system.read"]), revoked: true };
  await withEngine([systemStatusTool()], async (engine) => {
    const denied = new RemoteTaskService(engine, pairings(noScopes));
    await assert.rejects(denied.submitTask(PHONE_KEY_ID, {
      requestId,
      idempotencyKey: "phone-request-0003",
      capability: "system_status",
      canonicalArguments: {},
    }), { code: "SCOPE_REQUIRED" });

    const unknown = new RemoteTaskService(engine, {
      getTrustedDeviceByKeyId: () => undefined,
    });
    assert.throws(() => unknown.manifestSnapshot(PHONE_KEY_ID), { code: "UNKNOWN_KEY" });

    const revokedService = new RemoteTaskService(engine, pairings(revoked));
    assert.throws(() => revokedService.manifestSnapshot(PHONE_KEY_ID), { code: "REVOKED_DEVICE" });
  });
});

test("T2 capability submissions fail before task creation when no biometric key is registered", async () => {
  const device = trustedDevice(["files.delete"]);
  await withEngine([deleteTool()], async (engine) => {
    const service = new RemoteTaskService(engine, pairings(device));
    assert.deepEqual(service.manifestSnapshot(PHONE_KEY_ID).capabilities, []);
    await assert.rejects(service.submitTask(PHONE_KEY_ID, {
      requestId,
      idempotencyKey: "phone-delete-without-biometric",
      capability: "delete_file",
      canonicalArguments: { path: "C:/Users/test/Downloads/report.pdf" },
    }), { code: "PERMISSION_DENIED" });
    assert.equal(engine.recentAudit().length, 0);
  });
});

test("destructive approval remains blocked until a biometric-bound proof verifier accepts it", async () => {
  const device = trustedDevice(["files.delete"], {
    approvalPublicKeySpki: "registered-p256-test-key",
    approvalKeyId: "registered_approval_key_123",
  });
  await withEngine([deleteTool()], async (engine) => {
    const service = new RemoteTaskService(engine, pairings(device));
    const submission = await service.submitTask(PHONE_KEY_ID, {
      requestId,
      idempotencyKey: "phone-delete-request-1",
      capability: "delete_file",
      canonicalArguments: { path: "C:/Users/test/Downloads/report.pdf" },
    });
    const approval = submission.confirmationRequired?.approval;
    assert.ok(approval);
    assert.equal(approval.deviceId, PHONE_DEVICE_ID);
    assert.equal(approval.target.kind, "file");
    assert.equal(approval.target.value, "C:/Users/test/Downloads/report.pdf");
    assert.equal(engine.getTask(approval.taskId)?.state, "awaiting_confirm");

    const response = {
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      actionHash: approval.actionHash,
      decision: "approved" as const,
      approvedAt: Date.now(),
      method: "biometric_strong",
    };
    await assert.rejects(service.confirmTask(PHONE_KEY_ID, response, { token: "unverified" }), {
      code: "PERMISSION_DENIED",
    });
    assert.equal(engine.getTask(approval.taskId)?.state, "awaiting_confirm");

    const verifiedService = new RemoteTaskService(engine, pairings(device), {
      verifyApprovalProof: async ({ proof, device: trusted }) =>
        trusted.deviceId === PHONE_DEVICE_ID && (proof as any)?.assertion === "verified-test-assertion",
    });
    await verifiedService.confirmTask(PHONE_KEY_ID, response, { assertion: "verified-test-assertion" });
    await waitFor(() => engine.getTask(approval.taskId)?.state === "done");
  });
});

test("an authenticated phone with a registered biometric key may deny its pending approval without a proof", async () => {
  const device = trustedDevice(["files.delete"], {
    approvalPublicKeySpki: "registered-p256-test-key",
    approvalKeyId: "registered_approval_key_123",
  });
  await withEngine([deleteTool()], async (engine) => {
    const service = new RemoteTaskService(engine, pairings(device));
    const submission = await service.submitTask(PHONE_KEY_ID, {
      requestId,
      idempotencyKey: "phone-delete-request-2",
      capability: "delete_file",
      canonicalArguments: { path: "C:/Users/test/Downloads/other.pdf" },
    });
    const approval = submission.confirmationRequired!.approval;
    await service.confirmTask(PHONE_KEY_ID, {
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      actionHash: approval.actionHash,
      decision: "denied",
      approvedAt: Date.now(),
      method: "device_session",
    });
    assert.equal(engine.getTask(approval.taskId)?.state, "cancelled");
  });
});
