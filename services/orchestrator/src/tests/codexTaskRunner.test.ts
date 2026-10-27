import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { test } from "node:test";
import {
  cancelCodexTask,
  codexTaskRunnerDependencies,
  runCodexTask,
  type CodexTaskRunnerDependencies,
} from "../agents/codex-task-runner.js";

function fixture(options: {
  dirty?: boolean;
  branch?: string;
  events?: unknown[];
  exitCode?: number | null;
  delayMs?: number;
} = {}) {
  const calls: { file?: string; args?: string[]; spawnOptions?: SpawnOptions; terminated: boolean } = { terminated: false };
  let child: ChildProcess;
  const deps: CodexTaskRunnerDependencies = {
    ...codexTaskRunnerDependencies,
    platform: () => "win32",
    isDirectory: async () => true,
    inspectWorkspace: async (path) => ({
      root: path,
      branch: options.branch ?? "feature/test",
      dirty: options.dirty ?? false,
    }),
    resolveCli: async () => ({ file: "C:\\node.exe", prefix: ["C:\\codex.js"] }),
    spawnProcess: (file, args, spawnOptions) => {
      calls.file = file;
      calls.args = args;
      calls.spawnOptions = spawnOptions;
      const proc = new EventEmitter() as ChildProcess;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let terminated = false;
      Object.assign(proc, {
        pid: 12345,
        stdout,
        stderr,
        kill: () => {
          terminated = true;
          return true;
        },
      });
      child = proc;
      if (options.events) {
        setTimeout(() => {
          for (const item of options.events || []) stdout.write(JSON.stringify(item) + "\n");
          stdout.end();
          stderr.end();
          proc.emit("close", options.exitCode === undefined ? 0 : options.exitCode, null);
        }, options.delayMs ?? 10);
      }
      return proc;
    },
    terminateProcess: (proc) => {
      calls.terminated = true;
      proc.kill();
      setTimeout(() => {
        proc.stdout?.end();
        proc.stderr?.end();
        proc.emit("close", null, "SIGTERM");
      }, 5);
    },
    now: () => Date.now(),
  };
  return { deps, calls, get child() { return child!; } };
}

const successEvents = [
  { type: "thread.started", thread_id: "thread-test" },
  { type: "turn.started" },
  { type: "item.completed", item: { type: "agent_message", text: "Added a regression test and ran the focused checks." } },
  { type: "turn.completed", turn: { status: "completed" } },
];

test("validates inputs and refuses a dirty or unexpected repository before spawning", async () => {
  const dirty = fixture({ dirty: true });
  const dirtyResult = await runCodexTask(
    { projectPath: "C:\\Projects\\Vanessa", prompt: "Fix the tests" },
    { taskId: "codex-dirty" },
    dirty.deps,
  );
  assert.equal(dirtyResult.success, false);
  assert.match(dirtyResult.error, /staged, modified, or untracked/);
  assert.equal(dirty.calls.args, undefined);

  const wrongBranch = fixture({ branch: "main" });
  const branchResult = await runCodexTask(
    { projectPath: "C:\\Projects\\Vanessa", prompt: "Fix the tests", expectedBranch: "feature/expected" },
    { taskId: "codex-branch" },
    wrongBranch.deps,
  );
  assert.equal(branchResult.success, false);
  assert.match(branchResult.error, /Expected branch/);
  assert.equal(wrongBranch.calls.args, undefined);

  const invalid = fixture();
  const invalidResult = await runCodexTask({ projectPath: "relative\\path", prompt: "Fix the tests" }, { taskId: "codex-invalid" }, invalid.deps);
  assert.equal(invalidResult.success, false);
  assert.match(invalidResult.error, /must be absolute/);
  assert.equal(invalid.calls.args, undefined);
});

test("invokes Codex with JSONL and workspace-write without a shell or Vanessa provider secrets", async () => {
  const f = fixture({ events: successEvents });
  const original = process.env.SARVAM_API_KEY;
  process.env.SARVAM_API_KEY = "sarvam-never-forward-this";
  try {
    const result = await runCodexTask(
      {
        projectPath: "C:\\Projects\\Vanessa",
        prompt: "Add a regression test; do not commit.",
        expectedBranch: "feature/test",
        acceptanceCriteria: ["The regression test fails before the fix and passes after."],
        allowedPaths: ["services/orchestrator/src/tests"],
      },
      { taskId: "codex-success", requestId: "request-42" },
      f.deps,
    );
    assert.equal(result.success, true);
    assert.equal(result.status, "completed");
    assert.equal(result.exitCode, 0);
    assert.equal(result.branch, "feature/test");
    assert.equal(result.verification, undefined, "a Codex turn is not independent verification");
    assert.match(result.spokenSummary, /not independently verified/i);
    assert.equal(f.calls.spawnOptions?.shell, false);
    assert.equal(f.calls.spawnOptions?.cwd, "C:\\Projects\\Vanessa");
    assert.ok(f.calls.args?.includes("--json"));
    assert.ok(f.calls.args?.includes("--sandbox"));
    assert.ok(f.calls.args?.includes("workspace-write"));
    assert.ok(f.calls.args?.includes("--cd"));
    assert.match(f.calls.args?.at(-1) || "", /Do not commit, push, merge/);
    assert.equal(f.calls.spawnOptions?.env?.SARVAM_API_KEY, undefined);
    assert.equal(f.calls.spawnOptions?.env?.OPENAI_API_KEY, undefined);
  } finally {
    if (original === undefined) delete process.env.SARVAM_API_KEY;
    else process.env.SARVAM_API_KEY = original;
  }
});

test("does not treat exit code zero without turn.completed and final assistant text as success", async () => {
  const f = fixture({ events: [{ type: "thread.started" }], exitCode: 0 });
  const result = await runCodexTask(
    { projectPath: "C:\\Projects\\Vanessa", prompt: "Inspect the application" },
    { taskId: "codex-incomplete" },
    f.deps,
  );
  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.match(result.error, /without a turn.completed event|without a final assistant message/);
});

test("cancellation terminates the active process and returns a cancelled state", async () => {
  const f = fixture({ events: successEvents, delayMs: 250 });
  const running = runCodexTask(
    { projectPath: "C:\\Projects\\Vanessa", prompt: "Inspect the application", timeoutMs: 10_000 },
    { taskId: "codex-cancel" },
    f.deps,
  );
  setTimeout(() => cancelCodexTask("codex-cancel"), 50);
  const result = await running;
  assert.equal(result.success, false);
  assert.equal(result.status, "cancelled");
  assert.equal(f.calls.terminated, true);
});
