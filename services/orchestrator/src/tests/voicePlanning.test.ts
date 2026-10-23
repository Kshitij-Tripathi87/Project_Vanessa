import assert from "node:assert/strict";
import { planner } from "../core/planner.js";
import { modelRouter } from "../core/router.js";
import { orchestrator } from "../core/orchestrator.js";

async function runVoicePlanningTests() {
  const originalCallLlm = modelRouter.callLLM;
  let receivedPrompt = "";
  modelRouter.callLLM = async (prompt: string) => {
    receivedPrompt = prompt;
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
    const plan = await planner.createPlan("open it", [
      { role: "user", content: "Find the latest project report." },
      { role: "assistant", content: "I found the project report in Documents." },
    ]);
    assert.match(receivedPrompt, /User: Find the latest project report/);
    assert.match(receivedPrompt, /Vanessa: I found the project report/);
    assert.match(receivedPrompt, /Current user request \(plan this request\):\nopen it/);
    assert.strictEqual(plan.command, "open it");
    assert.strictEqual(plan.tasks[0].agent, "files");
    assert.strictEqual(plan.tasks[0].status, "pending", "Model tasks must be ready for the runner");

    modelRouter.callLLM = async () => JSON.stringify({
      intent: "multi_task",
      risk: "low",
      tasks: [
        { id: "a", agent: "files", action: "file.search", params: {}, dependsOn: ["b"] },
        { id: "b", agent: "files", action: "file.search", params: {}, dependsOn: ["a"] },
      ],
    });
    await assert.rejects(planner.createPlan("What can you help with?"), /valid task plan/);

    modelRouter.callLLM = async () => null;
    await assert.rejects(planner.createPlan("Turn on Bluetooth"), /valid task plan/);
    modelRouter.callLLM = async () => "not JSON";
    await assert.rejects(planner.createPlan("Create a folder"), /invalid plan JSON/);
    modelRouter.callLLM = async () => { throw new Error("Gemini unavailable"); };
    await assert.rejects(planner.createPlan("Open YouTube"), /Gemini unavailable/);

    const activeBefore = orchestrator.getSystemStatus().activeTasksCount;
    const failed = await orchestrator.executeCommand({
      command: "Turn on Bluetooth",
      idempotencyKey: `gemini-failure-test-${Date.now()}`,
    });
    assert.strictEqual(failed.status, "failed");
    assert.strictEqual(failed.plan, undefined);
    assert.strictEqual(failed.verification?.verified, false);
    assert.match(failed.spokenSummary, /No tasks were started/);
    assert.strictEqual(orchestrator.getSystemStatus().activeTasksCount, activeBefore);
  } finally {
    modelRouter.callLLM = originalCallLlm;
  }

  console.log("Voice planning tests passed: recent context is routed and invalid agent DAGs are rejected.");
  process.exit(0);
}

runVoicePlanningTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
