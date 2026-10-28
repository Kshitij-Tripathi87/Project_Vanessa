import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inferBrowserSearch,
  inferExplicitBrowserNavigation,
  inferWindowsControl,
  inferYouTubeSearch,
} from "../core/agentRouting.js";

test("a concrete destination resolves to browser navigation, not search", () => {
  assert.deepEqual(inferExplicitBrowserNavigation("Hey Vanessa, open https://example.com/docs?q=browser"), {
    url: "https://example.com/docs?q=browser",
  });
  assert.equal(inferBrowserSearch("Hey Vanessa, open https://example.com/docs?q=browser"), null);
});

test("explicit Google search resolves to browser.search and preserves the exact query", () => {
  assert.deepEqual(inferBrowserSearch("Search Google for lo-fi & jazz + focus"), {
    query: "lo-fi & jazz + focus",
  });
  assert.equal(inferExplicitBrowserNavigation("Search Google for lo-fi & jazz + focus"), null);
});

test("YouTube's specialized search route remains distinct from general web search", () => {
  assert.deepEqual(inferYouTubeSearch("Hey Vanessa, open YouTube and search for rainforest sounds"), {
    query: "rainforest sounds",
  });
  assert.equal(inferBrowserSearch("Hey Vanessa, open YouTube and search for rainforest sounds"), null);
});

test("common Windows controls resolve to reviewed action names and parameters", () => {
  assert.deepEqual(inferWindowsControl("Open File Explorer"), {
    action: "app.open", params: { name: "explorer" },
  });
  assert.deepEqual(inferWindowsControl("Turn off Bluetooth"), {
    action: "bluetooth.disable", params: {},
  });
  assert.deepEqual(inferWindowsControl("Set brightness to 60 percent"), {
    action: "brightness.set", params: { level: 60 },
  });
  assert.deepEqual(inferWindowsControl("Increase brightness"), {
    action: "brightness.adjust", params: { delta: 10 },
  });
});
