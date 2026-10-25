import assert from "node:assert/strict";
import { planner, PLANNER_SYSTEM_PROMPT } from "../core/planner.js";
import { modelRouter } from "../core/router.js";
import { orchestrator } from "../core/orchestrator.js";
import { resolvePlannerWorkspace } from "../core/contextBuilder.js";
import { developerAgent } from "../agents/developer.agent.js";
import { permissionGuard } from "../core/permissionGuard.js";
import { runPlan } from "../core/taskRunner.js";
import { fileAgent } from "../agents/file.agent.js";
import * as fs from "node:fs";

async function runVoicePlanningTests() {
  const originalCallLlm = modelRouter.callLLM;
  let receivedPrompt = "";
  let receivedSystem = "";
  let receivedRequestId: string | undefined;
  let receivedSignal: AbortSignal | undefined;
  modelRouter.callLLM = async (prompt: string, system: string, requestId?: string, signal?: AbortSignal) => {
    receivedSignal = signal;
    receivedPrompt = prompt;
    receivedSystem = system;
    receivedRequestId = requestId;
    return JSON.stringify({
      intent: "single_task",
      risk: "low",
      tasks: [{
        id: "t1",
        agent: "files",
        action: "file.search",
        params: { query: "report" },
        dependsOn: [],
      }],
    });
  };

  try {
    const controller = new AbortController();
    const plan = await planner.createPlan("open it", [
      { role: "user", content: "Find the latest project report." },
      { role: "assistant", content: "I found the project report in Documents." },
    ], { requestId: "planning-log-correlation" }, controller.signal);
    assert.equal(receivedSignal, controller.signal);
    assert.equal(receivedRequestId, "planning-log-correlation");
    assert.match(receivedPrompt, /User: Find the latest project report/);
    assert.match(receivedPrompt, /Vanessa: I found the project report/);
    assert.match(receivedPrompt, /Current user request \(plan this request\):\nopen it/);
    assert.strictEqual(plan.command, "open it");
    assert.strictEqual(plan.tasks[0].agent, "files");
    assert.strictEqual(plan.tasks[0].status, "pending", "Model tasks must be ready for the runner");
    assert.equal(receivedSystem, PLANNER_SYSTEM_PROMPT);
    assert.match(receivedSystem, /AGENT developer:/);
    assert.match(receivedSystem, /Action codex.open/);
    assert(!receivedSystem.includes("AGENT coding:"));
    assert.match(receivedPrompt, /Runtime context/);

    const projectPath = fs.realpathSync(resolvePlannerWorkspace());
    const minimalTasks = [
      { agent: "windows", action: "app.open", params: { name: "Brave" } },
      { agent: "developer", action: "codex.open", params: { projectPath, prompt: "Write a Python Hello World script" } },
    ];
    modelRouter.callLLM = async () => JSON.stringify({ tasks: minimalTasks });
    const minimal = await planner.createPlan("Open Brave and write a Python Hello World program");
    assert.equal(minimal.intent, "multi_task");
    assert.equal(minimal.risk, "high");
    assert.equal(minimal.tasks.length, 2);
    assert.deepEqual(minimal.tasks.map((task) => task.dependsOn), [[], []]);
    assert(minimal.tasks.every((task) => task.id.startsWith(minimal.id) && task.acceptanceCriteria?.length));
    assert.equal(permissionGuard.check(minimal.tasks[1], false), "confirm");
    assert.match(minimal.tasks[1].params.prompt, /Write a Python Hello World script/);
    assert(!minimal.tasks[1].params.prompt.includes("Open Brave and write a Python Hello World program"));
    modelRouter.callLLM = async () => JSON.stringify({ intent: "single_task", risk: "low", tasks: minimalTasks });
    const correctedMetadata = await planner.createPlan("Open Brave and write a Python Hello World program");
    assert.equal(correctedMetadata.intent, "multi_task");
    assert.equal(correctedMetadata.risk, "high");

    const codexPlan = () => JSON.stringify({ intent: "single_task", risk: "low", tasks: [{
      id: "t1", agent: "developer", action: "codex.open", params: { projectPath, prompt: "Fix the parser and run relevant checks" },
      dependsOn: [], acceptanceCriteria: ["Pass prompt to Codex"], status: "success", result: { invented: true },
    }] });
    modelRouter.callLLM = async () => codexPlan();
    const coding = await planner.createPlan("Fix the checkout parser; do not deploy", [
      { role: "user", content: "The parser is in planner.ts" },
      { role: "assistant", content: "I will inspect that file." },
    ], { source: "desktop", requestId: "request-codex" });
    const codingTask = coding.tasks[0];
    assert.equal(codingTask.agent, "developer");
    assert.equal(codingTask.action, "codex.open");
    assert.equal(codingTask.params.projectPath, projectPath);
    assert.match(codingTask.params.prompt, /Fix the parser and run relevant checks/);
    assert(!codingTask.params.prompt.includes("Original current user request"));
    assert(!codingTask.params.prompt.includes("Fix the checkout parser; do not deploy"));
    assert.match(codingTask.params.prompt, /parser is in planner.ts/);
    assert.equal(codingTask.status, "pending");
    assert.equal(codingTask.result, undefined);
    assert.equal(codingTask.risk, "high");
    assert.equal(coding.risk, "high");
    assert.equal(permissionGuard.check(codingTask, false), "confirm");
    assert.notEqual((await planner.createPlan("Fix it")).tasks[0].id, codingTask.id);

    for (const task of [
      { id: "t1", agent: "coding", action: "coding.inspect_changes", params: {} },
      { id: "t1", agent: "files", action: "folder.invented", params: {} },
      { id: "t1", agent: "developer", action: "codex.open", params: { projectPath } },
      { id: "t1", agent: "cloud", action: "gmail.send", params: { to: "person", subject: "test" } },
    ]) {
      modelRouter.callLLM = async () => JSON.stringify({ tasks: [{ ...task, dependsOn: [] }] });
      await assert.rejects(planner.createPlan("Execute this request"), /valid task plan/);
    }

    modelRouter.callLLM = async () => JSON.stringify({ risk: "low", tasks: [
      { id: "folder", agent: "files", action: "folder.create", params: { name: "test" }, dependsOn: [] },
      { id: "search", agent: "files", action: "file.search", params: { path: "$folder.result.path", query: "report" } },
    ] });
    const references = await planner.createPlan("Create and search a folder");
    assert.deepEqual(references.tasks[1].dependsOn, [references.tasks[0].id]);
    assert.equal(references.tasks[1].params.path, `$${references.tasks[0].id}.result.path`);

    // The model omits dependency metadata; actual runner ordering still follows result references.
    const executeFileBefore = fileAgent.execute;
    const searchCalls: string[] = [];
    let failFirstSearch = false;
    fileAgent.execute = async (_action, params) => {
      const values = params as Record<string, any>;
      searchCalls.push(values.query);
      if (values.query === "second") assert.equal(values.path, projectPath);
      const failed = failFirstSearch && values.query === "first";
      return {
        agentId: "files", status: failed ? "failed" : "completed", success: !failed,
        spokenSummary: failed ? "Directory read failed." : "Directory inspected.",
        evidence: [], artifacts: [], data: { directory: projectPath, matches: [] },
        verification: { passed: !failed, details: failed ? "Simulated directory read failure" : "Simulated observed directory listing" },
      };
    };
    try {
      modelRouter.callLLM = async () => JSON.stringify({ tasks: [
        { agent: "files", action: "file.search", params: { query: "first" } },
        { agent: "files", action: "file.search", params: { query: "second", path: "$t1.result.directory" } },
      ] });
      const ordered = await runPlan(await planner.createPlan("Search, then search the returned directory"));
      assert.deepEqual(searchCalls, ["first", "second"]);
      assert.deepEqual(ordered.map((task) => task.status), ["success", "success"]);
      searchCalls.length = 0;
      failFirstSearch = true;
      const blocked = await runPlan(await planner.createPlan("Search, then search the returned directory"));
      assert.deepEqual(searchCalls, ["first"]);
      assert.deepEqual(blocked.map((task) => task.status), ["failed", "blocked"]);
    } finally { fileAgent.execute = executeFileBefore; }

    // Exercise the approved handoff with a substituted launcher, never a real CLI.
    modelRouter.callLLM = async () => codexPlan();
    const executeBefore = developerAgent.execute;
    const dispatches: Array<{ action: string; params: Record<string, any> }> = [];
    developerAgent.execute = async (action, params) => {
      dispatches.push({ action, params: params || {} });
      return { success: true, status: "started", terminalPid: 1234, output: "Terminal started; coding completion unverified." };
    };
    try {
      const result = await orchestrator.executeCommand({ command: "Investigate checkout parser", source: "desktop", conversationContext: [] });
      assert.equal(result.status, "awaiting_approval");
      assert.equal(dispatches.length, 0);
      const approved = await orchestrator.approve(result.pendingTasks![0].id);
      const dispatch = dispatches[0];
      assert.equal(dispatch.action, "codex.open");
      assert.deepEqual(Object.keys(dispatch.params).sort(), ["projectPath", "prompt"]);
      assert.match(dispatch.params.prompt, /Fix the parser and run relevant checks/);
      assert(!dispatch.params.prompt.includes("Investigate checkout parser"));
      assert.equal(approved?.status, "success");
      assert.match(approved?.spokenSummary || "", /Coding completion is not yet reported/);
    } finally { developerAgent.execute = executeBefore; }

    modelRouter.callLLM = async () => JSON.stringify({
      intent: "multi_task",
      risk: "low",
      tasks: [
        { id: "a", agent: "files", action: "file.search", params: { query: "report" }, dependsOn: ["b"] },
        { id: "b", agent: "files", action: "file.search", params: { query: "report" }, dependsOn: ["a"] },
      ],
    });
    await assert.rejects(planner.createPlan("What can you help with?"), /valid task plan/);

    modelRouter.callLLM = async () => null;
    await assert.rejects(planner.createPlan("Turn on Bluetooth"), /valid task plan/);
    modelRouter.callLLM = async () => "not JSON";
    await assert.rejects(planner.createPlan("Create a folder"), /invalid plan JSON/);
    modelRouter.callLLM = async () => { throw new Error("NVIDIA unavailable"); };
    await assert.rejects(planner.createPlan("Open YouTube"), /NVIDIA unavailable/);

    const activeBefore = orchestrator.getSystemStatus().activeTasksCount;
    const failed = await orchestrator.executeCommand({
      command: "Turn on Bluetooth",
      idempotencyKey: `nvidia-failure-test-${Date.now()}`,
    });
    assert.strictEqual(failed.status, "failed");
    assert.strictEqual(failed.plan, undefined);
    assert.strictEqual(failed.verification?.verified, false);
    assert.match(failed.spokenSummary, /No tasks were started/);
    assert.strictEqual(orchestrator.getSystemStatus().activeTasksCount, activeBefore);
  } finally {
    modelRouter.callLLM = originalCallLlm;
  }

  console.log("Planning checks passed: catalog validation, Codex context/approval handoff, scoped dependencies, and provider failure handling (model/launcher substituted).");
  process.exit(0);
}

runVoicePlanningTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
