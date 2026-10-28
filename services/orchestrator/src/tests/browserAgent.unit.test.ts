import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRemoteBrowserUrl } from "../agents/browser-playwright.agent.js";
import { BrowserAgent, buildYouTubeSearchUrl } from "../agents/browser.agent.js";

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

test("builds a safely encoded YouTube search URL on the expected origin", () => {
  const result = new URL(buildYouTubeSearchUrl("lo-fi & jazz + focus"));
  assert.equal(result.origin, "https://www.youtube.com");
  assert.equal(result.pathname, "/results");
  assert.equal(result.searchParams.get("search_query"), "lo-fi & jazz + focus");
  assert.throws(() => buildYouTubeSearchUrl("   "), /non-empty/i);
  assert.throws(() => buildYouTubeSearchUrl("x".repeat(501)), /500 characters/i);
});

test("external YouTube handoff reports launch acceptance without claiming playback", async () => {
  const launched: string[] = [];
  const agent = new BrowserAgent({ openExternalBrowser: async (url) => { launched.push(url); } });
  const result = await agent.execute("youtube.search_and_play", { query: "lo-fi & jazz" });
  const data = result.data as { url: string; playbackVerified: boolean; externalBrowser: boolean };
  assert.equal(result.success, false);
  assert.equal(result.status, "partial");
  assert.equal(launched.length, 1);
  assert.equal(launched[0], data.url);
  assert.equal(new URL(data.url).searchParams.get("search_query"), "lo-fi & jazz");
  assert.equal(data.externalBrowser, true);
  assert.equal(data.playbackVerified, false);
  assert.match(result.spokenSummary || "", /playback has not been verified/i);
});

test("external browser launch failures remain failures with no success evidence", async () => {
  const agent = new BrowserAgent({
    openExternalBrowser: async () => { throw new Error("no default browser"); },
  });
  const result = await agent.execute("youtube.search_and_play", { query: "test query" });
  const data = result.data as { externalBrowser: boolean; error: string };
  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.equal(data.externalBrowser, false);
  assert.match(data.error, /no default browser/i);
  assert.equal(result.evidence?.length ?? 0, 0);
  assert.match(result.spokenSummary || "", /could not open/i);
});
