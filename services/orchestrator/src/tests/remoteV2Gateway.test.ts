import assert from "node:assert/strict";
import { createServer } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { WebSocket } from "ws";
import {
  computeKeyId,
  decodeRemoteEnvelope,
  signRemoteEnvelope,
  verifyRemoteEnvelopeSignature,
} from "@vanessa/protocol";
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
    assert.equal(envelope.sessionId, "pre-session");
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
