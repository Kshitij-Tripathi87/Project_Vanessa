import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { AgentRunContext, Task } from "@vanessa/shared";
import { parseRegressionSummary, validateRegressionRequest, validateTestingApproval, TestingAgent } from "../agents/testing.agent.js";
import { CodingAgent } from "../agents/coding.agent.js";
import { DeveloperAgent } from "../agents/developer.agent.js";
import { IncidentAgent } from "../agents/incident.agent.js";
import { VanessaAgent } from "../agents/openjarvis.agent.js";
import { MemoryAgent } from "../agents/memory.agent.js";
import { MemoryPalace } from "../memory/memoryPalace.js";
import { BrowserAgent } from "../agents/browser.agent.js";
import { FileAgent } from "../agents/file.agent.js";
import { WindowsAgent } from "../agents/windows.agent.js";
import { FolderAgent } from "../agents/folder.agent.js";
import { buildPowerShellEnvironment } from "../agents/powershell.js";
import { resolveManagedAction } from "../core/actionRegistry.js";
import { catalogAccepts } from "../agents/agentCatalog.js";
import { recordAgentResult } from "../core/agentResult.js";
import { getIncidentLabTestInvocation, ProcessSupervisor } from "../core/processSupervisor.js";
import { RepairWorkspaceService, type RepairWorkspace } from "../core/repairWorkspace.js";
import { cancelTaskWithProof, runPlan } from "../core/taskRunner.js";
import { resourceLockManager } from "../core/resourceLocks.js";

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

test("reviewed action catalog rejects non-selectable and unknown actions", () => {
  assert.equal(catalogAccepts("testing", "testing.run_incident_lab", validTestParams), true);
  assert.equal(catalogAccepts("developer", "terminal.run_command", { command: "echo unsafe" }), false);
  assert.equal(catalogAccepts("developer", "codex.run_task", { projectPath: "/repo", prompt: "edit" }), false);
  assert.equal(catalogAccepts("windows", "windows.unregistered_operation", {}), false);
  assert.equal(catalogAccepts("testing", "testing.run_incident_lab", { ...validTestParams, command: "echo pass" }), false);
});

test("runPlan rejects a task omitted from the reviewed action catalog before executor dispatch", async () => {
  const taskId = `catalog-deny-${randomUUID()}`;
  const plan: any = {
    id: `catalog-plan-${randomUUID()}`,
    command: "exercise unknown action gate",
    tasks: [{
      id: taskId,
      agent: "windows",
      action: "windows.unregistered_operation",
      params: {},
      dependsOn: [],
      status: "pending",
      risk: "low",
      allowedTools: [],
      acceptanceCriteria: [],
    }],
  };

  const results = await runPlan(plan);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "blocked");
  assert.equal(results[0].verification?.outcome, "blocked");
  assert.match(results[0].error || "", /reviewed, selectable agent catalog/i);
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

test("memory storage redacts sensitive metadata and never returns raw metadata", async () => {
  const tempRoot = await fs.mkdtemp(path.join(tmpdir(), "vanessa-memory-isolation-"));
  const palace = new MemoryPalace(path.join(tempRoot, "memory.db"));
  try {
    const agent = new MemoryAgent(palace);
    const marker = "memory-privacy-" + randomUUID();
    const secretToken = "sk-" + "A".repeat(32);
    const passwordValue = "nested-password-value-" + randomUUID();
    const stored = await agent.execute("memory.store", {
      content: marker + " api_key=" + secretToken,
      metadata: { title: marker, api_key: secretToken, nested: { password: passwordValue } },
    });
    assert.equal(stored.success, true);
    assert.equal((stored.data as Record<string, any>)?.outcome, "succeeded");
    assert.ok((stored.data as Record<string, any>)?.redactedCount >= 2);
    const storedJson = JSON.stringify(stored.data);
    assert.equal(storedJson.includes(secretToken), false);
    assert.equal(storedJson.includes(passwordValue), false);
    assert.equal(Object.prototype.hasOwnProperty.call((stored.data as Record<string, any>)?.record, "rawData"), false);

    const recalled = await agent.execute("memory.retrieve", { query: marker });
    assert.equal(recalled.success, true);
    assert.equal((recalled.data as Record<string, any>)?.resultCount, 1);
    assert.equal(JSON.stringify(recalled.data).includes(secretToken), false);
    assert.equal(JSON.stringify(recalled.data).includes(passwordValue), false);
  } finally {
    palace.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("incident memory retrieval reports the unmanaged Python bridge as disabled", async () => {
  const result = await new IncidentAgent().retrieveMemoryAndRunbook({});
  assert.equal(result.findings.memoryRetrieved, false);
  assert.equal(result.findings.memoryRetrievalStatus, "disabled");
  assert.equal(result.findings.memoryProcessStarted, false);
  assert.match(String(result.findings.memoryRetrievalError), /registered process supervisor/i);
  assert.equal((result.findings.sourcesUsed as string[]).includes("local-memory"), false);
});

test("PowerShell helper excludes inherited secrets and only accepts explicit VANESSA data values", () => {
  const previousSecret = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "must-not-cross-process-boundary";
  try {
    const env = buildPowerShellEnvironment({ VANESSA_URL: "https://example.invalid" });
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.VANESSA_URL, "https://example.invalid");
    assert.ok(Object.keys(env).some((key) => key.toUpperCase() === "PATH"), "Windows executable lookup path remains available");
    assert.throws(() => buildPowerShellEnvironment({ PATH: "unapproved" }), /Invalid PowerShell environment key/);
    assert.throws(() => buildPowerShellEnvironment({ VANESSA_URL: "x" + String.fromCharCode(0) + "y" }), /Invalid value/);
  } finally {
    if (previousSecret === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousSecret;
  }
});

test("FAKE mode can never report file creation, browser navigation, or Wi-Fi restart as real success", async () => {
  const previousFake = process.env.FAKE;
  process.env.FAKE = "1";
  const tempRoot = await fs.mkdtemp(path.join(tmpdir(), "vanessa-fake-mode-"));
  try {
    const target = path.join(tempRoot, "must-not-be-created-" + randomUUID());
    const fileResult = await new FileAgent().execute("folder.create", { name: path.basename(target), basePath: tempRoot });
    assert.equal(fileResult.status, "partial");
    assert.equal(fileResult.success, false);
    assert.equal((fileResult.data as Record<string, any>)?.outcome, "simulated");
    assert.equal((fileResult.data as Record<string, any>)?.actualStateChanged, false);
    await assert.rejects(fs.stat(target), { code: "ENOENT" });

    const browser = new BrowserAgent();
    const navigation = await browser.execute("browser.open_url", { url: "https://example.invalid" });
    assert.equal(navigation.status, "partial");
    assert.equal(navigation.success, false);
    assert.equal((navigation.data as Record<string, any>)?.outcome, "simulated");
    assert.equal((navigation.data as Record<string, any>)?.pageLoadVerified, false);

    const youtube = await browser.execute("youtube.search_and_play", { query: "trust-contract-test" });
    assert.equal(youtube.status, "partial");
    assert.equal(youtube.success, false);
    assert.equal((youtube.data as Record<string, any>)?.outcome, "simulated");
    assert.equal((youtube.data as Record<string, any>)?.playbackVerified, false);

    const wifi = await new WindowsAgent().execute("wifi.restart_adapter", {});
    assert.equal(wifi.status, "partial");
    assert.equal(wifi.success, false);
    assert.equal((wifi.data as Record<string, any>)?.outcome, "simulated");
    assert.equal((wifi.data as Record<string, any>)?.actualStateChanged, false);
    assert.equal((wifi.verification as Record<string, any>)?.passed, false);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
    if (previousFake === undefined) delete process.env.FAKE;
    else process.env.FAKE = previousFake;
  }
});

test("FAKE folder open requests are simulated and never claim that a desktop window opened", async () => {
  const previousFake = process.env.FAKE;
  process.env.FAKE = "1";
  try {
    const agent = new FolderAgent();
    const opened = await agent.execute("folder.open", { target: process.cwd() });
    assert.equal(opened.status, "partial");
    assert.equal(opened.success, false);
    assert.equal((opened.data as Record<string, any>)?.outcome, "simulated");
    assert.equal((opened.data as Record<string, any>)?.opened, false);
    assert.equal((opened.data as Record<string, any>)?.processStarted, false);
    assert.equal(opened.verification?.passed, false);

    const resolved = await agent.execute("folder.resolve", { target: process.cwd(), openExplorer: true });
    assert.equal(resolved.status, "partial");
    assert.equal(resolved.success, false);
    assert.equal((resolved.data as Record<string, any>)?.path, process.cwd());
    assert.equal((resolved.data as Record<string, any>)?.openedExplorer, false);
    assert.equal((resolved.data as Record<string, any>)?.simulated, true);
    assert.equal(resolved.verification?.passed, false);
  } finally {
    if (previousFake === undefined) delete process.env.FAKE;
    else process.env.FAKE = previousFake;
  }
});

test("browser active-tab read is inconclusive until a real observation provider exists", async () => {
  const result = await new BrowserAgent().execute("browser.read_title", { url: "https://example.invalid" });
  assert.equal(result.status, "partial");
  assert.equal(result.success, false);
  assert.equal((result.data as Record<string, any>)?.outcome, "inconclusive");
  assert.equal((result.data as Record<string, any>)?.titleRead, false);
  assert.equal(result.verification?.passed, false);
});

test("real worktree runner binds to the patch digest, redacts output, and kills timed-out process trees", async () => {
  const tempRoot = await fs.mkdtemp(path.join(tmpdir(), "vanessa-trust-test-"));
  const repositoryRoot = path.join(tempRoot, "fixture-repo");
  const childPidPath = path.join(tempRoot, "supervised-descendant.pid");
  const childCode = `require("node:fs").writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid)); setInterval(() => {}, 1000);`;
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
      `if (checkout.includes("HANG_TEST_MARKER")) { const { spawn } = await import("node:child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: "ignore" }); setInterval(() => {}, 1000); }`,
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

    assert.equal(
      processResult.status,
      "exited",
      JSON.stringify({
        status: processResult.status,
        exitCode: processResult.exitCode,
        processStarted: processResult.processStarted,
        terminationVerified: processResult.terminationVerified,
        error: processResult.error,
        launcherExecutable: processResult.launcherExecutable,
        launcherArgs: processResult.launcherArgs,
        stderr: processResult.stderr,
      }),
    );
    assert.equal(
      processResult.exitCode,
      0,
      JSON.stringify({
        exitCode: processResult.exitCode,
        executable: processResult.executable,
        args: processResult.args,
        cwd: processResult.cwd,
        launcherExecutable: processResult.launcherExecutable,
        launcherArgs: processResult.launcherArgs,
        stdout: processResult.stdout,
        stderr: processResult.stderr,
        error: processResult.error,
      }),
    );
    assert.equal(processResult.processStarted, true);
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
      // Windows must allow time for the fixed Job Object wrapper to initialize
      // before exercising cancellation of a live root + grandchild process tree.
      timeoutMs: process.platform === "win32" ? 12000 : 1000,
      maxOutputBytes: 64 * 1024,
    });
    assert.equal(timeoutResult.status, "timed_out");
    assert.equal(timeoutResult.processStarted, true);
    assert.equal(timeoutResult.terminationVerified, true);
    const childPidText = await fs.readFile(childPidPath, "utf8");
    const childPid = Number(childPidText.trim());
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0, "the fixture grandchild must have started");
    let childStillAlive = false;
    try { process.kill(childPid, 0); childStillAlive = true; }
    catch (error: any) { if (error?.code !== "ESRCH") throw error; }
    assert.equal(childStillAlive, false, "the supervisor must terminate the test runner's grandchild");
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

test("cancellation during the pre-launch reservation prevents the test executable from starting", async () => {
  const supervisor = new ProcessSupervisor(new RepairWorkspaceService());
  const taskId = `cancel-before-launch-${randomUUID()}`;
  const tempRoot = await fs.mkdtemp(path.join(tmpdir(), "vanessa-cancel-before-launch-"));
  const sentinelPath = path.join(tempRoot, "process-started.txt");

  try {
    // This is the reservation taskRunner installs before the testing agent's
    // asynchronous workspace preflight begins.
    supervisor.reserve(taskId, "testing.run_incident_lab");
    const cancellation = supervisor.cancel(taskId, "testing.run_incident_lab");

    const result = await supervisor.run({
      taskId,
      actionId: "testing.run_incident_lab",
      actionParams: validTestParams,
      executable: process.execPath,
      args: [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(sentinelPath)}, "process started")`,
      ],
      cwd: tmpdir(),
      timeoutMs: 1000,
    });
    const cancellationResult = await cancellation;

    assert.equal(result.status, "cancelled");
    assert.equal(result.processStarted, false);
    assert.equal(result.terminationVerified, true);
    assert.equal(result.cancellationRequested, true);
    assert.equal(cancellationResult?.status, "cancelled");
    assert.equal(cancellationResult?.processStarted, false);
    assert.equal(await fs.stat(sentinelPath).then(() => true, () => false), false);
    assert.equal(supervisor.listActiveTaskIds().includes(taskId), false);
    assert.equal(supervisor.listStartingTaskIds().includes(taskId), false);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("cancellation is resolved when a reserved action exits preflight without reaching process launch", async () => {
  const supervisor = new ProcessSupervisor(new RepairWorkspaceService());
  const taskId = `cancel-preflight-return-${randomUUID()}`;

  supervisor.reserve(taskId, "testing.run_incident_lab");
  const cancellation = supervisor.cancel(taskId, "testing.run_incident_lab");
  supervisor.releaseReservationIfUnused(taskId);

  const result = await cancellation;
  assert.equal(result?.status, "cancelled");
  assert.equal(result?.processStarted, false);
  assert.equal(result?.terminationVerified, true);
  assert.equal(supervisor.listStartingTaskIds().includes(taskId), false);
});

test("coding patch preparation stops before writing when cancellation arrives during worktree creation", async () => {
  const tempRoot = await fs.mkdtemp(path.join(tmpdir(), "vanessa-coding-cancel-"));
  const worktreePath = path.join(tempRoot, "repair-worktree");
  const relativeTarget = path.join("packages", "incident-lab", "src", "checkout.ts");
  const targetPath = path.join(worktreePath, relativeTarget);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const original = [
    "export function calculateDiscount(subtotal: number, promo: any) {",
    "  const discount = (subtotal * promo.discountRate) / 100;",
    "  return discount;",
    "}",
    "",
  ].join("\n");
  await fs.writeFile(targetPath, original, "utf8");

  const taskId = `coding-cancel-${randomUUID()}`;
  const task: Task = {
    id: taskId,
    agent: "coding",
    action: "coding.prepare_patch",
    params: { taskId },
    dependsOn: [],
    status: "running",
    approvalDigest: "d".repeat(64),
    approvalConsumedAt: Date.now(),
    approvalExpiresAt: Date.now() + 60_000,
    approvalPolicyVersion: "trustworthy-execution-v1",
    approvalRepositoryRoot: tempRoot,
    approvalBranch: "main",
    approvalBaseCommit: "base-commit-for-fixture",
    approvalWorkingTreeDigest: "e".repeat(64),
    approvalTarget: "packages/incident-lab/src/checkout.ts",
    approvalPatchContract: "incident-lab.checkout-promo-null-guard.v1",
  };

  const workspace: RepairWorkspace = {
    taskId,
    repositoryRoot: tempRoot,
    worktreePath,
    branchName: "vanessa/repair/cancelled-fixture",
    baseCommit: "base-commit-for-fixture",
    baseBranch: "main",
    baseStatus: "",
    createdAt: new Date().toISOString(),
  };
  const fakeWorkspaceService = {
    create: async () => {
      // Simulate the task runner receiving cancellation while the async Git
      // worktree-creation operation was in progress.
      task.lifecycleState = "cancel_requested";
      return workspace;
    },
    isBaseCheckoutUnchanged: async () => true,
  } as unknown as RepairWorkspaceService;

  try {
    const agent = new CodingAgent(fakeWorkspaceService);
    const result = await agent.execute(
      "coding.prepare_patch",
      { taskId },
      { task } as AgentRunContext,
    );

    assert.equal(result.status, "partial");
    assert.equal(result.success, false);
    assert.equal((result.data as Record<string, any>)?.outcome, "inconclusive");
    assert.equal((result.data as Record<string, any>)?.patchApplied, false);
    assert.equal((result.data as Record<string, any>)?.cancellationRequested, true);
    assert.match(result.summary || "", /cancellation/i);
    assert.equal(await fs.readFile(targetPath, "utf8"), original);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("cancellation does not relabel already-finished supervised processes as cancelled", async () => {
  const terminalStatuses = ["exited", "timed_out", "spawn_failed", "orphaned_processes"] as const;
  for (const processStatus of terminalStatuses) {
    const task: Task = {
      id: `cancel-race-${processStatus}-${randomUUID()}`,
      agent: "testing",
      action: "testing.run_incident_lab",
      params: validTestParams,
      dependsOn: [],
      status: "running",
      lifecycleState: "running",
      startedAt: Date.now(),
    };
    const fakeSupervisor = {
      cancel: async () => ({
        status: processStatus,
        processStarted: true,
        terminationVerified: true,
        exitCode: processStatus === "exited" ? 0 : 1,
        error: undefined,
      }),
    } as any;

    const resolution = await cancelTaskWithProof(task, "cancel race test", fakeSupervisor);
    assert.equal(resolution, "execution_finished", processStatus);
    assert.equal(task.status, "running", processStatus);
    assert.equal(task.lifecycleState, "running", processStatus);
    assert.notEqual(task.verification?.outcome, "cancelled", processStatus);
  }
});

test("verified cancellation is distinct from a completed or timed-out process", async () => {
  const task: Task = {
    id: `cancel-verified-${randomUUID()}`,
    agent: "testing",
    action: "testing.run_incident_lab",
    params: validTestParams,
    dependsOn: [],
    status: "running",
    lifecycleState: "running",
    startedAt: Date.now(),
  };
  const resolution = await cancelTaskWithProof(task, "verified cancel test", {
    cancel: async () => ({
      status: "cancelled",
      processStarted: true,
      terminationVerified: true,
      exitCode: null,
      error: undefined,
    }),
  } as any);

  assert.equal(resolution, "cancelled");
  assert.equal(task.status, "cancelled");
  assert.equal(task.lifecycleState, "cancelled");
  assert.equal(task.verification?.verified, true);
  assert.equal(task.verification?.outcome, "cancelled");
});

test("unconfirmed process termination retains the task's conflicting resource lock", async () => {
  const taskId = `cancel-unconfirmed-${randomUUID()}`;
  const lockName = `trustworthy-execution-test:${taskId}`;
  const task: Task = {
    id: taskId,
    agent: "testing",
    action: "testing.run_incident_lab",
    params: validTestParams,
    dependsOn: [],
    status: "running",
    lifecycleState: "running",
    startedAt: Date.now(),
  };
  await resourceLockManager.acquireLock(lockName, taskId);
  try {
    const resolution = await cancelTaskWithProof(task, "unconfirmed cancel test", {
      cancel: async () => ({
        status: "termination_unconfirmed",
        processStarted: true,
        terminationVerified: null,
        exitCode: null,
        error: "fixture cannot prove process exit",
      }),
    } as any);

    assert.equal(resolution, "termination_unconfirmed");
    assert.equal(task.status, "termination_unconfirmed");
    assert.equal(task.verification?.outcome, "termination_unconfirmed");
    assert.equal(resourceLockManager.getHeldLocks()[lockName], taskId);
  } finally {
    resourceLockManager.releaseLock(lockName, taskId);
  }
});

