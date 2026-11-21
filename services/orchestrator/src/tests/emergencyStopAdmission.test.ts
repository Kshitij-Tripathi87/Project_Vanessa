import assert from "node:assert/strict";
import { test } from "node:test";
import { orchestrator } from "../core/orchestrator.js";
import { engageKillSwitch, isKillSwitchActive } from "../core/taskRunner.js";
import { modelRouter } from "../core/router.js";

test("new commands are rejected throughout the emergency-stop window", async () => {
  const original = modelRouter.callLLM;
  let plannerCalls = 0;
  modelRouter.callLLM = async () => {
    plannerCalls += 1;
    return JSON.stringify({ tasks: [] });
  };

  engageKillSwitch();
  try {
    assert.equal(isKillSwitchActive(), true);
    const result = await orchestrator.executeCommand({
      command: "Check system status",
      requestId: "blocked-during-emergency-stop",
    });
    assert.equal(result.status, "failed");
    assert.match(result.spokenSummary, /Emergency stop is active/);
    assert.equal(result.plan, undefined);
    assert.equal(plannerCalls, 0);
    assert.equal(isKillSwitchActive(), true);
  } finally {
    modelRouter.callLLM = original;
  }
});
