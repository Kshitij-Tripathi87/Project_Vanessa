import assert from "node:assert/strict";
import test from "node:test";
import { shouldStartLegacyMobileGateway } from "../remote/remoteGatewayMode.js";

test("packaged Windows desktop never starts the legacy HMAC mobile gateway", () => {
  assert.equal(shouldStartLegacyMobileGateway({
    VANESSA_PACKAGED_DESKTOP: "true",
    VANESSA_MOBILE_GATEWAY_ENABLED: "true",
  } as NodeJS.ProcessEnv), false);
});

test("local development may opt into the legacy gateway explicitly", () => {
  assert.equal(shouldStartLegacyMobileGateway({
    VANESSA_PACKAGED_DESKTOP: "false",
    VANESSA_MOBILE_GATEWAY_ENABLED: "true",
  } as NodeJS.ProcessEnv), true);
});

test("the legacy gateway remains off unless explicitly enabled", () => {
  assert.equal(shouldStartLegacyMobileGateway({
    VANESSA_PACKAGED_DESKTOP: "false",
    VANESSA_MOBILE_GATEWAY_ENABLED: "false",
  } as NodeJS.ProcessEnv), false);
});
