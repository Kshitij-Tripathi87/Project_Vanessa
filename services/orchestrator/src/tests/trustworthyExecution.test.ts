import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { Task } from "@vanessa/shared";
import { parseRegressionSummary, validateRegressionRequest, validateTestingApproval, TestingAgent } from "../agents/testing.agent.js";
import { CodingAgent } from "../agents/coding.agent.js";
import { DeveloperAgent } from "../agents/developer.agent.js";
import { IncidentAgent } from "../agents/incident.agent.js";
import { VanessaAgent } from "../agents/openjarvis.agent.js";
import { MemoryAgent } from "../agents/memory.agent.js";
import { resolveManagedAction } from "../core/actionRegistry.js";
import { recordAgentResult } from "../core/agentResult.js";
import { getIncidentLabTestInvocation, ProcessSupervisor } from "../core/processSupervisor.js";
import { RepairWorkspaceService, type RepairWorkspace } from "../core/repairWorkspace.js";

const validTestParams = {
  suiteId: "incident-lab.regression",
  workspaceId: "repair-task-1",
  expectedDiffHash: "a".repeat(64),
};

function reportLine(runId: string, overrides: Record<string, unknown> = {}): string {
  return "VANESSA_REGRESSION_REPORT " + JSON.stringify({
    schema: "vanessa.regression-report",
    version: 1,
    suiteId: "incident-lab.regression",
    runId,
    passed: 2,
    total: 2,
    failed: 0,
    ...overrides,
  });
}

test("structured regression parser rejects keyword-only, partial, malformed and stale-run output", () => {
  assert.deepEqual(parseRegressionSummary(reportLine("run-1"), "run-1"), { passed: 2, total: 2 });
  assert.equal(parseRegressionSummary("some tests pass", "run-1"), null);
  assert.equal(parseRegressionSummary("ALL REGRESSION TESTS PASSED (2/2)", "run-1"), null);
  assert.equal(parseRegressionSummary(reportLine("another-run"), "run-1"), null);
  assert.equal(parseRegressionSummary(reportLine("run-1", { passed: 1 }), "run-1"), null);
  assert.equal(parseRegressionSummary(reportLine("run-1", { failed: 1 }), "run-1"), null);
  assert.equal(parseRegressionSummary(reportLine("run-1", { total: 0, passed: 0 }), "run-1"), null);
  assert.equal(parseRegressionSummary(reportLine("run-1", { command: "echo pass" }), "run-1"), null);
  assert.equal(parseRegressionSummary(reportLine("run-1") + "\n" + reportLine("run-1"), "run-1"), null);
  assert.equal(parseRegressionSummary(reportLine("run-1")), null);
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

  const autonomousCoding = resolveManagedAction("codex.run_task", {
    projectPath: "C:/repo",
    prompt: "Modify files in the active checkout",
  });
  assert.equal(autonomousCoding.managed, true);
  assert.equal(autonomousCoding.blocked, true);
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

test("testing requires an unexpired one-use approval bound to exact registered arguments", () => {
  assert.equal(validateTestingApproval(validTestParams, undefined, 1000).valid, false);
  const task: Task = {
    id: "approved-testing-task",
    agent: "testing",
    action: "testing.run_incident_lab",
    params: validTestParams,
    dependsOn: [],
    status: "running",
    approvalDigest: "b".repeat(64),
    approvalConsumedAt: 200,
    approvalExpiresAt: 2000,
    approvalPolicyVersion: "trustworthy-execution-v1",
  };
  assert.deepEqual(validateTestingApproval(validTestParams, task, 1000), { valid: true });
  assert.equal(validateTestingApproval({ ...validTestParams, expectedDiffHash: "c".repeat(64) }, task, 1000).valid, false);
  assert.equal(validateTestingApproval(validTestParams, task, 2000).valid, false);
  assert.equal(validateTestingApproval(validTestParams, { ...task, approvalConsumedAt: undefined }, 1000).valid, false);
});

test("agent-local dispatch blocks unknown actions and direct autonomous Codex execution", async () => {
  const coding = await new CodingAgent().execute("coding.unknown_operation", {});
  assert.equal(coding.status, "blocked");
  assert.equal(coding.verification?.passed, false);

  const incident = await new IncidentAgent().execute("incident.unknown_operation", {});
  assert.equal(incident.status, "blocked");
  assert.equal(incident.data?.processStarted, false);

  const testing = await new TestingAgent().execute("testing.run_incident_lab", validTestParams);
  assert.equal(testing.status, "blocked");
  assert.equal(testing.verification?.passed, false);

  const developer = new DeveloperAgent();
  const rawTerminal = await developer.execute("terminal.run_command", { command: "echo unsafe" });
  assert.equal(rawTerminal.status, "blocked");
  assert.equal(rawTerminal.data?.processStarted, false);

  const autonomous = await developer.execute("codex.run_task", {
    projectPath: "/not-a-real-project",
    prompt: "Modify files in the active checkout",
  });
  assert.equal(autonomous.status, "blocked");
  assert.equal(autonomous.data?.processStarted, false);

  const directLaunch = await developer.execute("codex.open", {
    projectPath: "/not-a-real-project",
    prompt: "Run arbitrary commands",
  });
  assert.equal(directLaunch.status, "blocked");
  assert.equal(directLaunch.data?.processStarted, false);
});
test("legacy OpenJarvis/Vanessa shell, tool, status, schedule and goal aliases fail closed", async () => {
  const agent = new VanessaAgent();
  const requests: Array<{ action: string; params: Record<string, unknown> }> = [
    { action: "openjarvis.shell", params: { command: "echo should-not-run" } },
    { action: "vanessa.shell", params: { command: "echo should-not-run" } },
    { action: "tools.run_tool", params: { tool: "shell_exec", params: { command: "echo should-not-run" } } },
    { action: "connector.run_goal", params: { goal: "run a shell command", tools: ["shell_exec"] } },
    { action: "jarvis.schedule_create", params: { prompt: "execute a shell command", tools: "shell_exec" } },
    { action: "vanessa.tool.shell_exec", params: { command: "echo should-not-run" } },
    { action: "openjarvis.status", params: {} },
  ];

  for (const request of requests) {
    const result = await agent.execute(request.action, request.params);
    assert.equal(result.status, "blocked", request.action);
    assert.equal(result.success, false, request.action);
    assert.equal(result.data?.processStarted, false, request.action);
  }

  // Public compatibility methods must also be inert if called directly.
  const directTool = await agent.runTool("shell_exec", { command: "echo should-not-run" });
  assert.equal(directTool.status, "blocked");
  assert.equal(directTool.data?.processStarted, false);
  const directBridge = await agent.runBridge("run_tool", { tool: "shell_exec", params: { command: "echo should-not-run" } });
  assert.equal(directBridge.status, "blocked");
  assert.equal(directBridge.data?.processStarted, false);

  assert.equal(resolveManagedAction("vanessa.ask", { query: "Explain the current task." }).blocked, undefined);
  assert.equal(resolveManagedAction("vanessa.ask", { query: "Explain the current task.", command: "echo unsafe" }).blocked, true);
});

test("memory agent returns real matches or inconclusive and never fabricates a historical record", async () => {
  const agent = new MemoryAgent();
  const noMatchQuery = "vanessa-trust-test-no-match-" + randomUUID();
  const noMatch = await agent.execute("memory.retrieve", { query: noMatchQuery });
  assert.equal(noMatch.status, "partial");
  assert.equal(noMatch.success, false);
  assert.equal((noMatch.data as Record<string, any>)?.outcome, "inconclusive");
  assert.equal((noMatch.data as Record<string, any>)?.resultCount, 0);
  assert.deepEqual((noMatch.data as Record<string, any>)?.records, []);
  assert.doesNotMatch(noMatch.summary || "", /INC-842|missing null check/i);
  assert.equal(noMatch.evidence?.[0]?.source, "memoryPalace.retrieve");

  const malformed = await agent.execute("memory.retrieve", { query: "checkout", command: "echo unsafe" });
  assert.equal(malformed.status, "blocked");
  assert.equal((malformed.data as Record<string, any>)?.processStarted, false);

  const unknown = await agent.execute("memory.execute_arbitrary", { query: "checkout" });
  assert.equal(unknown.status, "blocked");
  assert.equal((unknown.data as Record<string, any>)?.processStarted, false);

  const invalidLimit = await agent.execute("memory.list", { limit: 0 });
  assert.equal(invalidLimit.status, "blocked");
  assert.equal((invalidLimit.data as Record<string, any>)?.processStarted, false);
});

test("incident memory retrieval reports the unmanaged Python bridge as disabled", async () => {
  const result = await new IncidentAgent().retrieveMemoryAndRunbook({});
  assert.equal(result.findings.memoryRetrieved, false);
  assert.equal(result.findings.memoryRetrievalStatus, "disabled");
  assert.equal(result.findings.memoryProcessStarted, false);
  assert.match(String(result.findings.memoryRetrievalError), /registered process supervisor/i);
  assert.equal((result.findings.sourcesUsed as string[]).includes("local-memory"), false);
});

test("real worktree runner binds to the patch digest, redacts output, and kills timed-out process trees", async () => {
  const tempRoot = await fs.mkdtemp(path.join(tmpdir(), "vanessa-trust-test-"));
  const repositoryRoot = path.join(tempRoot, "fixture-repo");
  await fs.mkdir(repositoryRoot, { recursive: true });

  let workspace: RepairWorkspace | undefined;
  try {
    await fs.writeFile(path.join(repositoryRoot, "package.json"), JSON.stringify({
      name: "vanessa-trust-fixture-root",
      private: true,
      type: "module",
    }, null, 2));
    await fs.writeFile(path.join(repositoryRoot, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");

    const packageRoot = path.join(repositoryRoot, "packages", "incident-lab");
    await fs.mkdir(path.join(packageRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "@vanessa/incident-lab",
      version: "0.1.0",
      private: true,
      type: "module",
    }, null, 2));

    await fs.mkdir(path.join(packageRoot, "tests"), { recursive: true });
    const fixtureTestScript = [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'import { fileURLToPath } from "node:url";',
      'const __dirname = path.dirname(fileURLToPath(import.meta.url));',
      'const checkout = fs.readFileSync(path.join(__dirname, "..", "src", "checkout.ts"), "utf8");',
      'if (checkout.includes("HANG_TEST_MARKER")) { setInterval(() => {}, 1000); }',
      'else { console.log("api_key=supersecret-token-value"); console.log("VANESSA_REGRESSION_REPORT " + JSON.stringify({ schema: "vanessa.regression-report", version: 1, suiteId: "incident-lab.regression", runId: process.env.VANESSA_EXECUTION_RUN_ID, passed: 2, total: 2, failed: 0 })); }',
      "",
    ].join("\n");
    await fs.writeFile(path.join(packageRoot, "tests", "checkout.test.ts"), fixtureTestScript);
    await fs.writeFile(
      path.join(packageRoot, "src", "checkout.ts"),
      "export const discount = (subtotal, promo) => (subtotal * promo.discountRate) / 100;\n",
    );

    const git = (args: string[]) => execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: "ignore",
    });
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
    const { executable, args } = getIncidentLabTestInvocation(workspace.worktreePath);

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
    assert.equal(processResult.terminationVerified, true);
    assert.deepEqual(parseRegressionSummary(processResult.stdout + processResult.stderr, processResult.runId), { passed: 2, total: 2 });
    assert.doesNotMatch(processResult.stdout + processResult.stderr, /supersecret-token-value/);
    assert.match(processResult.stdout + processResult.stderr, /api_key=\[REDACTED\]/);
    assert.equal(await workspaceService.isBaseCheckoutUnchanged(workspace), true);

    const hangingPatch = patched.replace("const discount", "/* HANG_TEST_MARKER */\nconst discount");
    await fs.writeFile(target, hangingPatch, "utf8");
    const hangingDiff = execFileSync("git", ["diff", "--no-ext-diff", "--", relativeFile], {
      cwd: workspace.worktreePath,
      encoding: "utf8",
    });
    const hangingDiffHash = createHash("sha256").update(hangingDiff).digest("hex");
    const timeoutResult = await supervisor.run({
      taskId: `timeout-${randomUUID()}`,
      actionId: "testing.run_incident_lab",
      actionParams: {
        suiteId: "incident-lab.regression",
        workspaceId: workspace.taskId,
        expectedDiffHash: hangingDiffHash,
      },
      executable,
      args,
      cwd: workspace.worktreePath,
      timeoutMs: 1000,
      maxOutputBytes: 64 * 1024,
    });
    assert.equal(timeoutResult.status, "timed_out");
    assert.equal(timeoutResult.terminationVerified, true);
    assert.equal(await workspaceService.isBaseCheckoutUnchanged(workspace), true);
  } finally {
    if (workspace) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", workspace.worktreePath], {
          cwd: repositoryRoot,
          stdio: "ignore",
        });
      } catch { /* best-effort cleanup of the isolated fixture worktree only */ }
      try {
        execFileSync("git", ["branch", "-D", workspace.branchName], {
          cwd: repositoryRoot,
          stdio: "ignore",
        });
      } catch { /* fixture repository is removed below */ }
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
