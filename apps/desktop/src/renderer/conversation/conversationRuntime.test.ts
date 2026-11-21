import assert from "node:assert/strict";
import { test } from "node:test";
import { initialConversationState, type ConversationState } from "@vanessa/protocol/conversation";
import { DesktopConversationRuntime } from "./conversationRuntime.js";

const CONVERSATION_ID = "00000000-0000-4000-8000-000000000001";
const ids = () => {
  let next = 1;
  return () => "00000000-0000-4000-8000-" + String(next++).padStart(12, "0");
};

function makeRuntime() {
  let latest = initialConversationState(CONVERSATION_ID);
  const runtime = new DesktopConversationRuntime(latest, (state) => { latest = state; }, ids(), () => 1_795_258_515_000);
  return { runtime, get state() { return latest; } };
}

test("typed submit creates one completed user turn with stable canonical IDs", () => {
  const fixture = makeRuntime();
  const request = fixture.runtime.submitTyped("  What is my default audio device?  ");
  assert.ok(request);
  assert.match(request.requestId, /^[0-9a-f-]{36}$/);
  assert.match(request.userTurnId, /^[0-9a-f-]{36}$/);
  assert.equal(fixture.state.turns.length, 1);
  assert.equal(fixture.state.turns[0].role, "user");
  assert.equal(fixture.state.turns[0].text, "What is my default audio device?");
  assert.equal(fixture.state.turns[0].status, "completed");
  assert.equal(fixture.state.turns[0].requestId, request.requestId);
});

test("assistant response shares the request ID and completes through bounded chunks", () => {
  const fixture = makeRuntime();
  const request = fixture.runtime.submitTyped("Summarize this result");
  assert.ok(request);
  const response = "a".repeat(511) + "😀" + "b".repeat(40);
  assert.equal(fixture.runtime.completeAssistant(request, response), true);
  const user = fixture.state.turns[0];
  const assistant = fixture.state.turns[1];
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.requestId, user.requestId);
  assert.equal(assistant.status, "completed");
  assert.equal(assistant.text, response);
  assert.equal(assistant.final, true);
});

test("duplicate assistant completion cannot manufacture another response turn", () => {
  const fixture = makeRuntime();
  const request = fixture.runtime.submitTyped("One request");
  assert.ok(request);
  assert.equal(fixture.runtime.completeAssistant(request, "First response"), true);
  assert.equal(fixture.runtime.completeAssistant(request, "Duplicate response"), false);
  assert.equal(fixture.state.turns.filter((turn) => turn.role === "assistant").length, 1);
  assert.equal(fixture.state.turns[1].text, "First response");
});

test("failed orchestrator response remains an explicit failed assistant turn", () => {
  const fixture = makeRuntime();
  const request = fixture.runtime.submitTyped("Open the report");
  assert.ok(request);
  assert.equal(fixture.runtime.failAssistant(request, "The orchestrator is unavailable."), true);
  assert.equal(fixture.state.turns[1].status, "failed");
  assert.equal(fixture.state.turns[1].text, "The orchestrator is unavailable.");
});

test("planner context contains only the six newest completed turns and excludes the current request", () => {
  const { runtime } = makeRuntime();
  for (let i = 1; i <= 8; i++) {
    const request = runtime.submitTyped("Question " + i);
    assert.ok(request);
    assert.equal(runtime.completeAssistant(request, "Answer " + i), true);
  }
  const current = runtime.submitTyped("Current request");
  assert.ok(current);
  const context = runtime.plannerContext(current.requestId);
  assert.deepEqual(context.map((turn) => turn.content), ["Question 6", "Answer 6", "Question 7", "Answer 7", "Question 8", "Answer 8"]);
  assert.ok(context.every((turn) => !turn.content.includes("Current request")));
});

test("planner context collapses and bounds each turn", () => {
  const { runtime } = makeRuntime();
  const request = runtime.submitTyped("Earlier question " + "x".repeat(300));
  assert.ok(request);
  assert.equal(runtime.completeAssistant(request, "Earlier answer\n" + "y".repeat(300)), true);
  const current = runtime.submitTyped("Now");
  assert.ok(current);
  const context = runtime.plannerContext(current.requestId);
  assert.ok(context.every((turn) => turn.content.length <= 240));
  assert.ok(context.every((turn) => !/\s{2,}|\n/.test(turn.content)));
});

test("blank and over-limit requests do not create transcript turns", () => {
  const fixture = makeRuntime();
  assert.equal(fixture.runtime.submitTyped("   "), null);
  assert.equal(fixture.runtime.submitTyped("x".repeat(4001)), null);
  assert.equal(fixture.state.turns.length, 0);
});

test("an over-limit assistant response fails rather than publishing a truncated success", () => {
  const fixture = makeRuntime();
  const request = fixture.runtime.submitTyped("Generate a very long response");
  assert.ok(request);
  assert.equal(fixture.runtime.completeAssistant(request, "x".repeat(4001)), true);
  assert.equal(fixture.state.turns[1].status, "failed");
  assert.match(fixture.state.turns[1].text, /exceeded the conversation limit/);
});

function fullHistory(firstUnfinished = false) {
  const uuid = ids();
  const base = initialConversationState(CONVERSATION_ID);
  const turns = Array.from({ length: 200 }, (_, index) => ({
    turnId: uuid(), conversationId: CONVERSATION_ID, requestId: uuid(),
    role: "user" as const, source: "text" as const, text: "Request " + index,
    final: !(firstUnfinished && index === 0), streaming: false,
    status: firstUnfinished && index === 0 ? "processing" as const : "completed" as const,
    createdAt: index,
  }));
  let latest: ConversationState = { ...base, turns, activeTurnId: firstUnfinished ? turns[0].turnId : null };
  const runtime = new DesktopConversationRuntime(latest, (state) => { latest = state; }, uuid, () => 1);
  return { turns, runtime, get state() { return latest; } };
}

test("assistant response does not evict an unfinished oldest turn at the history limit", () => {
  const fixture = fullHistory(true);
  const user = fixture.turns[199];
  assert.equal(fixture.runtime.completeAssistant({ conversationId: CONVERSATION_ID, requestId: user.requestId, userTurnId: user.turnId, source: "text" }, "Answer"), false);
  assert.equal(fixture.state.turns.length, 200);
  assert.equal(fixture.state.turns[0].turnId, fixture.turns[0].turnId);
  assert.equal(fixture.state.turns[0].status, "processing");
});

test("assistant response does not evict its originating user turn", () => {
  const fixture = fullHistory();
  const user = fixture.turns[0];
  assert.equal(fixture.runtime.completeAssistant({ conversationId: CONVERSATION_ID, requestId: user.requestId, userTurnId: user.turnId, source: "text" }, "Answer"), false);
  assert.equal(fixture.state.turns[0].turnId, user.turnId);
  assert.equal(fixture.state.turns.length, 200);
});

test("assistant response may evict an unrelated completed oldest turn", () => {
  const fixture = fullHistory();
  const user = fixture.turns[199];
  assert.equal(fixture.runtime.completeAssistant({ conversationId: CONVERSATION_ID, requestId: user.requestId, userTurnId: user.turnId, source: "text" }, "Answer"), true);
  assert.equal(fixture.state.turns.length, 200);
  assert.equal(fixture.state.turns[0].turnId, fixture.turns[1].turnId);
  assert.equal(fixture.state.turns[199].requestId, user.requestId);
  assert.equal(fixture.state.turns[199].status, "completed");
});
