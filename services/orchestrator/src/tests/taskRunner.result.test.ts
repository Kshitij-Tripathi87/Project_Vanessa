import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "@vanessa/shared";
import { recordAgentResult } from "../core/taskRunner.js";

function taskTemplate(): Task {
  return {
    id: "task-test",
    agent: "windows",
    action: "volume.set",
    params: { level: 35 },
    dependsOn: [],
    status: "running",
  };
}

test("an explicit partial action stays partial when it cannot prove the resulting state", () => {
  const task = taskTemplate();
  const outcome = recordAgentResult(task, {
    agentId: "windows",
    status: "partial",
    success: true,
    summary: "Windows accepted media keys but exact volume was not read back.",
    spokenSummary: "I sent the adjustment but cannot verify the exact system volume.",
    verification: { passed: false, details: "Exact system volume was not read back." },
    evidence: [],
    artifacts: [],
    data: { requestedLevel: 35, readBackVerified: false },
  });

  assert.equal(outcome, "partial");
  assert.equal(task.verification?.verified, false);
  assert.equal(task.verification?.outcome, "partial");
  assert.match(task.verification?.details || "", /not read back/i);
  assert.deepEqual(task.result, { requestedLevel: 35, readBackVerified: false });
});

test("an explicit failure cannot be upgraded based on its returned data", () => {
  const task = taskTemplate();
  const outcome = recordAgentResult(task, {
    status: "failed",
    success: false,
    summary: "Bluetooth state change failed.",
    verification: { passed: false, details: "Windows denied the request." },
    data: { state: "unknown" },
  });

  assert.equal(outcome, "failed");
  assert.equal(task.verification?.verified, false);
  assert.equal(task.verification?.outcome, "failed");
});

test("a verified successful action remains successful", () => {
  const task = taskTemplate();
  const outcome = recordAgentResult(task, {
    status: "completed",
    success: true,
    summary: "Bluetooth radio is enabled.",
    verification: { passed: true, details: "Windows reported the Bluetooth radio state as On." },
    data: { state: "enabled" },
  });

  assert.equal(outcome, "success");
  assert.equal(task.verification?.verified, true);
  assert.equal(task.verification?.outcome, "succeeded");
});
