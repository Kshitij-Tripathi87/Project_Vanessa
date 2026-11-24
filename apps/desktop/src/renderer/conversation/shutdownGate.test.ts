import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversationShutdownGate } from "./shutdownGate.js";
import { initialConversationState } from "@vanessa/protocol/conversation";
import { DesktopConversationRuntime } from "./conversationRuntime.js";
import { LocalConversationHistory } from "./localConversationHistory.js";

test("shutdown gate permits startup but fails closed for a busy, failing, or unmounted owner", async () => {
  const gate = new ConversationShutdownGate();
  assert.equal(await gate.canSeal(), true);
  const dispose = gate.register(() => false);
  assert.equal(await gate.canSeal(), false);
  dispose();
  assert.equal(await gate.canSeal(), false, "Unmount does not prove async callbacks have stopped.");
  const disposeFailing = gate.register(async () => { throw new Error("failure"); });
  assert.equal(await gate.canSeal(), false);
  disposeFailing();
  assert.equal(await gate.canSeal(), false);
  gate.register(() => true);
  assert.equal(await gate.canSeal(), false, "A new owner cannot certify work belonging to an abandoned owner.");
});

test("a stale owner cannot authorize shutdown after replacement", async () => {
  const gate = new ConversationShutdownGate();
  let release!: (safe: boolean) => void;
  const disposeOld = gate.register(() => new Promise((resolve) => { release = resolve; }));
  const pending = gate.canSeal();
  const disposeNew = gate.register(() => false);
  disposeOld();
  release(true);
  assert.equal(await pending, false);
  assert.equal(await gate.canSeal(), false);
  disposeNew();
});

test("replacement cannot hide a retired owner's pending work", async () => {
  const gate = new ConversationShutdownGate();
  let pending = true;
  const dispose = gate.register(() => !pending);
  dispose();
  gate.register(() => true);
  assert.equal(await gate.canSeal(), false);
  pending = false;
  assert.equal(await gate.canSeal(), true);
});

test("unmount during an async drain invalidates the acknowledgement", async () => {
  const gate = new ConversationShutdownGate();
  let release!: (safe: boolean) => void;
  const dispose = gate.register(() => new Promise((resolve) => { release = resolve; }));
  const pending = gate.canSeal();
  dispose();
  release(true);
  assert.equal(await pending, false);
});

test("a response arriving after a blocked close is persisted before a later successful drain", async () => {
  const snapshots: Array<string[]> = [];
  const history = new LocalConversationHistory(() => ({
    load: async () => ({ ok: true, state: null, revision: 0 }),
    save: async (state, revision) => {
      snapshots.push(state.turns.map((turn) => turn.text));
      return { ok: true, revision: revision + 1 };
    },
    clear: async () => ({ ok: true, revision: 0 }),
  }), () => {});
  await history.initialize();
  let sequence = 0;
  const runtime = new DesktopConversationRuntime(
    initialConversationState("11111111-1111-4111-8111-111111111111"),
    (state) => history.record(state),
    () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    () => 100,
  );
  const gate = new ConversationShutdownGate();
  gate.register(() => !runtime.hasPendingRequests);
  const request = runtime.submitTyped("Pending question");
  assert(request);
  assert.equal(await gate.canSeal(), false, "An in-flight request cannot claim a complete drain.");
  assert.equal(runtime.completeAssistant(request, "Late response"), true);
  assert.equal(await gate.canSeal(), true);
  assert.equal(await history.sealAndFlush(), true);
  assert.deepEqual(snapshots.at(-1), ["Pending question", "Late response"]);
});
