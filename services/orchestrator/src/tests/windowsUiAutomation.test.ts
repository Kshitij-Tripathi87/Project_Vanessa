import assert from "node:assert/strict";
import { test } from "node:test";
import type { runPowerShell } from "../agents/powershell.js";
import {
  inspectForegroundWindow,
  invokeForegroundControl,
  type UiAutomationClickRequest,
} from "../agents/windows-ui-automation.js";

function runnerFor(stdout: string, inspect?: (script: string, values: Record<string, string>, timeout: number) => void) {
  return (async (script: string, values: Record<string, string> = {}, timeout = 5000) => {
    inspect?.(script, values, timeout);
    return { stdout, stderr: "" };
  }) as unknown as typeof runPowerShell;
}

const inspectionPayload = JSON.stringify({
  success: true,
  windowTitle: "Settings",
  windowHandle: "123456",
  processId: 3210,
  controls: [
    {
      name: "Bluetooth",
      automationId: "BluetoothToggle",
      controlType: "ControlType.Button",
      className: "Button",
      isEnabled: true,
      isOffscreen: false,
      depth: 4,
    },
  ],
  truncated: false,
  valuesRead: false,
});

test("foreground inspection returns bounded accessibility metadata without input values", async () => {
  let scriptSeen = "";
  const result = await inspectForegroundWindow(runnerFor(inspectionPayload, (script) => { scriptSeen = script; }));
  assert.equal(result.success, true);
  assert.equal(result.windowTitle, "Settings");
  assert.equal(result.windowHandle, "123456");
  assert.equal(result.processId, 3210);
  assert.equal(result.controls?.length, 1);
  assert.equal(result.controls?.[0].automationId, "BluetoothToggle");
  assert.equal(result.valuesRead, false);
  assert.equal(result.truncated, false);
  assert.match(scriptSeen, /GetForegroundWindow/);
  assert.match(scriptSeen, /ControlViewWalker/);
  assert.doesNotMatch(scriptSeen, /ValuePattern/);
  assert.doesNotMatch(scriptSeen, /GetCurrentPattern\(.*ValuePattern/);
});

test("foreground inspection caps the returned controls at 120", async () => {
  const controls = Array.from({ length: 130 }, (_, index) => ({
    name: "Control " + index,
    automationId: "control_" + index,
    controlType: "ControlType.Button",
    className: "Button",
    isEnabled: true,
    isOffscreen: false,
    depth: 1,
  }));
  const payload = JSON.stringify({
    success: true,
    windowTitle: "Demo",
    windowHandle: "9876",
    processId: 55,
    controls,
    truncated: true,
    valuesRead: false,
  });
  const result = await inspectForegroundWindow(runnerFor(payload));
  assert.equal(result.controls?.length, 120);
  assert.equal(result.truncated, true);
});

test("malformed UI Automation JSON is rejected rather than treated as an empty window", async () => {
  await assert.rejects(() => inspectForegroundWindow(runnerFor("not-json")), /malformed JSON/i);
});

test("control invocation refuses a missing or non-numeric inspected window handle", async () => {
  let calls = 0;
  const runner = runnerFor("{}", () => { calls++; });
  const base: UiAutomationClickRequest = {
    windowHandle: "not-a-handle",
    expectedWindowTitle: "Settings",
    expectedProcessId: 3210,
    automationId: "BluetoothToggle",
  };
  const result = await invokeForegroundControl(runner, base);
  assert.equal(result.success, false);
  assert.match(result.error || "", /windowHandle/i);
  assert.equal(calls, 0);
});

test("control invocation passes exact inspected window identity and selector to the fixed PowerShell script", async () => {
  let scriptSeen = "";
  let valuesSeen: Record<string, string> = {};
  const payload = JSON.stringify({
    success: true,
    windowTitle: "Settings",
    processId: 3210,
    invocationAccepted: true,
    postClickStateVerified: false,
    control: {
      name: "Bluetooth",
      automationId: "BluetoothToggle",
      controlType: "ControlType.Button",
      className: "Button",
    },
    message: "Invocation returned. State not independently verified.",
  });
  const result = await invokeForegroundControl(
    runnerFor(payload, (script, values) => { scriptSeen = script; valuesSeen = values; }),
    {
      windowHandle: "123456",
      expectedWindowTitle: "Settings",
      expectedProcessId: 3210,
      automationId: "BluetoothToggle",
    },
  );
  assert.equal(result.success, true);
  assert.equal(result.invocationAccepted, true);
  assert.equal(result.postClickStateVerified, false);
  assert.equal(valuesSeen.VANESSA_UI_WINDOW_HANDLE, "123456");
  assert.equal(valuesSeen.VANESSA_UI_EXPECTED_WINDOW_TITLE, "Settings");
  assert.equal(valuesSeen.VANESSA_UI_EXPECTED_PROCESS_ID, "3210");
  assert.equal(valuesSeen.VANESSA_UI_AUTOMATION_ID, "BluetoothToggle");
  assert.match(scriptSeen, /GetWindowThreadProcessId/);
  assert.match(scriptSeen, /AutomationId/);
  assert.match(scriptSeen, /InvokePattern/);
  assert.doesNotMatch(scriptSeen, /SendKeys/);
  assert.doesNotMatch(scriptSeen, /SetCursorPos/);
});

test("control invocation requires an exact selector instead of guessing", async () => {
  let calls = 0;
  const runner = runnerFor("{}", () => { calls++; });
  const result = await invokeForegroundControl(runner, {
    windowHandle: "123456",
    expectedWindowTitle: "Settings",
    expectedProcessId: 3210,
  });
  assert.equal(result.success, false);
  assert.match(result.error || "", /selector/i);
  assert.equal(calls, 0);
});

test("ambiguous or unavailable UI control results stay failures and are not upgraded", async () => {
  const result = await invokeForegroundControl(
    runnerFor(JSON.stringify({
      success: false,
      error: "The selector matched more than one control.",
      matches: [
        { name: "Search", automationId: "Search1", controlType: "ControlType.Button" },
        { name: "Search", automationId: "Search2", controlType: "ControlType.Button" },
      ],
    })),
    {
      windowHandle: "123456",
      expectedWindowTitle: "Settings",
      expectedProcessId: 3210,
      name: "Search",
      controlType: "ControlType.Button",
    },
  );
  assert.equal(result.success, false);
  assert.match(result.error || "", /more than one/i);
  assert.equal(result.invocationAccepted, undefined);
});
