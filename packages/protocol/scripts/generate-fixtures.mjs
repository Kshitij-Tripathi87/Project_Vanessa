#!/usr/bin/env node

/**
 * Generates the protocol v2 fixtures under packages/protocol/fixtures/.
 *
 * Three files, each with one job:
 *
 * - canonical-vectors.json  deterministic JCS bytes + SHA-256 for values that
 *                           must canonicalize identically in Kotlin and in JS.
 *                           Includes the cases where implementations disagree:
 *                           number exponent thresholds, UTF-16 key ordering,
 *                           control characters, lone surrogates, -0.
 * - signature-vectors.json  a throwaway P-256 key pair and envelopes signed
 *                           with it, with the exact canonical bytes that were
 *                           signed. TEST-ONLY: this key is public by design and
 *                           must never ship to a device.
 * - protocol-v2.jsonl       one envelope per line, valid and invalid, each
 *                           labelled with the error code the listener must
 *                           return when the frame is rejected.
 *
 * Output is deterministic: existing signatures are reused when the same
 * canonical bytes and key id are signed again, so re-running the generator
 * without changing an input produces no git diff.
 *
 * Requires a built package: `pnpm --filter @vanessa/protocol build`
 * (generate-json-schema.mjs writes dist/ first).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash, generateKeyPairSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dirname, "..");
const FIXTURES = join(PKG, "fixtures");

/** Dynamic import needs a file:// URL on Windows; a bare drive path fails ESM. */
const load = (name) => import(pathToFileURL(join(PKG, "dist", name)).href);

const { canonicalize } = await load("canonicalize.js");
const {
  createRemoteEnvelope,
  toSignedRemoteEnvelope,
  PRE_SESSION_ID,
  decodeRemoteEnvelope,
  safeParseRemoteEnvelope,
  MAX_ENVELOPE_BYTES,
} = await load("envelope.js");
const { signRemoteEnvelope, computeKeyId, publicKeyFingerprint, verifyRemoteEnvelopeSignature } = await load(
  "signatures.js",
);
const { safeParseRemotePayload, REMOTE_MESSAGE_DIRECTIONS } = await load("messages.js");

mkdirSync(FIXTURES, { recursive: true });

const PC_SESSION = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const PHONE_SESSION = "b1b2c3d4-e5f6-4a7b-8c9d-d0e1f2a3b4c5";
const DEVICE_ID = "pixel-9-pro";

/** Real key id of the throwaway fixture key; assigned once the key is known. */
let KEY_ID = "";

const T0 = 1_760_000_000_000; // fixed clock (2025-10-09); fixtures never use Date.now()
const LATER = T0 + 600_000;

/* ------------------------------------------------------------------ *
 * 1. Canonical vectors
 * ------------------------------------------------------------------ */

const CANONICAL_VECTORS = [
  {
    name: "nested-object-and-array",
    description: "Key order follows UTF-16 code units, not insertion order; array order is preserved.",
    input: { a: [1, 2, { c: "x", b: 2, a: 1 }], b: 1 },
    expected: '{"a":[1,2,{"a":1,"b":2,"c":"x"}],"b":1}',
  },
  {
    name: "utf16-key-ordering-digits",
    description: "Numeric-looking keys sort by code units, so 10 precedes 2.",
    input: { 2: 3, 10: 2, a: 1 },
    expected: '{"10":2,"2":3,"a":1}',
  },
  {
    name: "bare-minus-sign-is-invalid",
    description: "-0 serializes as 0 and 1.0 serializes as 1; trailing zeros are dropped.",
    input: { a: -0, b: 1.0, c: 100, d: 1.5 },
    expected: '{"a":0,"b":1,"c":100,"d":1.5}',
  },
  {
    name: "number-exponent-thresholds",
    description: "Exponent form starts at 1e21 or below 1e-6; 9.99e20 stays fixed (21 digits).",
    input: { a: 1e21, b: 1e-7, c: 1e-6, d: 273.15, e: 9.99e20 },
    expected: '{"a":1e+21,"b":1e-7,"c":0.000001,"d":273.15,"e":999000000000000000000}',
  },
  {
    name: "safe-integer-boundary",
    description: "Integers beyond 2^53-1 are serialized as the double they round to.",
    input: { a: 9007199254740992, b: 9007199254740993 },
    expected: '{"a":9007199254740992,"b":9007199254740992}',
  },
  {
    name: "string-escapes",
    description: "Only the mandatory escapes are emitted; / is not escaped and lone surrogates are \\uXXXX.",
    input: { a: 'quote"back\\slash', b: "\u0000\u001f", c: "\b\f\n\r\t", d: "slash/kept", e: "\ud800lone" },
    expected:
      '{"a":"quote\\"back\\\\slash","b":"\\u0000\\u001f","c":"\\b\\f\\n\\r\\t","d":"slash/kept","e":"\\ud800lone"}',
  },
  {
    name: "unicode-passthrough",
    description: "Non-ASCII text and astral (surrogate pair) characters are emitted as raw UTF-8.",
    input: { a: "é", b: "😀", c: "中文", d: "\ud83d\ude00" },
    expected: '{"a":"é","b":"😀","c":"中文","d":"😀"}',
  },
  {
    name: "control-character-form-feed",
    description: "b, f, n, r and t use the two-character escapes; other C0 controls use \\uXXXX.",
    input: { "\u000c": "x" },
    expected: '{"\\f":"x"}',
  },
  {
    name: "null-and-booleans",
    description: "null, true and false are real JSON values and are never dropped.",
    input: { a: null, b: true, c: false, d: [] },
    expected: '{"a":null,"b":true,"c":false,"d":[]}',
  },
  {
    name: "empty-object-and-array",
    description: "Empty containers serialize with no separator or whitespace.",
    input: [{}, [], { a: {} }],
    expected: "[{},[],{\"a\":{}}]",
  },
  {
    name: "action-hash-preimage",
    description: "The exact object the PC hashes for an approval; nested objects are sorted too.",
    input: {
      taskId: "0d3a8c0c-9e2a-4b6f-9f11-2f4a6b8c1d03",
      taskVersion: 1,
      capability: "media_play_pause",
      capabilityVersion: 1,
      canonicalArguments: { app: "spotify" },
      target: { kind: "app", value: "spotify.exe" },
      policyVersion: "policy-2026-11-01",
      expiresAt: LATER,
    },
    expected:
      '{"canonicalArguments":{"app":"spotify"},"capability":"media_play_pause","capabilityVersion":1,"expiresAt":1760000600000,"policyVersion":"policy-2026-11-01","target":{"kind":"app","value":"spotify.exe"},"taskId":"0d3a8c0c-9e2a-4b6f-9f11-2f4a6b8c1d03","taskVersion":1}',
  },
];

/* ------------------------------------------------------------------ *
 * 2. Test key pair (THROWAWAY)
 * ------------------------------------------------------------------ */

const SIG_PATH = join(FIXTURES, "signature-vectors.json");
const previous = existsSync(SIG_PATH) ? JSON.parse(readFileSync(SIG_PATH, "utf8")) : null;

const keyPair = previous?.keyPair ?? (() => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  };
})();

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Signature values from the previous run, reused so output stays deterministic. */
const signatureIndex = new Map();
for (const entry of previous?.vectors ?? []) {
  if (entry?.canonicalSignedJson && entry?.envelope?.auth?.keyId) {
    signatureIndex.set(`${entry.envelope.auth.keyId}|${sha256(entry.canonicalSignedJson)}`, entry.envelope.auth.signature);
  }
}

KEY_ID = computeKeyId(keyPair.publicKeyPem);
const FIXTURE_SPKI_BASE64URL = keyPair.publicKeyPem
  .replace(/-----BEGIN PUBLIC KEY-----/, "")
  .replace(/-----END PUBLIC KEY-----/, "")
  .replace(/\s+/g, "")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

/** Canonicalize the signed form of an unsigned envelope (algorithm, no signature). */
function canonicalOf(envelope) {
  return canonicalize({ ...envelope, auth: { algorithm: "ES256" } });
}

function signedEntry(key, envelope, note) {
  return { key, unsigned: envelope, canonical: canonicalOf(envelope), note };
}

function payloadExamples() {
  return [
    ["server.challenge", "PC opens a session with a nonce the device must answer", PHONE_SESSION, 1, 0, KEY_ID, {
      serverNonce: "U2VydmVyTm9uY2UxMjM0NTY3ODkwYWJjZGVm",
      pcId: "pc-7f3a9c2",
      pcName: "Studio PC",
      protocolVersion: 2,
      supportedVersions: [2],
      issuedAt: T0,
      expiresAt: LATER,
      pairingRequired: false,
    }],
    ["client.authenticate", "phone answers with its SPKI key", PC_SESSION, 2, 0, KEY_ID, {
      serverNonce: "U2VydmVyTm9uY2UxMjM0NTY3ODkwYWJjZGVm",
      clientNonce: "Q2xpZW50Tm9uY2VhYmNkZWZnaGlqa2xtbg",
      publicKey: FIXTURE_SPKI_BASE64URL,
      deviceHint: "pixel-9-pro",
      platform: "android",
      appVersion: "1.0.0",
      requestedScopes: ["media_control"],
    }],
    ["session.ready", "PC issues the session identity, scope grant and both nonces", PC_SESSION, 3, 0, KEY_ID, {
      sessionId: PC_SESSION,
      deviceId: "pixel-9-pro",
      grantedScopes: ["media_control", "notes"],
      manifestVersion: "manifest-9",
      serverEventSeq: 0,
      serverNonce: "U2VydmVyTm9uY2VhYmNkZWZnaGlqazA",
      clientNonce: "Q2xpZW50Tm9uY2VhYmNkZWZnaGlqa2xtbg",
      issuedAt: T0,
      expiresAt: LATER,
    }],
    ["session.expiring", "warning issued before the session expires", PC_SESSION, 4, 1, KEY_ID, {
      expiresAt: LATER,
      renewWithinMs: 300_000,
      reason: "expiring",
    }],
    ["session.close", "session closed because the device was revoked", PC_SESSION, 5, 2, KEY_ID, {
      reason: "revoked",
    }],
    ["protocol.error", "typed rejection with a safe message", PC_SESSION, 6, 3, KEY_ID, {
      code: "PERMISSION_DENIED",
      message: "This capability is disabled by PC policy.",
    }],
    ["pairing.claim", "device claims a pairing code with its key", PRE_SESSION_ID, 7, 0, KEY_ID, {
      pairingId: "pair-1a2b3c4",
      code: "ABCD-EFGH-JKLM",
      publicKey: FIXTURE_SPKI_BASE64URL,
      keyId: KEY_ID,
      deviceHint: "pixel-9-pro",
      platform: "android",
      appVersion: "1.0.0",
    }],
    ["pairing.challenge", "PC challenges the claimant key", PRE_SESSION_ID, 8, 1, KEY_ID, {
      pairingId: "pair-1a2b3c4",
      nonce: "UGFpcmluZ05vbmNlMTIzNDU2Nzg5MGFiY2Q",
      issuedAt: T0,
      expiresAt: T0 + 180_000,
      clientNonce: "UGFpcmluZ0NsaWVudE5vbmNlYWJjZGVm",
    }],
    ["pairing.complete", "the envelope signature is the proof of possession", PRE_SESSION_ID, 9, 2, KEY_ID, {
      pairingId: "pair-1a2b3c4",
      challengeNonce: "UGFpcmluZ05vbmNlMTIzNDU2Nzg5MGFiY2Q",
    }],
    ["pairing.pending", "pairing is waiting for a human on the PC", PRE_SESSION_ID, 10, 3, KEY_ID, {
      pairingId: "pair-1a2b3c4",
      state: "awaiting_approval",
      expiresAt: T0 + 180_000,
    }],
    ["pairing.approved", "PC operator approved the device", PRE_SESSION_ID, 11, 4, KEY_ID, {
      deviceId: "pixel-9-pro",
      keyId: KEY_ID,
      grantedScopes: ["media_control"],
      sessionExpiresAt: T0 + 86_400_000,
      serverNonce: "U2VydmVyTm9uY2VhcHByb3ZlZDEyMw",
      clientNonce: "UGFpcmluZ0FwcHJvdmFsQ2xpZW50",
    }],
    ["pairing.rejected", "PC operator declined the pairing", PRE_SESSION_ID, 12, 5, KEY_ID, {
      pairingId: "pair-1a2b3c4",
      reason: "declined_on_pc",
    }],
    ["pairing.expired", "three minutes elapsed with no approval", PRE_SESSION_ID, 13, 6, KEY_ID, {
      pairingId: "pair-1a2b3c4",
    }],
    ["manifest.get", "empty request; the PC replies with the whole manifest", PC_SESSION, 14, 4, KEY_ID, {}],
    ["manifest.snapshot", "capability list with tiers and argument schemas", PC_SESSION, 15, 5, KEY_ID, {
      manifestVersion: "manifest-9",
      generatedAt: T0,
      policyVersion: "policy-2026-11-01",
      capabilities: [
        {
          name: "media_play_pause",
          version: 1,
          description: "Pause or resume playback on the active media session.",
          tier: "T1",
          scopes: ["media_control"],
          idempotent: true,
          timeoutMs: 5_000,
          argumentsSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    }],
    ["manifest.changed", "manifest or policy version moved", PC_SESSION, 16, 6, KEY_ID, {
      manifestVersion: "manifest-10",
      policyVersion: "policy-2026-11-02",
      changedAt: T0,
    }],
    ["task.submit", "normalized arguments only; no tier, no raw command line", PC_SESSION, 17, 5, KEY_ID, {
      requestId: "3f2b1c0d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      idempotencyKey: "phone-1710000000000-0001",
      capability: "media_play_pause",
      canonicalArguments: { app: "spotify" },
    }],
    ["task.accepted", "PC accepted the task and issued its id", PC_SESSION, 18, 6, KEY_ID, {
      requestId: "3f2b1c0d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      taskId: "0d3a8c0c-9e2a-4b6f-9f11-2f4a6b8c1d03",
      state: "accepted",
      taskVersion: 1,
      eventSeq: 1,
      acceptedAt: T0,
    }],
    ["task.snapshot", "authoritative task state, sent on change and on resume", PHONE_SESSION, 19, 7, KEY_ID, {
      task: {
        taskId: "0d3a8c0c-9e2a-4b6f-9f11-2f4a6b8c1d03",
        requestId: "3f2b1c0d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
        capability: "media_play_pause",
        state: "running",
        tier: "T1",
        taskVersion: 1,
        acceptedAt: T0,
        updatedAt: T0 + 1_000,
        safeSummary: "Pausing playback on spotify.exe.",
      },
      eventSeq: 2,
    }],
    ["task.progress", "cheap progress update", PHONE_SESSION, 20, 8, KEY_ID, {
      taskId: "0d3a8c0c-9e2a-4b6f-9f11-2f4a6b8c1d03",
      state: "running",
      eventSeq: 3,
      safeSummary: "Locating the media session.",
      percentComplete: 40,
    }],
    ["task.confirmation_required", "T2 binding: action hash over task, capability, arguments and target", PHONE_SESSION, 21, 9, KEY_ID, {
      approval: {
        approvalId: "aa4e5f60-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
        taskId: "0d3a8c0c-9e2a-4b6f-9f11-2f4a6b8c1d03",
        taskVersion: 1,
        deviceId: "pixel-9-pro",
        capability: "file_delete",
        capabilityVersion: 2,
        consequence: "Delete 3 files from Downloads. This cannot be undone.",
        target: { kind: "file", value: "C:\\\\Users\\\\user\\\\Downloads\\\\inbox" },
        actionHash: "a".repeat(64),
        policyVersion: "policy-2026-11-01",
        expiresAt: T0 + 120_000,
      },
      eventSeq: 4,
    }],
    ["task.confirmation_response", "approval of the exact bound action", PHONE_SESSION, 22, 10, KEY_ID, {
      approvalId: "aa4e5f60-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
      taskId: "0d3a8c0c-9e2a-4b6f-9f11-2f4a6b8c1d03",
      actionHash: "a".repeat(64),
      decision: "approved",
      approvedAt: T0 + 1_000,
      method: "biometric_strong",
    }],
    ["task.cancel", "cancel request for a task the phone started", PC_SESSION, 23, 11, KEY_ID, {
      taskId: "0d3a8c0c-9e2a-4b6f-9f11-2f4a6b8c1d03",
      requestId: "5b4c3d2e-1f0a-4b5c-8d9e-0f1a2b3c4d5e",
      reason: "mistake",
    }],
    ["task.cancel_ack", "honest outcome of a cancel, including too_late", PHONE_SESSION, 24, 12, KEY_ID, {
      taskId: "0d3a8c0c-9e2a-4b6f-9f11-2f4a6b8c1d03",
      outcome: "completed",
      state: "succeeded",
    }],
    ["task.result", "compact result with verification evidence", PHONE_SESSION, 25, 13, KEY_ID, {
      taskId: "0d3a8c0c-9e2a-4b6f-9f11-2f4a6b8c1d03",
      status: "succeeded",
      verification: { status: "verified", summary: "Playback paused; state observed via media session." },
      safeSummary: "Playback paused on spotify.exe.",
      eventSeq: 5,
      completedAt: T0 + 2_000,
    }],
    ["task.error", "typed task failure, retryable flag set", PHONE_SESSION, 26, 14, KEY_ID, {
      taskId: "0d3a8c0c-9e2a-4b6f-9f11-2f4a6b8c1d03",
      code: "TASK_FAILED",
      message: "Playback could not be paused; the media session did not respond.",
      retryable: true,
    }],
    ["sync.resume", "phone reconnects and asks for its missing events", PRE_SESSION_ID, 27, 15, KEY_ID, {
      lastEventSeq: 5,
      activeTaskIds: ["0d3a8c0c-9e2a-4b6f-9f11-2f4a6b8c1d03"],
      clientNonce: "UmVzdW1lQ2xpZW50Tm9uY2UxMjM0",
    }],
    ["sync.snapshot", "authoritative resume payload", PC_SESSION, 28, 16, KEY_ID, {
      lastEventSeq: 5,
      historyGap: false,
      tasks: [
        {
          taskId: "0d3a8c0c-9e2a-4b6f-9f11-2f4a6b8c1d03",
          requestId: "3f2b1c0d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
          capability: "media_play_pause",
          state: "running",
          tier: "T1",
          taskVersion: 1,
          acceptedAt: T0,
          updatedAt: T0 + 1_000,
          safeSummary: "Pausing playback on spotify.exe.",
        },
      ],
      events: [
        {
          eventId: "6c7d8e9f-0a1b-4c2d-8e3f-4a5b6c7d8e9f",
          eventSeq: 3,
          taskId: "0d3a8c0c-9e2a-4b6f-9f11-2f4a6b8c1d03",
          type: "task.progress",
          state: "running",
          safePayload: { detail: "Locating the media session." },
          at: T0 + 1_000,
        },
      ],
    }],
    ["sync.event", "one event, at-least-once delivery; the client dedupes", PHONE_SESSION, 29, 17, KEY_ID, {
      event: {
        eventId: "6c7d8e9f-0a1b-4c2d-8e3f-4a5b6c7d8e90",
        eventSeq: 4,
        taskId: "0d3a8c0c-9e2a-4b6f-9f11-2f4a6b8c1d03",
        type: "task.progress",
        state: "running",
        safePayload: { detail: "Requesting pause." },
        at: T0 + 1_500,
      },
    }],
    ["sync.complete", "resume finished; session bounds refreshed", PC_SESSION, 30, 18, KEY_ID, {
      lastEventSeq: 5,
      resumedAt: T0 + 3_000,
      sessionExpiresAt: T0 + 86_400_000,
    }],
    ["ping", "keepalive", PC_SESSION, 31, 19, KEY_ID, { sentAt: T0, nonce: "cGluZ25vbmNl" }],
    ["pong", "keepalive reply echoing the peer's timestamp", PHONE_SESSION, 32, 20, KEY_ID, { sentAt: T0, receivedAt: T0 + 50 }],
  ].map(([type, note, sessionId, sequence, messageSuffix, keyId, payload]) => {
    const messageId = `11112222-3333-4444-5555-${String(messageSuffix).padStart(4, "0")}66667777`;
    const unsigned = createRemoteEnvelope({
      type,
      payload,
      keyId,
      sessionId,
      messageId,
      sentAt: T0 + sequence,
      sequence,
    });
    return signedEntry(keyId, unsigned, note);
  });
}

const examples = payloadExamples();

/* ------------------------------------------------------------------ *
 * 3. Valid/invalid wire fixtures
 * ------------------------------------------------------------------ */

function reuseOrSign(entry) {
  const digest = sha256(entry.canonical);
  const cached = signatureIndex.get(`${entry.key}|${digest}`);
  if (cached) return { ...entry.unsigned, auth: { algorithm: "ES256", signature: cached } };
  const signed = signRemoteEnvelope(keyPair.privateKeyPem, entry.unsigned);
  signatureIndex.set(`${entry.key}|${digest}`, signed.auth.signature);
  return signed;
}

const jsonl = [];
for (const entry of examples) {
  const envelope = reuseOrSign(entry);
  const check = verifyRemoteEnvelopeSignature(keyPair.publicKeyPem, envelope);
  if (!check.ok) throw new Error(`Generated signature does not verify for ${entry.unsigned.type}: ${check.reason}`);
  jsonl.push({
    kind: "valid",
    messageType: entry.unsigned.type,
    note: entry.note,
    envelope,
  });
}

function invalidEntry(messageType, note, reasonCode, extra) {
  return { kind: "invalid", messageType, note, reasonCode, ...(extra ?? {}) };
}

/** Seal an unsigned envelope with the throwaway key, reusing a cached signature. */
function sealed(keyId, unsigned) {
  const envelope = reuseOrSign({ key: keyId, unsigned, canonical: canonicalOf(unsigned) });
  return envelope;
}

// Wrong protocol version.
{
  const base = examples[0].unsigned;
  jsonl.push(
    invalidEntry("server.challenge", "v is not 2; the listener answers UNSUPPORTED_VERSION.", "UNSUPPORTED_VERSION", {
      envelope: sealed(base.keyId, { ...base, v: 1 }),
    }),
  );
}

// Unknown message type.
{
  const base = examples[16].unsigned;
  jsonl.push(
    invalidEntry("task.submit_guessed", "type is not in the v2 registry.", "UNKNOWN_MESSAGE_TYPE", {
      envelope: sealed(base.keyId, { ...base, type: "task.submit_guessed" }),
    }),
  );
}

// Client-asserted permission tier.
{
  const base = examples[16].unsigned;
  jsonl.push(
    invalidEntry(
      "task.submit",
      "payload asserts a permission tier; the PC resolves tiers itself, so the field is rejected as a strict-schema failure.",
      "INVALID_PAYLOAD",
      { envelope: sealed(base.keyId, { ...base, payload: { ...base.payload, tier: "T0" } }) },
    ),
  );
}

// Extra envelope field.
{
  const base = examples[16].unsigned;
  jsonl.push(
    invalidEntry("task.submit", "envelope carries a field outside the contract.", "INVALID_MESSAGE", {
      envelope: { ...base, debug: true, auth: { algorithm: "ES256", signature: "A".repeat(86) } },
    }),
  );
}

// Duplicate JSON member names: JSON.parse keeps the last one, so the bytes that
// were signed are not the bytes the listener parses.
{
  const base = examples[16].unsigned;
  const duplicateText = JSON.stringify(sealed(base.keyId, base)).replace(/^\{"v":2/, '{"v":2,"v":2');
  jsonl.push(
    invalidEntry("task.submit", "`v` appears twice in the frame; strict decoding must reject the frame outright.", "INVALID_MESSAGE", {
      rawText: duplicateText,
    }),
  );
}

// Oversized frame.
jsonl.push(
  invalidEntry("task.submit", "frame larger than the 64 KiB control bound.", "PAYLOAD_TOO_LARGE", {
    rawText: "x".repeat(70_000),
  }),
);

// Tampered payload.
{
  const base = examples[16].unsigned;
  const signed = sealed(base.keyId, base);
  jsonl.push(
    invalidEntry(
      "task.submit",
      "payload was edited after signing; the signature no longer covers the canonical bytes.",
      "INVALID_SIGNATURE",
      { envelope: { ...signed, payload: { ...signed.payload, capability: "file_delete" } } },
    ),
  );
}

// Byte flipped inside the signature.
{
  const base = examples[0].unsigned;
  const signed = sealed(base.keyId, base);
  const flipped = signed.auth.signature[0] === "A" ? "B" : "A";
  jsonl.push(
    invalidEntry("server.challenge", "a single character of the signature is changed.", "INVALID_SIGNATURE", {
      envelope: { ...signed, auth: { ...signed.auth, signature: flipped + signed.auth.signature.slice(1) } },
    }),
  );
}

// Signature removed.
{
  const base = examples[1].unsigned;
  jsonl.push(
    invalidEntry("client.authenticate", "auth.signature is absent, so the frame cannot be attributed to a key.", "MALFORMED_SIGNATURE", {
      envelope: { ...base, auth: { algorithm: "ES256" } },
    }),
  );
}

// keyId swapped after signing.
{
  const base = examples[1].unsigned;
  const signed = sealed(base.keyId, base);
  jsonl.push(
    invalidEntry("client.authenticate", "keyId is authenticated by the signature, so swapping it invalidates the frame.", "INVALID_SIGNATURE", {
      envelope: { ...signed, keyId: "TESTKEYIDDOESNOTMATCH" },
    }),
  );
}

// Wrong direction: client sending a server-only type.
{
  const base = examples[0].unsigned;
  jsonl.push(
    invalidEntry("server.challenge", "server.challenge is server_to_client; a client may not send it.", "PERMISSION_DENIED", {
      envelope: sealed(base.keyId, base),
    }),
  );
}

/* ------------------------------------------------------------------ *
 * 4. Self-check: every line must behave exactly as its reasonCode says
 * ------------------------------------------------------------------ */

/**
 * The fixture set is only useful if each line fails for the stated reason, so
 * the generator proves it here rather than leaving it to a test that might
 * drift away from the file.
 */
function classify(line) {
  if (line.rawText !== undefined) {
    const bytes = Buffer.byteLength(line.rawText, "utf8");
    if (bytes > MAX_ENVELOPE_BYTES) return { stage: "size", detail: `${bytes} bytes` };
    try {
      decodeRemoteEnvelope(Buffer.from(line.rawText, "utf8"));
      return { stage: "decoded", detail: "should not have decoded" };
    } catch (error) {
      return { stage: "decode_error", detail: error instanceof Error ? error.message : String(error) };
    }
  }
  const envelope = safeParseRemoteEnvelope(line.envelope);
  if (!envelope.success) return { stage: "envelope_invalid", detail: envelope.error.issues[0]?.message ?? "envelope" };
  if (line.kind === "invalid") {
    const payload = safeParseRemotePayload(envelope.data.type, envelope.data.payload);
    if (!payload.success) return { stage: "payload_invalid", detail: payload.error.issues[0]?.message ?? "payload" };
  }
  const signature = verifyRemoteEnvelopeSignature(keyPair.publicKeyPem, envelope.data);
  if (!signature.ok) return { stage: "signature_invalid", detail: signature.reason };
  return { stage: "accepted", detail: REMOTE_MESSAGE_DIRECTIONS[envelope.data.type] };
}

for (const line of jsonl) {
  const result = classify(line);
  const where = `${line.kind} ${line.messageType} (${line.reasonCode})`;
  if (line.kind === "valid") {
    if (result.stage !== "accepted") throw new Error(`expected ${where} to be accepted, got ${result.stage}: ${result.detail}`);
    continue;
  }
  // `decode_error` belongs to the raw-text frames (bad JSON), which are also
  // INVALID_MESSAGE; `size` is the frame-bound rejection.
  const expectedStages = {
    UNSUPPORTED_VERSION: ["envelope_invalid"],
    UNKNOWN_MESSAGE_TYPE: ["envelope_invalid"],
    INVALID_MESSAGE: ["envelope_invalid", "decode_error"],
    MALFORMED_SIGNATURE: ["envelope_invalid"],
    INVALID_PAYLOAD: ["payload_invalid"],
    INVALID_SIGNATURE: ["signature_invalid"],
    PERMISSION_DENIED: ["accepted"],
    PAYLOAD_TOO_LARGE: ["size"],
  };
  const expected = expectedStages[line.reasonCode];
  if (expected === undefined) throw new Error(`unclassified reason code ${line.reasonCode} for ${where}`);
  if (!expected.includes(result.stage)) {
    throw new Error(`expected ${where} to fail as ${expected.join(" or ")}, got ${result.stage}: ${result.detail}`);
  }
  if (line.reasonCode === "PERMISSION_DENIED" && result.detail !== "server_to_client") {
    throw new Error(`expected ${where} to be a server-only type, got ${result.detail}`);
  }
  if (line.reasonCode === "INVALID_MESSAGE" && line.rawText && !/Duplicate JSON member/.test(String(result.detail))) {
    throw new Error(`expected the duplicate-member frame to be refused as a duplicate, got ${result.detail}`);
  }
}

/* ------------------------------------------------------------------ *
 * 5. Write everything
 * ------------------------------------------------------------------ */

const canonicalFile = {
  version: 2,
  generatedBy: "packages/protocol/scripts/generate-fixtures.mjs",
  description:
    "Golden JCS vectors. Kotlin and TypeScript must both produce `canonical` byte-for-byte from `input`; `sha256` is the digest of `canonical`.",
  vectors: CANONICAL_VECTORS.map((vector) => {
    const canonical = canonicalize(vector.input);
    if (canonical !== vector.expected) {
      throw new Error(`Canonical mismatch for "${vector.name}":\n  expected ${vector.expected}\n  actual   ${canonical}`);
    }
    return { ...vector, canonical, sha256: sha256(canonical) };
  }),
};

writeFileSync(join(FIXTURES, "canonical-vectors.json"), `${JSON.stringify(canonicalFile, null, 2)}\n`);

const signatureFile = {
  version: 2,
  generatedBy: "packages/protocol/scripts/generate-fixtures.mjs",
  testOnly: true,
  warning:
    "TEST-ONLY KEY. This P-256 key pair is public by design and must never be installed on a device, referenced by production code, or used to derive a real keyId.",
  keyPair,
  /** Single throwaway key. Both directions in these fixtures use it. */
  keyId: KEY_ID,
  fingerprint: publicKeyFingerprint(keyPair.publicKeyPem),
  vectors: examples.map((entry) => {
    const envelope = reuseOrSign(entry);
    return {
      name: entry.unsigned.type,
      note: entry.note,
      canonicalSignedJson: entry.canonical,
      sha256: sha256(entry.canonical),
      keyId: entry.key,
      envelope,
    };
  }),
};
writeFileSync(join(FIXTURES, "signature-vectors.json"), `${JSON.stringify(signatureFile, null, 2)}\n`);

const jsonlText = `${jsonl.map((line) => JSON.stringify(line)).join("\n")}\n`;
writeFileSync(join(FIXTURES, "protocol-v2.jsonl"), jsonlText);

console.log(
  `✅ Generated fixtures: ${canonicalFile.vectors.length} canonical vectors, ` +
    `${signatureFile.vectors.length} signed envelopes, ${jsonl.length} wire lines (${jsonl.filter((l) => l.kind === "valid").length} valid / ` +
    `${jsonl.filter((l) => l.kind === "invalid").length} invalid).`,
);
console.log(`   fixture key fingerprint (test only): ${signatureFile.fingerprint}`);
