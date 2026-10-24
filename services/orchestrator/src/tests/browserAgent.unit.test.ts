import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRemoteBrowserUrl } from "../agents/browser-playwright.agent.js";

test("accepts normal HTTP and HTTPS URLs", () => {
  assert.equal(normalizeRemoteBrowserUrl("https://example.com"), "https://example.com/");
  assert.equal(normalizeRemoteBrowserUrl("http://example.com:8080/path"), "http://example.com:8080/path");
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
