import assert from "node:assert/strict";
import { test } from "node:test";
import { agentRegistry } from "../agents/registry.js";
import { getCatalogAction } from "../agents/agentCatalog.js";
import {
  activeTasks,
  cancelTaskWithProof,
  engageKillSwitch,
  runPlan,
} from "../core/taskRunner.js";

test("emergency stop verifies already-finished work and prevents its dependent task from starting", async () => {
  const spec = getCatalogAction("files", "file.search");
  assert.ok(spec?.selectable);
  const originalExecute = agentRegistry.files.execute;
  let finishFirst!: (value: any) => void;
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const executions: string[] = [];

  agentRegistry.files.execute = async (action: string, params: Record<string, any>) => {
    const query = String((params as Record<string, unknown>).query);
    executions.push(query);
    if (query === "first") {
      firstStarted();
      return new Promise((resolve) => { finishFirst = resolve; });
    }
    return {
      agentId: "files",
      status: "completed",
      success: true,
      summary: "Dependent task should not have started.",
      verification: { passed: true, details: "fixture" },
      data: { matches: [] },
      evidence: [],
      artifacts: [],
    };
  };

  const firstId = "kill-switch-finished-first";
  const secondId = "kill-switch-blocked-second";
  const plan: any = {
    id: "kill-switch-finished-plan",
    command: "Search twice with a dependency",
    tasks: [
      {
        id: firstId,
        agent: "files",
        action: "file.search",
        params: { query: "first" },
        dependsOn: [],
        acceptanceCriteria: ["The first search returns verified data."],
        status: "pending",
        risk: spec.risk,
        allowedTools: [...spec.tools],
      },
      {
        id: secondId,
        agent: "files",
        action: "file.search",
        params: { query: "second" },
        dependsOn: [firstId],
        acceptanceCriteria: ["The dependent search runs only after the first."],
        status: "pending",
        risk: spec.risk,
        allowedTools: [...spec.tools],
      },
    ],
  };

  try {
    const execution = runPlan(plan);
    await started;
    const active = activeTasks.get(firstId);
    assert.ok(active, "first task must be owned by the runner before cancellation");
    engageKillSwitch();
    const cancellation = await cancelTaskWithProof(active, "emergency stop test", {
      cancel: async () => ({
        status: "exited",
        processStarted: true,
        terminationVerified: true,
        exitCode: 0,
      }),
    } as any);
    assert.equal(cancellation, "execution_finished");
    assert.equal(active.status, "running");
    assert.equal(active.lifecycleState, "running");

    finishFirst({
      agentId: "files",
      status: "completed",
      success: true,
      summary: "The first search completed before the cancellation request took effect.",
      verification: { passed: true, details: "The handler returned a complete read-only result." },
      data: { matches: [{ name: "fixture.txt" }] },
      evidence: [{ description: "The first search result was returned.", source: "test", timestamp: new Date().toISOString() }],
      artifacts: [],
    });

    const results = await execution;
    assert.equal(results[0].status, "success");
    assert.equal(results[0].verification?.verified, true);
    assert.equal(results[1].status, "cancelled");
    assert.equal(results[1].verification?.verified, true);
    assert.equal(results[1].verification?.outcome, "cancelled");
    assert.match(results[1].verification?.details || "", /before execution began/);
    assert.ok(results[1].completedAt);
    assert.deepEqual(executions, ["first"]);
  } finally {
    agentRegistry.files.execute = originalExecute;
    activeTasks.delete(firstId);
    activeTasks.delete(secondId);
  }
});
