import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileAgent } from "../agents/file.agent.js";
import { privacyGuard } from "../core/privacy.js";

test("inspects supported text files and returns bounded content with evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vanessa-file-"));
  privacyGuard.addAllowedFolder(root);
  const target = path.join(root, "notes.md");
  await fs.writeFile(target, "# Findings\nThe result is 42.\n", "utf8");
  const result = await new FileAgent().execute("file.inspect", { path: target });
  assert.equal(result.success, true);
  assert.match(String((result.data as any).content), /The result is 42/);
  assert.equal((result.data as any).truncated, false);
  assert.equal(result.verification?.passed, true);
  await fs.rm(root, { recursive: true, force: true });
});

test("refuses to read outside approved filesystem roots", async () => {
  const approved = await fs.mkdtemp(path.join(os.tmpdir(), "vanessa-file-approved-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "vanessa-file-denied-"));
  privacyGuard.addAllowedFolder(approved);
  const target = path.join(outside, "secret.txt");
  await fs.writeFile(target, "secret", "utf8");
  await assert.rejects(() => new FileAgent().execute("file.inspect", { path: target }), /outside approved folders/i);
  await fs.rm(approved, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});
