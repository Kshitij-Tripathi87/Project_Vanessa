import assert from "node:assert/strict";
import { test } from "node:test";
import { initialConversationState } from "@vanessa/protocol/conversation";
import { HistoryShutdownCoordinator } from "./historyShutdownCoordinator.js";

const state = initialConversationState("11111111-1111-4111-8111-111111111111");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test("cancelled close cannot be sealed by a late owner acknowledgement", async () => {
  const delayed = deferred<boolean>();
  let seals = 0;
  let resumes = 0;
  const closing: boolean[] = [];
  const coordinator = new HistoryShutdownCoordinator(
    { canSeal: () => delayed.promise },
    { sealAndFlush: async () => { seals++; return true; }, resumeAfterCancelledClose: (current) => { assert.equal(current, state); resumes++; } },
    (value) => closing.push(value), () => state,
  );
  const attempt = coordinator.request();
  coordinator.cancel();
  delayed.resolve(true);
  assert.equal(await attempt, false);
  assert.equal(seals, 0);
  assert.equal(resumes, 1);
  assert.deepEqual(closing, [true, false]);
});

test("a late flush result cannot acknowledge a cancelled close or override a newer attempt", async () => {
  const flushing = deferred<boolean>();
  let seals = 0;
  let resumes = 0;
  const coordinator = new HistoryShutdownCoordinator(
    { canSeal: async () => true },
    { sealAndFlush: () => { seals++; return seals === 1 ? flushing.promise : Promise.resolve(true); }, resumeAfterCancelledClose: () => { resumes++; } },
    () => {}, () => state,
  );
  const first = coordinator.request();
  await Promise.resolve(); // first attempt has begun sealing
  assert.equal(seals, 1);
  coordinator.cancel();
  const second = coordinator.request();
  assert.equal(await second, true);
  flushing.resolve(true);
  assert.equal(await first, false);
  assert.equal(resumes, 1);
  assert.equal(seals, 2);
});

test("busy guard never seals or cancels a task", async () => {
  let seals = 0;
  const coordinator = new HistoryShutdownCoordinator(
    { canSeal: async () => false },
    { sealAndFlush: async () => { seals++; return true; }, resumeAfterCancelledClose: () => {} },
    () => {}, () => state,
  );
  assert.equal(await coordinator.request(), false);
  assert.equal(seals, 0);
});
