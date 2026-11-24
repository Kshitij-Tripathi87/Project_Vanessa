import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PersistedConversationStateSchema,
  applyConversationEvent,
  initialConversationState,
  projectPersistedConversation,
} from "./conversation.ts";

const conversationId = "11111111-1111-4111-8111-111111111111";
const otherConversation = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const userTurnId = "44444444-4444-4444-8444-444444444444";
const assistantTurnId = "55555555-5555-4555-8555-555555555555";

function conversationWithDraft() {
  let state = initialConversationState(conversationId);
  state = applyConversationEvent(state, {
    type: "turn.received", conversationId, turnId: userTurnId, requestId,
    role: "user", source: "voice", createdAt: 100,
  });
  state = applyConversationEvent(state, { type: "transcript.final", conversationId, turnId: userTurnId, text: "A committed question" });
  state = applyConversationEvent(state, {
    type: "turn.received", conversationId, turnId: assistantTurnId, requestId,
    role: "assistant", source: "voice", createdAt: 101,
  });
  state = applyConversationEvent(state, { type: "response.chunk", conversationId, turnId: assistantTurnId, text: "Unfinished private output" });
  return state;
}

test("durable projection keeps finalized turns but excludes in-flight content", () => {
  const live = conversationWithDraft();
  const snapshot = projectPersistedConversation(live);
  assert.equal(live.turns.length, 2, "Projecting must not mutate the live conversation.");
  assert.equal(live.activeTurnId, assistantTurnId);
  assert.equal(snapshot.activeTurnId, null);
  assert.deepEqual(snapshot.turns.map((turn) => turn.text), ["A committed question"]);
  assert.equal(JSON.stringify(snapshot).includes("Unfinished private output"), false);
});

test("a completed response is restored as terminal conversation data, not an active task", () => {
  const live = applyConversationEvent(conversationWithDraft(), { type: "response.completed", conversationId, turnId: assistantTurnId });
  const snapshot = projectPersistedConversation(live);
  assert.equal(snapshot.turns.length, 2);
  assert.equal(snapshot.turns[1].status, "completed");
  assert.equal(snapshot.activeTurnId, null);
  assert.deepEqual(PersistedConversationStateSchema.parse(JSON.parse(JSON.stringify(snapshot))), snapshot);
});

test("durable validation rejects cross-conversation, duplicate, live and unknown fields", () => {
  const snapshot = projectPersistedConversation(conversationWithDraft());
  const turn = snapshot.turns[0];
  assert.equal(PersistedConversationStateSchema.safeParse({ ...snapshot, turns: [{ ...turn, conversationId: otherConversation }] }).success, false);
  assert.equal(PersistedConversationStateSchema.safeParse({ ...snapshot, turns: [turn, turn] }).success, false);
  assert.equal(PersistedConversationStateSchema.safeParse({ ...snapshot, activeTurnId: turn.turnId }).success, false);
  assert.equal(PersistedConversationStateSchema.safeParse({ ...snapshot, turns: [{ ...turn, status: "processing", final: false }] }).success, false);
  assert.equal(PersistedConversationStateSchema.safeParse({ ...snapshot, turns: [{ ...turn, extra: "not allowed" }] }).success, false);
});

test("durable validation enforces text and history bounds", () => {
  const snapshot = projectPersistedConversation(conversationWithDraft());
  assert.equal(PersistedConversationStateSchema.safeParse({ ...snapshot, turns: [{ ...snapshot.turns[0], text: "x".repeat(4001) }] }).success, false);
  assert.equal(PersistedConversationStateSchema.safeParse({ ...snapshot, turns: Array(201).fill(snapshot.turns[0]) }).success, false);
});

test("interrupted and failed turns retain only status, never partial output or transcript drafts", () => {
  for (const terminal of [
    { type: "turn.interrupted" as const, reason: "user_cancel" as const },
    { type: "turn.failed" as const, reason: "synthetic failure" },
  ]) {
    const terminalState = applyConversationEvent(conversationWithDraft(), { ...terminal, conversationId, turnId: assistantTurnId });
    const snapshot = projectPersistedConversation(terminalState);
    assert.equal(snapshot.turns[1].text, "");
    assert.equal(snapshot.turns[1].streaming, false);
    assert.equal(JSON.stringify(snapshot).includes("Unfinished private output"), false);
    assert.equal(PersistedConversationStateSchema.safeParse({
      ...snapshot,
      turns: [snapshot.turns[0], { ...snapshot.turns[1], text: "unsafe draft" }],
    }).success, false);
  }

  let userDraft = initialConversationState(conversationId);
  userDraft = applyConversationEvent(userDraft, { type: "turn.received", conversationId, turnId: userTurnId, requestId, role: "user", source: "voice", createdAt: 102 });
  userDraft = applyConversationEvent(userDraft, { type: "transcript.partial", conversationId, turnId: userTurnId, text: "private ASR draft" });
  userDraft = applyConversationEvent(userDraft, { type: "turn.interrupted", conversationId, turnId: userTurnId, reason: "user_cancel" });
  assert.equal(projectPersistedConversation(userDraft).turns[0].text, "");
});
