import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { Task } from "@vanessa/shared";
import { parseRegressionSummary, validateRegressionRequest } from "../agents/testing.agent.js";
import { resolveManagedAction } from "../core/actionRegistry.js";
import { recordAgentResult } from "../core/agentResult.js";
import { ProcessSupervisor } from "../core/processSupervisor.js";
import { RepairWorkspaceService, type RepairWorkspace } from "../core/repairWorkspace.js";

const validTestParams = {
  suiteId: "incident-lab.regression",
  workspaceId: "repair-task-1",
  expectedDiffHash: "a".repeat(64),
};

test("structured regression parser rejects keyword-only and partial-pass output", () => {
  assert.deepEqual(parseRegressionSummary("ALL REGRESSION TESTS PASSED (2/2)"), { passed: 2, total: 2 });
  assert.equal(parseRegressionSummary("some tests pass"), null);
  assert.equal(parseRegressionSummary("ALL REGRESSION TESTS PASSED (1/2)"), null);
  assert.equal(parseRegressionSummary("ALL REGRESSION TESTS PASSED (0/0)"), null);
  assert.deepEqual(parseRegressionSummary("ALL REGRESSION TESTS PASSED (2/2) with additional diagnostics"), { passed: 2, total: 2 });
});

test("testing request schema rejects arbitrary commands and non-registered runners", () => {
  assert.deepEqual(validateRegressionRequest({ command: "echo pass" }), {
    valid: false,
    reason: "Free-form command execution is not accepted by the testing agent. Use a registered suiteId.",
  });
  assert.equal(validateRegressionRequest({ suiteId: "arbitrary" }).valid, false);
  assert.equal(validateRegressionRequest({ ...validTestParams, cwd: "/tmp" }).valid, false);
  assert.equal(validateRegressionRequest(validTestParams).valid, true);
});

test("action registry canonicalizes legacy names and fails closed on unknown or unsafe actions", () => {
  const valid = resolveManagedAction("testing.verify_regression", validTestParams);
  assert.equal(valid.managed, true);
  assert.equal(valid.canonicalId, "testing.run_incident_lab");
  assert.equal(valid.blocked, undefined);

  const arbitrary = resolveManagedAction("testing.verify_regression", { command: "echo pass", autoDeploy: false });
  assert.equal(arbitrary.managed, true);
  assert.equal(arbitrary.blocked, true);

  const unknown = resolveManagedAction("testing.run_anything", {});
  assert.equal(unknown.managed, true);
  assert.equal(unknown.blocked, true);

  const shell = resolveManagedAction("terminal.run_command", { command: "whoami" });
  assert.equal(shell.blocked, true);
});

test("managed actions without evidence cannot turn a positive flag into success", () => {
  const task: Task = {
    id: "trust-contract",
    agent: "testing",
    action: "testing.run_incident_lab",
    params: validTestParams,
    dependsOn: [],
    status: "running",
  };
  const outcome = recordAgentResult(task, {
    success: true,
    status: "completed",
    verification: { passed: true, details: "ALL REGRESSION TESTS PASSED (2/2)" },
    data: { outcome: "succeeded" },
    evidence: [],
  });
  assert.equal(outcome, "partial");
  assert.equal(task.verification?.verified, false);
  assert.equal(task.verification?.outcome, "inconclusive");
});

test("real worktree + registered test runner is tied to the exact patch digest", async () => {
  const tempRoot = await fs.mkdtemp(path.join(tmpdir(), "vanessa-trust-test-"));
  const repositoryRoot = path.join(tempRoot, "fixture-repo");
  await fs.mkdir(repositoryRoot, { recursive: true });

  let workspace: RepairWorkspace | undefined;
  try {
    await fs.writeFile(path.join(repositoryRoot, "package.json"), JSON.stringify({
      name: "vanessa-trust-fixture-root",
      private: true,
    }, null, 2));
    await fs.writeFile(path.join(repositoryRoot, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    const packageRoot = path.join(repositoryRoot, "packages", "incident-lab");
    await fs.mkdir(path.join(packageRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "@vanessa/incident-lab",
      version: "0.1.0",
      private: true,
      scripts: { test: "node test.js" },
    }, null, 2));
    await fs.writeFile(path.join(packageRoot, "test.js"), "console.log(\"api_key=supersecret-token-value\");\nconsole.log(\"ALL REGRESSION TESTS PASSED (2/2)\");\n");
    await fs.writeFile(
      path.join(packageRoot, "src", "checkout.ts"),
      "export const discount = (subtotal, promo) => (subtotal * promo.discountRate) / 100;\n",
    );

    const git = (args: string[]) => execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", stdio: "ignore" });
    git(["init"]);
    git(["config", "user.name", "Vanessa Test"]);
    git(["config", "user.email", "vanessa-test@example.invalid"]);
    git(["add", "-A"]);
    git(["commit", "-m", "fixture baseline"]);

    const workspaceService = new RepairWorkspaceService(repositoryRoot);
    workspace = await workspaceService.create(`test-${randomUUID()}`);
    assert.equal(await workspaceService.isBaseCheckoutUnchanged(workspace), true);

    const relativeFile = "packages/incident-lab/src/checkout.ts";
    const target = path.join(workspace.worktreePath, relativeFile);
    const original = await fs.readFile(target, "utf8");
    const patched = original.replace(
      "promo.discountRate",
      "(promo?.discountRate ?? 0)",
    );
    assert.notEqual(patched, original);
    await fs.writeFile(target, patched, "utf8");

    const diff = execFileSync("git", ["diff", "--no-ext-diff", "--", relativeFile], {
      cwd: workspace.worktreePath,
      encoding: "utf8",
    });
    const expectedDiffHash = createHash("sha256").update(diff).digest("hex");
    const supervisor = new ProcessSupervisor(workspaceService);
    const executable = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "pnpm";
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", "pnpm --filter @vanessa/incident-lab test"]
      : ["--filter", "@vanessa/incident-lab", "test"];
    const processResult = await supervisor.run({
      taskId: `run-${randomUUID()}`,
      actionId: "testing.run_incident_lab",
      actionParams: {
        suiteId: "incident-lab.regression",
        workspaceId: workspace.taskId,
        expectedDiffHash,
      },
      executable,
      args,
      cwd: workspace.worktreePath,
      timeoutMs: 15000,
      maxOutputBytes: 64 * 1024,
    });

    assert.equal(processResult.status, "exited");
    assert.equal(processResult.exitCode, 0);
    assert.match(processResult.stdout + processResult.stderr, /ALL REGRESSION TESTS PASSED \(2\/2\)/);
    assert.doesNotMatch(processResult.stdout + processResult.stderr, /supersecret-token-value/);
    assert.match(processResult.stdout + processResult.stderr, /api_key=\\[REDACTED\\]/);
    assert.equal(await workspaceService.isBaseCheckoutUnchanged(workspace), true);
  } finally {
    if (workspace) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", workspace.worktreePath], {
          cwd: repositoryRoot, stdio: "ignore",
        });
      } catch { /* best-effort cleanup of the isolated fixture worktree only */ }
      try {
        execFileSync("git", ["branch", "-D", workspace.branchName], { cwd: repositoryRoot, stdio: "ignore" });
      } catch { /* fixture repository is removed below */ }
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
