import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { PRE_SESSION_ID, createRemoteEnvelope, computeKeyId, signRemoteEnvelope } from "@vanessa/protocol";
import { RemotePairingRegistry, PairingRegistryError } from "../remote/remotePairingRegistry.js";

const NOW = 1_760_000_000_000;

function newPhone() {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const keyId = computeKeyId(pair.publicKey);
  const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  return { ...pair, keyId, publicKey };
}

async function withRegistry(run: (registry: RemotePairingRegistry, advance: (millis: number) => void, storePath: string) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vanessa-v2-pairing-"));
  const storePath = path.join(directory, "trusted-devices.json");
  let now = NOW;
  const registry = new RemotePairingRegistry({
    storePath,
    now: () => now,
    pairingTtlMs: 5 * 60_000,
    challengeTtlMs: 2 * 60_000,
    sessionTtlMs: 24 * 60 * 60_000,
    maxCodeAttempts: 3,
  });
  await registry.initialize();
  try {
    await run(registry, (millis) => { now += millis; }, storePath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function claimEnvelope(phone: ReturnType<typeof newPhone>, pairing: { pairingId: string; code: string }, options: { code?: string; sequence?: number; sentAt?: number; clientNonce?: string } = {}) {
  return signRemoteEnvelope(phone.privateKey, createRemoteEnvelope({
    type: "pairing.claim",
    sessionId: PRE_SESSION_ID,
    keyId: phone.keyId,
    sequence: options.sequence ?? 0,
    sentAt: options.sentAt ?? NOW,
    payload: {
      pairingId: pairing.pairingId,
      code: options.code ?? pairing.code,
      publicKey: phone.publicKey,
      keyId: phone.keyId,
      deviceHint: "pixel-9-pro",
      platform: "android",
      appVersion: "0.1.0",
      clientNonce: options.clientNonce ?? randomBytes(24).toString("base64url"),
    },
  }));
}

function completeEnvelope(phone: ReturnType<typeof newPhone>, pairingId: string, challengeNonce: string, sequence = 1) {
  return signRemoteEnvelope(phone.privateKey, createRemoteEnvelope({
    type: "pairing.complete",
    sessionId: PRE_SESSION_ID,
    keyId: phone.keyId,
    sequence,
    sentAt: NOW + 100,
    payload: { pairingId, challengeNonce },
  }));
}

test("pairing requires a signed claim, challenge completion, and local approval", async () => {
  await withRegistry(async (registry, _advance, storePath) => {
    const phone = newPhone();
    const window = registry.createPairingWindow(NOW);
    const clientNonce = randomBytes(24).toString("base64url");
    const challenge = registry.claim(claimEnvelope(phone, window, { clientNonce }), NOW);
    assert.equal(challenge.pairingId, window.pairingId);
    assert.equal(challenge.clientNonce, clientNonce);
    assert.ok(challenge.expiresAt > NOW);

    const pending = registry.complete(completeEnvelope(phone, window.pairingId, challenge.nonce), NOW + 100);
    assert.deepEqual(pending, {
      pairingId: window.pairingId,
      state: "awaiting_approval",
      expiresAt: challenge.expiresAt,
    });
    assert.equal(registry.getPendingApprovals().length, 1);
    assert.equal(registry.listTrustedDevices().length, 0);

    const approved = await registry.approve(window.pairingId, ["system.read", "calendar.read"], NOW + 200);
    assert.equal(approved.keyId, phone.keyId);
    assert.deepEqual(approved.grantedScopes, ["system.read", "calendar.read"]);
    assert.ok(approved.deviceId.length >= 8);
    assert.equal(approved.clientNonce, clientNonce);
    assert.equal(approved.serverNonce, challenge.nonce);

    const trusted = registry.getTrustedDeviceByKeyId(phone.keyId);
    assert.equal(trusted?.deviceId, approved.deviceId);
    assert.equal(trusted?.revoked, false);
    assert.equal(fs.existsSync(storePath), true);

    const restored = new RemotePairingRegistry({ storePath });
    await restored.initialize();
    assert.equal(restored.getTrustedDeviceByKeyId(phone.keyId)?.deviceId, approved.deviceId);
  });
});

test("a bad code does not consume the code until the bounded attempt limit", async () => {
  await withRegistry(async (registry) => {
    const phone = newPhone();
    const window = registry.createPairingWindow(NOW);
    assert.throws(
      () => registry.claim(claimEnvelope(phone, window, { code: "0".repeat(48) }), NOW),
      (error: unknown) => error instanceof PairingRegistryError && error.code === "PAIRING_CODE_INVALID",
    );
    const challenge = registry.claim(claimEnvelope(phone, window), NOW);
    assert.equal(challenge.pairingId, window.pairingId);
    assert.throws(
      () => registry.claim(claimEnvelope(phone, window), NOW),
      (error: unknown) => error instanceof PairingRegistryError && error.code === "PAIRING_ALREADY_CLAIMED",
    );
  });
});

test("pairing code locks after the configured number of failed code checks", async () => {
  await withRegistry(async (registry) => {
    const phone = newPhone();
    const window = registry.createPairingWindow(NOW);
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.throws(
        () => registry.claim(claimEnvelope(phone, window, { code: String(attempt).repeat(48) }), NOW),
        (error: unknown) => error instanceof PairingRegistryError && error.code === "PAIRING_CODE_INVALID",
      );
    }
    assert.throws(
      () => registry.claim(claimEnvelope(phone, window), NOW),
      (error: unknown) => error instanceof PairingRegistryError && error.code === "PAIRING_EXPIRED",
    );
  });
});

test("invalid phone signatures and mismatched challenge responses are rejected", async () => {
  await withRegistry(async (registry) => {
    const phone = newPhone();
    const window = registry.createPairingWindow(NOW);
    const claim = claimEnvelope(phone, window);
    const tampered = { ...claim, payload: { ...claim.payload, code: "f".repeat(48) } };
    assert.throws(
      () => registry.claim(tampered, NOW),
      (error: unknown) => error instanceof PairingRegistryError && error.code === "PAIRING_PROOF_INVALID",
    );

    const challenge = registry.claim(claim, NOW);
    assert.throws(
      () => registry.complete(completeEnvelope(phone, window.pairingId, "x".repeat(32)), NOW + 100),
      (error: unknown) => error instanceof PairingRegistryError && error.code === "PAIRING_PROOF_INVALID",
    );
  });
});

test("pairing challenge expires and cannot be approved after timeout", async () => {
  await withRegistry(async (registry, advance) => {
    const phone = newPhone();
    const window = registry.createPairingWindow(NOW);
    const challenge = registry.claim(claimEnvelope(phone, window), NOW);
    advance(2 * 60_000 + 1);
    assert.deepEqual(registry.getPendingApprovals(), []);
    assert.throws(
      () => registry.complete(completeEnvelope(phone, window.pairingId, challenge.nonce), NOW + 2 * 60_000 + 1),
      (error: unknown) => error instanceof PairingRegistryError && error.code === "PAIRING_EXPIRED",
    );
  });
});

test("local rejection and device revocation never grant or preserve trust", async () => {
  await withRegistry(async (registry) => {
    const phone = newPhone();
    const window = registry.createPairingWindow(NOW);
    const challenge = registry.claim(claimEnvelope(phone, window), NOW);
    registry.complete(completeEnvelope(phone, window.pairingId, challenge.nonce), NOW + 100);
    assert.deepEqual(registry.reject(window.pairingId), {
      pairingId: window.pairingId,
      reason: "declined_on_pc",
    });
    await assert.rejects(registry.approve(window.pairingId, ["system.read"], NOW + 200), {
      code: "PAIRING_STATE_INVALID",
    });
    assert.equal(registry.listTrustedDevices().length, 0);

    const next = registry.createPairingWindow(NOW + 300);
    const secondChallenge = registry.claim(claimEnvelope(phone, next), NOW + 300);
    registry.complete(completeEnvelope(phone, next.pairingId, secondChallenge.nonce), NOW + 400);
    const grant = await registry.approve(next.pairingId, ["system.read"], NOW + 500);
    assert.equal(await registry.revokeDevice(grant.deviceId), true);
    assert.equal(registry.getTrustedDeviceByKeyId(phone.keyId)?.revoked, true);
  });
});

test("trusted-device restore rejects duplicate or malformed identity records", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vanessa-v2-invalid-store-"));
  const storePath = path.join(directory, "trusted-devices.json");
  const phone = newPhone();
  const malformed = {
    version: 1,
    devices: [{
      deviceId: "not-a-uuid",
      keyId: phone.keyId,
      publicKeySpki: phone.publicKey,
      deviceHint: "pixel-9-pro",
      platform: "android",
      appVersion: "0.1.0",
      grantedScopes: ["system.read"],
      pairedAt: NOW,
      revoked: false,
    }],
  };
  fs.writeFileSync(storePath, JSON.stringify(malformed), "utf8");
  const registry = new RemotePairingRegistry({ storePath });
  try {
    await assert.rejects(registry.initialize(), /invalid record/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("trusted-device restore rejects duplicate capability scopes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vanessa-v2-duplicate-scopes-"));
  const storePath = path.join(directory, "trusted-devices.json");
  const phone = newPhone();
  fs.writeFileSync(storePath, JSON.stringify({
    version: 1,
    devices: [{
      deviceId: "11112222-3333-4444-8555-666677778888",
      keyId: phone.keyId,
      publicKeySpki: phone.publicKey,
      deviceHint: "pixel-9-pro",
      platform: "android",
      appVersion: "0.1.0",
      grantedScopes: ["system.read", "system.read"],
      pairedAt: NOW,
      revoked: false,
    }],
  }), "utf8");
  const registry = new RemotePairingRegistry({ storePath });
  try {
    await assert.rejects(registry.initialize(), /invalid permission scopes/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
