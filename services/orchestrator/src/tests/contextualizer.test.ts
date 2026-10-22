import assert from "node:assert/strict";
import { contextualizeBrowserRequest, contextualizeRequest, extractExplicitHttpUrl, isYouTubeWatchUrl } from "../core/contextualizer.js";

const cases: Array<{ name: string; run: () => void }> = [
  {
    name: "preserves an exact HTTP URL and path/query",
    run: () => {
      const url = "https://example.com/path?q=1";
      const context = contextualizeBrowserRequest(`Please open this link: ${url}`);
      assert.equal(context.kind, "exact_url");
      if (context.kind !== "exact_url") return;
      assert.equal(context.url, url);
      assert.equal(context.canShortCircuit, true);
      assert.equal(context.conflictingIntent, false);
      assert.equal(context.play, false);
    },
  },
  {
    name: "exact YouTube watch URL with play intent opens direct video",
    run: () => {
      const url = "https://www.youtube.com/watch?v=abc123";
      const context = contextualizeBrowserRequest(`Play this video: ${url}`);
      assert.equal(context.kind, "exact_url");
      if (context.kind !== "exact_url") return;
      assert.equal(context.url, url);
      assert.equal(context.play, true);
    },
  },
  {
    name: "open YouTube means home page",
    run: () => {
      assert.deepEqual(contextualizeBrowserRequest("Hey Vanessa, open YouTube"), { kind: "youtube_home" });
    },
  },
  {
    name: "YouTube search is distinct from play",
    run: () => {
      assert.deepEqual(contextualizeBrowserRequest("Search YouTube for lo-fi music"), { kind: "youtube_search", query: "lo-fi music" });
    },
  },
  {
    name: "composite open YouTube then search resolves to search intent",
    run: () => {
      assert.deepEqual(contextualizeBrowserRequest("Open YouTube and search for lo-fi music"), { kind: "youtube_search", query: "lo-fi music" });
    },
  },
  {
    name: "video request defaults to YouTube when no other platform is named",
    run: () => {
      assert.deepEqual(contextualizeBrowserRequest("Find and play a video about Python async"), { kind: "youtube_play", query: "Python async" });
    },
  },
  {
    name: "mentions of YouTube inside a Google query do not change the target platform",
    run: () => {
      assert.deepEqual(contextualizeBrowserRequest("Search Google for YouTube video resolution"), { kind: "web_search", query: "YouTube video resolution", engine: "google" });
    },
  },
  {
    name: "explicitly compound URL command is not short-circuited",
    run: () => {
      const url = "https://example.com";
      const context = contextualizeBrowserRequest(`Open ${url} and create a folder`);
      assert.equal(context.kind, "exact_url");
      if (context.kind !== "exact_url") return;
      assert.equal(context.canShortCircuit, false);
      assert.equal(context.conflictingIntent, false);
    },
  },
  {
    name: "non-HTTP schemes are never accepted as explicit URLs",
    run: () => {
      assert.equal(extractExplicitHttpUrl("Open javascript:alert(1)"), undefined);
      assert.equal(contextualizeBrowserRequest("Open javascript:alert(1)").kind, "none");
    },
  },
  {
    name: "incident requests produce multiple relevant agent domains",
    run: () => {
      const context = contextualizeRequest("Investigate why checkout is failing; check the logs, runbook, code changes and tests.");
      assert.equal(context.primaryDomain, "incident");
      assert.ok(context.domains.includes("incident"));
      assert.ok(context.domains.includes("it_ops"));
      assert.ok(context.domains.includes("knowledge"));
      assert.ok(context.domains.includes("testing"));
    },
  },
  {
    name: "phone-originated laptop command targets the paired PC",
    run: () => {
      const context = contextualizeRequest("Run the unit tests on my laptop", { source: "phone", originDeviceId: "phone-1" });
      assert.equal(context.targetDevice.kind, "paired_pc");
      assert.ok(context.domains.includes("testing"));
    },
  },
  {
    name: "desktop-originated request for the phone targets a paired mobile device",
    run: () => {
      const context = contextualizeRequest("Create a reminder on my phone", { source: "desktop", originDeviceId: "desktop-1" });
      assert.equal(context.targetDevice.kind, "paired_mobile");
    },
  },
  {
    name: "phone-local reminder defaults to the origin device",
    run: () => {
      const context = contextualizeRequest("Remind me to submit the form at 6 PM", { source: "phone", originDeviceId: "phone-1" });
      assert.equal(context.targetDevice.kind, "origin_device");
    },
  },
  {
    name: "validated envelope target overrides inferred target",
    run: () => {
      const context = contextualizeRequest("Open YouTube", {
        source: "phone",
        targetDeviceId: "laptop-9",
      });
      assert.deepEqual(context.targetDevice, {
        kind: "specific_device",
        deviceId: "laptop-9",
        reason: "A validated target device was supplied by the command envelope.",
      });
    },
  },
  {
    name: "cross-agent contextualizer does not grant permissions",
    run: () => {
      const context = contextualizeRequest("Restart my Wi-Fi adapter", { source: "desktop" });
      assert.ok(context.domains.includes("system"));
      assert.ok(context.notes.some((note) => note.includes("relay connectivity")));
      assert.equal("allowedTools" in context, false);
    },
  },
    name: "YouTube URL recognition accepts watch and short links only",
    run: () => {
      assert.equal(isYouTubeWatchUrl("https://www.youtube.com/watch?v=abc123"), true);
      assert.equal(isYouTubeWatchUrl("https://youtu.be/abc123"), true);
      assert.equal(isYouTubeWatchUrl("https://www.youtube.com/results?search_query=music"), false);
      assert.equal(isYouTubeWatchUrl("https://example.com/watch?v=abc123"), false);
    },
  },
];

let failed = 0;
for (const test of cases) {
  try {
    test.run();
    console.log(`PASS ${test.name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${test.name}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  }
}
console.log(`Contextualizer tests: ${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
