import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  CONVERSATION_PROTOCOL_VERSION,
  MAX_CONVERSATION_TURNS,
  ConversationEventSchema,
  ConversationSessionSchema,
  ConversationTurnSchema,
  applyConversationEvent,
  applyConversationEvents,
  decodeConversationEvent,
  decodeConversationSession,
  decodeConversationTurn,
  initialConversationState,
  type ConversationEvent,
  type ConversationState,
} from "./conversation.ts";

const fixtures = new URL("../fixtures/", import.meta.url);
const wireLines = readFileSync(new URL("conversation-events-v1.jsonl", fixtures), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line));
const vectors = JSON.parse(readFileSync(new URL("conversation-reducer-vectors-v1.json", fixtures), "utf8"));

for (const fixture of wireLines) {
  test(`conversation wire: ${fixture.name}`, () => {
    const decode = fixture.kind === "event" ? decodeConversationEvent
      : fixture.kind === "session" ? decodeConversationSession
        : fixture.kind === "turn" ? decodeConversationTurn
          : undefined;
    assert.ok(decode, `unknown fixture kind ${fixture.kind}`);
    if (fixture.valid) {
      const decoded = decode(fixture.wire);
      // Compare normalized JSON: JavaScript retains -0 in memory, but JSON
      // serializes it as 0, which is what Kotlin's Long also represents.
      assert.deepEqual(JSON.parse(JSON.stringify(decoded)), fixture.expected);
    } else {
      assert.throws(() => decode(fixture.wire));
    }
  });
}

test("the checked-in conversation schema is derived from the three Zod declarations", () => {
  const schema = JSON.parse(readFileSync(new URL("../schema/conversation-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
  assert.equal(schema.$ref, "#/definitions/ConversationEvent");
  assert.equal(schema["x-vanessa-protocolVersion"], CONVERSATION_PROTOCOL_VERSION);
  assert.equal(schema["x-vanessa-maxConversationTurns"], MAX_CONVERSATION_TURNS);

  // Verify every standard keyword against a fresh Zod conversion and every
  // UTF-16 annotation against its source bound. JSON Schema's standard length
  // keywords alone count code points and cannot represent Zod's JS lengths.
  function withoutUtf16Annotations(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutUtf16Annotations);
    if (value === null || typeof value !== "object") return value;
    const node = value as Record<string, unknown>;
    if (node.minLength !== undefined) assert.equal(node["x-vanessa-minUtf16Length"], node.minLength);
    if (node.maxLength !== undefined) assert.equal(node["x-vanessa-maxUtf16Length"], node.maxLength);
    return Object.fromEntries(Object.entries(node)
      .filter(([key]) => key !== "x-vanessa-minUtf16Length" && key !== "x-vanessa-maxUtf16Length")
      .map(([key, child]) => [key, withoutUtf16Annotations(child)]));
  }
  for (const [name, source] of [
    ["ConversationEvent", ConversationEventSchema],
    ["ConversationSession", ConversationSessionSchema],
    ["ConversationTurn", ConversationTurnSchema],
  ] as const) {
    const converted = zodToJsonSchema(source, { name, $refStrategy: "none" });
    assert.deepEqual(withoutUtf16Annotations(schema.definitions[name]), converted.definitions?.[name], name);
  }
});

for (const vector of vectors.vectors) {
  test(`conversation reducer parity: ${vector.name}`, () => {
    let state: ConversationState = vector.initialState ?? initialConversationState(vector.conversationId);
    const initial = structuredClone(state);
    const events: ConversationEvent[] = [];
    for (const [index, item] of vector.steps.entries()) {
      const event = ConversationEventSchema.parse(item.event);
      events.push(event);
      const before = structuredClone(state);
      const next = applyConversationEvent(state, event);
      assert.deepEqual(state, before, `step ${index} mutated its input`);
      assert.equal(next === state, item.same, `step ${index} identity`);
      assert.deepEqual(next, item.state, `step ${index} normalized state`);
      state = next;
    }
    assert.deepEqual(applyConversationEvents(initial, events), state, "batch fold");
  });
}

test("shared conversation fixture corpus is nonempty and covers every wire family", () => {
  assert.equal(vectors.version, CONVERSATION_PROTOCOL_VERSION);
  assert.ok(vectors.vectors.length >= 10);
  assert.ok(wireLines.filter((item) => item.valid).length >= 20);
  assert.ok(wireLines.filter((item) => !item.valid).length >= 30);
  for (const kind of ["event", "session", "turn"]) {
    assert.ok(wireLines.some((item) => item.kind === kind && item.valid), kind);
    assert.ok(wireLines.some((item) => item.kind === kind && !item.valid), kind);
  }
});
