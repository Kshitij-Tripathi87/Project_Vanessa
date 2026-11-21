import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { agentRegistry } from "../agents/registry.js";
import { WindowsAgent } from "../agents/windows.agent.js";
import type { WindowsAudioRequest, WindowsAudioResult } from "../agents/windows-audio.js";
import { orchestrator } from "../core/orchestrator.js";
import { modelRouter } from "../core/router.js";

const command = "Report the current default playback volume and whether it is muted.";

async function runThroughOrchestrator(audioResult: WindowsAudioResult) {
  const originalCallLLM = modelRouter.callLLM;
  const originalWindowsExecute = agentRegistry.windows.execute;
  let plannerCalls = 0;
  let audioCalls = 0;
  let observedRequest: WindowsAudioRequest | undefined;

  modelRouter.callLLM = async (prompt) => {
    plannerCalls += 1;
    assert.ok(prompt.includes(command), "the current user request must reach the planner");
    return JSON.stringify({
      tasks: [{
        id: "read_volume",
        agent: "windows",
        action: "volume.get",
        params: {},
        dependsOn: [],
      }],
    });
  };

  const reader = async (request: WindowsAudioRequest): Promise<WindowsAudioResult> => {
    audioCalls += 1;
    observedRequest = request;
    return audioResult;
  };
  const fixtureAgent = new WindowsAgent(reader);
  agentRegistry.windows.execute = fixtureAgent.execute.bind(fixtureAgent);

  try {
    const result = await orchestrator.executeCommand({
      command,
      requestId: randomUUID(),
      source: "desktop",
    });
    return { result, plannerCalls, audioCalls, observedRequest };
  } finally {
    modelRouter.callLLM = originalCallLLM;
    agentRegistry.windows.execute = originalWindowsExecute;
  }
}

test("natural-language read-only volume request runs through planner, policy, runner and evidence verifier", async () => {
  const fixture = await runThroughOrchestrator({
    success: true,
    operation: "get",
    requested: null,
    observed: { volumePercent: 37.5, muted: false },
    device: {
      id: "fixture-default-render-device",
      flow: "render",
      role: "multimedia",
      currentDefaultId: "fixture-default-render-device",
    },
    error: null,
  });

  assert.equal(fixture.plannerCalls, 1);
  assert.equal(fixture.audioCalls, 1);
  assert.deepEqual(fixture.observedRequest, { operation: "get" });
  assert.equal(fixture.result.status, "success");
  assert.equal(fixture.result.verification?.verified, true);
  assert.equal(fixture.result.plan?.tasks.length, 1);

  const task = fixture.result.plan!.tasks[0];
  assert.equal(task.agent, "windows");
  assert.equal(task.action, "volume.get");
  assert.equal(task.status, "success");
  assert.equal(task.verification?.verified, true);
  assert.equal(task.verification?.outcome, "succeeded");
  assert.equal((task.result as any).audio.observed.volumePercent, 37.5);
  assert.equal((task.result as any).audio.observed.muted, false);
  assert.equal(task.evidence?.length, 1);
  assert.equal(task.evidence?.[0].source, "windows-audio.readback");
  assert.match(fixture.result.spokenSummary, /37\.5%/);
});

test("missing Windows audio read-back cannot be narrated as a successful status", async () => {
  const fixture = await runThroughOrchestrator({
    success: false,
    operation: "get",
    requested: null,
    observed: null,
    device: null,
    error: { code: "no_default_device", message: "No default render device is available." },
  });

  assert.equal(fixture.plannerCalls, 1);
  assert.equal(fixture.audioCalls, 1);
  assert.equal(fixture.result.status, "failed");
  assert.equal(fixture.result.verification?.verified, false);
  const task = fixture.result.plan!.tasks[0];
  assert.equal(task.status, "failed");
  assert.equal(task.verification?.verified, false);
  assert.equal((task.result as any).audio.observed, null);
  assert.match(task.error || "", /Task did not return a passing verification result/);
  assert.equal((task.result as any).audio.error.message, "No default render device is available.");
  assert.doesNotMatch(fixture.result.spokenSummary, /Playback volume is \d/);
});
