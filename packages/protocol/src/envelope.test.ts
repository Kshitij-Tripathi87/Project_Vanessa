import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalize } from "./canonicalize.ts";
import {
  EnvelopeSchema,
  EnvelopeTooLargeError,
  MAX_ENVELOPE_BYTES,
  MAX_PAYLOAD_KEYS,
  MAX_PAYLOAD_KEY_LENGTH,
  MAX_SEQUENCE,
  MalformedEnvelopeError,
  PRE_SESSION_ID,
  assertEnvelopeSize,
  createRemoteEnvelope,
  decodeRemoteEnvelope,
  isSupportedRemoteProtocolVersion,
  parseRemoteEnvelope,
  safeParseRemoteEnvelope,
  toEnvelopeJsonSchema,
  toSignedRemoteEnvelope,
  type RemoteEnvelope,
} from "./envelope.ts";
import { parseRemotePayload } from "./messages.ts";
import { computeKeyId, signRemoteEnvelope, verifyRemoteEnvelopeSignature } from "./signatures.ts";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const KEY_ID = computeKeyId(publicKey);

function unsigned(type: Parameters<typeof createRemoteEnvelope>[0]["type"], payload: Record<string, unknown>) {
  return createRemoteEnvelope({ type, payload, keyId: KEY_ID });
}

/** Seal an envelope so the decode path sees a realistic, well-formed frame. */
function sealed(type: Parameters<typeof createRemoteEnvelope>[0]["type"], payload: Record<string, unknown>): RemoteEnvelope {
  return signRemoteEnvelope(privateKey, unsigned(type, payload));
}

test("createRemoteEnvelope fills the fields the caller did not supply", () => {
  const envelope = unsigned("ping", { sentAt: 1_760_000_000_000 });
  assert.equal(envelope.v, 2);
  assert.equal(envelope.sessionId, PRE_SESSION_ID);
  assert.equal(envelope.sequence, 0);
  assert.match(envelope.messageId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("the envelope schema is strict about unknown fields and about types", () => {
  // A complete, valid envelope skeleton: every rejection below must come from
  // the field under test, not from a missing `auth`.
  const base = {
    ...unsigned("ping", { sentAt: 1_760_000_000_000 }),
    auth: { algorithm: "ES256", signature: "x".repeat(16) },
  };
  assert.equal(EnvelopeSchema.safeParse({ ...base, debug: true }).success, false);
  assert.equal(EnvelopeSchema.safeParse({ ...base, v: 1 }).success, false);
  assert.equal(EnvelopeSchema.safeParse({ ...base, sentAt: 1.5 }).success, false);
  assert.equal(EnvelopeSchema.safeParse({ ...base, sentAt: -1 }).success, false);
  assert.equal(EnvelopeSchema.safeParse({ ...base, sequence: -1 }).success, false);
  assert.equal(EnvelopeSchema.safeParse({ ...base, sequence: MAX_SEQUENCE + 1 }).success, false);
  assert.equal(EnvelopeSchema.safeParse({ ...base, keyId: "short" }).success, false);
  assert.equal(EnvelopeSchema.safeParse({ ...base, keyId: "with spaces in it" }).success, false);
  assert.equal(EnvelopeSchema.safeParse({ ...base, auth: { algorithm: "HS256", signature: "x" } }).success, false);
  assert.equal(EnvelopeSchema.safeParse({ ...base, auth: { algorithm: "ES256" } }).success, false);
});

test("payload member count and key length are bounded", () => {
  const base = {
    ...unsigned("ping", { sentAt: 1_760_000_000_000 }),
    auth: { algorithm: "ES256", signature: "x".repeat(16) },
  };
  const wide: Record<string, unknown> = {};
  for (let index = 0; index < MAX_PAYLOAD_KEYS + 1; index += 1) wide[`k${index}`] = 1;
  assert.equal(EnvelopeSchema.safeParse({ ...base, payload: wide }).success, false);

  const longKey = "k".repeat(MAX_PAYLOAD_KEY_LENGTH + 1);
  assert.equal(EnvelopeSchema.safeParse({ ...base, payload: { [longKey]: 1 } }).success, false);
  assert.equal(EnvelopeSchema.safeParse({ ...base, payload: { ["k".repeat(MAX_PAYLOAD_KEY_LENGTH)]: 1 } }).success, true);
});

test("toSignedRemoteEnvelope removes the signature and nothing else", () => {
  const envelope = sealed("ping", { sentAt: 1_760_000_000_000, nonce: "cGluZ25vbmNl" });
  const signed = toSignedRemoteEnvelope(envelope);
  assert.equal(signed.auth.algorithm, "ES256");
  assert.equal("signature" in signed.auth, false);
  assert.equal(signed.payload.nonce, "cGluZ25vbmNl");
  assert.equal(signed.keyId, envelope.keyId);
  assert.equal(
    canonicalize(signed),
    canonicalize({ ...envelope, auth: { algorithm: "ES256" } }),
    "the signed object is the envelope minus the signature, byte for byte",
  );
});

test("decodeRemoteEnvelope accepts a well-formed signed frame", () => {
  const decoded = decodeRemoteEnvelope(Buffer.from(JSON.stringify(sealed("ping", { sentAt: 1_760_000_000_000 }))));
  assert.equal(decoded.type, "ping");
  assert.equal(verifyRemoteEnvelopeSignature(publicKey, decoded).ok, true);
});

test("decodeRemoteEnvelope accepts a frame that is not in canonical form", () => {
  // Canonical form is a signing rule, not a transport rule: a sender may emit
  // whitespace or unsorted keys, and verification re-canonicalizes before it
  // compares bytes. Rejecting such a frame would break interop with any peer
  // that serializes with a generic JSON writer.
  const envelope = sealed("pong", { sentAt: 1_760_000_000_000, receivedAt: 1_760_000_000_001 });
  const fields: Record<string, unknown> = { ...envelope };
  const reordered: Record<string, unknown> = {};
  for (const key of Object.keys(fields).reverse()) reordered[key] = fields[key];
  const text = JSON.stringify(reordered, null, 1);
  assert.notEqual(text, JSON.stringify(envelope));
  assert.notEqual(canonicalize(JSON.parse(text)), text, "the frame really is non-canonical");
  const decoded = decodeRemoteEnvelope(Buffer.from(text, "utf8"));
  assert.equal(decoded.type, "pong");
  assert.equal(verifyRemoteEnvelopeSignature(publicKey, decoded).ok, true);
});

test("decodeRemoteEnvelope rejects a frame over the size bound before parsing it", () => {
  assert.throws(
    () => decodeRemoteEnvelope(Buffer.alloc(MAX_ENVELOPE_BYTES + 1)),
    (error: unknown) => error instanceof EnvelopeTooLargeError,
  );
  assert.throws(() => assertEnvelopeSize(MAX_ENVELOPE_BYTES + 1), EnvelopeTooLargeError);
  assert.doesNotThrow(() => assertEnvelopeSize(MAX_ENVELOPE_BYTES));
});

test("decodeRemoteEnvelope rejects invalid UTF-8", () => {
  assert.throws(() => decodeRemoteEnvelope(Uint8Array.from([0x7b, 0xff, 0x7d])), MalformedEnvelopeError);
});

test("decodeRemoteEnvelope rejects duplicate JSON member names", () => {
  const text = JSON.stringify(sealed("ping", { sentAt: 1_760_000_000_000, nonce: "cGluZ25vbmNl" }));

  const duplicated = text.replace(/^\{/, '{"v":2,');
  assert.notEqual(duplicated, text);
  assert.throws(() => decodeRemoteEnvelope(Buffer.from(duplicated, "utf8")), /Duplicate JSON member/);

  // The same name written a different way is still the same member.
  const escaped = text.replace(/^\{/, '{"\\u0076":2,');
  assert.throws(() => decodeRemoteEnvelope(Buffer.from(escaped, "utf8")), /Duplicate JSON member/);

  // Duplicates nested inside the payload are caught too.
  const nested = text.replace(/"payload":/, '"payload":{"x":1,"x":2,"_":');
  assert.throws(() => decodeRemoteEnvelope(Buffer.from(nested, "utf8")), /Duplicate JSON member/);

  // A duplicate inside a nested payload object is caught.
  const deep = text.replace(/"nonce":"([^"]*)"/, '"args":{"a":1,"a":2},"nonce":"$1"');
  assert.throws(() => decodeRemoteEnvelope(Buffer.from(deep, "utf8")), /Duplicate JSON member/);
});

test("decodeRemoteEnvelope rejects trailing content, truncated JSON and empty bytes", () => {
  assert.throws(() => decodeRemoteEnvelope(Buffer.from('{"v":2}garbage', "utf8")), MalformedEnvelopeError);
  assert.throws(() => decodeRemoteEnvelope(Buffer.from('{"v":2', "utf8")), MalformedEnvelopeError);
  assert.throws(() => decodeRemoteEnvelope(Buffer.from("", "utf8")), MalformedEnvelopeError);
  assert.throws(() => decodeRemoteEnvelope(Uint8Array.from([0x20])), MalformedEnvelopeError);
});

test("decodeRemoteEnvelope survives a JSON round trip without weakening the envelope", () => {
  const envelope = sealed("pong", { sentAt: 1_760_000_000_000, receivedAt: 1_760_000_000_001 });
  const text = JSON.stringify(envelope);
  const decoded = decodeRemoteEnvelope(Buffer.from(text, "utf8"));
  assert.equal(canonicalize(decoded), canonicalize(envelope));
  assert.equal(safeParseRemoteEnvelope(decoded).success, true);
  assert.equal(safeParseRemoteEnvelope({ ...decoded, v: 3 }).success, false);
});

test("parseRemoteEnvelope throws a ZodError on a malformed envelope", () => {
  assert.throws(() => parseRemoteEnvelope({ v: 2 }), /Required|Invalid/);
});

test("toEnvelopeJsonSchema describes version 2", () => {
  const schema = toEnvelopeJsonSchema();
  assert.equal(schema.version, 2);
  assert.equal(schema.title, "RemoteEnvelope");
  // A named schema that carries a refinement is emitted as a `$ref` plus a
  // definition; the definition must hold the full envelope property set.
  const definition = (schema.definitions as Record<string, { properties?: Record<string, unknown> }> | undefined)?.[
    "RemoteEnvelope"
  ];
  assert.ok(definition?.properties, "the schema carries the referenced envelope definition");
  for (const field of ["v", "messageId", "sessionId", "type", "sentAt", "sequence", "keyId", "payload", "auth"]) {
    assert.equal(Object.keys(definition.properties).includes(field), true, `the envelope schema is missing ${field}`);
  }
});

test("isSupportedRemoteProtocolVersion only accepts what this package implements", () => {
  assert.equal(isSupportedRemoteProtocolVersion(2), true);
  assert.equal(isSupportedRemoteProtocolVersion(1), false);
  assert.equal(isSupportedRemoteProtocolVersion("2"), false);
});

test("the payload schema rejects members the type does not declare", () => {
  const submit = {
    requestId: "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    idempotencyKey: "idem-key-0001",
    capability: "media_play_pause",
    canonicalArguments: { query: "focus" },
  };
  assert.equal(parseRemotePayload("task.submit", submit).capability, "media_play_pause");

  // A client-asserted tier is the interesting case: the PC resolves tiers, so
  // the field must fail validation rather than being silently ignored.
  assert.throws(
    () => parseRemotePayload("task.submit", { ...submit, tier: "T0" }),
    /Unrecognized key/,
  );

  // `canonicalArguments` is deliberately a bounded record rather than a strict
  // object — arguments are free-form — so its bound is member count, not keys.
  const wide: Record<string, unknown> = {};
  for (let index = 0; index < 33; index += 1) wide[`arg${index}`] = index;
  assert.throws(() => parseRemotePayload("task.submit", { ...submit, canonicalArguments: wide }), /exceeds 32 members/);
  const longKey = "a".repeat(65);
  assert.throws(
    () => parseRemotePayload("task.submit", { ...submit, canonicalArguments: { [longKey]: 1 } }),
    /exceeds 32 members/,
  );
});
