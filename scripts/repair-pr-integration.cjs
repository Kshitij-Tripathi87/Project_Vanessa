#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const targetSnapshot = process.argv[2];
if (!targetSnapshot) throw new Error("Usage: node scripts/repair-pr-integration.cjs <target-snapshot-sha>");

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error("git " + args.join(" ") + " failed: " + String(result.stderr || result.stdout || result.error || "").trim());
  }
  return String(result.stdout || "").trim();
}
function restoreTarget(paths) {
  git(["restore", "--source", targetSnapshot, "--staged", "--worktree", "--", ...paths]);
}
function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");
}
function write(relative, content) {
  fs.writeFileSync(path.join(root, relative), content, "utf8");
}
function replaceOnce(content, needle, replacement, label) {
  const first = content.indexOf(needle);
  if (first < 0) throw new Error("Could not find expected source anchor for " + label);
  if (content.indexOf(needle, first + needle.length) >= 0) throw new Error("Source anchor is ambiguous for " + label);
  return content.slice(0, first) + replacement + content.slice(first + needle.length);
}

// Keep the electron/main/preload bridge aligned with the target's existing compact orb shell.
// The old Control Deck branch was based on a different IPC contract.
restoreTarget([
  "apps/desktop/src/main/index.ts",
  "apps/desktop/src/main/ipc.ts",
  "apps/desktop/src/preload/index.ts",
  "apps/desktop/src/renderer/main.tsx",
  "apps/desktop/src/renderer/vanessa.d.ts",
  "apps/desktop/src/renderer/index.css",
  "services/orchestrator/src/agents/windows.agent.ts",
  "services/orchestrator/src/agents/agentCatalog.ts",
  "services/orchestrator/src/agents/memory.agent.ts",
  "services/orchestrator/src/tests/agentCatalog.test.ts",
  "services/orchestrator/src/core/planner.ts",
  "services/orchestrator/src/core/taskRunner.ts",
  "services/orchestrator/src/core/permissionGuard.ts"
]);

// Browser automation imports Playwright at runtime; declare the dependency instead of shipping
// uncompilable code that relies on an undeclared, transitive package.
const packagePath = "services/orchestrator/package.json";
const packageJson = JSON.parse(read(packagePath));
packageJson.dependencies = packageJson.dependencies || {};
if (!packageJson.dependencies.playwright) packageJson.dependencies.playwright = "^1.40.0";
write(packagePath, JSON.stringify(packageJson, null, 2) + "\n");

// Wire the new bounded foreground-window automation module into the current typed WindowsAgent.
// The UI module never reads text-field values and validates window identity and unique visible controls.
const agentPath = "services/orchestrator/src/agents/windows.agent.ts";
let agent = read(agentPath);
agent = replaceOnce(
  agent,
  'import { runPowerShell } from "./powershell.js";',
  'import { runPowerShell } from "./powershell.js";\nimport { inspectForegroundWindow, invokeForegroundControl, type ForegroundWindowInspection, type UiAutomationClickRequest, type UiAutomationClickResult } from "./windows-ui-automation.js";',
  "WindowsAgent UI Automation import"
);
agent = replaceOnce(
  agent,
  '    private readonly control: (request: WindowsControlRequest) => Promise<WindowsControlResult> = executeWindowsControl,\n  ) {}',
  '    private readonly control: (request: WindowsControlRequest) => Promise<WindowsControlResult> = executeWindowsControl,\n' +
  '    private readonly inspectForeground: () => Promise<ForegroundWindowInspection> = () => inspectForegroundWindow(runPowerShell),\n' +
  '    private readonly invokeForeground: (request: UiAutomationClickRequest) => Promise<UiAutomationClickResult> = (request) => invokeForegroundControl(runPowerShell, request),\n' +
  '  ) {}',
  "WindowsAgent injectable UI Automation adapters"
);
agent = replaceOnce(
  agent,
  '    "screenshot_capture",\n  ];',
  '    "screenshot_capture",\n    "ui_inspection",\n    "ui_control_invocation",\n  ];',
  "WindowsAgent UI capabilities"
);
agent = replaceOnce(
  agent,
  '    "process_control",\n  ];',
  '    "process_control",\n    "windows_ui_automation",\n  ];',
  "WindowsAgent UI tool permission"
);
const uiCases = [
'      case "ui.inspect":',
'      case "windows.ui_inspect": {',
'        const result = await this.inspectForeground();',
'        const controls = Array.isArray(result.controls) ? result.controls : [];',
'        const verified = result.success === true && result.valuesRead === false;',
'        const title = typeof result.windowTitle === "string" && result.windowTitle ? result.windowTitle : "the foreground window";',
'        const summary = verified',
'          ? "Inspected " + title + " and found " + controls.length + " accessible controls. Input-field values were not read."',
'          : "Foreground-window inspection was not verified: " + (result.error || "Windows returned incomplete inspection data") + ".";',
'        return {',
'          agentId: this.id,',
'          status: verified ? "completed" : "failed",',
'          success: verified,',
'          summary,',
'          spokenSummary: summary,',
'          evidence: verified ? [{ description: summary, source: "windows-ui-automation.inspect", timestamp: startTime, confidence: 1, data: result }] : [],',
'          artifacts: [],',
'          verification: { passed: verified, details: summary },',
'          data: {',
'            outcome: verified ? "succeeded" : "failed",',
'            windowTitle: result.windowTitle,',
'            windowHandle: result.windowHandle,',
'            processId: result.processId,',
'            controls,',
'            truncated: result.truncated === true,',
'            valuesRead: result.valuesRead,',
'            actionsAttempted: ["Inspect foreground UI Automation Control View"],',
'            actualObservations: summary,',
'            failures: verified ? [] : [result.error || "UI Automation inspection was not verified"],',
'          },',
'        };',
'      }',
'',
'      case "ui.click":',
'      case "windows.ui_click": {',
'        const request: UiAutomationClickRequest = {',
'          windowHandle: typeof params.windowHandle === "string" ? params.windowHandle : "",',
'          expectedWindowTitle: typeof params.expectedWindowTitle === "string" ? params.expectedWindowTitle : "",',
'          expectedProcessId: Number(params.expectedProcessId),',
'          ...(typeof params.automationId === "string" && params.automationId ? { automationId: params.automationId } : {}),',
'          ...(typeof params.name === "string" && params.name ? { name: params.name } : {}),',
'          ...(typeof params.controlType === "string" && params.controlType ? { controlType: params.controlType } : {}),',
'        };',
'        const result = await this.invokeForeground(request);',
'        const accepted = result.success === true && result.invocationAccepted === true;',
'        const summary = accepted',
'          ? "Windows accepted the UI Automation invoke request. The resulting visual state was not independently verified."',
'          : "UI Automation invocation failed: " + (result.error || result.message || "the target control was not uniquely and safely invokable") + ".";',
'        return {',
'          agentId: this.id,',
'          status: accepted ? "completed" : "failed",',
'          success: accepted,',
'          summary,',
'          spokenSummary: summary,',
'          evidence: [{ description: summary, source: "windows-ui-automation.invoke", timestamp: startTime, confidence: accepted ? 1 : 0, data: { request, result } }],',
'          artifacts: [],',
'          verification: { passed: accepted && result.postClickStateVerified === true, details: summary },',
'          data: {',
'            outcome: accepted ? "invocation_accepted" : "failed",',
'            invocationAccepted: accepted,',
'            postClickStateVerified: result.postClickStateVerified === true,',
'            actionsAttempted: ["Invoke UI Automation control"],',
'            actualObservations: summary,',
'            failures: accepted ? [] : [result.error || result.message || "UI Automation invocation was not accepted"],',
'            control: result.control,',
'            matches: result.matches,',
'          },',
'        };',
'      }',
'',
];
const switchAnchor = '    switch (action) {';
agent = replaceOnce(agent, switchAnchor, switchAnchor + "\n" + uiCases.join("\n"), "WindowsAgent UI action cases");
write(agentPath, agent);

// Keep the reviewed target catalog as the source of truth; add only the two bounded UI Automation
// operations introduced by this integration, so stale branch catalog changes cannot replace it.
const catalogPath = "services/orchestrator/src/agents/agentCatalog.ts";
let catalog = read(catalogPath);
const screenshotAction = '      action("screenshot.capture", "Capture the primary Windows screen to a temporary PNG.", {}, "AgentResult with data.path and artifact path, or failure."),';
const uiActions = [
  '      action("ui.inspect", "Inspect the foreground window and bounded accessible control metadata without reading input-field values.", {}, "Verified window identity and at most 120 control descriptors; input values are not read.", "low", true, ["windows_ui_automation"]),',
  '      action("ui.click", "Invoke a uniquely identified accessible foreground-window control only when its inspected window identity still matches.", {',
  '        windowHandle: p("string", "Handle from a recent ui.inspect result.", true),',
  '        expectedWindowTitle: p("string", "Exact inspected foreground-window title.", true),',
  '        expectedProcessId: p("number", "Process ID from the same inspection.", true),',
  '        automationId: p("string", "Exact inspected AutomationId when available."),',
  '        name: p("string", "Exact inspected accessible control name when no AutomationId is available."),',
  '        controlType: p("string", "Exact inspected control type."),',
  '      }, "Reports whether InvokePattern was accepted; does not claim a visual postcondition without independent verification.", "high", true, ["windows_ui_automation"]),'
].join("\n");
if (!catalog.includes(screenshotAction)) throw new Error("Reviewed Windows catalog screenshot action anchor missing");
if (!catalog.includes('action("ui.inspect"')) {
  catalog = replaceOnce(catalog, screenshotAction, screenshotAction + "\n" + uiActions, "Windows UI Automation catalog actions");
  write(catalogPath, catalog);
}

// Keep the Control Deck component's standalone type contract without restoring its old app shell.
const dtsPath = "apps/desktop/src/renderer/vanessa.d.ts";
let dts = read(dtsPath);
if (!dts.includes("interface VanessaControlStatus")) {
  dts = replaceOnce(
    dts,
    "declare global {",
    "declare global {\n  interface VanessaControlStatus {\n" +
      "    success: boolean;\n" +
      "    orchestratorOnline: boolean;\n" +
      "    orchestratorPort: number;\n" +
      "    activeTasksCount: number;\n" +
      "    platform: string;\n" +
      "    autonomousMode?: boolean;\n" +
      "    allowedFolders: string[];\n" +
      "    checkedAt: number;\n" +
      "    errors: string[];\n" +
      "  }\n",
    "Control Deck status type"
  );
  write(dtsPath, dts);
}

// Add focused integration tests for the action handler contract using injected adapters.
// Existing lower-level tests continue to cover the real PowerShell script constraints.
const testPath = "services/orchestrator/src/tests/windowsAgentUiAutomation.test.ts";
const testLines = [
'import assert from "node:assert/strict";',
'import { test } from "node:test";',
'import { WindowsAgent } from "../agents/windows.agent.js";',
'',
'test("ui.inspect returns bounded foreground-window evidence and never claims values were read", async () => {',
'  const agent = new WindowsAgent(undefined, undefined, async () => ({',
'    success: true, windowTitle: "Settings", windowHandle: "123", processId: 42,',
'    controls: [{ name: "Network", automationId: "network", controlType: "ControlType.Button", className: "Button", isEnabled: true, isOffscreen: false, depth: 1 }],',
'    truncated: false, valuesRead: false,',
'  }), async () => ({ success: false, error: "not used" }));',
'  const result = await agent.execute("ui.inspect", {});',
'  const data = result.data as Record<string, unknown>;',
'  assert.equal(result.success, true);',
'  assert.equal(data.valuesRead, false);',
'  assert.equal(data.windowHandle, "123");',
'  assert.equal(result.verification?.passed, true);',
'});',
'',
'test("ui.click separates accepted InvokePattern invocation from unverified visual state", async () => {',
'  let seenRequest: { windowHandle?: string } | undefined;',
'  const agent = new WindowsAgent(undefined, undefined, async () => ({ success: false, error: "not used" }), async (request) => {',
'    seenRequest = request;',
'    return { success: true, windowTitle: "Settings", processId: 42, invocationAccepted: true, postClickStateVerified: false, message: "InvokePattern accepted" };',
'  });',
'  const result = await agent.execute("ui.click", {',
'    windowHandle: "123", expectedWindowTitle: "Settings", expectedProcessId: 42,',
'    automationId: "network", controlType: "ControlType.Button",',
'  });',
'  const data = result.data as Record<string, unknown>;',
'  assert.equal(result.success, true);',
'  assert.equal(seenRequest?.windowHandle, "123");',
'  assert.equal(result.verification?.passed, false);',
'  assert.equal(data.postClickStateVerified, false);',
'});',
'',
];
write(testPath, testLines.join("\n"));
git(["add", "--", packagePath, agentPath, testPath]);
console.log("[OK] Restored current desktop/agent contracts, declared Playwright, wired safe foreground UI actions, and staged focused tests.");
