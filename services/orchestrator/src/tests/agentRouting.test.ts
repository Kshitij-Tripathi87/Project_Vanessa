import assert from "node:assert/strict";
import { test } from "node:test";
import { extractResourceTarget, inferResourceWorkflow, inferYouTubeSearch } from "../core/agentRouting.js";

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

