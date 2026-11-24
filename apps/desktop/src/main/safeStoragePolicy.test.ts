import assert from "node:assert/strict";
import { test } from "node:test";
import { isProtectedLinuxStorageBackend } from "./safeStoragePolicy.js";

test("only known OS-backed Linux secret stores qualify for private history", () => {
  for (const backend of ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]) assert.equal(isProtectedLinuxStorageBackend(backend), true);
  for (const backend of ["basic_text", "unknown", "", "future_unknown_backend"]) assert.equal(isProtectedLinuxStorageBackend(backend), false);
});
