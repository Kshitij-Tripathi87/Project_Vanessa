import { strict as assert } from "node:assert";
import { test } from "node:test";
import { PrivacyGuard } from "../core/privacy.js";

test("privacy status does not claim a network firewall or universal encryption", () => {
  const status = new PrivacyGuard().getPrivacyStatus();
  assert.equal(status.networkBoundToLocal, false);
  assert.match(status.networkNotice, /providers or tools/);
  assert.match(status.localMemory, /encryption is not enabled/);
  assert.match(status.redactionScope, /best effort/);
  assert.match(status.folderPolicy, /guarded file operations/);
});

test("credential redaction never retains single-capture tokens at nonzero offsets", () => {
  const guard = new PrivacyGuard();
  const tokens = [
    "sk-" + "A".repeat(32),
    "nvapi-" + "B".repeat(32),
    "ghp_" + "C".repeat(32),
    "Bearer " + "D".repeat(32),
  ];
  for (const token of tokens) {
    for (const prefix of ["", "before "]) {
      const result = guard.redactSensitiveData(prefix + token + " after");
      assert(!result.cleanText.includes(token));
      assert.match(result.cleanText, /\[REDACTED_API_KEY\]/);
      assert.equal(result.redactedCount, 1);
    }
  }
  const assigned = "E".repeat(32);
  const result = guard.redactSensitiveData(`api_key=\"${assigned}\"`);
  assert.equal(result.cleanText, 'api_key="[REDACTED_API_KEY]"');
  assert(!result.cleanText.includes(assigned));
});
