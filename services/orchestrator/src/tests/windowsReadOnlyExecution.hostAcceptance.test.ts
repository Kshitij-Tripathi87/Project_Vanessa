import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { agentRegistry } from "../agents/registry.js";
import { WindowsAgent } from "../agents/windows.agent.js";
import { orchestrator } from "../core/orchestrator.js";
import { modelRouter } from "../core/router.js";

const enabled =
  process.platform === "win32" &&
  process.env.VANESSA_RUN_WINDOWS_HOST_ACCEPTANCE === "1";

test("real Windows host executes a read-only volume query and verifies Core Audio read-back", {
  skip: !enabled,
}, async () => {
  const originalCallLLM = modelRouter.callLLM;
  const originalWindowsExecute = agentRegistry.windows.execute;
  const command = "Inspect the foreground window without reading field values, then report the current default playback volume and whether it is muted.";

  // Keep planning deterministic. The Windows agent and Core Audio read-back
  // remain real; only the planner's selected read-only action is fixed.
  modelRouter.callLLM = async (prompt) => {
    assert.ok(prompt.includes(command), "the exact user request must reach the planner");
    return JSON.stringify({
      tasks: [
        {
          id: "inspect_foreground",
          agent: "windows",
          action: "ui.inspect",
          params: {},
          dependsOn: [],
        },
        {
          id: "read_volume",
          agent: "windows",
          action: "volume.get",
          params: {},
          dependsOn: ["inspect_foreground"],
        },
      ],
    });
  };

  const realWindowsAgent = new WindowsAgent();
  agentRegistry.windows.execute = realWindowsAgent.execute.bind(realWindowsAgent);

  try {
    const result = await orchestrator.executeCommand({
      command,
      requestId: randomUUID(),
      source: "desktop",
    });

    assert.equal(result.status, "success");
    assert.equal(result.verification?.verified, true);
    assert.equal(result.plan?.tasks.length, 2);

    const inspection = result.plan!.tasks.find((task) => task.id === "inspect_foreground")!;
    assert.equal(inspection.action, "ui.inspect");
    assert.equal(inspection.agent, "windows");
    assert.equal(inspection.verification?.verified, true);
    assert.equal(inspection.verification?.outcome, "succeeded");
    assert.ok(inspection.evidence?.some((entry) => entry.source === "windows-ui-automation.inspect"));
    assert.equal((inspection.result as any).data.valuesRead, false);

    const task = result.plan!.tasks.find((candidate) => candidate.id === "read_volume")!;
    assert.equal(task.action, "volume.get");
    assert.equal(task.agent, "windows");
    assert.equal(task.verification?.verified, true);
    assert.equal(task.verification?.outcome, "succeeded");

    const audio = (task.result as any).audio;
    assert.equal(audio.success, true);
    assert.equal(audio.operation, "get");
    assert.ok(typeof audio.device.id === "string" && audio.device.id.length > 0);
    assert.ok(Number.isFinite(audio.observed.volumePercent));
    assert.ok(audio.observed.volumePercent >= 0 && audio.observed.volumePercent <= 100);
    assert.equal(typeof audio.observed.muted, "boolean");
    assert.ok(task.evidence?.some((entry) => entry.source === "windows-audio.readback"));
    assert.match(result.spokenSummary, /\d+(?:\.\d+)?%/);
  } finally {
    modelRouter.callLLM = originalCallLLM;
    agentRegistry.windows.execute = originalWindowsExecute;
  }
});
