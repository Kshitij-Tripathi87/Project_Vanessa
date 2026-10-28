import assert from "node:assert/strict";
import { test } from "node:test";
import { VanessaPlanner } from "../core/planner.js";
import { modelRouter } from "../core/router.js";

test("plans code changes as Folder Agent resolution followed by the coding handoff", async () => {
  const originalCallLLM = modelRouter.callLLM;
  let llmCalls = 0;
  modelRouter.callLLM = (async () => {
    llmCalls++;
    throw new Error("The LLM should not be called for a high-confidence local resource workflow.");
  }) as typeof modelRouter.callLLM;

  try {
    const plan = await new VanessaPlanner().createPlan(
      'Fix the bug in "src/example.ts" and add a regression test.',
      [],
      { requestId: "resource-routing-code-test" },
    );
    assert.equal(llmCalls, 0);
    assert.equal(plan.tasks.length, 2);
    const [resolve, coding] = plan.tasks;
    assert.equal(resolve.agent, "folder");
    assert.equal(resolve.action, "folder.resolve");
    assert.equal(coding.agent, "developer");
    assert.equal(coding.action, "codex.open");
    assert.equal(coding.params.projectPath, "$" + resolve.id + ".result.projectRoot");
    assert.deepEqual(coding.dependsOn, [resolve.id]);
    assert.match(coding.params.prompt, /Fix the bug in/);
  } finally {
    modelRouter.callLLM = originalCallLLM;
  }
});

test("plans passive local-file analysis as resolve then bounded file inspection", async () => {
  const originalCallLLM = modelRouter.callLLM;
  let llmCalls = 0;
  modelRouter.callLLM = (async () => {
    llmCalls++;
    throw new Error("The LLM should not be called for a high-confidence local resource workflow.");
  }) as typeof modelRouter.callLLM;

  try {
    const plan = await new VanessaPlanner().createPlan(
      'Summarize "docs/overview.md" and explain the key points.',
      [],
      { requestId: "resource-routing-analysis-test" },
    );
    assert.equal(llmCalls, 0);
    assert.equal(plan.tasks.length, 2);
    const [resolve, inspect] = plan.tasks;
    assert.equal(resolve.agent, "folder");
    assert.equal(resolve.action, "folder.resolve");
    assert.equal(inspect.agent, "files");
    assert.equal(inspect.action, "file.inspect");
    assert.equal(inspect.params.path, "$" + resolve.id + ".result.targetPath");
    assert.deepEqual(inspect.dependsOn, [resolve.id]);
  } finally {
    modelRouter.callLLM = originalCallLLM;
  }
});

test("routes a named folder open to a single Folder Agent task", async () => {
  const originalCallLLM = modelRouter.callLLM;
  modelRouter.callLLM = (async () => {
    throw new Error("The LLM should not be called for a high-confidence local resource workflow.");
  }) as typeof modelRouter.callLLM;
  try {
    const plan = await new VanessaPlanner().createPlan(
      "Open my Cortex project folder",
      [],
      { requestId: "resource-routing-open-test" },
    );
    assert.equal(plan.tasks.length, 1);
    assert.equal(plan.tasks[0].agent, "folder");
    assert.equal(plan.tasks[0].action, "folder.open");
    assert.equal(plan.tasks[0].params.target, "Cortex");
    assert.equal(plan.tasks[0].params.mode, "explorer");
  } finally {
    modelRouter.callLLM = originalCallLLM;
  }
});
