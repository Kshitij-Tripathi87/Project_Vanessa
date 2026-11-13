import { createHash, generateKeyPairSync, createPublicKey, createPrivateKey } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalize } from "./canonicalize.ts";
import { createRemoteEnvelope, toSignedRemoteEnvelope, type RemoteEnvelope } from "./envelope.ts";
import type { ApprovalBinding } from "./messages.ts";
import {
  IDENTITY_CURVE,
  KEY_ID_DIGEST_BYTES,
  computeActionHash,
  computeKeyId,
  exportIdentityPublicKeyDer,
  isSupportedIdentityKey,
  normalizeIdentityPublicKey,
  publicKeyFingerprint,
  signRemoteEnvelope,
  signatureBytes,
  timingSafeEqualHex,
  verifyRemoteEnvelopeSignature,
} from "./signatures.ts";

const pc = generateKeyPairSync("ec", { namedCurve: "P-256" });
const phone = generateKeyPairSync("ec", { namedCurve: "P-256" });
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pcKeyId = computeKeyId(pc.publicKey);
const phoneKeyId = computeKeyId(phone.publicKey);

function seal(
  key: { privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"] },
  keyId: string,
  type: Parameters<typeof createRemoteEnvelope>[0]["type"],
  payload: Record<string, unknown>,
) {
  return signRemoteEnvelope(
    key.privateKey,
    createRemoteEnvelope({ type, payload, keyId, sentAt: 1_760_000_000_000, sequence: 0 }),
  );
}

/* ------------------------------------------------------------------ *
 * Key identity
 * ------------------------------------------------------------------ */

test("keyId is base64url of the truncated SPKI digest and is stable", () => {
  assert.match(pcKeyId, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(pcKeyId, "base64url").length, KEY_ID_DIGEST_BYTES);
  const digest = createHash("sha256").update(exportIdentityPublicKeyDer(pc.publicKey)).digest();
  assert.equal(pcKeyId, digest.subarray(0, KEY_ID_DIGEST_BYTES).toString("base64url"));
  // Re-importing the same key yields the same id: this is how the PC recognizes
  // a device across restarts without storing the key bytes.
  assert.equal(computeKeyId(pc.publicKey.export({ type: "spki", format: "pem" })), pcKeyId);
  assert.notEqual(pcKeyId, phoneKeyId, "different keys have different ids");
});

test("a public key is accepted as PEM, base64url DER or a KeyObject", () => {
  const fromPem = normalizeIdentityPublicKey(pc.publicKey.export({ type: "spki", format: "pem" }));
  const der = exportIdentityPublicKeyDer(pc.publicKey);
  const fromDer = normalizeIdentityPublicKey(der.toString("base64url"));
  const fromKeyObject = normalizeIdentityPublicKey(pc.publicKey);
  assert.equal(fromPem.export({ type: "spki", format: "der" }).toString("hex"), der.toString("hex"));
  assert.equal(fromDer.export({ type: "spki", format: "der" }).toString("hex"), der.toString("hex"));
  assert.equal(fromKeyObject.export({ type: "spki", format: "der" }).toString("hex"), der.toString("hex"));
  assert.equal(computeKeyId(fromPem), pcKeyId);
  assert.equal(computeKeyId(der), pcKeyId);
});

test("a malformed key is reported as malformed, not silently coerced", () => {
  assert.throws(() => normalizeIdentityPublicKey("-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----"), /not a valid/);
  assert.throws(() => normalizeIdentityPublicKey("bm90LWEtZGVyLWtleQ"), /not a valid/);
  assert.throws(() => normalizeIdentityPublicKey(Buffer.from("nonsense")), /not a DER SPKI/);
  assert.equal(isSupportedIdentityKey("not a key"), false);
});

test("only P-256 keys are accepted", () => {
  assert.equal(isSupportedIdentityKey(pc.publicKey), true);
  assert.equal(isSupportedIdentityKey(rsa.publicKey), false);
  assert.equal(isSupportedIdentityKey(pc.privateKey), false, "a private key is not an identity key");
});

test("the fingerprint is the full digest, so it can be compared out of band", () => {
  const fingerprint = publicKeyFingerprint(pc.publicKey);
  const expected = createHash("sha256").update(exportIdentityPublicKeyDer(pc.publicKey)).digest();
  assert.equal(Buffer.from(fingerprint, "base64url").toString("hex"), expected.toString("hex"));
  assert.notEqual(fingerprint, pcKeyId, "the fingerprint is longer than the key id");
});

/* ------------------------------------------------------------------ *
 * Signing and verification
 * ------------------------------------------------------------------ */

test("a signed envelope verifies against the signer's key", () => {
  const envelope = seal(pc, pcKeyId, "pong", { sentAt: 1_760_000_000_000, receivedAt: 1_760_000_000_001 });
  assert.deepEqual(verifyRemoteEnvelopeSignature(pc.publicKey, envelope), { ok: true });
  assert.equal(signatureBytes(envelope).length > 0, true);
  // ES256 signatures are DER SEQUENCEs of two INTEGERs; the length prefix must
  // cover exactly the remaining bytes.
  const der = signatureBytes(envelope);
  assert.equal(der[0], 0x30, "the signature is DER, not raw r||s");
  assert.equal(der[1], der.length - 2, "the DER length prefix covers the rest of the buffer");
  assert.equal(der[2], 0x02, "the first INTEGER is the r component");
  assert.ok(der.length >= 68 && der.length <= 72, `unexpected DER length ${der.length}`);
  // The signature is not the hash of the canonical text itself: it is a
  // signature over it, so two signings of the same bytes differ.
  const again = seal(pc, pcKeyId, "pong", { sentAt: 1_760_000_000_000, receivedAt: 1_760_000_000_001 });
  assert.notEqual(again.auth.signature, envelope.auth.signature);
  assert.deepEqual(verifyRemoteEnvelopeSignature(pc.publicKey, again), { ok: true });
});

test("the signature covers the canonical bytes, not the wire bytes", () => {
  // Whitespace and key order are not signed; they are erased by
  // canonicalization. A frame re-serialized differently must still verify.
  const envelope = seal(pc, pcKeyId, "pong", { sentAt: 1_760_000_000_000, receivedAt: 1_760_000_000_001 });
  const fields: Record<string, unknown> = { ...envelope };
  const reordered: Record<string, unknown> = {};
  for (const key of Object.keys(fields).reverse()) reordered[key] = fields[key];
  const parsed = JSON.parse(JSON.stringify(reordered)) as RemoteEnvelope;
  assert.notEqual(JSON.stringify(parsed), JSON.stringify(envelope));
  assert.deepEqual(verifyRemoteEnvelopeSignature(pc.publicKey, parsed), { ok: true });
});

test("the signature authenticates the algorithm tag and the keyId", () => {
  const envelope = seal(pc, pcKeyId, "ping", { sentAt: 1_760_000_000_000 });
  assert.deepEqual(
    verifyRemoteEnvelopeSignature(pc.publicKey, { ...envelope, auth: { algorithm: "ES384", signature: envelope.auth.signature } }),
    { ok: false, reason: "unsupported_algorithm" },
  );
  // keyId is inside the signed material: swapping it breaks verification, so a
  // proxy cannot redirect a frame to a different identity.
  assert.deepEqual(verifyRemoteEnvelopeSignature(pc.publicKey, { ...envelope, keyId: phoneKeyId }), {
    ok: false,
    reason: "invalid_signature",
  });
  // ...and a frame signed by the phone does not verify against the PC key.
  const fromPhone = seal(phone, phoneKeyId, "ping", { sentAt: 1_760_000_000_000 });
  assert.deepEqual(verifyRemoteEnvelopeSignature(pc.publicKey, fromPhone), {
    ok: false,
    reason: "invalid_signature",
  });
  assert.deepEqual(verifyRemoteEnvelopeSignature(phone.publicKey, fromPhone), { ok: true });
});

test("a tampered payload is rejected", () => {
  const envelope = seal(pc, pcKeyId, "pong", { sentAt: 1_760_000_000_000, receivedAt: 1_760_000_000_001 });
  assert.deepEqual(
    verifyRemoteEnvelopeSignature(pc.publicKey, { ...envelope, payload: { ...envelope.payload, receivedAt: 1 } }),
    { ok: false, reason: "invalid_signature" },
  );
  assert.deepEqual(verifyRemoteEnvelopeSignature(pc.publicKey, { ...envelope, sentAt: 1 }), {
    ok: false,
    reason: "invalid_signature",
  });
  assert.deepEqual(verifyRemoteEnvelopeSignature(pc.publicKey, { ...envelope, sequence: 99 }), {
    ok: false,
    reason: "invalid_signature",
  });
});

test("a tampered signature is rejected without saying which byte differed", () => {
  const envelope = seal(pc, pcKeyId, "ping", { sentAt: 1_760_000_000_000 });
  const bytes = signatureBytes(envelope);
  bytes[0] ^= 0x01;
  const flipped = { ...envelope, auth: { ...envelope.auth, signature: bytes.toString("base64url") } };
  assert.deepEqual(verifyRemoteEnvelopeSignature(pc.publicKey, flipped), { ok: false, reason: "invalid_signature" });

  // Truncated and empty signatures are malformed, not merely wrong.
  assert.deepEqual(
    verifyRemoteEnvelopeSignature(pc.publicKey, { ...envelope, auth: { ...envelope.auth, signature: "AAAA" } }),
    { ok: false, reason: "invalid_signature" },
  );
});

test("a wrong-curve key is reported as unsupported rather than invalid", () => {
  const envelope = seal(pc, pcKeyId, "ping", { sentAt: 1_760_000_000_000 });
  assert.deepEqual(verifyRemoteEnvelopeSignature(rsa.publicKey, envelope), {
    ok: false,
    reason: "unsupported_curve",
  });
  assert.deepEqual(verifyRemoteEnvelopeSignature("garbage", envelope), {
    ok: false,
    reason: "malformed_public_key",
  });
});

test("timingSafeEqualHex compares digests without leaking the difference", () => {
  const left = "a".repeat(64);
  assert.equal(timingSafeEqualHex(left, "a".repeat(64)), true);
  assert.equal(timingSafeEqualHex(left, "a".repeat(63)), false);
  assert.equal(timingSafeEqualHex(left, "b".repeat(64)), false);
});

/* ------------------------------------------------------------------ *
 * Action hashes
 * ------------------------------------------------------------------ */

const binding: ApprovalBinding = {
  taskId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  taskVersion: 3,
  capability: "media_play_pause",
  capabilityVersion: 1,
  canonicalArguments: { query: "focus" },
  target: { kind: "media", value: "Spotify" },
  policyVersion: "policy-2026-01",
  expiresAt: 1_760_000_600_000,
};

test("the action hash is SHA-256 over the JCS bytes of the binding", () => {
  const expected = createHash("sha256").update(canonicalize(binding), "utf8").digest("hex");
  assert.equal(computeActionHash(binding), expected);
  assert.match(computeActionHash(binding), /^[a-f0-9]{64}$/);
});

test("every field of the binding changes the hash, so an approval is single-use", () => {
  const base = computeActionHash(binding);
  const variants: ApprovalBinding[] = [
    { ...binding, taskVersion: 4 },
    { ...binding, canonicalArguments: { query: "focus " } },
    { ...binding, canonicalArguments: { query: "sleep" } },
    { ...binding, target: { kind: "app", value: "Spotify" } },
    { ...binding, target: { kind: "media", value: "spotify" } },
    { ...binding, policyVersion: "policy-2026-02" },
    { ...binding, capability: "volume_set" },
    { ...binding, expiresAt: binding.expiresAt + 1 },
    { ...binding, taskId: "b1b2c3d4-e5f6-4a7b-8c9d-d0e1f2a3b4c5" },
  ];
  for (const variant of variants) {
    assert.notEqual(computeActionHash(variant), base, `the hash must change when ${Object.keys(variant).join()} changes`);
  }
  // Key order is not part of the identity: the PC and the phone serialize
  // independently and must agree.
  const reordered: ApprovalBinding = {
    expiresAt: binding.expiresAt,
    policyVersion: binding.policyVersion,
    target: binding.target,
    canonicalArguments: binding.canonicalArguments,
    capabilityVersion: binding.capabilityVersion,
    capability: binding.capability,
    taskVersion: binding.taskVersion,
    taskId: binding.taskId,
  };
  assert.equal(computeActionHash(reordered), base);
});

test("the signed material is exactly the envelope minus the signature", () => {
  const envelope = seal(pc, pcKeyId, "ping", { sentAt: 1_760_000_000_000 });
  const signed = toSignedRemoteEnvelope(envelope);
  assert.deepEqual(Object.keys(signed.auth), ["algorithm"]);
  assert.equal(IDENTITY_CURVE, "P-256");
  assert.equal(
    canonicalize(signed),
    canonicalize({ ...envelope, auth: { algorithm: "ES256" } }),
    "the keyId stays inside the signed bytes while the signature leaves",
  );
});

test("a private key that is not PEM is read as PKCS#8 DER", () => {
  const der = pc.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const envelope = seal(
    { privateKey: createPrivateKey({ key: der, format: "der", type: "pkcs8" }) },
    pcKeyId,
    "ping",
    { sentAt: 1_760_000_000_000 },
  );
  assert.deepEqual(verifyRemoteEnvelopeSignature(pc.publicKey, envelope), { ok: true });
});
