import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageBudget } from "./usageMeter.js";

test("UsageBudget reserves, settles and releases against a hard cap", () => {
  const budget = new UsageBudget({ capInr: 0.01 });
  const first = budget.reserve({
    requestId: "one",
    model: "test",
    kind: "tts_characters",
    estimatedCostInr: 0.006,
  });
  assert.throws(() => budget.reserve({
    requestId: "two",
    model: "test",
    kind: "tts_characters",
    estimatedCostInr: 0.005,
  }), /budget exceeded/i);
  budget.settle(first, { quantity: 100, actualCostInr: 0.004 });
  const second = budget.reserve({
    requestId: "three",
    model: "test",
    kind: "llm_input_tokens",
    estimatedCostInr: 0.006,
  });
  budget.release(second, { reason: "cancelled" });
  const snapshot = budget.snapshot();
  assert.equal(snapshot.spentInr, 0.004);
  assert.equal(snapshot.reservedInr, 0);
  assert.equal(snapshot.events.filter((event) => event.status === "settled").length, 1);
  assert.equal(snapshot.events.filter((event) => event.status === "released").length, 1);
});

test("UsageBudget applies a separate per-user cap", () => {
  const budget = new UsageBudget({ perUserCapInr: 0.01 });
  const reservation = budget.reserve({
    requestId: "user-one",
    userId: "alice",
    model: "test",
    kind: "llm_output_tokens",
    estimatedCostInr: 0.01,
  });
  assert.throws(() => budget.reserve({
    requestId: "user-one-more",
    userId: "alice",
    model: "test",
    kind: "llm_output_tokens",
    estimatedCostInr: 0.001,
  }), /user alice/i);
  budget.release(reservation);
  assert.equal(budget.snapshot().users.alice, undefined);
});
