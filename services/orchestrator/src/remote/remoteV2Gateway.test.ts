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
    throw new Error(`Timed out waiting for ${type ?? "a remote frame"}; queued frames: ${queued.map((frame) => frame.type).join(", ") || "none"}`);
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
  let socket2: WebSocket | undefined;
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
    // A self-asserted public key is not enough to grant a destructive scope.
    assert.equal(pairings.getPendingApprovals()[0]?.biometricApprovalAvailable, false);

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
    assert.equal(pairings.getTrustedDeviceByKeyId(phone.keyId)?.approvalKeyHardwareAttested, false);

    // Biometric verification material must survive a PC service restart.
    const reloadedPairings = new RemotePairingRegistry({ storePath: join(directory, "trusted-devices.json") });
    await reloadedPairings.initialize();
    assert.equal(reloadedPairings.getTrustedDeviceByKeyId(phone.keyId)?.approvalKeyId, biometricApproval.keyId);
    assert.equal(reloadedPairings.getTrustedDeviceByKeyId(phone.keyId)?.approvalKeyHardwareAttested, false);

    await send(socket, signed(phone, "manifest.get", {}, sessionId, 1));
    const manifest = await next("manifest.snapshot");
    assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, manifest).ok, true);
    assert.deepEqual((manifest.payload as Record<string, any>).capabilities.map((entry: any) => entry.name), ["system_status"]);

    // A second session for the same trusted phone must not steal task events
    // from the socket that actually submitted the task.
    socket2 = new WebSocket("ws://" + address.host + ":" + address.port);
    const next2 = createFrameReader(socket2);
    await new Promise<void>((resolve, reject) => {
      socket2!.once("open", resolve);
      socket2!.once("error", reject);
    });
    const secondChallenge = await next2("server.challenge");
    const secondChallengePayload = secondChallenge.payload as Record<string, any>;
    const secondSessionId = secondChallenge.sessionId;
    await send(socket2, signed(phone, "client.authenticate", {
      serverNonce: secondChallengePayload.serverNonce,
      clientNonce: Buffer.from("second-session-client-nonce").toString("base64url"),
      publicKey: phone.publicKeySpki,
      deviceHint: "pixel-test-phone",
      platform: "android",
      appVersion: "0.1.0",
    }, secondSessionId, 0));
    const secondReady = await next2("session.ready");
    assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, secondReady).ok, true);

    const taskRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    // Submit through the second live session while the first session remains
    // connected. The result must be delivered to the submitting socket.
    const secondTaskFrame = signed(phone, "task.submit", {
      requestId: taskRequestId,
      idempotencyKey: "remote-status-e2e-0001",
      capability: "system_status",
      canonicalArguments: {},
      intent: "Read the PC system status",
    }, secondSessionId, 1);
    await send(socket2, secondTaskFrame);

    const accepted = await next2("task.accepted");
    assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, accepted).ok, true);
    const acceptedPayload = accepted.payload as Record<string, any>;
    assert.equal(acceptedPayload.requestId, taskRequestId);

    const result = await next2("task.result", 5000);
    assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, result).ok, true);
    const resultPayload = result.payload as Record<string, any>;
    assert.equal(resultPayload.taskId, acceptedPayload.taskId);
    assert.equal(resultPayload.status, "succeeded");
    assert.equal(resultPayload.verification.status, "verified");
    assert.equal(resultPayload.result.platform, "win32");
    assert.equal(JSON.stringify(resultPayload).includes("privateDiagnostic"), false);

    // A duplicate idempotency key returns the original durable task and
    // replays its terminal result on the current submitting session.
    await send(socket, signed(phone, "task.submit", {
      requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      idempotencyKey: "remote-status-e2e-0001",
      capability: "system_status",
      canonicalArguments: {},
      intent: "Retry the same status read",
    }, sessionId, 2));
    const duplicateAccepted = await next("task.accepted");
    assert.equal((duplicateAccepted.payload as Record<string, any>).taskId, acceptedPayload.taskId);
    const duplicateResult = await next("task.result", 5000);
    assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, duplicateResult).ok, true);
    assert.equal((duplicateResult.payload as Record<string, any>).taskId, acceptedPayload.taskId);
    assert.equal((duplicateResult.payload as Record<string, any>).status, "succeeded");

    // A reconnect asks for task IDs, not arbitrary device IDs. The server
    // restores only durable rows owned by the currently authenticated phone.
    await send(socket, signed(phone, "sync.resume", {
      lastEventSeq: 0,
      activeTaskIds: [acceptedPayload.taskId],
      clientNonce: Buffer.from("vanessa-recovery-nonce").toString("base64url"),
    }, sessionId, 3));
    const recoverySnapshot = await next("sync.snapshot");
    assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, recoverySnapshot).ok, true);
    const recoveredTasks = (recoverySnapshot.payload as Record<string, any>).tasks;
    assert.equal(recoveredTasks.length, 1);
    assert.equal(recoveredTasks[0].taskId, acceptedPayload.taskId);
    assert.equal(recoveredTasks[0].state, "succeeded");
    const recoveredResult = await next("task.result");
    assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, recoveredResult).ok, true);
    assert.equal((recoveredResult.payload as Record<string, any>).taskId, acceptedPayload.taskId);
    assert.equal((recoveredResult.payload as Record<string, any>).status, "succeeded");
    await next("sync.complete");

    // Replaying the exact signed ping is detected by message ID even when
    // its sequence is otherwise the latest accepted sequence.
    const pingFrame = signed(phone, "ping", { sentAt: Date.now() }, sessionId, 4);
    await send(socket, pingFrame);
    const pong = await next("pong");
    assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, pong).ok, true);
    await send(socket, pingFrame);
    const replayError = await next("protocol.error");
    assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, replayError).ok, true);
    assert.equal((replayError.payload as Record<string, any>).code, "REPLAYED_MESSAGE");
  } finally {
    socket?.close();
    socket2?.close();
    await gateway.stop();
    engine.close();
    await rm(directory, { recursive: true, force: true });
  }
});
 
test("pairing approval is not persisted when the phone disconnects before local approval", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vanessa-v2-disconnected-pairing-"));
  const pc = keyPair();
  const phone = keyPair();
  let gateway: RemoteV2Gateway | undefined;
  const engine = new MobileTaskEngine({ dbPath: join(directory, "tasks.sqlite"), tools: [statusTool()] });
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
    const window = pairings.createPairingWindow();
    socket = new WebSocket("ws://" + address.host + ":" + address.port);
    const next = createFrameReader(socket);
    await new Promise<void>((resolve, reject) => {
      socket!.once("open", resolve);
      socket!.once("error", reject);
    });
    await next("server.challenge");
    const clientNonce = Buffer.from("disconnect-test-client-nonce").toString("base64url");
    await send(socket, signed(phone, "pairing.claim", {
      pairingId: window.pairingId,
      code: window.code,
      publicKey: phone.publicKeySpki,
      keyId: phone.keyId,
      deviceHint: "pixel-disconnect-test",
      platform: "android",
      appVersion: "0.1.0",
      clientNonce,
    }, PRE_SESSION_ID, 0));
    const challenge = await next("pairing.challenge");
    const challengePayload = challenge.payload as Record<string, any>;
    await send(socket, signed(phone, "pairing.complete", {
      pairingId: window.pairingId,
      challengeNonce: challengePayload.nonce,
    }, PRE_SESSION_ID, 1));
    await next("pairing.pending");

    const closed = new Promise<void>((resolve) => socket!.once("close", () => resolve()));
    socket.close();
    await closed;

    await assert.rejects(
      gateway.approvePairing(window.pairingId, ["system.read"]),
      { code: "PAIRING_STATE_INVALID" },
    );
    assert.equal(pairings.getTrustedDeviceByKeyId(phone.keyId), undefined);
  } finally {
    socket?.close();
    await gateway.stop();
    engine.close();
    await rm(directory, { recursive: true, force: true });
  }
});
