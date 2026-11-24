import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyConversationEvent,
  initialConversationState,
  projectPersistedConversation,
  type LocalConversationLoadResult,
  type LocalConversationMutationResult,
} from "@vanessa/protocol/conversation";
import { LocalConversationHistory, type ConversationHistoryBridge, type ConversationHistoryStatus } from "./localConversationHistory.js";
import { hydrateBeforeStartingConversation } from "./bootstrapHistory.js";

const conversationId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const turnId = "33333333-3333-4333-8333-333333333333";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function conversation(text: string) {
  let state = initialConversationState(conversationId);
  state = applyConversationEvent(state, { type: "turn.received", conversationId, turnId, requestId, role: "user", source: "text", createdAt: 42 });
  return applyConversationEvent(state, { type: "transcript.final", conversationId, turnId, text });
}

function fixture(bridge?: ConversationHistoryBridge, timeout = 5000) {
  const statuses: ConversationHistoryStatus[] = [];
  const history = new LocalConversationHistory(() => bridge, (status) => statuses.push(status), timeout);
  return { history, statuses };
}

test("hydration completes before the runtime starts and never starts a task", async () => {
  const load = deferred<LocalConversationLoadResult>();
  const state = projectPersistedConversation(conversation("Restored private history"));
  const { history } = fixture({ load: () => load.promise, save: async () => { throw new Error("unexpected save"); }, clear: async () => { throw new Error("unexpected clear"); } });
  const events: string[] = [];
  const startup = hydrateBeforeStartingConversation(history, (loaded) => {
    assert.deepEqual(loaded, state);
    events.push("published");
  }, () => events.push("started"), () => events.push("error"));
  assert.deepEqual(events, []);
  load.resolve({ ok: true, state, revision: 1 });
  await startup;
  assert.deepEqual(events, ["published", "started"]);
  assert.deepEqual(await history.initialize(), state, "Initialization is idempotent.");
});

test("a timed-out load cannot later overwrite or enable saving in the new session", async () => {
  const load = deferred<LocalConversationLoadResult>();
  let writes = 0;
  const { history, statuses } = fixture({
    load: () => load.promise,
    save: async () => { writes += 1; return { ok: true, revision: 1 }; },
    clear: async () => ({ ok: true, revision: 0 }),
  }, 5);
  assert.equal(await history.initialize(), null);
  assert.equal(statuses.at(-1), "error");
  load.resolve({ ok: true, state: projectPersistedConversation(conversation("old")), revision: 1 });
  await Promise.resolve();
  history.record(conversation("new"));
  await history.flush();
  assert.equal(writes, 0);
  assert.equal(await history.clear(), "failed", "An inaccessible vault must not be silently cleared.");
  assert.equal(statuses.at(-1), "error");
});

test("unavailable storage is explicitly session-only; corrupted results fail closed", async () => {
  const absent = fixture();
  assert.equal(await absent.history.initialize(), null);
  assert.deepEqual(absent.statuses, ["session_only"]);
  assert.equal(await absent.history.clear(), "session_only");

  let mutations = 0;
  const broken = fixture({
    load: async () => ({ ok: true, state: null, revision: 3 }),
    save: async () => { mutations += 1; return { ok: true, revision: 1 }; },
    clear: async () => { mutations += 1; return { ok: true, revision: 0 }; },
  });
  assert.equal(await broken.history.initialize(), null);
  broken.history.record(conversation("must not overwrite"));
  assert.equal(await broken.history.clear(), "failed");
  assert.equal(mutations, 0);
  assert.equal(broken.statuses.at(-1), "error");
});

test("slow writes are ordered by revision and coalesce to the latest bounded snapshot", async () => {
  const first = deferred<LocalConversationMutationResult>();
  const writes: Array<{ text: string; revision: number }> = [];
  const { history, statuses } = fixture({
    load: async () => ({ ok: true, state: null, revision: 0 }),
    save: async (state, revision) => {
      writes.push({ text: state.turns[0].text, revision });
      return writes.length === 1 ? first.promise : { ok: true, revision: revision + 1 };
    },
    clear: async () => ({ ok: true, revision: 0 }),
  });
  await history.initialize();
  history.record(conversation("first"));
  history.record(conversation("middle"));
  history.record(conversation("latest"));
  assert.deepEqual(writes, [{ text: "first", revision: 0 }]);
  assert.equal(statuses.at(-1), "saving");
  first.resolve({ ok: true, revision: 1 });
  await history.flush();
  assert.deepEqual(writes, [{ text: "first", revision: 0 }, { text: "latest", revision: 1 }]);
  assert.equal(statuses.at(-1), "saved");
});

test("clear waits for all accepted writes, fences new snapshots and resets the revision", async () => {
  const save = deferred<LocalConversationMutationResult>();
  const operations: string[] = [];
  let first = true;
  const { history } = fixture({
    load: async () => ({ ok: true, state: null, revision: 0 }),
    save: async (state, revision) => {
      operations.push(`save:${state.turns[0].text}:${revision}`);
      if (first) { first = false; return save.promise; }
      return { ok: true, revision: revision + 1 };
    },
    clear: async (revision) => { operations.push(`clear:${revision}`); return { ok: true, revision: 0 }; },
  });
  await history.initialize();
  history.record(conversation("before"));
  const clearing = history.clear();
  history.record(conversation("ignored during clear"));
  assert.deepEqual(operations, ["save:before:0"]);
  save.resolve({ ok: true, revision: 1 });
  assert.equal(await clearing, "cleared");
  assert.deepEqual(operations, ["save:before:0", "clear:1"]);
  history.record(conversation("after"));
  await history.flush();
  assert.equal(operations.at(-1), "save:after:0");
});

test("a write error stops later writes and makes a queued clear fail instead of discarding the session", async () => {
  const save = deferred<LocalConversationMutationResult>();
  let clears = 0;
  const { history, statuses } = fixture({
    load: async () => ({ ok: true, state: null, revision: 0 }),
    save: () => save.promise,
    clear: async () => { clears += 1; return { ok: true, revision: 0 }; },
  });
  await history.initialize();
  history.record(conversation("unsaved"));
  const clearing = history.clear();
  save.resolve({ ok: false, reason: "storage" });
  assert.equal(await clearing, "failed");
  assert.equal(clears, 0);
  assert.equal(statuses.at(-1), "error");
  assert.equal(await history.sealAndFlush(), false);
});

test("shutdown drains accepted writes, fences new ones, and can resume after a cancelled close", async () => {
  const save = deferred<LocalConversationMutationResult>();
  const writes: string[] = [];
  let first = true;
  const { history } = fixture({
    load: async () => ({ ok: true, state: null, revision: 0 }),
    save: async (state, revision) => {
      writes.push(state.turns[0].text);
      if (first) { first = false; return save.promise; }
      return { ok: true, revision: revision + 1 };
    },
    clear: async () => ({ ok: true, revision: 0 }),
  });
  await history.initialize();
  history.record(conversation("accepted"));
  const closing = history.sealAndFlush();
  history.record(conversation("not admitted during close"));
  save.resolve({ ok: true, revision: 1 });
  assert.equal(await closing, true);
  assert.deepEqual(writes, ["accepted"]);
  history.resumeAfterCancelledClose(conversation("after cancelling close"));
  await history.flush();
  assert.deepEqual(writes, ["accepted", "after cancelling close"]);
});

test("shutdown also waits for a clear already in flight", async () => {
  const clearing = deferred<LocalConversationMutationResult>();
  const { history } = fixture({
    load: async () => ({ ok: true, state: null, revision: 0 }),
    save: async (_state, revision) => ({ ok: true, revision: revision + 1 }),
    clear: () => clearing.promise,
  });
  await history.initialize();
  const clear = history.clear();
  let drained = false;
  const closing = history.sealAndFlush().then((result) => { drained = true; return result; });
  await Promise.resolve();
  assert.equal(drained, false);
  clearing.resolve({ ok: true, revision: 0 });
  assert.equal(await clear, "cleared");
  assert.equal(await closing, true);
});
