import assert from "node:assert/strict";
import { test } from "node:test";
import { initialConversationState } from "@vanessa/protocol/conversation";
import { DesktopConversationRuntime } from "./conversationRuntime.js";
import { DesktopVoiceConversationBridge } from "./voiceConversationBridge.js";

function fixture() {
  let state = initialConversationState("00000000-0000-4000-8000-000000000001");
  let nextId = 1;
  const runtime = new DesktopConversationRuntime(
    state,
    (next) => { state = next; },
    () => "00000000-0000-4000-8000-" + String(nextId++).padStart(12, "0"),
    () => 1_795_258_515_000,
  );
  const bridge = new DesktopVoiceConversationBridge(runtime);
  return { bridge, runtime, get state() { return state; } };
}

const requestId = "11111111-2222-4333-8444-555555555555";

test("final voice transcript creates one voice-source turn with the service request ID", () => {
  const f = fixture();
  assert.equal(f.bridge.acceptFinalTranscript("Read my calendar", requestId), true);
  assert.equal(f.state.turns.length, 1);
  assert.equal(f.state.turns[0].source, "voice");
  assert.equal(f.state.turns[0].requestId, requestId);
  assert.equal(f.state.turns[0].status, "completed");
});

test("duplicate final transcript is idempotent and conflicting text is rejected", () => {
  const f = fixture();
  assert.equal(f.bridge.acceptFinalTranscript("Read my calendar", requestId), true);
  assert.equal(f.bridge.acceptFinalTranscript("Read my calendar", requestId), true);
  assert.equal(f.bridge.acceptFinalTranscript("Delete my calendar", requestId), false);
  assert.equal(f.state.turns.length, 1);
});

test("voice assistant response joins the exact originating turn", () => {
  const f = fixture();
  assert.equal(f.bridge.acceptFinalTranscript("What is my next meeting?", requestId), true);
  assert.equal(f.bridge.completeAssistantResponse(requestId, "Your next meeting is at 3 PM."), true);
  assert.equal(f.state.turns.length, 2);
  assert.equal(f.state.turns[0].role, "user");
  assert.equal(f.state.turns[1].role, "assistant");
  assert.equal(f.state.turns[1].source, "voice");
  assert.equal(f.state.turns[1].requestId, requestId);
  assert.equal(f.state.turns[1].text, "Your next meeting is at 3 PM.");
  assert.equal(f.bridge.hasPendingRequest(requestId), false);
});

test("a response for an unknown or already completed request is ignored", () => {
  const f = fixture();
  assert.equal(f.bridge.completeAssistantResponse(requestId, "Unmatched response"), false);
  assert.equal(f.bridge.acceptFinalTranscript("Hello", requestId), true);
  assert.equal(f.bridge.completeAssistantResponse(requestId, "Hello there"), true);
  assert.equal(f.bridge.completeAssistantResponse(requestId, "Duplicate"), false);
  assert.equal(f.state.turns.length, 2);
});

test("voice context frame contains only completed turns and uses the canonical frame type", () => {
  const f = fixture();
  const first = f.runtime.submitTyped("Previous typed question");
  assert.ok(first);
  assert.equal(f.runtime.completeAssistant(first, "Previous typed answer"), true);
  assert.equal(f.bridge.acceptFinalTranscript("Current voice request", requestId), true);
  const frame = f.bridge.buildContextFrame();
  assert.equal(frame.type, "conversation_context");
  assert.deepEqual(frame.turns, [
    { role: "user", content: "Previous typed question" },
    { role: "assistant", content: "Previous typed answer" },
  ]);
  assert.ok(frame.turns.every((turn) => !turn.content.includes("Current voice request")));
});

test("malformed request IDs and message shapes are rejected", () => {
  const f = fixture();
  assert.equal(f.bridge.acceptFinalTranscript("Valid text", "voice-not-a-uuid"), false);
  assert.equal(f.bridge.acceptFinalTranscript({ text: "not a string" }, requestId), false);
  assert.equal(f.bridge.completeAssistantResponse(requestId, "No matching request"), false);
  assert.equal(f.state.turns.length, 0);
});

test("voice failure is stored as a failed assistant turn without claiming task cancellation", () => {
  const f = fixture();
  assert.equal(f.bridge.acceptFinalTranscript("Run my report", requestId), true);
  assert.equal(f.bridge.failAssistantResponse(requestId, "I could not verify the result."), true);
  assert.equal(f.state.turns[1].status, "failed");
  assert.equal(f.state.turns[1].text, "I could not verify the result.");
});


test("voice disconnect fails only the pending assistant response, not the task", () => {
  const f = fixture();
  assert.equal(f.bridge.acceptFinalTranscript("Run the analysis", requestId), true);
  const failed = f.bridge.failPendingResponses(
    "Voice disconnected. The task may still be running; check its task status.",
  );
  assert.equal(failed, 1);
  assert.equal(f.state.turns.length, 2);
  assert.equal(f.state.turns[1].status, "failed");
  assert.match(f.state.turns[1].text, /task may still be running/);
  assert.equal(f.bridge.hasPendingRequest(requestId), false);
  assert.equal(f.bridge.completeAssistantResponse(requestId, "Late response"), false);
});
