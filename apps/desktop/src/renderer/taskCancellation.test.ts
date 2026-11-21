import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCancellationResponse, isActiveTaskStage } from "./taskCancellation.js";

test("a confirmed task cancellation remains in stopping until the overall plan resolves", () => {
  const result = classifyCancellationResponse({
    success: true, cancelled: 1, executionFinished: 0, terminationUnconfirmed: 0, planningOnly: false,
  });
  assert.equal(result.kind, "cancellation_pending");
  assert.equal(result.stage, "cancelling");
  assert.equal(result.clearRequest, false);
});

test("unconfirmed process termination is never presented as stopped", () => {
  const result = classifyCancellationResponse({
    success: true, cancelled: 0, executionFinished: 0, terminationUnconfirmed: 1,
    planningOnly: false, message: "One process could not be verified as stopped.",
  });
  assert.equal(result.kind, "termination_unconfirmed");
  assert.equal(result.stage, "cancellation_unconfirmed");
  assert.match(result.message, /could not be verified/);
});

test("work that finished before cancellation keeps its actual outcome", () => {
  const result = classifyCancellationResponse({
    success: true, cancelled: 0, executionFinished: 1, terminationUnconfirmed: 0, planningOnly: false,
  });
  assert.equal(result.kind, "execution_finished");
  assert.equal(result.stage, "verifying");
});

test("a cancellation tombstone before planning is a verified no-execution outcome", () => {
  const result = classifyCancellationResponse({
    success: true, cancelled: 0, executionFinished: 0, terminationUnconfirmed: 0, planningOnly: true,
  });
  assert.equal(result.kind, "cancelled_before_execution");
  assert.equal(result.stage, "cancelled");
  assert.equal(result.clearRequest, true);
});

test("an emergency stop with no active work does not rewrite the previous task result", () => {
  const result = classifyCancellationResponse({
    success: true, cancelled: 0, executionFinished: 0, terminationUnconfirmed: 0,
  });
  assert.equal(result.kind, "no_active_work");
  assert.equal(result.stage, "verifying");
  assert.equal(result.clearPendingApproval, false);
});

test("an API acknowledgement without termination counters is not treated as cancellation proof", () => {
  const result = classifyCancellationResponse({ success: true, message: "Processed." });
  assert.equal(result.kind, "invalid_response");
  assert.equal(result.stage, "executing");
});

test("a failed cancellation request leaves task state active", () => {
  const result = classifyCancellationResponse({ success: false, error: "Orchestrator offline." });
  assert.equal(result.kind, "request_failed");
  assert.equal(result.stage, "executing");
  assert.equal(result.clearRequest, false);
});

test("only active task states permit task cancellation", () => {
  assert.equal(isActiveTaskStage("executing"), true);
  assert.equal(isActiveTaskStage("cancelling"), true);
  assert.equal(isActiveTaskStage("cancellation_unconfirmed"), true);
  assert.equal(isActiveTaskStage("completed"), false);
  assert.equal(isActiveTaskStage("cancelled"), false);
});
