import assert from "node:assert/strict";
import { contextualizeBrowserRequest, extractExplicitHttpUrl, isYouTubeWatchUrl } from "../core/contextualizer.js";

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
