import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RemotePcIdentityStore, type PcIdentityEncryptionAdapter } from "./remotePcIdentityStore.js";

class TestEncryption implements PcIdentityEncryptionAdapter {
  available = true;
  isAvailable(): boolean { return this.available; }
  encrypt(plaintext: string): Buffer { return Buffer.from(`test-encrypted:${plaintext}`, "utf8"); }
  decrypt(ciphertext: Buffer): string {
    const value = ciphertext.toString("utf8");
    if (!value.startsWith("test-encrypted:")) throw new Error("invalid test cipher");
    return value.slice("test-encrypted:".length);
  }
}

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "vanessa-pc-identity-"));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("PC identity is generated once, encrypted at rest and stable across store instances", async () => {
  await withDirectory(async (directory) => {
    const filePath = join(directory, "identity-v2.json");
    const adapter = new TestEncryption();
    const first = await new RemotePcIdentityStore(filePath, adapter).loadOrCreate();
    const disk = await readFile(filePath, "utf8");
    assert.equal(disk.includes("BEGIN PRIVATE KEY"), false);
    assert.equal(disk.includes("test-encrypted:"), false);
    assert.ok(first.keyId.length >= 16);
    assert.ok(first.fingerprint.length >= 32);

    const second = await new RemotePcIdentityStore(filePath, adapter).loadOrCreate();
    assert.equal(second.keyId, first.keyId);
    assert.equal(second.publicKeySpki, first.publicKeySpki);
  });
});

test("concurrent requests share one identity initialization", async () => {
  await withDirectory(async (directory) => {
    const store = new RemotePcIdentityStore(join(directory, "identity-v2.json"), new TestEncryption());
    const [a, b] = await Promise.all([store.loadOrCreate(), store.loadOrCreate()]);
    assert.equal(a.keyId, b.keyId);
    assert.equal(a.publicKeySpki, b.publicKeySpki);
  });
});

test("unavailable OS encryption disables identity creation", async () => {
  await withDirectory(async (directory) => {
    const adapter = new TestEncryption();
    adapter.available = false;
    const store = new RemotePcIdentityStore(join(directory, "identity-v2.json"), adapter);
    await assert.rejects(store.loadOrCreate(), /OS-backed encryption is unavailable/);
  });
});

test("corrupt identity storage fails closed and is not silently regenerated", async () => {
  await withDirectory(async (directory) => {
    const filePath = join(directory, "identity-v2.json");
    const adapter = new TestEncryption();
    await new RemotePcIdentityStore(filePath, adapter).loadOrCreate();
    await (await import("node:fs/promises")).writeFile(filePath, "{broken", "utf8");
    const store = new RemotePcIdentityStore(filePath, adapter);
    await assert.rejects(store.loadOrCreate(), /Refusing to replace the existing identity/);
  });
});

test("mismatched private and public halves are rejected", async () => {
  await withDirectory(async (directory) => {
    const filePath = join(directory, "identity-v2.json");
    const adapter = new TestEncryption();
    const first = await new RemotePcIdentityStore(filePath, adapter).loadOrCreate();
    const second = await new RemotePcIdentityStore(join(directory, "other.json"), adapter).loadOrCreate();
    const original = JSON.parse(await readFile(filePath, "utf8"));
    const other = JSON.parse(await readFile(join(directory, "other.json"), "utf8"));
    original.encryptedPrivateKey = other.encryptedPrivateKey;
    await (await import("node:fs/promises")).writeFile(filePath, JSON.stringify(original), "utf8");
    assert.notEqual(first.keyId, second.keyId);
    await assert.rejects(new RemotePcIdentityStore(filePath, adapter).loadOrCreate(), /public and private identities do not match/);
  });
});
