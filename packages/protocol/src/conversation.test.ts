import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_CONVERSATION_TURNS,
  MAX_TURN_CONTENT,
  applyConversationEvent,
  applyConversationEvents,
  initialConversationState,
  type ConversationEvent,
  type ConversationState,
} from "./conversation.ts";

/**
 * The reducer's job is to be boring under bad input. Every test below is a
 * delivery the phone or PC can actually produce: duplicates after a reconnect,
 * a chunk that arrives after the user interrupted, a partial that lands after
 * the final transcript, an event for a turn this device never received.
 */

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const OTHER_CONVERSATION = "22222222-2222-4222-8222-222222222222";
const TURN = "33333333-3333-4333-8333-333333333333";
const TURN_2 = "44444444-4444-4444-8444-444444444444";
const REQUEST = "55555555-5555-4555-8555-555555555555";
const AT = 1_700_000_000_000;

function received(overrides: Partial<ConversationEvent> = {}): ConversationEvent {
  return {
    type: "turn.received",
    conversationId: CONVERSATION,
    turnId: TURN,
    requestId: REQUEST,
    role: "user",
    source: "voice",
    createdAt: AT,
    ...(overrides as object),
  } as ConversationEvent;
}

function started(role: "user" | "assistant" = "user"): ConversationState {
  return applyConversationEvent(
    initialConversationState(CONVERSATION),
    received(role === "user" ? {} : { role: "assistant" }),
  );
}

test("a received turn becomes the active turn", () => {
  const state = started();
  assert.equal(state.turns.length, 1);
  assert.equal(state.activeTurnId, TURN);
  assert.equal(state.turns[0].status, "received");
  assert.equal(state.turns[0].final, false);
});

test("a duplicate turn.received does not add a second turn", () => {
  const once = started();
  const twice = applyConversationEvent(once, received());
  assert.equal(twice, once, "an ignored event returns the same state object");
  assert.equal(twice.turns.length, 1);
});

test("an event for a turn that was never received is dropped", () => {
  const state = started();
  const next = applyConversationEvent(state, {
    type: "transcript.final",
    conversationId: CONVERSATION,
    turnId: TURN_2,
    text: "hello",
  });
  assert.equal(next, state);
  assert.equal(next.turns.length, 1);
});

test("an event from another conversation never enters this transcript", () => {
  const state = started();
  const next = applyConversationEvent(state, {
    type: "transcript.final",
    conversationId: OTHER_CONVERSATION,
    turnId: TURN,
    text: "hello from somewhere else",
  });
  assert.equal(next, state);
  assert.equal(next.turns[0].text, "");
});

test("partial transcripts replace rather than accumulate", () => {
  let state = started();
  state = applyConversationEvent(state, {
    type: "transcript.partial",
    conversationId: CONVERSATION,
    turnId: TURN,
    text: "open my",
  });
  state = applyConversationEvent(state, {
    type: "transcript.partial",
    conversationId: CONVERSATION,
    turnId: TURN,
    text: "open my project",
  });
  assert.equal(state.turns[0].text, "open my project");
  assert.equal(state.turns[0].final, false);
});

test("a partial that arrives after the final transcript is ignored", () => {
  let state = started();
  state = applyConversationEvent(state, {
    type: "transcript.final",
    conversationId: CONVERSATION,
    turnId: TURN,
    text: "open my project",
  });
  const after = applyConversationEvent(state, {
    type: "transcript.partial",
    conversationId: CONVERSATION,
    turnId: TURN,
    text: "open my proj",
  });
  assert.equal(after, state);
  assert.equal(after.turns[0].text, "open my project");
});

test("a duplicate final transcript does not disturb the turn", () => {
  const final: ConversationEvent = {
    type: "transcript.final",
    conversationId: CONVERSATION,
    turnId: TURN,
    text: "what is on my calendar",
  };
  const once = applyConversationEvent(started(), final);
  const twice = applyConversationEvent(once, final);
  assert.equal(twice, once);
});

test("a user turn completes when its final transcript is accepted", () => {
  const state = applyConversationEvent(started(), {
    type: "transcript.final",
    conversationId: CONVERSATION,
    turnId: TURN,
    text: "what is on my calendar",
  });
  assert.equal(state.turns[0].status, "completed");
  assert.equal(state.turns[0].final, true);
  assert.equal(state.activeTurnId, null);
});

test("an assistant turn moves to processing and then streams", () => {
  let state = started("assistant");
  state = applyConversationEvent(state, {
    type: "transcript.final",
    conversationId: CONVERSATION,
    turnId: TURN,
    text: "You have two meetings today.",
  });
  assert.equal(state.turns[0].status, "processing");

  state = applyConversationEvent(state, {
    type: "response.chunk",
    conversationId: CONVERSATION,
    turnId: TURN,
    text: "You have two",
  });
  state = applyConversationEvent(state, {
    type: "response.chunk",
    conversationId: CONVERSATION,
    turnId: TURN,
    text: " meetings today.",
  });
  assert.equal(state.turns[0].status, "responding");
  assert.equal(state.turns[0].text, "You have two meetings today.");
});

test("an assistant turn can stream before any transcript exists", () => {
  let state = started("assistant");
  state = applyConversationEvent(state, {
    type: "response.chunk",
    conversationId: CONVERSATION,
    turnId: TURN,
    text: "Sure.",
  });
  assert.equal(state.turns[0].status, "responding");
  assert.equal(state.turns[0].text, "Sure.");
});

test("chunks are ignored on a user turn", () => {
  const state = started();
  const next = applyConversationEvent(state, {
    type: "response.chunk",
    conversationId: CONVERSATION,
    turnId: TURN,
    text: "not a response",
  });
  assert.equal(next, state);
});

test("a response at the content bound succeeds but an overflow fails without truncation", () => {
  let state = started("assistant");
  for (let index = 0; index < 8; index += 1) {
    state = applyConversationEvent(state, {
      type: "response.chunk",
      conversationId: CONVERSATION,
      turnId: TURN,
      text: "x".repeat(500),
    });
  }
  assert.equal(state.turns[0].text.length, MAX_TURN_CONTENT);
  assert.equal(state.turns[0].status, "responding");
  const overflow = applyConversationEvent(state, {
    type: "response.chunk", conversationId: CONVERSATION, turnId: TURN, text: "!",
  });
  assert.equal(overflow.turns[0].text, state.turns[0].text);
  assert.equal(overflow.turns[0].status, "failed");
  assert.equal(overflow.turns[0].final, true);
  assert.equal(applyConversationEvent(overflow, {
    type: "response.completed", conversationId: CONVERSATION, turnId: TURN,
  }), overflow, "an incomplete response cannot later be marked complete");
});

test("overflow never splits a surrogate pair or publishes a partial chunk", () => {
  let state = started("assistant");
  for (let index = 0; index < 7; index += 1) {
    state = applyConversationEvent(state, {
      type: "response.chunk", conversationId: CONVERSATION, turnId: TURN, text: "x".repeat(512),
    });
  }
  state = applyConversationEvent(state, {
    type: "response.chunk", conversationId: CONVERSATION, turnId: TURN, text: "x".repeat(415),
  });
  assert.equal(state.turns[0].text.length, MAX_TURN_CONTENT - 1);
  const overflow = applyConversationEvent(state, {
    type: "response.chunk", conversationId: CONVERSATION, turnId: TURN, text: "😀",
  });
  assert.equal(overflow.turns[0].text, state.turns[0].text);
  assert.equal(overflow.turns[0].status, "failed");
});

test("interruption ends the turn and stops further chunks", () => {
  let state = started("assistant");
  state = applyConversationEvent(state, {
    type: "response.chunk",
    conversationId: CONVERSATION,
    turnId: TURN,
    text: "Here is what I found",
  });
  state = applyConversationEvent(state, {
    type: "turn.interrupted",
    conversationId: CONVERSATION,
    turnId: TURN,
    reason: "barge_in",
  });
  assert.equal(state.turns[0].status, "interrupted");
  assert.equal(state.turns[0].interruptReason, "barge_in");
  assert.equal(state.activeTurnId, null);

  const late = applyConversationEvent(state, {
    type: "response.chunk",
    conversationId: CONVERSATION,
    turnId: TURN,
    text: " and more",
  });
  assert.equal(late, state, "speech that stops must stay stopped");
});

test("completion after interruption does not resurrect the turn", () => {
  let state = started("assistant");
  state = applyConversationEvent(state, {
    type: "turn.interrupted",
    conversationId: CONVERSATION,
    turnId: TURN,
    reason: "user_cancel",
  });
  const completed = applyConversationEvent(state, {
    type: "response.completed",
    conversationId: CONVERSATION,
    turnId: TURN,
  });
  assert.equal(completed, state);
  assert.equal(completed.turns[0].status, "interrupted");
});

test("completion is idempotent", () => {
  let state = started("assistant");
  state = applyConversationEvent(state, {
    type: "response.chunk",
    conversationId: CONVERSATION,
    turnId: TURN,
    text: "Done.",
  });
  const completed = applyConversationEvent(state, {
    type: "response.completed",
    conversationId: CONVERSATION,
    turnId: TURN,
  });
  const again = applyConversationEvent(completed, {
    type: "response.completed",
    conversationId: CONVERSATION,
    turnId: TURN,
  });
  assert.equal(completed.turns[0].status, "completed");
  assert.equal(again, completed);
});

test("a failure is terminal and keeps any text already spoken", () => {
  let state = started("assistant");
  state = applyConversationEvent(state, {
    type: "response.chunk",
    conversationId: CONVERSATION,
    turnId: TURN,
    text: "I could not",
  });
  state = applyConversationEvent(state, {
    type: "turn.failed",
    conversationId: CONVERSATION,
    turnId: TURN,
    reason: "inference timeout",
  });
  assert.equal(state.turns[0].status, "failed");
  assert.equal(state.turns[0].text, "I could not");
});

test("an empty failure still says something to the surface", () => {
  const state = applyConversationEvent(started("assistant"), {
    type: "turn.failed",
    conversationId: CONVERSATION,
    turnId: TURN,
    reason: "inference timeout",
  });
  assert.equal(state.turns[0].text, "inference timeout");
});

test("the active turn is the newest unfinished turn", () => {
  let state = started();
  state = applyConversationEvent(state, {
    type: "transcript.final",
    conversationId: CONVERSATION,
    turnId: TURN,
    text: "inspect the project",
  });
  state = applyConversationEvent(
    state,
    received({ turnId: TURN_2, role: "assistant" } as Partial<ConversationEvent>),
  );
  assert.equal(state.activeTurnId, TURN_2);
  assert.equal(state.turns.length, 2);
});

test("history is bounded and drops the oldest turn first", () => {
  let state = initialConversationState(CONVERSATION);
  for (let index = 0; index < MAX_CONVERSATION_TURNS + 5; index += 1) {
    const turnId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    state = applyConversationEvent(state, {
      type: "turn.received",
      conversationId: CONVERSATION,
      turnId,
      requestId: REQUEST,
      role: "user",
      source: "text",
      createdAt: AT + index,
    });
  }
  assert.equal(state.turns.length, MAX_CONVERSATION_TURNS);
  assert.equal(state.turns[0].turnId, "00000000-0000-4000-8000-000000000005");
  assert.equal(
    state.turns[state.turns.length - 1].turnId,
    `00000000-0000-4000-8000-${String(MAX_CONVERSATION_TURNS + 4).padStart(12, "0")}`,
  );
});

test("replaying the same batch twice changes nothing the second time", () => {
  const batch: ConversationEvent[] = [
    received(),
    { type: "transcript.partial", conversationId: CONVERSATION, turnId: TURN, text: "open" },
    { type: "transcript.final", conversationId: CONVERSATION, turnId: TURN, text: "open the project" },
  ];
  const once = applyConversationEvents(initialConversationState(CONVERSATION), batch);
  const twice = applyConversationEvents(once, batch);
  assert.deepEqual(twice.turns, once.turns);
  assert.equal(twice.activeTurnId, once.activeTurnId);
});
