import { strict as assert } from "node:assert";
import { test } from "node:test";
import { allowDevelopmentRenderer, restrictPackagedEnvironment } from "./developmentPolicy.js";

test("only an explicitly enabled unpackaged app may trust a development renderer", () => {
  assert.equal(allowDevelopmentRenderer(false, { VANESSA_DEV_MODE: "1" }), true);
  assert.equal(allowDevelopmentRenderer(false, {}), false);
  assert.equal(allowDevelopmentRenderer(true, { VANESSA_DEV_MODE: "1" }), false);
});

test("packaged environment strips stale development mode and renderer URL", () => {
  const env: NodeJS.ProcessEnv = { VANESSA_DEV_MODE: "1", VITE_DEV_SERVER_URL: "http://localhost:5173", OTHER_SETTING: "kept" };
  restrictPackagedEnvironment(env);
  assert.equal(env.VANESSA_DEV_MODE, "0");
  assert.equal(env.VITE_DEV_SERVER_URL, undefined);
  assert.equal(env.OTHER_SETTING, "kept");
});
