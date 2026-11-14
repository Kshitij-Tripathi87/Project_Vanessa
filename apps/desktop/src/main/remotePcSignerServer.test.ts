import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRemoteEnvelope, verifyRemoteEnvelopeSignature } from "@vanessa/protocol";
import { RemotePcIdentityStore, type PcIdentityEncryptionAdapter } from "./remotePcIdentityStore.js";
import { RemotePcSignerServer } from "./remotePcSignerServer.js";

class TestEncryption implements PcIdentityEncryptionAdapter {
  isAvailable(): boolean { return true; }
  encrypt(value: string): Buffer { return Buffer.from("encrypted:" + value); }
  decrypt(value: Buffer): string {
    const text = value.toString("utf8");
    if (!text.startsWith("encrypted:")) throw new Error("invalid fixture");
    return text.slice("encrypted:".length);
  }
}

test("PC signer signs authenticated loopback requests without exporting the private key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vanessa-pc-signer-"));
  const store = new RemotePcIdentityStore(join(directory, "identity.json"), new TestEncryption());
  const signer = new RemotePcSignerServer(store);
  try {
    const config = await signer.start();
    const health = await fetch(config.url + "/health", {
      headers: { Authorization: "Bearer " + config.token },
    });
    assert.equal(health.status, 200);

    const now = Date.now();
    const unsigned = createRemoteEnvelope({
      type: "server.challenge",
      keyId: config.keyId,
      payload: {
        serverNonce: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64url"),
        pcId: "pc-test-123",
        pcName: "Test PC",
        protocolVersion: 2,
        supportedVersions: [2],
        issuedAt: now,
        expiresAt: now + 30_000,
        pairingRequired: true,
      },
    });
    const denied = await fetch(config.url + "/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(unsigned),
    });
    assert.equal(denied.status, 401);

    const signedResponse = await fetch(config.url + "/sign", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(unsigned),
    });
    assert.equal(signedResponse.status, 200);
    const signed = await signedResponse.json();
    assert.equal(verifyRemoteEnvelopeSignature(config.publicKeySpki, signed as any).ok, true);
  } finally {
    await signer.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
