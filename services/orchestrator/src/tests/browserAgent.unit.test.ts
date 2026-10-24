import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRemoteBrowserUrl } from "../agents/browser-playwright.agent.js";
import { BrowserAgent, buildYouTubeSearchUrl } from "../agents/browser.agent.js";

function createBrowserAgent(options: { openExternalBrowser?: (url: string, browserName?: string) => Promise<void> } = {}): BrowserAgent {
  return new BrowserAgent({
    ...options,
    // Keep these unit tests hermetic. The production validator additionally
    // resolves DNS and rejects hostnames that resolve to private/reserved IPs.
    validateExternalUrl: async (url) => normalizeRemoteBrowserUrl(url),
  });
}

test("accepts normal HTTP and HTTPS URLs", () => {
  assert.equal(normalizeRemoteBrowserUrl("https://example.com"), "https://example.com/");
  assert.equal(normalizeRemoteBrowserUrl("http://example.com:8080/path"), "http://example.com:8080/path");
  assert.equal(normalizeRemoteBrowserUrl("https://[2606:4700:4700::1111]/"), "https://[2606:4700:4700::1111]/");
});

test("rejects non-web protocols, embedded credentials, and local network targets by default", () => {
  assert.throws(() => normalizeRemoteBrowserUrl("javascript:alert(1)"), /HTTP or HTTPS/i);
  assert.throws(() => normalizeRemoteBrowserUrl("file:///etc/passwd"), /HTTP or HTTPS/i);
  assert.throws(() => normalizeRemoteBrowserUrl("https://user:pass@example.com"), /credentials/i);
  assert.throws(() => normalizeRemoteBrowserUrl("http://127.0.0.1:3000"), /local or private/i);
  assert.throws(() => normalizeRemoteBrowserUrl("http://192.168.1.20"), /local or private/i);
  assert.throws(() => normalizeRemoteBrowserUrl("http://internal.local"), /local or private/i);
});

test("local development URLs require explicit opt-in", () => {
  assert.equal(normalizeRemoteBrowserUrl("http://localhost:3000", true), "http://localhost:3000/");
});

test("opens an explicit URL in the system browser and does not claim page-load verification", async () => {
  const launched: string[] = [];
  const agent = createBrowserAgent({ openExternalBrowser: async (url) => { launched.push(url); } });
  const result = await agent.execute("browser.open_url", { url: "https://example.com/docs?q=hello%20world" });
  const data = result.data as { url: string; externalBrowser: boolean; pageLoadVerified: boolean };
  assert.equal(result.success, true);
  assert.equal(result.status, "completed");
  assert.equal(launched.length, 1);
  assert.equal(launched[0], data.url);
  assert.equal(new URL(data.url).hostname, "example.com");
  assert.equal(data.externalBrowser, true);
  assert.equal(data.pageLoadVerified, false);
  assert.match(result.spokenSummary, /not verified that it loaded/i);
  assert.equal(result.evidence?.[0]?.source, "Desktop browser handoff");
});

test("rejects unsafe URL schemes before attempting a system-browser launch", async () => {
  let launchCount = 0;
  const agent = createBrowserAgent({ openExternalBrowser: async () => { launchCount++; } });
  const result = await agent.execute("browser.open_url", { url: "javascript:alert(1)" });
  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.equal(launchCount, 0);
  assert.equal(result.evidence?.length ?? 0, 0);
});

test("visible browser launch failures remain failures without evidence", async () => {
  const agent = createBrowserAgent({ openExternalBrowser: async () => { throw new Error("no default browser"); } });
  const result = await agent.execute("browser.open_url", { url: "https://example.com" });
  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.equal(result.evidence?.length ?? 0, 0);
  assert.match(result.spokenSummary, /could not open/i);
});

test("search launches an encoded Google search in the system browser without claiming extraction", async () => {
  const launched: string[] = [];
  const agent = createBrowserAgent({ openExternalBrowser: async (url) => { launched.push(url); } });
  const result = await agent.execute("browser.search", { query: "lo-fi & jazz + focus" });
  const data = result.data as { query: string; url: string; externalBrowser: boolean; resultsExtracted: boolean };
  assert.equal(result.success, true);
  assert.equal(launched.length, 1);
  assert.equal(launched[0], data.url);
  assert.equal(new URL(data.url).searchParams.get("q"), "lo-fi & jazz + focus");
  assert.equal(data.externalBrowser, true);
  assert.equal(data.resultsExtracted, false);
  assert.match(result.spokenSummary, /not independently inspected/i);
});

test("explicit Chrome and Edge targets are passed to the system-browser launcher", async () => {
  const launched: Array<{ url: string; browser?: string }> = [];
  const agent = createBrowserAgent({
    openExternalBrowser: async (url, browser) => { launched.push({ url, browser }); },
  });
  const result = await agent.execute("browser.search", { query: "TypeScript tutorials", browser: "chrome" });
  const data = result.data as { browser: string; query: string; resultsExtracted: boolean };
  assert.equal(result.success, true);
  assert.equal(launched.length, 1);
  assert.equal(launched[0].browser, "chrome");
  assert.equal(new URL(launched[0].url).searchParams.get("q"), "TypeScript tutorials");
  assert.equal(data.browser, "chrome");
  assert.equal(data.resultsExtracted, false);
});

test("unsupported explicit browser targets are rejected before launch", async () => {
  let launchCount = 0;
  const agent = createBrowserAgent({
    openExternalBrowser: async () => { launchCount++; },
  });
  const result = await agent.execute("browser.open_url", { url: "https://example.com", browser: "powershell" });
  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.equal(launchCount, 0);
  assert.equal(result.evidence?.length ?? 0, 0);
});

test("search with no query does not open the browser", async () => {
  let launchCount = 0;
  const agent = createBrowserAgent({ openExternalBrowser: async () => { launchCount++; } });
  const result = await agent.execute("browser.search", { query: "   " });
  assert.equal(result.success, false);
  assert.equal(launchCount, 0);
});

test("builds a safely encoded YouTube search URL on the expected origin", () => {
  const result = new URL(buildYouTubeSearchUrl("lo-fi & jazz + focus"));
  assert.equal(result.origin, "https://www.youtube.com");
  assert.equal(result.pathname, "/results");
  assert.equal(result.searchParams.get("search_query"), "lo-fi & jazz + focus");
  assert.throws(() => buildYouTubeSearchUrl("   "), /non-empty/i);
  assert.throws(() => buildYouTubeSearchUrl("x".repeat(501)), /500 characters/i);
});

test("YouTube handoff reports launch acceptance without claiming playback", async () => {
  const launched: string[] = [];
  const agent = createBrowserAgent({ openExternalBrowser: async (url) => { launched.push(url); } });
  const result = await agent.execute("youtube.search_and_play", { query: "lo-fi & jazz" });
  const data = result.data as { url: string; playbackVerified: boolean; externalBrowser: boolean };
  assert.equal(result.success, true);
  assert.equal(launched.length, 1);
  assert.equal(launched[0], data.url);
  assert.equal(new URL(data.url).searchParams.get("search_query"), "lo-fi & jazz");
  assert.equal(data.externalBrowser, true);
  assert.equal(data.playbackVerified, false);
  assert.match(result.spokenSummary, /playback has not been verified/i);
});

test("YouTube browser launch failure has no success evidence", async () => {
  const agent = createBrowserAgent({ openExternalBrowser: async () => { throw new Error("no default browser"); } });
  const result = await agent.execute("youtube.search_and_play", { query: "test query" });
  const data = result.data as { externalBrowser: boolean; error: string };
  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.equal(data.externalBrowser, false);
  assert.match(data.error, /no default browser/i);
  assert.equal(result.evidence?.length ?? 0, 0);
  assert.match(result.spokenSummary, /could not open/i);
});
