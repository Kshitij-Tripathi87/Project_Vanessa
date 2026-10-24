import assert from "node:assert/strict";
import { test } from "node:test";
import { WindowsAgent } from "../agents/windows.agent.js";
import type { runPowerShell } from "../agents/powershell.js";

const deniedPowerShell = (async () => {
  throw new Error("access denied by test adapter");
}) as unknown as typeof runPowerShell;

const outputPowerShell = (stdout: string) => (async () => ({
  stdout,
  stderr: "",
})) as unknown as typeof runPowerShell;

test("Wi-Fi restart errors are failures, not optimistic success", async () => {
  const agent = new WindowsAgent({ runPowerShell: deniedPowerShell, fakeMode: false });
  const result = await agent.execute("wifi.restart_adapter", {});
  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.equal(result.verification?.passed, false);
  assert.deepEqual(result.evidence, []);
  assert.match(result.summary || "", /failed/i);
  assert.match(result.spokenSummary, /could not restart/i);
});

test("Wi-Fi status reports the observed adapter state", async () => {
  const agent = new WindowsAgent({ runPowerShell: outputPowerShell("Up\n"), fakeMode: false });
  const result = await agent.execute("wifi.status", {});
  assert.equal(result.success, true);
  assert.equal(result.status, "completed");
  assert.equal((result.data as { status: string }).status, "Up");
  assert.equal(result.verification?.passed, true);
});

test("Wi-Fi status errors cannot be reported as connected", async () => {
  const agent = new WindowsAgent({ runPowerShell: deniedPowerShell, fakeMode: false });
  const result = await agent.execute("wifi.status", {});
  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.equal((result.data as { status: string }).status, "Unknown");
  assert.equal(result.verification?.passed, false);
});

test("Bluetooth failures return a failure rather than the requested state", async () => {
  const agent = new WindowsAgent({ runPowerShell: deniedPowerShell, fakeMode: false });
  const result = await agent.execute("bluetooth.enable", {});
  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.equal((result.data as { state: string }).state, "unknown");
  assert.equal(result.verification?.passed, false);
  assert.deepEqual(result.evidence, []);
});

test("volume rejects out-of-range values without touching Windows", async () => {
  let calls = 0;
  const runner = (async () => { calls++; return { stdout: "", stderr: "" }; }) as unknown as typeof runPowerShell;
  const agent = new WindowsAgent({ runPowerShell: runner, fakeMode: false });
  const result = await agent.execute("volume.set", { level: 140 });
  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.equal(calls, 0);
  assert.equal(result.verification?.passed, false);
});

test("volume uses a successful Core Audio read-back as verification evidence", async () => {
  const agent = new WindowsAgent({
    runPowerShell: outputPowerShell('{"Requested":0.35,"Observed":0.35}'),
    fakeMode: false,
  });
  const result = await agent.execute("volume.set", { level: 35 });
  assert.equal(result.success, true);
  assert.equal(result.status, "completed");
  assert.equal(result.verification?.passed, true);
  assert.equal((result.data as { readBackVerified: boolean }).readBackVerified, true);
  assert.equal((result.data as { actualObservedLevel: number }).actualObservedLevel, 35);
  assert.match(result.summary || "", /35%/);
  assert.equal(result.evidence?.[0]?.source, "Windows Core Audio master-volume read-back");
});

test("volume provider errors are propagated and never silently successful", async () => {
  const agent = new WindowsAgent({ runPowerShell: deniedPowerShell, fakeMode: false });
  const result = await agent.execute("volume.set", { level: 30 });
  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.match(result.summary || "", /failed/i);
  assert.equal(result.verification?.passed, false);
});

test("close-app errors are failures instead of false success", async () => {
  const agent = new WindowsAgent({ runPowerShell: deniedPowerShell, fakeMode: false });
  const result = await agent.execute("app.close", { name: "notepad" });
  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.match(result.spokenSummary, /could not verify/i);
});

test("screenshot failure has no success artifact", async () => {
  const agent = new WindowsAgent({ runPowerShell: deniedPowerShell, fakeMode: false });
  const result = await agent.execute("screenshot.capture", {});
  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(result.evidence, []);
  assert.match(result.spokenSummary, /could not capture/i);
});

test("brightness is successful only when WMI read-back matches the requested value", async () => {
  const agent = new WindowsAgent({
    runPowerShell: outputPowerShell('{"Current":40,"Target":60,"Observed":[60],"AllMatch":true}'),
    fakeMode: false,
  });
  const result = await agent.execute("brightness.set", { level: 60 });
  assert.equal(result.success, true);
  assert.equal(result.status, "completed");
  assert.equal(result.verification?.passed, true);
  assert.equal((result.data as { actualObservedLevel: number }).actualObservedLevel, 60);
  assert.equal((result.data as { readBackVerified: boolean }).readBackVerified, true);
});

test("brightness read-back mismatch is a failure", async () => {
  const agent = new WindowsAgent({
    runPowerShell: outputPowerShell('{"Current":40,"Target":60,"Observed":[58],"AllMatch":false}'),
    fakeMode: false,
  });
  const result = await agent.execute("brightness.set", { level: 60 });
  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.equal(result.verification?.passed, false);
  assert.match(result.summary || "", /not verified/i);
  assert.deepEqual(result.evidence, []);
});

test("brightness rejects invalid percentages without invoking Windows", async () => {
  let calls = 0;
  const runner = (async () => { calls++; return { stdout: "", stderr: "" }; }) as unknown as typeof runPowerShell;
  const agent = new WindowsAgent({ runPowerShell: runner, fakeMode: false });
  const result = await agent.execute("brightness.set", { level: 120 });
  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.equal(calls, 0);
});

test("FAKE mode never executes Windows actions and marks them as simulated partial results", async () => {
  let calls = 0;
  const runner = (async () => { calls++; throw new Error("must not call Windows"); }) as unknown as typeof runPowerShell;
  const agent = new WindowsAgent({ runPowerShell: runner, fakeMode: true });
  const result = await agent.execute("bluetooth.disable", {});
  assert.equal(calls, 0);
  assert.equal(result.success, true);
  assert.equal(result.status, "partial");
  assert.equal(result.verification?.passed, false);
  assert.equal((result.data as { simulated: boolean }).simulated, true);
  assert.equal((result.data as { actualStateChanged: boolean }).actualStateChanged, false);
  assert.match(result.spokenSummary, /simulated for testing/i);
});


test("ui.inspect returns bounded foreground-window controls and redacts sensitive text", async () => {
  const payload = JSON.stringify({
    success: true,
    windowTitle: "Settings for user@example.com",
    windowHandle: "123456",
    processId: 3210,
    controls: [{
      name: "Contact user@example.com",
      automationId: "contactControl",
      controlType: "ControlType.Button",
      className: "Button",
      isEnabled: true,
      isOffscreen: false,
      depth: 2,
    }],
    truncated: false,
    valuesRead: false,
  });
  const agent = new WindowsAgent({ runPowerShell: outputPowerShell(payload), fakeMode: false });
  const result = await agent.execute("ui.inspect", {});
  const data = result.data as { windowTitle: string; windowHandle: string; processId: number; controls: { name: string }[]; valuesRead: boolean };
  assert.equal(result.success, true);
  assert.equal(result.status, "completed");
  assert.equal(data.windowHandle, "123456");
  assert.equal(data.processId, 3210);
  assert.equal(data.valuesRead, false);
  assert.match(data.windowTitle, /REDACTED_EMAIL/);
  assert.match(data.controls[0].name, /REDACTED_EMAIL/);
  assert.match(result.spokenSummary, /did not read input-field values/i);
  assert.equal(result.verification?.passed, true);
});

test("ui.inspect rejects incomplete foreground-window identity", async () => {
  const agent = new WindowsAgent({
    runPowerShell: outputPowerShell(JSON.stringify({
      success: true, windowTitle: "", windowHandle: "123456", processId: 3210, controls: [],
    })),
    fakeMode: false,
  });
  const result = await agent.execute("ui.inspect", {});
  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.equal(result.verification?.passed, false);
  assert.deepEqual(result.evidence, []);
});

test("ui.click reports invocation acceptance without claiming a verified screen effect", async () => {
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
  const agent = new WindowsAgent({ runPowerShell: outputPowerShell(payload), fakeMode: false });
  const result = await agent.execute("ui.click", {
    windowHandle: "123456",
    expectedWindowTitle: "Settings",
    expectedProcessId: 3210,
    automationId: "BluetoothToggle",
  });
  const data = result.data as { invocationAccepted: boolean; postClickStateVerified: boolean };
  assert.equal(result.success, true);
  assert.equal(result.status, "partial");
  assert.equal(data.invocationAccepted, true);
  assert.equal(data.postClickStateVerified, false);
  assert.equal(result.verification?.passed, false);
  assert.match(result.spokenSummary, /not independently verified/i);
});

test("ui.click rejects an ambiguous selector and does not claim success", async () => {
  const payload = JSON.stringify({
    success: false,
    error: "The selector matched more than one control.",
    matches: [
      { name: "Search", automationId: "Search1", controlType: "ControlType.Button" },
      { name: "Search", automationId: "Search2", controlType: "ControlType.Button" },
    ],
  });
  const agent = new WindowsAgent({ runPowerShell: outputPowerShell(payload), fakeMode: false });
  const result = await agent.execute("ui.click", {
    windowHandle: "123456",
    expectedWindowTitle: "Settings",
    expectedProcessId: 3210,
    name: "Search",
    controlType: "ControlType.Button",
  });
  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.equal(result.verification?.passed, false);
  assert.deepEqual(result.evidence, []);
  assert.match(result.spokenSummary, /did not fall back to coordinates/i);
});

test("FAKE mode never invokes Windows UI Automation", async () => {
  let calls = 0;
  const runner = (async () => { calls++; throw new Error("Windows API must not be called in fake mode"); }) as unknown as typeof runPowerShell;
  const agent = new WindowsAgent({ runPowerShell: runner, fakeMode: true });
  const result = await agent.execute("ui.inspect", {});
  assert.equal(calls, 0);
  assert.equal(result.success, true);
  assert.equal(result.status, "partial");
  assert.equal(result.verification?.passed, false);
  assert.equal((result.data as { simulated: boolean }).simulated, true);
  assert.equal((result.data as { actualStateChanged: boolean }).actualStateChanged, false);
});
