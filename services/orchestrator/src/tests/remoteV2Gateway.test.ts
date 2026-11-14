import assert from "node:assert/strict";
import { createServer } from "node:net";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import {
  PRE_SESSION_ID,
  computeKeyId,
  createRemoteEnvelope,
  decodeRemoteEnvelope,
  signRemoteEnvelope,
  verifyRemoteEnvelopeSignature,
} from "@vanessa/protocol";
import { RemotePairingRegistry } from "../remote/remotePairingRegistry.js";
import { RemoteV2Gateway } from "../remote/remoteV2Gateway.js";

function createGateway(overrides: Record<string, unknown> = {}) {
  const pairings = {
    createPairingWindow: () => ({
      pairingId: "pair_0123456789abcdef01234567",
      code: "a".repeat(48),
      createdAt: 1_800_000_000_000,
      expiresAt: 1_800_000_300_000,
    }),
    listTrustedDevices: () => [],
  };
  return new RemoteV2Gateway({
    pcName: "Vanessa PC",
    identity: {
      keyId: "pc_test_key_id_123456",
      publicKeySpki: "A".repeat(80),
      sign: async (envelope: unknown) => envelope,
    },
    pairings: pairings as never,
    tasks: {} as never,
    ...overrides,
  } as never);
}

test("remote v2 gateway refuses every non-loopback bind address", () => {
  assert.throws(() => createGateway({ host: "0.0.0.0" }), /localhost/);
  assert.throws(() => createGateway({ host: "192.168.1.20" }), /localhost/);
  assert.throws(() => createGateway({ host: "100.64.0.4" }), /localhost/);
});

test("remote v2 gateway accepts only Tailscale MagicDNS WSS ingress", () => {
  const http = createGateway({ publicWebSocketUrl: "https://vanessa.example.ts.net/remote-v2" });
  assert.throws(() => http.createPairingPayload(), /Tailscale MagicDNS/);
  const publicHost = createGateway({ publicWebSocketUrl: "wss://vanessa.example.com/remote-v2" });
  assert.throws(() => publicHost.createPairingPayload(), /Tailscale MagicDNS/);
  const customPort = createGateway({ publicWebSocketUrl: "wss://vanessa.example.ts.net:444/remote-v2" });
  assert.throws(() => customPort.createPairingPayload(), /Tailscale MagicDNS/);
  const wrongPath = createGateway({ publicWebSocketUrl: "wss://vanessa.example.ts.net/other" });
  assert.throws(() => wrongPath.createPairingPayload(), /path/);
});

test("remote v2 QR uses the exact WSS route and includes a one-time pairing credential", () => {
  const gateway = createGateway({ publicWebSocketUrl: "wss://vanessa.example.ts.net/" });
  const created = gateway.createPairingPayload();
  const qr = JSON.parse(created.payload);
  assert.equal(qr.wsUrl, "wss://vanessa.example.ts.net/remote-v2");
  assert.equal(qr.protocolVersion, 2);
  assert.equal(qr.pairingId, created.window.pairingId);
  assert.equal(qr.code, created.window.code);
  assert.equal(qr.expiresAt, created.window.expiresAt);
});


test("gateway waits for a loopback listener and sends a verifiable signed challenge", async () => {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = (probe.address() as import("node:net").AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const keyId = computeKeyId(pair.publicKey);
  const publicKeySpki = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const pairings = { initialize: async () => undefined };

  const gateway = new RemoteV2Gateway({
    host: "127.0.0.1",
    port,
    pcName: "Vanessa Test PC",
    identity: {
      keyId,
      publicKeySpki,
      sign: async (envelope) => signRemoteEnvelope(pair.privateKey, envelope),
    },
    pairings: pairings as never,
    tasks: {} as never,
  });

  let socket: WebSocket | undefined;
  try {
    await gateway.start();
    socket = new WebSocket(`ws://127.0.0.1:${port}/remote-v2`);
    const raw = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Gateway challenge timed out.")), 5_000);
      socket!.once("message", (data) => {
        clearTimeout(timer);
        resolve(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      });
      socket!.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const envelope = decodeRemoteEnvelope(raw);
    assert.equal(envelope.type, "server.challenge");
    assert.equal(envelope.keyId, keyId);
    assert.equal(envelope.sessionId, PRE_SESSION_ID);
    assert.equal(verifyRemoteEnvelopeSignature(pair.publicKey, envelope).ok, true);
  } finally {
    if (socket && socket.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        socket!.once("close", () => resolve());
        socket!.close();
      });
    }
    await gateway.close();
  }
});


test("phone pairs, receives local approval, authenticates, submits task and receives verified result", async () => {
  const temp = await mkdtemp(join(tmpdir(), "vanessa-remote-v2-"));
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = (probe.address() as import("node:net").AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

  const pc = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const phone = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const approval = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pcKeyId = computeKeyId(pc.publicKey);
  const phoneKeyId = computeKeyId(phone.publicKey);
  const pcPublicKeySpki = pc.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const phonePublicKeySpki = phone.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const approvalPublicKeySpki = approval.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const pairings = new RemotePairingRegistry({ storePath: join(temp, "trusted-devices.json") });
  await pairings.initialize();
  const pairingWindow = pairings.createPairingWindow();
  const taskId = randomUUID();

  const gateway = new RemoteV2Gateway({
    host: "127.0.0.1",
    port,
    pcName: "Vanessa Integration PC",
    identity: {
      keyId: pcKeyId,
      publicKeySpki: pcPublicKeySpki,
      sign: async (envelope) => signRemoteEnvelope(pc.privateKey, envelope),
    },
    pairings,
    tasks: {
      manifestSnapshot: () => ({
        manifestVersion: "test-v1",
        generatedAt: Date.now(),
        capabilities: [],
        policyVersion: "mobile-policy-v1",
      }),
      submitTask: async (_keyId: string, payload: { requestId: string }) => ({
        accepted: {
          requestId: payload.requestId,
          taskId,
          state: "accepted" as const,
          taskVersion: 1,
          eventSeq: 1,
          acceptedAt: Date.now(),
        },
      }),
    } as never,
  });

  let socket: WebSocket | undefined;
  try {
    await gateway.start();
    socket = new WebSocket(\`ws://127.0.0.1:\${port}/remote-v2\`);
    const challengePromise = new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Gateway challenge timed out.")), 5_000);
      socket!.once("message", (data) => {
        clearTimeout(timer);
        resolve(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      });
      socket!.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    await new Promise<void>((resolve, reject) => {
      socket!.once("open", resolve);
      socket!.once("error", reject);
    });
    const firstFrame = decodeRemoteEnvelope(await challengePromise);
    assert.equal(firstFrame.type, "server.challenge");
    assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, firstFrame).ok, true);

    const receive = async () => {
      const raw = await new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Remote v2 response timed out.")), 5_000);
        socket!.once("message", (data) => {
          clearTimeout(timer);
          resolve(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        });
        socket!.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      const envelope = decodeRemoteEnvelope(raw);
      assert.equal(envelope.keyId, pcKeyId);
      assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, envelope).ok, true);
      return envelope;
    };
    const send = (
      type: "pairing.claim" | "pairing.complete" | "manifest.get" | "task.submit",
      payload: Record<string, unknown>,
      sessionId: string,
      sequence: number,
    ) => {
      const unsigned = createRemoteEnvelope({
        type,
        payload,
        keyId: phoneKeyId,
        sessionId,
        sequence,
        sentAt: Date.now(),
      });
      socket!.send(JSON.stringify(signRemoteEnvelope(phone.privateKey, unsigned)));
    };

    const clientNonce = randomBytes(24).toString("base64url");
    send("pairing.claim", {
      pairingId: pairingWindow.pairingId,
      code: pairingWindow.code,
      publicKey: phonePublicKeySpki,
      approvalPublicKey: approvalPublicKeySpki,
      keyId: phoneKeyId,
      deviceHint: "android-integration-test",
      platform: "android",
      appVersion: "test",
      clientNonce,
    }, PRE_SESSION_ID, 0);

    const pairingChallenge = await receive();
    assert.equal(pairingChallenge.type, "pairing.challenge");
    assert.equal(pairingChallenge.payload.clientNonce, clientNonce);
    const challengeNonce = String(pairingChallenge.payload.nonce);
    send("pairing.complete", {
      pairingId: pairingWindow.pairingId,
      challengeNonce,
    }, PRE_SESSION_ID, 1);

    const pending = await receive();
    assert.equal(pending.type, "pairing.pending");
    assert.equal(pending.payload.state, "awaiting_approval");

    const approved = await gateway.approvePairing(pairingWindow.pairingId, ["system.read"]);
    assert.equal(approved.keyId, phoneKeyId);
    const pairingApproved = await receive();
    assert.equal(pairingApproved.type, "pairing.approved");
    assert.equal(pairingApproved.payload.keyId, phoneKeyId);
    const sessionReady = await receive();
    assert.equal(sessionReady.type, "session.ready");
    const sessionId = String(sessionReady.payload.sessionId);
    assert.equal(sessionReady.payload.deviceId, approved.deviceId);
    const trusted = pairings.getTrustedDeviceByKeyId(phoneKeyId);
    assert.equal(trusted?.approvalPublicKeySpki, approvalPublicKeySpki);
    assert.equal(trusted?.grantedScopes.includes("system.read"), true);

    send("manifest.get", {}, sessionId, 0);
    const manifest = await receive();
    assert.equal(manifest.type, "manifest.snapshot");
    assert.equal(manifest.sessionId, sessionId);

    const requestId = randomUUID();
    send("task.submit", {
      requestId,
      idempotencyKey: randomUUID(),
      capability: "open_url",
      canonicalArguments: { url: "https://example.com" },
      intent: "Open a safe test URL",
    }, sessionId, 1);
    const accepted = await receive();
    assert.equal(accepted.type, "task.accepted");
    assert.equal(accepted.payload.taskId, taskId);
    assert.equal(accepted.payload.requestId, requestId);

    gateway.publishTaskUpdate({
      deviceId: approved.deviceId,
      task: {
        taskId,
        requestId,
        tool: "open_url",
        state: "done",
        result: { opened: true, url: "https://example.com" },
      },
    });
    const result = await receive();
    assert.equal(result.type, "task.result");
    assert.equal(result.payload.taskId, taskId);
    assert.equal(result.payload.status, "succeeded");
    assert.equal((result.payload.verification as Record<string, unknown>).status, "verified");
  } finally {
    if (socket && socket.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        socket!.once("close", () => resolve());
        socket!.close();
      });
    }
    await gateway.close();
    await rm(temp, { recursive: true, force: true });
  }
});
