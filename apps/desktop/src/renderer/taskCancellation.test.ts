import assert from "node:assert/strict";
import { test } from "node:test";
import { presentTaskCancellation } from "./taskCancellation.js";

test("confirmed child cancellation remains pending until the overall plan resolves", () => {
  assert.deepEqual(
    presentTaskCancellation({
      success: true,
      cancelled: 2,
      executionFinished: 0,
      terminationUnconfirmed: 0,
      planningOnly: false,
    }),
    {
      stage: "cancelling",
      message: "2 operation(s) were confirmed cancelled. Waiting for the overall plan outcome.",
      clearApproval: true,
      clearRequest: false,
    },
  );
});

test("a cancellation tombstone before planning is safe to clear", () => {
  const result = presentTaskCancellation({
    success: true,
    cancelled: 0,
    executionFinished: 0,
    terminationUnconfirmed: 0,
    planningOnly: true,
  });
  assert.equal(result.stage, "cancelled");
  assert.equal(result.clearRequest, true);
});

test("global emergency cancellation reports requests stopped during planning", () => {
  const result = presentTaskCancellation({
    success: true,
    cancelled: 0,
    executionFinished: 0,
    terminationUnconfirmed: 0,
    planningOnly: 2,
  });
  assert.equal(result.stage, "cancelled");
  assert.equal(result.clearRequest, true);
  assert.match(result.message, /2 request\(s\) was cancelled during planning/);
});

test("already-finished work remains in result verification rather than being relabeled stopped", () => {
  const result = presentTaskCancellation({
    success: true,
    cancelled: 0,
    executionFinished: 1,
    terminationUnconfirmed: 0,
    planningOnly: false,
  });
  assert.equal(result.stage, "verifying");
  assert.equal(result.clearRequest, false);
  assert.match(result.message, /finished before cancellation took effect/);
});

test("any unconfirmed process tree keeps task identity and approval", () => {
  const result = presentTaskCancellation({
    success: true,
    cancelled: 1,
    executionFinished: 0,
    terminationUnconfirmed: 1,
    planningOnly: false,
  });
  assert.equal(result.stage, "termination_unconfirmed");
  assert.equal(result.clearRequest, false);
  assert.equal(result.clearApproval, false);
  assert.match(result.message, /could not be verified stopped/);
});

test("missing evidence never becomes a successful cancellation", () => {
  for (const response of [undefined, null, { success: true }, { success: false, error: "offline" }]) {
    const result = presentTaskCancellation(response);
    assert.ok(["partial", "termination_unconfirmed"].includes(result.stage));
    assert.equal(result.clearRequest, false);
    assert.equal(result.clearApproval, false);
  }
});

test("mixed cancellation and completed work must be reconciled before clearing request identity", () => {
  const result = presentTaskCancellation({
    success: true,
    cancelled: 2,
    executionFinished: 1,
    terminationUnconfirmed: 0,
    planningOnly: false,
  });
  assert.equal(result.stage, "verifying");
  assert.equal(result.clearRequest, false);
  assert.match(result.message, /2 remaining operation/);
});
