import assert from "node:assert/strict";
import { BrowserAgent } from "../agents/browser.agent.js";
import type { PlaywrightBrowserAgent } from "../agents/browser-playwright.agent.js";

function fakeBrowser(overrides: Record<string, any> = {}) {
  const state = {
    navigateCalls: [] as string[],
    searchYouTubeCalls: [] as string[],
    playCalls: [] as string[],
    navigateResult: { success: true, title: "YouTube", url: "https://www.youtube.com/" },
    searchResult: {
      success: true, query: "playlist",
      results: [{ title: "Chill Playlist", url: "https://www.youtube.com/watch?v=test123" }],
      url: "https://www.youtube.com/results?search_query=playlist", title: "YouTube",
    },
    playResult: { success: false, query: "playlist", url: "https://www.youtube.com/watch?v=test123", title: "Chill Playlist", playbackVerified: false, error: "Playback did not advance" },
    ...overrides,
  } as any;
  const adapter = {
    navigate: async (url: string) => { state.navigateCalls.push(url); return { ...state.navigateResult, url: state.navigateResult.url || url }; },
    search: async (query: string) => ({ success: true, snippets: ["Playlist result snippet"], url: "https://www.google.com/search?q=" + encodeURIComponent(query), title: "Search" }),
    searchYouTube: async (query: string) => { state.searchYouTubeCalls.push(query); return { ...state.searchResult, query }; },
    searchAndPlayYouTube: async (query: string) => { state.playCalls.push(query); return { ...state.playResult, query }; },
    verifyPageState: async (url: string, expectedText: string) => ({ success: true, found: expectedText === "verified", url, title: "Test page" }),
    currentPageState: async () => ({ success: true, url: "https://www.youtube.com/results?search_query=playlist", title: "YouTube" }),
  } as unknown as PlaywrightBrowserAgent;
  return { state, agent: new BrowserAgent(adapter) };
}

async function main() {
  const cases: Array<{ name: string; run: () => Promise<void> }> = [
    {
      name: "YouTube search returns completed only when visible results are supplied",
      run: async () => {
        const { state, agent } = fakeBrowser();
        const result = await agent.execute("youtube.search", { query: "playlist" });
        assert.equal(result.status, "completed");
        assert.equal(result.success, true);
        assert.equal((result.data as any).resultsVerified, true);
        assert.equal((result.data as any).results[0].title, "Chill Playlist");
        assert.deepEqual(state.searchYouTubeCalls, ["playlist"]);
        assert.doesNotMatch(result.spokenSummary || "", /playing/i);
      },
    },
    {
      name: "YouTube page without visible results remains partial, not success",
      run: async () => {
        const { agent } = fakeBrowser({ searchResult: { success: false, query: "playlist", results: [], url: "https://www.youtube.com/results?search_query=playlist", title: "YouTube", error: "No visible results" } });
        const result = await agent.execute("youtube.search", { query: "playlist" });
        assert.equal(result.status, "partial");
        assert.equal(result.success, false);
        assert.equal((result.data as any).resultsVerified, false);
        assert.doesNotMatch(result.spokenSummary || "", /playing/i);
      },
    },
    {
      name: "search-and-play does not claim playback unless player state was verified",
      run: async () => {
        const { state, agent } = fakeBrowser();
        const result = await agent.execute("youtube.search_and_play", { query: "playlist" });
        assert.equal(result.status, "partial");
        assert.equal(result.success, false);
        assert.equal((result.data as any).playbackVerified, false);
        assert.match(result.spokenSummary || "", /couldn.t verify/i);
        assert.deepEqual(state.playCalls, ["playlist"]);
      },
    },
    {
      name: "verified playback may be reported as completed",
      run: async () => {
        const { agent } = fakeBrowser({ playResult: { success: true, query: "playlist", url: "https://www.youtube.com/watch?v=test123", title: "Chill Playlist", playbackVerified: true, video: { paused: false, currentTime: 1.2, readyState: 4 } } });
        const result = await agent.execute("youtube.search_and_play", { query: "playlist" });
        assert.equal(result.status, "completed");
        assert.equal(result.success, true);
        assert.equal((result.data as any).playbackVerified, true);
        assert.match(result.spokenSummary || "", /verified that it is playing/i);
      },
    },
    {
      name: "unsafe URL scheme is rejected before browser navigation",
      run: async () => {
        const { state, agent } = fakeBrowser();
        const result = await agent.execute("browser.open_url", { url: "javascript:alert(1)" });
        assert.equal(result.status, "failed");
        assert.equal(result.success, false);
        assert.equal(state.navigateCalls.length, 0);
      },
    },
  ];
  let failures = 0;
  for (const test of cases) {
    try { await test.run(); console.log("PASS " + test.name); }
    catch (error) { failures++; console.error("FAIL " + test.name + ": " + (error instanceof Error ? error.stack || error.message : String(error))); }
  }
  console.log("Browser agent verification tests: " + (cases.length - failures) + "/" + cases.length + " passed");
  process.exit(failures ? 1 : 0);
}
void main().catch((error) => { console.error(error); process.exit(1); });