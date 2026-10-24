import assert from "node:assert/strict";
import { test } from "node:test";
import { extractResourceTarget, inferResourceWorkflow } from "../core/agentRouting.js";
import { planner } from "../core/planner.js";

test("routes code changes through Folder Agent then the existing coding handoff", async () => {
  const plan = await planner.createPlan('Fix the bug in "src/example.ts" and add a regression test.');
  assert.equal(plan.tasks.length, 2);
  assert.equal(plan.tasks[0].agent, "folder");
  assert.equal(plan.tasks[0].action, "folder.resolve");
  assert.equal(plan.tasks[1].agent, "developer");
  assert.equal(plan.tasks[1].action, "codex.open");
  assert.equal(plan.tasks[1].params.projectPath, "$" + plan.tasks[0].id + ".result.projectRoot");
  assert.deepEqual(plan.tasks[1].dependsOn, [plan.tasks[0].id]);
});

test("routes local HTML preview through Folder Agent then Browser Agent", () => {
  assert.deepEqual(inferResourceWorkflow("Open index.html in the browser and inspect the layout."), { target: "index.html", intent: "browser" });
});

test("routes passive data analysis through Folder Agent then File Agent", () => {
  assert.deepEqual(inferResourceWorkflow("Summarize reports/monthly.csv"), { target: "reports/monthly.csv", intent: "analysis" });
});

test("routes open-only project requests to Folder Agent", () => {
  assert.deepEqual(inferResourceWorkflow("Open my Cortex project folder"), { target: "Cortex", intent: "open" });
});

test("does not hijack ordinary browser commands without a local target", () => {
  assert.equal(inferResourceWorkflow("Open Chrome and search for TypeScript tutorials"), null);
  assert.equal(extractResourceTarget("Navigate to https://example.com/index.html"), null);
});

test("the requested operation wins over the target extension", () => {
  assert.deepEqual(inferResourceWorkflow("Read src/service.py and explain what it does"), { target: "src/service.py", intent: "analysis" });
  assert.deepEqual(inferResourceWorkflow("Fix src/service.py"), { target: "src/service.py", intent: "code" });
});
