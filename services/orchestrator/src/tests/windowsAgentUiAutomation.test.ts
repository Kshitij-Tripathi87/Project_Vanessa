import assert from "node:assert/strict";
import { test } from "node:test";
import { WindowsAgent } from "../agents/windows.agent.js";

test("ui.inspect returns bounded foreground-window evidence and never claims values were read", async () => {
  const agent = new WindowsAgent(undefined, undefined, async () => ({
    success: true, windowTitle: "Settings", windowHandle: "123", processId: 42,
    controls: [{ name: "Network", automationId: "network", controlType: "ControlType.Button", className: "Button", isEnabled: true, isOffscreen: false, depth: 1 }],
    truncated: false, valuesRead: false,
  }), async () => ({ success: false, error: "not used" }));
  const result = await agent.execute("ui.inspect", {});
  const data = result.data as Record<string, unknown>;
  assert.equal(result.success, true);
  assert.equal(data.valuesRead, false);
  assert.equal(data.windowHandle, "123");
  assert.equal(result.verification?.passed, true);
});

test("ui.click separates accepted InvokePattern invocation from unverified visual state", async () => {
  let seenRequest: { windowHandle?: string } | undefined;
  const agent = new WindowsAgent(undefined, undefined, async () => ({ success: false, error: "not used" }), async (request) => {
    seenRequest = request;
    return { success: true, windowTitle: "Settings", processId: 42, invocationAccepted: true, postClickStateVerified: false, message: "InvokePattern accepted" };
  });
  const result = await agent.execute("ui.click", {
    windowHandle: "123", expectedWindowTitle: "Settings", expectedProcessId: 42,
    automationId: "network", controlType: "ControlType.Button",
  });
  const data = result.data as Record<string, unknown>;
  assert.equal(result.success, true);
  assert.equal(seenRequest?.windowHandle, "123");
  assert.equal(result.verification?.passed, false);
  assert.equal(data.postClickStateVerified, false);
});
