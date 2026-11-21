import assert from "node:assert/strict";
import { test } from "node:test";
import { initialConversationState } from "@vanessa/protocol/conversation";
import { DesktopConversationRuntime } from "./conversationRuntime.js";

const CONVERSATION_ID = "00000000-0000-4000-8000-000000000001";
const ids = () => {
  let next = 1;
  return () => "00000000-0000-4000-8000-" + String(next++).padStart(12, "0");
};

function makeRuntime() {
  let latest = initialConversationState(CONVERSATION_ID);
  const runtime = new DesktopConversationRuntime(
    latest,
    (state) => { latest = state; },
    ids(),
    () => 1_795_258_515_000,
  );
  return { runtime, get state() { return latest; } };
}

test("typed submit creates one completed user turn with stable canonical IDs", () => {
  const fixture = makeRuntime();
  const { runtime } = fixture;
  const request = runtime.submitTyped("  What is my default audio device?  ");
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
  const { runtime } = fixture;
  const request = runtime.submitTyped("Summarize this result");
  assert.ok(request);
  const response = "a".repeat(511) + "😀" + "b".repeat(40);
  assert.equal(runtime.completeAssistant(request, response), true);
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
  const { runtime } = fixture;
  const request = runtime.submitTyped("One request");
  assert.ok(request);
  assert.equal(runtime.completeAssistant(request, "First response"), true);
  assert.equal(runtime.completeAssistant(request, "Duplicate response"), false);
  assert.equal(fixture.state.turns.filter((turn) => turn.role === "assistant").length, 1);
  assert.equal(fixture.state.turns[1].text, "First response");
});

test("failed orchestrator response remains an explicit failed assistant turn", () => {
  const fixture = makeRuntime();
  const { runtime } = fixture;
  const request = runtime.submitTyped("Open the report");
  assert.ok(request);
  assert.equal(runtime.failAssistant(request, "The orchestrator is unavailable."), true);
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
  assert.deepEqual(context.map((turn) => turn.content), [
    "Question 6", "Answer 6", "Question 7", "Answer 7", "Question 8", "Answer 8",
  ]);
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
  const { runtime } = fixture;
  assert.equal(runtime.submitTyped("   "), null);
  assert.equal(runtime.submitTyped("x".repeat(4001)), null);
  assert.equal(fixture.state.turns.length, 0);
});

test("an over-limit assistant response fails rather than publishing a truncated success", () => {
  const fixture = makeRuntime();
  const { runtime } = fixture;
  const request = runtime.submitTyped("Generate a very long response");
  assert.ok(request);
  assert.equal(runtime.completeAssistant(request, "x".repeat(4001)), true);
  assert.equal(fixture.state.turns[1].status, "failed");
  assert.match(fixture.state.turns[1].text, /exceeded the conversation limit/);
});


test("voice final transcript uses the voice request ID and creates a voice-source turn", () => {
  const fixture = makeRuntime();
  const { runtime } = fixture;
  const requestId = "11111111-2222-4333-8444-555555555555";
  const request = runtime.submitVoiceFinal("  Turn on the light  ", requestId);
  assert.ok(request);
  assert.equal(request.source, "voice");
  assert.equal(request.requestId, requestId);
  assert.equal(fixture.state.turns.length, 1);
  assert.equal(fixture.state.turns[0].source, "voice");
  assert.equal(fixture.state.turns[0].text, "Turn on the light");
  assert.equal(fixture.state.turns[0].requestId, requestId);
});

test("duplicate voice final is idempotent and conflicting final text is rejected", () => {
  const fixture = makeRuntime();
  const { runtime } = fixture;
  const requestId = "22222222-2222-4333-8444-555555555555";
  const first = runtime.submitVoiceFinal("Read my calendar", requestId);
  assert.ok(first);
  const duplicate = runtime.submitVoiceFinal("Read my calendar", requestId);
  assert.deepEqual(duplicate, first);
  assert.equal(runtime.submitVoiceFinal("Delete my calendar", requestId), null);
  assert.equal(fixture.state.turns.length, 1);
});

test("voice assistant response shares the voice request ID and releases it from planner context", () => {
  const fixture = makeRuntime();
  const { runtime } = fixture;
  const requestId = "33333333-2222-4333-8444-555555555555";
  const request = runtime.submitVoiceFinal("What is my next meeting?", requestId);
  assert.ok(request);
  assert.deepEqual(runtime.plannerContext(), []);
  assert.equal(runtime.completeAssistant(request, "Your next meeting is at 3 PM."), true);
  assert.equal(fixture.state.turns[1].source, "voice");
  assert.equal(fixture.state.turns[1].requestId, requestId);
  assert.deepEqual(runtime.plannerContext(), [
    { role: "user", content: "What is my next meeting?" },
    { role: "assistant", content: "Your next meeting is at 3 PM." },
  ]);
});

test("voice request IDs must be canonical UUIDs before entering the shared protocol", () => {
  const { runtime } = makeRuntime();
  assert.equal(runtime.submitVoiceFinal("Turn on the light", "voice-abcd"), null);
});


test("interrupting assistant speech leaves an explicit interrupted turn and releases context", () => {
  const fixture = makeRuntime();
  const { runtime } = fixture;
  const request = runtime.submitVoiceFinal(
    "Find my next meeting",
    "44444444-2222-4333-8444-555555555555",
  );
  assert.ok(request);
  assert.equal(runtime.interruptAssistant(request, "user_cancel"), true);
  const assistant = fixture.state.turns[1];
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.status, "interrupted");
  assert.equal(assistant.requestId, request.requestId);
  assert.equal(runtime.plannerContext().length, 1);
  assert.equal(runtime.plannerContext()[0].content, "Find my next meeting");
});
