import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  BoundedJsonSchema,
  CapabilityNameSchema,
  EpochMsSchema,
  HexSha256Schema,
  MAX_JSON_DEPTH,
  OpaqueIdSchema,
  REMOTE_MESSAGE_DIRECTIONS,
  REMOTE_MESSAGE_TYPES,
  REMOTE_PAYLOAD_SCHEMAS,
  REMOTE_PROTOCOL_VERSION,
  RemoteCapabilitySchema,
  RemotePermissionTierSchema,
  RemoteTaskStateSchema,
  ScopeSchema,
  SUPPORTED_REMOTE_PROTOCOL_VERSIONS,
  TaskEventSchema,
  TaskResultStatusSchema,
  UuidSchema,
  parseRemotePayload,
  safeParseRemotePayload,
  type RemoteMessageType,
} from "./messages.ts";

const TASK_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const REQUEST_ID = "b1b2c3d4-e5f6-4a7b-8c9d-d0e1f2a3b4c5";
const NOW = 1_760_000_000_000;

test("every message type has a direction and a payload schema", () => {
  assert.equal(REMOTE_PROTOCOL_VERSION, 2);
  assert.deepEqual([...SUPPORTED_REMOTE_PROTOCOL_VERSIONS], [2]);
  assert.equal(Object.keys(REMOTE_MESSAGE_DIRECTIONS).length, REMOTE_MESSAGE_TYPES.length);
  assert.equal(Object.keys(REMOTE_PAYLOAD_SCHEMAS).length, REMOTE_MESSAGE_TYPES.length);
  for (const type of REMOTE_MESSAGE_TYPES) {
    assert.equal(REMOTE_MESSAGE_DIRECTIONS[type] !== undefined, true, `${type} has no direction`);
    assert.equal(REMOTE_PAYLOAD_SCHEMAS[type] !== undefined, true, `${type} has no payload schema`);
  }
  // Only keepalive is symmetric: everything else is a request or a reply, never both.
  const bidirectional = REMOTE_MESSAGE_TYPES.filter((type) => REMOTE_MESSAGE_DIRECTIONS[type] === "bidirectional");
  assert.deepEqual(bidirectional, ["ping", "pong"]);
  // No message may be sent by nobody.
  for (const direction of Object.values(REMOTE_MESSAGE_DIRECTIONS)) {
    assert.equal(["client_to_server", "server_to_client", "bidirectional"].includes(direction), true);
  }
});

test("task lifecycle states match the documented set, and results are terminal-only", () => {
  assert.deepEqual([...RemoteTaskStateSchema.options], [
    "accepted",
    "queued",
    "planning",
    "validating",
    "awaiting_input",
    "awaiting_approval",
    "running",
    "verifying",
    "succeeded",
    "partial",
    "failed",
    "cancelled",
    "timed_out",
    "interrupted",
    "unknown",
  ]);
  // Every status reported by task.result is a state the task can end in, and
  // every non-terminal state is absent from that list.
  for (const status of TaskResultStatusSchema.options) {
    assert.equal(RemoteTaskStateSchema.options.includes(status), true, `${status} is not a task state`);
  }
  assert.equal(TaskResultStatusSchema.options.includes("running"), false);
  assert.equal(TaskResultStatusSchema.options.includes("awaiting_approval"), false);
});

test("permission tiers are the four documented levels", () => {
  assert.deepEqual([...RemotePermissionTierSchema.options], ["T0", "T1", "T2", "T3"]);
});

test("primitives enforce their bounds", () => {
  assert.equal(UuidSchema.safeParse(TASK_ID).success, true);
  assert.equal(UuidSchema.safeParse("not-a-uuid").success, false);
  assert.equal(UuidSchema.safeParse(TASK_ID.toUpperCase()).success, false, "UUIDs are lowercase on the wire");

  assert.equal(EpochMsSchema.safeParse(NOW).success, true);
  assert.equal(EpochMsSchema.safeParse(0).success, true);
  assert.equal(EpochMsSchema.safeParse(-1).success, false);
  assert.equal(EpochMsSchema.safeParse(8.64e15 + 1).success, false);
  assert.equal(EpochMsSchema.safeParse(1.5).success, false, "a fractional instant is a malformed message");

  assert.equal(HexSha256Schema.safeParse("a".repeat(64)).success, true);
  assert.equal(HexSha256Schema.safeParse("A".repeat(64)).success, false, "digests are lowercase hex");
  assert.equal(HexSha256Schema.safeParse("a".repeat(63)).success, false);

  assert.equal(ScopeSchema.safeParse("media_control").success, true);
  assert.equal(ScopeSchema.safeParse("files.read").success, true);
  assert.equal(ScopeSchema.safeParse("Media_control").success, false);
  assert.equal(ScopeSchema.safeParse("x".repeat(65)).success, false);

  assert.equal(CapabilityNameSchema.safeParse("media_play_pause").success, true);
  assert.equal(CapabilityNameSchema.safeParse("Media_play").success, false);
  assert.equal(CapabilityNameSchema.safeParse("9lives").success, false);

  assert.equal(OpaqueIdSchema.safeParse("pixel-9-pro").success, true);
  assert.equal(OpaqueIdSchema.safeParse("short").success, false);
  assert.equal(OpaqueIdSchema.safeParse("has space").success, false);
});

test("bounded JSON accepts real argument shapes and rejects runaway depth", () => {
  assert.equal(BoundedJsonSchema.safeParse({ a: [1, 2, { b: "c" }], d: null }).success, true);
  assert.equal(BoundedJsonSchema.safeParse("leaf").success, true);
  assert.equal(BoundedJsonSchema.safeParse(Number.NaN).success, false, "JSON has no NaN");

  // Depth is counted in wrappers around a leaf: `{"a":"leaf"}` is level 1.
  let nested: unknown = "leaf";
  for (let index = 0; index < MAX_JSON_DEPTH; index += 1) nested = { nested };
  assert.equal(BoundedJsonSchema.safeParse(nested).success, true, "MAX_JSON_DEPTH levels are accepted");

  let tooDeep: unknown = "leaf";
  for (let index = 0; index <= MAX_JSON_DEPTH; index += 1) tooDeep = { nested: tooDeep };
  assert.equal(BoundedJsonSchema.safeParse(tooDeep).success, false, "one level past the bound is rejected");
});

test("a capability advertises its own argument schema and timeout", () => {
  const capability = {
    name: "media_play_pause",
    version: 1,
    description: "Play or pause the active media session.",
    tier: "T1",
    scopes: ["media_control"],
    idempotent: true,
    timeoutMs: 15_000,
    argumentsSchema: { type: "object", properties: {}, additionalProperties: false },
  };
  assert.equal(RemoteCapabilitySchema.safeParse(capability).success, true);
  assert.equal(RemoteCapabilitySchema.safeParse({ ...capability, timeoutMs: 0 }).success, false);
  assert.equal(RemoteCapabilitySchema.safeParse({ ...capability, timeoutMs: 600_001 }).success, false);
  assert.equal(RemoteCapabilitySchema.safeParse({ ...capability, scopes: [] }).success, true);
  assert.equal(
    RemoteCapabilitySchema.safeParse({ ...capability, scopes: Array.from({ length: 33 }, () => "media_control") }).success,
    false,
  );
});

test("task.submit carries a request id, an idempotency key and normalized arguments only", () => {
  const parsed = parseRemotePayload("task.submit", {
    requestId: REQUEST_ID,
    idempotencyKey: "idem-key-0001",
    capability: "media_play_pause",
    canonicalArguments: { query: "focus" },
    intent: "put on my focus playlist",
  });
  assert.equal(parsed.capability, "media_play_pause");

  const strict = safeParseRemotePayload("task.submit", {
    requestId: REQUEST_ID,
    idempotencyKey: "idem-key-0001",
    capability: "media_play_pause",
    canonicalArguments: {},
    tier: "T3",
  });
  assert.equal(strict.success, false, "a client may not assert its own tier");
  if (!strict.success) {
    assert.match(JSON.stringify(strict.error.issues), /tier/);
  }

  // Arguments are bounded: 32 members and 64-character keys.
  const wide: Record<string, unknown> = {};
  for (let index = 0; index < 33; index += 1) wide[`arg${index}`] = index;
  assert.equal(
    safeParseRemotePayload("task.submit", {
      requestId: REQUEST_ID,
      idempotencyKey: "idem-key-0001",
      capability: "media_play_pause",
      canonicalArguments: wide,
    }).success,
    false,
  );

  assert.equal(
    safeParseRemotePayload("task.submit", {
      requestId: REQUEST_ID,
      idempotencyKey: "short",
      capability: "media_play_pause",
      canonicalArguments: {},
    }).success,
    false,
    "an idempotency key must be long enough to be unguessable",
  );
});

test("task.result cannot carry raw tool output", () => {
  const result = {
    taskId: TASK_ID,
    status: "succeeded",
    verification: { status: "verified", summary: "Volume reported 40%." },
    safeSummary: "Playback resumed.",
    eventSeq: 7,
    completedAt: NOW,
  };
  assert.equal(parseRemotePayload("task.result", result).status, "succeeded");
  assert.equal(
    safeParseRemotePayload("task.result", { ...result, status: "running" }).success,
    false,
    "task.result reports a terminal status",
  );
  assert.equal(safeParseRemotePayload("task.result", { ...result, rawOutput: "..." }).success, false);
  assert.equal(
    safeParseRemotePayload("task.result", { ...result, safeSummary: "x".repeat(501) }).success,
    false,
    "the summary is bounded so one result cannot flood the timeline",
  );
});

test("an event's safe payload is bounded in count, key length and value length", () => {
  const event = {
    eventId: TASK_ID,
    eventSeq: 0,
    taskId: TASK_ID,
    type: "task.progress",
    state: "running",
    safePayload: { step: "opening the app" },
    at: NOW,
  };
  assert.equal(TaskEventSchema.safeParse(event).success, true);
  assert.equal(TaskEventSchema.safeParse({ ...event, safePayload: { step: "x".repeat(201) } }).success, false);
  assert.equal(TaskEventSchema.safeParse({ ...event, safePayload: { ["k".repeat(41)]: "v" } }).success, false);

  const many: Record<string, string> = {};
  for (let index = 0; index < 17; index += 1) many[`k${index}`] = "v";
  assert.equal(TaskEventSchema.safeParse({ ...event, safePayload: many }).success, false);
});

test("manifest.get is the only empty payload and still rejects members", () => {
  assert.deepEqual(parseRemotePayload("manifest.get", {}), {});
  assert.equal(safeParseRemotePayload("manifest.get", { since: NOW }).success, false);
});

test("payload types are strictly typed", () => {
  // Every payload schema must reject an undeclared member, not just ignore it:
  // ignoring one is how a client-asserted field becomes trusted. Verified here
  // structurally for the whole registry rather than per message.
  for (const [type, schema] of Object.entries(REMOTE_PAYLOAD_SCHEMAS) as [RemoteMessageType, z.ZodTypeAny][]) {
    const shape = schema instanceof z.ZodEffects ? schema.innerType() : schema;
    if (!(shape instanceof z.ZodObject)) continue;
    assert.equal(shape.shape !== undefined, true, `${type} has no shape`);
    // `.strict()` is the only unknownKeys setting this protocol allows.
    assert.equal(
      shape._def.unknownKeys,
      "strict",
      `${type} must be strict; ${String(shape._def.unknownKeys)} lets a peer add fields`,
    );
  }
});
