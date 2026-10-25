import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { AGENT_CATALOG, catalogAccepts } from "../agents/agentCatalog.js";
import { resolvePlannerWorkspace } from "../core/contextBuilder.js";
import { normalizeModelTasks } from "../core/modelPlan.js";

test("the minimal teaching example covers every selectable agent and normalizes into runnable task metadata", () => {
  const source = readFileSync(path.join(resolvePlannerWorkspace(), "services/orchestrator/src/core/planner.ts"), "utf8");
  const match = source.match(/COMPREHENSIVE EXAMPLE OUTPUT[^\n]*\n([\s\S]*?)\nEND EXAMPLE OUTPUT/);
  assert(match, "The actual system prompt must contain a complete JSON teaching example");
  const example = JSON.parse(match[1]);
  assert.deepEqual(Object.keys(example), ["tasks"]);
  assert(example.tasks.length > 1 && example.tasks.length <= 12);
  const expectedAgents = AGENT_CATALOG.filter((agent) => agent.actions.some((action) => action.selectable)).map((agent) => agent.id).sort();
  assert.deepEqual([...new Set(example.tasks.map((task: any) => task.agent))].sort(), expectedAgents);

  const fields = ["agent", "action", "params"].sort();
  for (const task of example.tasks) {
    assert.deepEqual(Object.keys(task).sort(), fields, "The model must supply only routing and action parameters");
    assert(catalogAccepts(task.agent, task.action, task.params), `${task.agent}/${task.action} must match the real action contract`);
  }
  const tasks = normalizeModelTasks(example.tasks);
  assert.deepEqual(tasks[4].dependsOn, [tasks[3].id], "The folder/search dependency must be inferred from its result reference");
  assert(tasks.every((task) => task.id && task.acceptanceCriteria?.length && task.status === "pending"));
  assert.equal(tasks[0].risk, "high");
});
