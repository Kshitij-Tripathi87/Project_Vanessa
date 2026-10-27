import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { AGENT_CATALOG, catalogAccepts, getCatalogAction, renderAgentCatalog } from "../agents/agentCatalog.js";
import { resolvePlannerWorkspace } from "../core/contextBuilder.js";

test("canonical catalog excludes legacy coding/incident routing and documents Codex's launch boundary", () => {
  assert(!AGENT_CATALOG.some((agent) => ["coding", "incident"].includes(agent.id)));
  const codex = getCatalogAction("developer", "codex.open");
  assert(codex?.selectable);
  assert.equal(codex.risk, "high");
  assert.match(codex.returns, /launch only/);
  assert.equal(getCatalogAction("coding", "codex.open"), undefined);
  const prompt = renderAgentCatalog();
  assert.match(prompt, /AGENT developer:/);
  assert.match(prompt, /projectPath \(string, required\)/);
  assert.match(prompt, /prompt \(string, required\)/);
  assert.match(prompt, /completed CLI turn is execution evidence only/i);
  const managed = getCatalogAction("developer", "codex.run_task");
  assert(managed?.selectable);
  assert.equal(managed?.risk, "high");
  assert.match(managed?.returns || "", /not independent verification/i);
  assert(catalogAccepts("developer", "codex.run_task", {
    projectPath: "C:/repo",
    prompt: "Add regression coverage",
    expectedBranch: "feature/work",
    acceptanceCriteria: ["The regression test passes"],
    allowedPaths: ["services/orchestrator/src/tests"],
    timeoutMs: 60000,
  }));
  assert(!catalogAccepts("developer", "codex.run_task", { projectPath: "C:/repo" }));
});

test("every catalog action matches a real canonical handler switch, and names are unique", () => {
  const ids = new Set<string>();
  for (const agent of AGENT_CATALOG) {
    assert(!ids.has(agent.id));
    ids.add(agent.id);
    const sourceName = agent.id === "files" ? "file" : agent.id === "vanessa" ? "openjarvis" : agent.id;
    // Tests may run from source or an isolated compiler output; source is authoritative.
    const source = readFileSync(path.join(resolvePlannerWorkspace(), "services/orchestrator/src/agents", `${sourceName}.agent.ts`), "utf8");
    const actions = new Set<string>();
    for (const action of agent.actions) {
      assert(!actions.has(action.name));
      actions.add(action.name);
      assert(source.includes(`case "${action.name}":`), `${agent.id}/${action.name} has no handler`);
      assert(action.description && action.returns);
    }
  }
});

test("validates action identity, required parameter types, unsupported placeholders, and deployment constraints", () => {
  assert(catalogAccepts("developer", "codex.open", { projectPath: "C:/project", prompt: "Inspect code" }));
  assert(!catalogAccepts("developer", "codex.open", { projectPath: "C:/project" }));
  assert(!catalogAccepts("developer", "codex.open", { projectPath: 3, prompt: "Inspect code" }));
  assert(!catalogAccepts("developer", "codex.open", { projectPath: "C:/project", prompt: " " }));
  assert(!catalogAccepts("developer", "codex.open", { projectPath: "C:/project", prompt: "x\0y" }));
  assert(!catalogAccepts("files", "folder.create", { name: "test", command: "unexpected" }));
  assert(!catalogAccepts("files", "invented.action", {}));
  assert(!catalogAccepts("cloud", "gmail.send", { to: "person", subject: "subject" }));
  assert(!catalogAccepts("files", "drive.upload", { file: "report.pdf" }));
  assert(!catalogAccepts("testing", "testing.run_checks", { command: "test", autoDeploy: true }));
  assert(!catalogAccepts("windows", "volume.set", { level: 101 }));
  assert(catalogAccepts("files", "file.search", { query: "report", path: "$folder.result.path" }));
});

test("exposes verified Windows controls with typed planner contracts", () => {
  for (const action of ["volume.get", "volume.set", "volume.mute", "brightness.list", "brightness.get", "brightness.set", "bluetooth.list", "bluetooth.status", "bluetooth.set"]) {
    assert(getCatalogAction("windows", action)?.selectable, `${action} should be planner-selectable`);
  }
  assert(catalogAccepts("windows", "volume.get", {}));
  assert(catalogAccepts("windows", "volume.set", { level: 30 }));
  assert(catalogAccepts("windows", "volume.mute", { muted: false }));
  assert(catalogAccepts("windows", "brightness.set", { brightnessPercent: 40 }));
  assert(!catalogAccepts("windows", "brightness.set", { brightnessPercent: 40.5 }));
  assert(catalogAccepts("windows", "bluetooth.status", {}));
  assert(catalogAccepts("windows", "bluetooth.set", { state: "Off" }));
  assert(!catalogAccepts("windows", "bluetooth.set", { state: "Toggle" }));
});
