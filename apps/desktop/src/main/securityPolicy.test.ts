import assert from "node:assert/strict";
import { test } from "node:test";
import { rendererContentSecurityPolicy } from "./securityPolicy.js";

test("the built desktop CSP permits local services but no remote script or provider origins", () => {
  const csp = rendererContentSecurityPolicy(false);
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /connect-src 'self' http:\/\/127\.0\.0\.1:\*/);
  assert.doesNotMatch(csp, /https?:\/\/(?!127\.0\.0\.1|localhost)/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.match(rendererContentSecurityPolicy(true), /script-src 'self' 'unsafe-inline';/);
});
