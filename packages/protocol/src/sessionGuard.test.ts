import { generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";

import { createRemoteEnvelope, type RemoteEnvelope } from "./envelope.ts";
import { computeKeyId, signRemoteEnvelope } from "./signatures.ts";
import { RemoteSessionGuard } from "./sessionGuard.ts";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const keyId = computeKeyId(publicKey);
const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function seal(
  type: Parameters<typeof createRemoteEnvelope>[0]["type"],
  payload: Record<string, unknown>,
  options: { sequence?: number; sentAt?: number; sessionId?: string; messageId?: string } = {},
): RemoteEnvelope {
  const unsigned = createRemoteEnvelope({
    type,
    payload,
    keyId,
    sessionId: options.sessionId ?? sessionId,
    sequence: options.sequence ?? 0,
    sentAt: options.sentAt ?? 1_000,
    ...(options.messageId ? { messageId: options.messageId } : {}),
  });
  return signRemoteEnvelope(privateKey, unsigned);
}

test("session guard accepts a valid client ping and rejects exact replay", () => {
  const guard = new RemoteSessionGuard({ sessionId, keyId, publicKey });
  const message = seal("ping", { sentAt: 1_000 }, { sequence: 0 });
  const accepted = guard.verifyAndAccept(message, 1_000);
  assert.equal(accepted.accepted, true);
  if (accepted.accepted) assert.equal(accepted.payload.sentAt, 1_000);

  assert.deepEqual(guard.verifyAndAccept(message, 1_000), {
    accepted: false,
    reason: "replayed_message",
  });
  assert.equal(guard.getLastAcceptedSequence(), 0);
});

test("session guard permits sequence gaps but rejects non-increasing values", () => {
  const guard = new RemoteSessionGuard({ sessionId, keyId, publicKey });
  assert.equal(guard.verifyAndAccept(seal("ping", { sentAt: 1_000 }, { sequence: 0 }), 1_000).accepted, true);
  assert.equal(guard.verifyAndAccept(seal("ping", { sentAt: 1_000 }, { sequence: 3 }), 1_000).accepted, true);
  assert.deepEqual(
    guard.verifyAndAccept(seal("ping", { sentAt: 1_000 }, { sequence: 2 }), 1_000),
    { accepted: false, reason: "sequence_out_of_order" },
  );
  assert.equal(guard.getLastAcceptedSequence(), 3);
});

test("session guard rejects wrong session, wrong direction and invalid payload", () => {
  const guard = new RemoteSessionGuard({ sessionId, keyId, publicKey });
  assert.deepEqual(
    guard.verifyAndAccept(seal("ping", { sentAt: 1_000 }, {
      sequence: 0,
      sessionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
    }), 1_000),
    { accepted: false, reason: "wrong_session" },
  );

  const serverMessage = seal("task.accepted", {
    requestId: "00000000-0000-4000-8000-000000000001",
    taskId: "00000000-0000-4000-8000-000000000002",
    state: "accepted",
    taskVersion: 1,
    eventSeq: 1,
    acceptedAt: 1_000,
  }, { sequence: 0 });
  assert.deepEqual(guard.verifyAndAccept(serverMessage, 1_000), {
    accepted: false,
    reason: "wrong_direction",
  });

  assert.deepEqual(
    guard.verifyAndAccept(seal("task.submit", { capability: "system_status" }, { sequence: 0 }), 1_000),
    { accepted: false, reason: "invalid_payload" },
  );
  assert.equal(guard.getLastAcceptedSequence(), -1);
});

test("session guard rejects stale and future envelopes without mutating sequence", () => {
  const guard = new RemoteSessionGuard({
    sessionId, keyId, publicKey, maxMessageAgeMs: 10_000, maxFutureSkewMs: 2_000,
  });
  assert.deepEqual(
    guard.verifyAndAccept(seal("ping", { sentAt: 1_000 }, { sequence: 0, sentAt: 80_000 }), 100_000),
    { accepted: false, reason: "stale_message" },
  );
  assert.deepEqual(
    guard.verifyAndAccept(seal("ping", { sentAt: 103_000 }, { sequence: 0, sentAt: 103_000 }), 100_000),
    { accepted: false, reason: "future_message" },
  );
  assert.equal(guard.getLastAcceptedSequence(), -1);
});

test("session guard rejects tampered signatures and unknown key IDs", () => {
  const guard = new RemoteSessionGuard({ sessionId, keyId, publicKey });
  const message = seal("ping", { sentAt: 1_000 }, { sequence: 0 });
  const tampered = { ...message, payload: { sentAt: 2_000 } };
  assert.deepEqual(guard.verifyAndAccept(tampered, 1_000), {
    accepted: false,
    reason: "invalid_signature",
  });
  const unknown = { ...message, keyId: "AAAAAAAAAAAAAAAAAAAAAA" };
  assert.deepEqual(guard.verifyAndAccept(unknown, 1_000), {
    accepted: false,
    reason: "unknown_key",
  });
  assert.equal(guard.getLastAcceptedSequence(), -1);
});

test("session guard evicts old replay IDs but still enforces sequence monotonicity", () => {
  const guard = new RemoteSessionGuard({
    sessionId, keyId, publicKey, maxRememberedMessageIds: 1,
  });
  const first = seal("ping", { sentAt: 1_000 }, { sequence: 0 });
  const second = seal("ping", { sentAt: 1_000 }, { sequence: 1 });
  assert.equal(guard.verifyAndAccept(first, 1_000).accepted, true);
  assert.equal(guard.verifyAndAccept(second, 1_000).accepted, true);
  assert.deepEqual(guard.verifyAndAccept(first, 1_000), {
    accepted: false,
    reason: "sequence_out_of_order",
  });
});
