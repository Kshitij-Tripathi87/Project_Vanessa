import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_CATALOG, type CatalogAction } from "../agents/agentCatalog.js";
import { normalizeModelTasks } from "../core/modelPlan.js";

function requiredParams(spec: CatalogAction): Record<string, unknown> {
  return Object.fromEntries(Object.entries(spec.parameters).filter(([, field]) => field.required).map(([name, field]) => [
    name,
    field.type === "number" ? 50 : field.type === "boolean" ? false : field.type === "array" ? [] : field.type === "object" ? {} : "user-supplied-value",
  ]));
}

test("accepts the reported mixed Windows/Codex request without model-generated metadata", () => {
  const tasks = normalizeModelTasks([
    { agent: "windows", action: "app.open", params: { name: "Brave" } },
    { agent: "developer", action: "codex.open", params: { projectPath: "C:/project", prompt: "Write a Python Hello World script" } },
  ]);
  assert.deepEqual(tasks.map((task) => task.id), ["t1", "t2"]);
  assert.deepEqual(tasks.map((task) => task.dependsOn), [[], []]);
  assert.deepEqual(tasks.map((task) => task.risk), ["low", "high"]);
  assert(tasks.every((task) => task.status === "pending" && task.acceptanceCriteria!.length > 0));
  assert.match(tasks[1].acceptanceCriteria![0], /coding completion remains unverified/);
});

test("reviews required parameters for every selectable action across all ten agents", () => {
  assert.equal(AGENT_CATALOG.length, 10);
  for (const agent of AGENT_CATALOG) {
    for (const action of agent.actions) {
      const params = requiredParams(action);
      const input = { agent: agent.id, action: action.name, params };
      if (!action.selectable) {
        assert.throws(() => normalizeModelTasks([input]), /unavailable agent\/action/);
        continue;
      }
      const [task] = normalizeModelTasks([input]);
      assert.deepEqual(task.params, params, `${agent.id}/${action.name} must retain its actual parameters`);
      assert.equal(task.risk, action.risk);
      assert.deepEqual(task.allowedTools, action.tools);
      if (Object.keys(params).length === 0) assert.deepEqual(normalizeModelTasks([{ agent: agent.id, action: action.name }])[0].params, {});
      for (const name of Object.keys(params)) {
        const missing = { ...params };
        delete missing[name];
        assert.throws(() => normalizeModelTasks([{ ...input, params: missing }]), /invalid params/, `${agent.id}/${action.name} must still require ${name}`);
        const wrongType = typeof params[name] === "string" ? 123 : "invalid-value";
        assert.throws(() => normalizeModelTasks([{ ...input, params: { ...params, [name]: wrongType } }]), /invalid params/);
      }
      assert.throws(() => normalizeModelTasks([{ ...input, params: { ...params, inventedParameter: true } }]), /invalid params/);
    }
  }
});

test("infers result dependencies and retains explicit ordering when no result value is consumed", () => {
  const tasks = normalizeModelTasks([
    { agent: "files", action: "folder.create", params: { name: "Reports" } },
    { agent: "files", action: "file.search", params: { query: "report", path: "$t1.result.path" } },
    { agent: "windows", action: "app.open", params: { name: "notepad" }, dependsOn: ["t2"] },
  ]);
  assert.deepEqual(tasks.map((task) => task.dependsOn), [[], ["t1"], ["t2"]]);
  assert.equal(tasks[1].params.path, "$t1.result.path");
});

test("older named tasks still work when fields are omitted, and runtime state cannot be injected", () => {
  const tasks = normalizeModelTasks([
    { id: "folder", agent: "files", action: "folder.create", params: { name: "Reports" }, status: "success", result: { path: "invented" }, acceptanceCriteria: "untrusted" },
    { id: "search", agent: "files", action: "file.search", params: { query: "report", path: "$folder.result.path" } },
  ]);
  assert.equal(tasks[0].status, "pending");
  assert.equal(tasks[0].result, undefined);
  assert(Array.isArray(tasks[0].acceptanceCriteria));
  assert.deepEqual(tasks[1].dependsOn, ["folder"]);
  assert.throws(() => normalizeModelTasks([{ agent: "windows", action: "app.open", params: { name: "notepad" }, allowedTools: ["shell_exec"] }]), /catalog permissions/);
});

test("rejects missing, cyclic, self, duplicate, and malformed dependency definitions", () => {
  const search = (extra = {}) => ({ agent: "files", action: "file.search", params: { query: "report" }, ...extra });
  for (const input of [
    [search({ dependsOn: ["missing"] })],
    [search({ dependsOn: ["t1"] })],
    [search({ dependsOn: ["t2"] }), search({ dependsOn: ["t1"] })],
    [search({ id: "same" }), search({ id: "same" })],
    [search({ dependsOn: "t1" })],
    [search({ dependsOn: null })],
    [search({ params: { query: "report", path: "$missing.result.path" } })],
    [search({ params: { query: "report", path: "$t1.result.matches[0].path" } })],
  ]) assert.throws(() => normalizeModelTasks(input), /valid task plan/);
});

test("preserves Codex launch boundaries and action-specific validation", () => {
  const coding = { agent: "developer", action: "codex.open", params: { projectPath: "C:/project", prompt: "Inspect source" } };
  assert.throws(() => normalizeModelTasks([coding, { agent: "testing", action: "testing.run_checks", params: { command: "user-supplied-command" }, dependsOn: ["t1"] }]), /only acknowledges a terminal launch/);
  assert.throws(() => normalizeModelTasks([coding, coding]), /one Codex handoff/);
  assert.throws(() => normalizeModelTasks([{ agent: "testing", action: "testing.run_checks", params: { command: "test", autoDeploy: true } }]), /invalid params/);
  assert.throws(() => normalizeModelTasks([{ agent: "windows", action: "volume.set", params: { level: 101 } }]), /invalid params/);
  assert.throws(() => normalizeModelTasks([{ agent: "windows", action: "file.search", params: { query: "report" } }]), /unavailable agent\/action/);
});

test("rejects empty or oversized plans and malformed task objects", () => {
  for (const value of [undefined, null, {}, [], [null], ["task"], [{}], Array.from({ length: 13 }, () => ({ agent: "windows", action: "wifi.status" }))]) {
    assert.throws(() => normalizeModelTasks(value), /valid task plan/);
  }
});
