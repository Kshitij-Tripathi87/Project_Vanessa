import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { AGENT_CATALOG, catalogAccepts, getCatalogAction } from "../agents/agentCatalog.js";
import { resolvePlannerWorkspace } from "../core/contextBuilder.js";

test("the teaching example covers every selectable agent with valid parameters and complete task fields", () => {
  const source = readFileSync(path.join(resolvePlannerWorkspace(), "services/orchestrator/src/core/planner.ts"), "utf8");
  const match = source.match(/COMPREHENSIVE EXAMPLE OUTPUT[^\n]*\n([\s\S]*?)\nEND EXAMPLE OUTPUT/);
  assert(match, "The actual system prompt must contain a complete JSON teaching example");
  const example = JSON.parse(match[1]);
  assert.equal(example.intent, "multi_task");
  assert(example.tasks.length > 1 && example.tasks.length <= 12);
  const expectedAgents = AGENT_CATALOG.filter((agent) => agent.actions.some((action) => action.selectable)).map((agent) => agent.id).sort();
  assert.deepEqual([...new Set(example.tasks.map((task: any) => task.agent))].sort(), expectedAgents);

  const fields = ["id", "agent", "action", "params", "dependsOn", "acceptanceCriteria"].sort();
  const precedingIds = new Set<string>();
  const ranks = ["low", "medium", "high"];
  let dependencyCount = 0;
  for (const task of example.tasks) {
    assert.deepEqual(Object.keys(task).sort(), fields, `All six fields are required for ${task.id}`);
    assert(catalogAccepts(task.agent, task.action, task.params), `${task.agent}/${task.action} must match the real action contract`);
    assert(Array.isArray(task.acceptanceCriteria) && task.acceptanceCriteria.length > 0);
    assert(task.acceptanceCriteria.every((criterion: unknown) => typeof criterion === "string" && criterion.length > 0));
    assert(Array.isArray(task.dependsOn));
    for (const parent of task.dependsOn) {
      assert(precedingIds.has(parent));
      dependencyCount++;
    }
    assert(!precedingIds.has(task.id));
    precedingIds.add(task.id);
    assert(ranks.indexOf(example.risk) >= ranks.indexOf(getCatalogAction(task.agent, task.action)!.risk));
  }
  assert(dependencyCount > 0, "The example must illustrate an actual data dependency");
});
