import assert from "node:assert/strict";
import { test } from "node:test";
import { extractResourceTarget, inferBrowserSearch, inferCommonActionSequence, inferExplicitBrowserNavigation, inferResourceWorkflow, inferWindowsControl, inferYouTubeSearch } from "../core/agentRouting.js";

test("routes code changes to the coding workflow", () => {
  assert.deepEqual(inferResourceWorkflow('Fix the bug in "src/example.ts" and add a regression test.'), {
    target: "src/example.ts", intent: "code",
  });
});

test("routes local HTML preview to the browser workflow", () => {
  assert.deepEqual(inferResourceWorkflow("Open index.html in the browser and inspect the layout."), {
    target: "index.html", intent: "browser",
  });
  assert.deepEqual(inferResourceWorkflow("Preview index.html in Chrome"), {
    target: "index.html", intent: "browser",
  });
});

test("routes passive data analysis to the file workflow", () => {
  assert.deepEqual(inferResourceWorkflow("Summarize reports/monthly.csv"), {
    target: "reports/monthly.csv", intent: "analysis",
  });
  assert.deepEqual(inferResourceWorkflow("Check src/service.py and explain what it does"), {
    target: "src/service.py", intent: "analysis",
  });
});

test("routes open-only project requests to the Folder Agent", () => {
  assert.deepEqual(inferResourceWorkflow("Open my Cortex project folder"), {
    target: "Cortex", intent: "open",
  });
});

test("does not hijack ordinary browser commands without a local target", () => {
  assert.equal(inferResourceWorkflow("Open Chrome and search for TypeScript tutorials"), null);
  assert.equal(extractResourceTarget("Navigate to https://example.com/index.html"), null);
});

test("the requested operation wins over the target extension", () => {
  assert.deepEqual(inferResourceWorkflow("Read src/service.py and explain what it does"), {
    target: "src/service.py", intent: "analysis",
  });
  assert.deepEqual(inferResourceWorkflow("Fix src/service.py"), {
    target: "src/service.py", intent: "code",
  });
});

test("extracts explicit YouTube search queries from natural voice commands", () => {
  assert.deepEqual(inferYouTubeSearch("Hey Vanessa, open YouTube and search for rainforest sounds."), {
    query: "rainforest sounds",
  });
  assert.deepEqual(inferYouTubeSearch("Hi Vanessa, search YouTube for lo-fi study music please"), {
    query: "lo-fi study music",
  });
  assert.deepEqual(inferYouTubeSearch("Find the official music video on YouTube"), {
    query: "the official music video",
  });
  assert.equal(inferYouTubeSearch("Open YouTube"), null);
  assert.equal(inferYouTubeSearch("Search Google for rainforest sounds"), null);
});


test("routes explicit URLs to browser navigation instead of web search", () => {
  assert.deepEqual(inferExplicitBrowserNavigation("Hey Vanessa, open https://example.com/docs?q=hello"), {
    url: "https://example.com/docs?q=hello",
  });
  assert.deepEqual(inferExplicitBrowserNavigation("Open browser, open YouTube.com"), {
    url: "https://youtube.com/",
  });
  assert.deepEqual(inferExplicitBrowserNavigation("Navigate to www.example.org/help"), {
    url: "https://www.example.org/help",
  });
  assert.equal(inferExplicitBrowserNavigation("Open Chrome"), null);
  assert.equal(inferExplicitBrowserNavigation("What is the URL for example.com?"), null);
});

test("routes explicit Google/web searches to the browser agent and preserves the query", () => {
  assert.deepEqual(inferBrowserSearch("Search Google for lo-fi & jazz + focus"), {
    query: "lo-fi & jazz + focus",
  });
  assert.deepEqual(inferBrowserSearch("Hey Vanessa, search the web for official Windows Bluetooth troubleshooting please"), {
    query: "official Windows Bluetooth troubleshooting",
  });
  assert.deepEqual(inferBrowserSearch("Google search for Windows 11 keyboard shortcuts"), {
    query: "Windows 11 keyboard shortcuts",
  });
  assert.equal(inferBrowserSearch("What is Bluetooth?"), null);
  assert.equal(inferBrowserSearch("Open https://example.com"), null);
});

test("routes single-intent Windows controls deterministically", () => {
  assert.deepEqual(inferWindowsControl("Open File Explorer"), {
    action: "app.open", params: { name: "explorer" },
  });
  assert.deepEqual(inferWindowsControl("Open Chrome"), {
    action: "app.open", params: { name: "chrome" },
  });
  assert.deepEqual(inferWindowsControl("Turn off Bluetooth"), {
    action: "bluetooth.disable", params: {},
  });
  assert.deepEqual(inferWindowsControl("Enable Bluetooth"), {
    action: "bluetooth.enable", params: {},
  });
  assert.deepEqual(inferWindowsControl("Check my Wi-Fi adapter status"), {
    action: "wifi.status", params: {},
  });
  assert.deepEqual(inferWindowsControl("Set system volume to 35 percent"), {
    action: "volume.set", params: { level: 35 },
  });
  assert.deepEqual(inferWindowsControl("Set brightness to 60 percent"), {
    action: "brightness.set", params: { level: 60 },
  });
  assert.deepEqual(inferWindowsControl("Increase brightness"), {
    action: "brightness.adjust", params: { delta: 10 },
  });
  assert.deepEqual(inferWindowsControl("Decrease brightness"), {
    action: "brightness.adjust", params: { delta: -10 },
  });
  assert.deepEqual(inferWindowsControl("Capture a screenshot of my desktop"), {
    action: "screenshot.capture", params: {},
  });
});

test("routes active-window accessibility inspection to UI Automation", () => {
  assert.deepEqual(inferWindowsControl("Inspect the active window"), {
    action: "ui.inspect", params: {},
  });
  assert.deepEqual(inferWindowsControl("List controls in the current app"), {
    action: "ui.inspect", params: {},
  });
  assert.deepEqual(inferWindowsControl("Hey Vanessa, inspect the foreground application UI controls"), {
    action: "ui.inspect", params: {},
  });
  assert.equal(inferWindowsControl("Inspect the active window and click Search"), null);
});
test("does not collapse multi-action requests into a single Windows action", () => {
  assert.equal(inferWindowsControl("Turn off Bluetooth and increase brightness"), null);
  assert.equal(inferWindowsControl("Open Chrome and search for TypeScript tutorials"), null);
});

test("explicitly negated system and browser commands do not trigger deterministic actions", () => {
  assert.equal(inferWindowsControl("Do not enable Bluetooth"), null);
  assert.equal(inferWindowsControl("Don't open Chrome"), null);
  assert.equal(inferExplicitBrowserNavigation("Don't open https://example.com"), null);
  assert.equal(inferBrowserSearch("Do not search Google for private data"), null);
  assert.equal(inferYouTubeSearch("Don't open YouTube and search for private data"), null);
});

test("multi-action browser requests do not collapse to a single navigation or search", () => {
  assert.equal(inferExplicitBrowserNavigation("Open https://example.com and then search Google for documentation"), null);
  assert.equal(inferBrowserSearch("Search Google for documentation and then open https://example.com"), null);
  assert.equal(inferYouTubeSearch("Open YouTube and search for a lo-fi playlist, then turn off Bluetooth"), null);
});

test("compound words inside a single search query remain a single browser search", () => {
  assert.deepEqual(inferBrowserSearch("Search Google for open source AI and cloud security"), {
    query: "open source AI and cloud security",
  });
  assert.deepEqual(inferYouTubeSearch("Hey Vanessa, open YouTube and search for rainforest sounds"), {
    query: "rainforest sounds",
  });
});


test("compound Windows actions are split only when every clause is recognized", () => {
  assert.deepEqual(inferCommonActionSequence("Turn off Bluetooth and increase brightness"), [
    { agent: "windows", action: "bluetooth.disable", params: {}, group: 0 },
    { agent: "windows", action: "brightness.adjust", params: { delta: 10 }, group: 0 },
  ]);
  assert.equal(inferCommonActionSequence("Turn off Bluetooth and send an email"), null);
});

test("explicit Chrome and Edge targets are fused into browser tasks", () => {
  assert.deepEqual(inferCommonActionSequence("Open Chrome and search Google for TypeScript tutorials"), [
    { agent: "browser", action: "browser.search", params: { query: "TypeScript tutorials", browser: "chrome" }, group: 0 },
  ]);
  assert.deepEqual(inferCommonActionSequence("Open Edge then open https://example.com"), [
    { agent: "browser", action: "browser.open_url", params: { url: "https://example.com/", browser: "edge" }, group: 0 },
  ]);
});

test("multi-action routing preserves sequential dependency groups", () => {
  assert.deepEqual(inferCommonActionSequence("Turn off Bluetooth and increase brightness"), [
    { agent: "windows", action: "bluetooth.disable", params: {}, group: 0 },
    { agent: "windows", action: "brightness.adjust", params: { delta: 10 }, group: 0 },
  ]);
  assert.deepEqual(inferCommonActionSequence("Turn off Bluetooth then increase brightness"), [
    { agent: "windows", action: "bluetooth.disable", params: {}, group: 0 },
    { agent: "windows", action: "brightness.adjust", params: { delta: 10 }, group: 1 },
  ]);
});

test("explicit YouTube single intents keep their specialized direct route", () => {
  assert.equal(inferCommonActionSequence("Open YouTube and search for rainforest sounds"), null);
  assert.deepEqual(inferYouTubeSearch("Open YouTube and search for rainforest sounds"), { query: "rainforest sounds" });
});
