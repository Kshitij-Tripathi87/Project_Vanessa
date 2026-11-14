import assert from "node:assert/strict";
import test from "node:test";
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

test("remote v2 gateway rejects non-WSS or mismatched ingress URLs", () => {
  const http = createGateway({ publicWebSocketUrl: "https://vanessa.example.ts.net/remote-v2" });
  assert.throws(() => http.createPairingPayload(), /wss/);
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
