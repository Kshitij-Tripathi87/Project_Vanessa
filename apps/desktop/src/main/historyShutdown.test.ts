import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForHistoryFlush } from "./historyShutdown.js";

test("a matching one-use drain acknowledgement completes and cleans up its listener", async () => {
  let listener!: (nonce: unknown, ok: unknown) => void;
  let disposed = 0;
  const waiting = waitForHistoryFlush("first", (callback) => { listener = callback; return () => { disposed += 1; }; }, (nonce) => assert.equal(nonce, "first"));
  listener("old-attempt", true);
  listener("first", "not a boolean");
  assert.equal(disposed, 0);
  listener("first", true);
  listener("first", false);
  assert.equal(await waiting, true);
  assert.equal(disposed, 1);
});

test("a failed, timed-out or unsendable drain never claims success", async () => {
  let disposed = 0;
  assert.equal(await waitForHistoryFlush("one", (listener) => {
    queueMicrotask(() => listener("one", false));
    return () => { disposed += 1; };
  }, () => {}), false);
  assert.equal(await waitForHistoryFlush("two", () => () => { disposed += 1; }, () => {}, 5), false);
  assert.equal(await waitForHistoryFlush("three", () => () => { disposed += 1; }, () => { throw new Error("window destroyed"); }), false);
  assert.equal(disposed, 3);
});
