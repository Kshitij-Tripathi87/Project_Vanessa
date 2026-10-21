import assert from "node:assert/strict";
import { planner } from "../core/planner.js";
import { modelRouter } from "../core/router.js";

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

    modelRouter.callLLM = async () => JSON.stringify({
      intent: "multi_task",
      risk: "low",
      tasks: [
        { id: "a", agent: "files", action: "file.search", params: {}, dependsOn: ["b"] },
        { id: "b", agent: "files", action: "file.search", params: {}, dependsOn: ["a"] },
      ],
    });
    const rejectedGraph = await planner.createPlan("What can you help with?");
    assert(rejectedGraph.tasks.every((task) => task.status === "pending"));
    assert(!rejectedGraph.tasks.some((task) => task.id === "a" || task.id === "b"));
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
