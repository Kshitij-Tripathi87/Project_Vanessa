import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "@vanessa/shared";
import { recordAgentResult } from "../core/agentResult.js";

function taskTemplate(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-result-contract",
    agent: "developer",
    action: "windows.settings.set_brightness",
    params: {},
    dependsOn: [],
    status: "running",
    ...overrides,
  };
}

test("a returned object without an explicit outcome is partial, not verified success", () => {
  const task = taskTemplate();
  const outcome = recordAgentResult(task, { output: "setting command was sent" });

  assert.equal(outcome, "partial");
  assert.equal(task.verification?.verified, false);
  assert.equal(task.verification?.outcome, "partial");
  assert.match(task.verification?.postconditions.join(" ") || "", /No explicit passing verification/);
});

test("success:true without a passing verification remains unverified", () => {
  const task = taskTemplate();
  const outcome = recordAgentResult(task, {
    success: true,
    spokenSummary: "Brightness command executed.",
    output: "The command was dispatched.",
  });

  assert.equal(outcome, "partial");
  assert.equal(task.verification?.verified, false);
  assert.equal(task.verification?.outcome, "partial");
  assert.match(task.verification?.postconditions.join(" ") || "", /did not provide a passing verification result/);
});

test("a passing verification with concrete details is accepted as success", () => {
  const task = taskTemplate();
  const outcome = recordAgentResult(task, {
    success: true,
    status: "completed",
    verification: { passed: true, details: "Brightness value read back as 70 percent." },
    evidence: [{ description: "Brightness value read back as 70 percent.", source: "windows_settings" }],
  });

  assert.equal(outcome, "success");
  assert.equal(task.verification?.verified, true);
  assert.equal(task.verification?.outcome, "succeeded");
  assert.equal(task.verification?.postconditions[0], "Brightness value read back as 70 percent.");
});

test("a failed verification remains failed even when execution returned data", () => {
  const task = taskTemplate();
  const outcome = recordAgentResult(task, {
    success: false,
    status: "failed",
    data: { exitCode: 1 },
    verification: { passed: false, details: "The postcondition was not met." },
  });

  assert.equal(outcome, "failed");
  assert.equal(task.verification?.verified, false);
  assert.equal(task.verification?.outcome, "failed");
});

test("explicit failed or blocked status overrides a contradictory passing verification", () => {
  for (const status of ["failed", "blocked"] as const) {
    const task = taskTemplate();
    const outcome = recordAgentResult(task, {
      success: true,
      status,
      verification: { passed: true, details: "Contradictory positive text must not override the terminal status." },
    });

    const expected = status === "blocked" ? "blocked" : "failed";
    assert.equal(outcome, expected, `status=${status}`);
    assert.equal(task.verification?.verified, false, `status=${status}`);
    assert.equal(task.verification?.outcome, expected, `status=${status}`);
  }
});

test("opening Codex is a partial interactive handoff, not completed coding work", () => {
  const task = taskTemplate({ action: "codex.open" });
  const outcome = recordAgentResult(task, {
    success: true,
    status: "started",
    spokenSummary: "Codex terminal started.",
  });

  assert.equal(outcome, "partial");
  assert.equal(task.verification?.verified, false);
  assert.equal(task.verification?.outcome, "partial");
  assert.match(task.spokenSummary || "", /not yet verified/i);
});

test("a passing flag without concrete verification details is not enough", () => {
  const task = taskTemplate();
  const outcome = recordAgentResult(task, {
    success: true,
    verification: { passed: true, details: "   " },
  });

  assert.equal(outcome, "partial");
  assert.equal(task.verification?.verified, false);
});
