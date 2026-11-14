import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { z } from "zod";

import {
  PRE_SESSION_ID,
  computeKeyId,
  createRemoteEnvelope,
  signRemoteEnvelope,
  verifyRemoteEnvelopeSignature,
  type RemoteEnvelope,
  type RemoteMessageType,
} from "@vanessa/protocol";
import { MobileTaskEngine } from "../core/mobileTaskEngine.js";
import type { MobileTool } from "../core/mobileToolRegistry.js";
import { RemotePairingRegistry } from "./remotePairingRegistry.js";
import { RemoteTaskService } from "./remoteTaskService.js";
import { RemoteV2Gateway } from "./remoteV2Gateway.js";

type Frame = RemoteEnvelope;

function keyPair() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    ...pair,
    publicKeySpki: (pair.publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64url"),
    keyId: computeKeyId(pair.publicKey),
  };
}

function signed(
  key: ReturnType<typeof keyPair>,
  type: RemoteMessageType,
  payload: Record<string, unknown>,
  sessionId: string,
  sequence: number,
): RemoteEnvelope {
  return signRemoteEnvelope(key.privateKey, createRemoteEnvelope({
    type, payload, keyId: key.keyId, sessionId, sequence,
  }));
}

function statusTool(): MobileTool {
  const schema = z.object({}).strict();
  return {
    name: "system_status",
    description: "Read PC status for the paired phone.",
    argsSchema: schema,
    manifestSchema: { type: "object", properties: {}, additionalProperties: false },
    tier: 0,
    timeoutMs: 1000,
    idempotent: true,
    queue: "read",
    handler: async () => ({
      platform: "win32",
      cpu: { model: "Test CPU", logicalCores: 8, usagePercent: 12 },
      memory: { totalBytes: 16_000, freeBytes: 8_000, usedPercent: 50 },
      capturedAt: Date.now(),
      privateDiagnostic: "must not cross the protocol",
    }),
    verifier: async (_args, result) => typeof (result as any)?.platform === "string",
  };
}

function createFrameReader(socket: WebSocket) {
  const queued: Frame[] = [];
  const waiters: Array<(frame: Frame) => void> = [];
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as Frame;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else queued.push(frame);
  });
  return async function next(type?: RemoteMessageType, timeoutMs = 5000): Promise<Frame> {
    const index = type ? queued.findIndex((frame) => frame.type === type) : 0;
    if (queued.length && index >= 0) return queued.splice(index, 1)[0];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frame = await new Promise<Frame>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type ?? "a remote frame"}`)), Math.max(1, deadline - Date.now()));
        waiters.push((item) => { clearTimeout(timer); resolve(item); });
      });
      if (!type || frame.type === type) return frame;
      queued.push(frame);
    }
    throw new Error(`Timed out waiting for ${type ?? "a remote frame"}`);
  };
}

async function send(socket: WebSocket, frame: RemoteEnvelope): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.send(JSON.stringify(frame), (error) => error ? reject(error) : resolve());
  });
}

test("v2 WebSocket pairs a phone, authenticates it, executes a PC task and returns a verified result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vanessa-v2-gateway-"));
  const pc = keyPair();
  const phone = keyPair();
  const biometricApproval = keyPair();
  let gateway: RemoteV2Gateway | undefined;
  const engine = new MobileTaskEngine({
    dbPath: join(directory, "tasks.sqlite"),
    tools: [statusTool()],
    notify: (event) => gateway?.publishTask(event),
  });
  const pairings = new RemotePairingRegistry({ storePath: join(directory, "trusted-devices.json") });
  await pairings.initialize();
  const taskService = new RemoteTaskService(engine, pairings);
  gateway = new RemoteV2Gateway({
    host: "127.0.0.1",
    port: 0,
    pcId: `pc_${pc.keyId.slice(0, 12)}`,
    pcName: "Test PC",
    pcKeyId: pc.keyId,
    pcPublicKeySpki: pc.publicKeySpki,
    sign: async (unsigned) => signRemoteEnvelope(pc.privateKey, unsigned),
    pairings,
    tasks: taskService,
  });

  let socket: WebSocket | undefined;
  try {
    await gateway.start();
    const address = gateway.address();
    // Web browsers are not supported clients. Their Origin header is rejected
    // before the server allocates a connection or emits a challenge.
    const browserAttempt = new WebSocket(`ws://${address.host}:${address.port}`, {
      headers: { Origin: "https://attacker.example" },
    });
    const browserStatus = await new Promise<number>((resolve, reject) => {
      browserAttempt.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      browserAttempt.once("error", reject);
    });
    assert.equal(browserStatus, 403);

    socket = new WebSocket(`ws://${address.host}:${address.port}`);
    const next = createFrameReader(socket);
    await new Promise<void>((resolve, reject) => {
      socket!.once("open", resolve);
      socket!.once("error", reject);
    });

    const initialChallenge = await next("server.challenge");
    assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, initialChallenge).ok, true);
    const initialPayload = initialChallenge.payload as Record<string, any>;
    assert.equal(initialPayload.protocolVersion, 2);
    assert.equal(initialPayload.pairingRequired, true);

    const window = pairings.createPairingWindow();
    const clientNonce = Buffer.from("client-nonce-for-vanessa-test").toString("base64url");
    await send(socket, signed(phone, "pairing.claim", {
      pairingId: window.pairingId,
      code: window.code,
      publicKey: phone.publicKeySpki,
      keyId: phone.keyId,
      approvalPublicKey: biometricApproval.publicKeySpki,
      approvalKeyId: biometricApproval.keyId,
      deviceHint: "pixel-test-phone",
      platform: "android",
      appVersion: "0.1.0",
      clientNonce,
    }, PRE_SESSION_ID, 0));

    const pairingChallenge = await next("pairing.challenge");
    assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, pairingChallenge).ok, true);
    const challengePayload = pairingChallenge.payload as Record<string, any>;
    assert.equal(challengePayload.clientNonce, clientNonce);

    await send(socket, signed(phone, "pairing.complete", {
      pairingId: window.pairingId,
      // Pairing completion echoes the raw nonce in a signed envelope.
      challengeNonce: challengePayload.nonce,
    }, PRE_SESSION_ID, 1));
    const pending = await next(undefined, 5000);
    assert.equal(
      pending.type,
      "pairing.pending",
      `PC rejected pairing completion: ${JSON.stringify(pending.payload)}`,
    );
    assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, pending).ok, true);
    assert.equal((pending.payload as Record<string, any>).state, "awaiting_approval");
    // The PC-local manager reads this private capability from its authenticated
    // loopback registry API, not from the phone-visible pairing.pending event.
    assert.equal(pairings.getPendingApprovals()[0]?.biometricApprovalAvailable, true);

    await gateway.approvePairing(window.pairingId, ["system.read", "files.read", "apps.launch"]);
    const approved = await next("pairing.approved");
    assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, approved).ok, true);
    const freshChallenge = await next("server.challenge");
    assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, freshChallenge).ok, true);

    const sessionId = freshChallenge.sessionId;
    const serverNonce = (freshChallenge.payload as Record<string, any>).serverNonce;
    const authClientNonce = Buffer.from("client-auth-nonce-vanessa").toString("base64url");
    await send(socket, signed(phone, "client.authenticate", {
      serverNonce,
      clientNonce: authClientNonce,
      publicKey: phone.publicKeySpki,
      deviceHint: "pixel-test-phone",
      platform: "android",
      appVersion: "0.1.0",
    }, sessionId, 0));

    const ready = await next("session.ready");
    assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, ready).ok, true);
    const readyPayload = ready.payload as Record<string, any>;
    assert.equal(readyPayload.deviceId.length, 36);
    assert.deepEqual(readyPayload.grantedScopes, ["system.read", "files.read", "apps.launch"]);
    assert.equal(readyPayload.clientNonce, authClientNonce);
    assert.equal(pairings.getTrustedDeviceByKeyId(phone.keyId)?.approvalKeyId, biometricApproval.keyId);

    // Biometric verification material must survive a PC service restart.
    const reloadedPairings = new RemotePairingRegistry({ storePath: join(directory, "trusted-devices.json") });
    await reloadedPairings.initialize();
    assert.equal(reloadedPairings.getTrustedDeviceByKeyId(phone.keyId)?.approvalKeyId, biometricApproval.keyId);

    await send(socket, signed(phone, "manifest.get", {}, sessionId, 1));
    const manifest = await next("manifest.snapshot");
    assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, manifest).ok, true);
    assert.deepEqual((manifest.payload as Record<string, any>).capabilities.map((entry: any) => entry.name), ["system_status"]);

    const taskRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const taskFrame = signed(phone, "task.submit", {
      requestId: taskRequestId,
      idempotencyKey: "remote-status-e2e-0001",
      capability: "system_status",
      canonicalArguments: {},
      intent: "Read the PC system status",
    }, sessionId, 2);
    await send(socket, taskFrame);

    const accepted = await next("task.accepted");
    assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, accepted).ok, true);
    const acceptedPayload = accepted.payload as Record<string, any>;
    assert.equal(acceptedPayload.requestId, taskRequestId);

    const result = await next("task.result", 5000);
    assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, result).ok, true);
    const resultPayload = result.payload as Record<string, any>;
    assert.equal(resultPayload.taskId, acceptedPayload.taskId);
    assert.equal(resultPayload.status, "succeeded");
    assert.equal(resultPayload.verification.status, "verified");
    assert.equal(resultPayload.result.platform, "win32");
    assert.equal(JSON.stringify(resultPayload).includes("privateDiagnostic"), false);

    // Replaying the exact signed task envelope must be rejected before the
    // task adapter sees it for a second time.
    await send(socket, taskFrame);
    const replayError = await next("protocol.error");
    assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, replayError).ok, true);
    assert.equal((replayError.payload as Record<string, any>).code, "REPLAYED_MESSAGE");
  } finally {
    socket?.close();
    await gateway.stop();
    engine.close();
    await rm(directory, { recursive: true, force: true });
  }
});
