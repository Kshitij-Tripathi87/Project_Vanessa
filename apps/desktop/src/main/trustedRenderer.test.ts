import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isPathWithin, isTrustedLocalRendererUrl, resolveDesktopRendererAsset } from "./trustedRenderer.js";

const renderer = resolve("app/renderer/index.html");

test("sensitive history is restricted to the exact local renderer file", () => {
  assert.equal(isTrustedLocalRendererUrl(pathToFileURL(renderer).toString(), renderer), true);
  assert.equal(isTrustedLocalRendererUrl(pathToFileURL(resolve("app/renderer/other.html")).toString(), renderer), false);
  assert.equal(isTrustedLocalRendererUrl("https://example.invalid/", renderer), false);
  assert.equal(isTrustedLocalRendererUrl("http://localhost:5173/", renderer), false);
  assert.equal(isTrustedLocalRendererUrl("invalid", renderer), false);
});

test("development access is explicit and limited to the loopback Vite page", () => {
  assert.equal(isTrustedLocalRendererUrl("http://localhost:5173/", renderer, true), true);
  assert.equal(isTrustedLocalRendererUrl("http://127.0.0.1:5173/index.html", renderer, true), true);
  assert.equal(isTrustedLocalRendererUrl("http://localhost:5173/other", renderer, true), false);
  assert.equal(isTrustedLocalRendererUrl("http://example.invalid:5173/", renderer, true), false);
  assert.equal(isTrustedLocalRendererUrl("http://localhost:4319/", renderer, true), false);
  assert.equal(isTrustedLocalRendererUrl("http://user:password@localhost:5173/", renderer, true), false);
});

test("the packaged renderer uses a fixed app origin, not a loopback page", () => {
  assert.equal(isTrustedLocalRendererUrl("vanessa://desktop/index.html", renderer), true);
  assert.equal(isTrustedLocalRendererUrl("vanessa://desktop/", renderer), true);
  for (const url of [
    "vanessa://desktop/other.html", "vanessa://other/index.html", "vanessa://desktop:123/index.html",
    "vanessa://user@desktop/index.html", "vanessa://desktop/index.html?x=1", "vanessa://desktop/index.html#section",
    "http://127.0.0.1:5173/",
  ]) assert.equal(isTrustedLocalRendererUrl(url, renderer), false, url);
});

test("app assets stay within the renderer tree and reject encoded traversal and other origins", () => {
  const directory = resolve("app/renderer");
  assert.equal(resolveDesktopRendererAsset("vanessa://desktop/", directory), resolve(directory, "index.html"));
  assert.equal(resolveDesktopRendererAsset("vanessa://desktop/assets/main.js", directory), resolve(directory, "assets/main.js"));
  for (const url of [
    "https://desktop/assets/main.js", "vanessa://wrong/assets/main.js", "vanessa://desktop:8080/index.html",
    "vanessa://desktop/assets/%2e%2e%2f%2e%2e%2fsecret", "vanessa://desktop/%5csecret",
    "vanessa://desktop/assets/a.js?override=1", "vanessa://desktop/%00secret", "vanessa://desktop/C:%5csecret",
  ]) assert.equal(resolveDesktopRendererAsset(url, directory), null, url);
  assert.equal(isPathWithin(directory, resolve(directory, "assets/main.js")), true);
  assert.equal(isPathWithin(directory, resolve(directory, "../secret")), false);
  assert.equal(isPathWithin(directory, directory), false);
});
