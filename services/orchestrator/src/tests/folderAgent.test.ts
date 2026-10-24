import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FolderAgent } from "../agents/folder.agent.js";
import { privacyGuard } from "../core/privacy.js";

test("resolves approved files and finds the containing project root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vanessa-folder-"));
  privacyGuard.addAllowedFolder(root);
  await fs.writeFile(path.join(root, "package.json"), '{"name":"fixture"}', "utf8");
  const target = path.join(root, "sample.ts");
  await fs.writeFile(target, "export const value = 1;", "utf8");
  const result = await new FolderAgent({ openTarget: async () => undefined }).execute("folder.resolve", { target });
  assert.equal(result.success, true);
  assert.equal((result.data as any).kind, "code");
  assert.equal((result.data as any).projectRoot, root);
  assert.equal((result.data as any).targetPath, target);
  await fs.rm(root, { recursive: true, force: true });
});

test("opens a target through the injected desktop adapter", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vanessa-folder-open-"));
  privacyGuard.addAllowedFolder(root);
  const target = path.join(root, "note.txt");
  await fs.writeFile(target, "hello", "utf8");
  const calls: unknown[][] = [];
  const agent = new FolderAgent({ platform: "win32", openTarget: async (pathValue, mode, isDirectory) => { calls.push([pathValue, mode, isDirectory]); } });
  const result = await agent.execute("folder.open", { target, mode: "explorer" });
  assert.equal(result.success, true);
  assert.deepEqual(calls[0], [target, "explorer", false]);
  await fs.rm(root, { recursive: true, force: true });
});

test("refuses targets outside approved filesystem roots", async () => {
  const approved = await fs.mkdtemp(path.join(os.tmpdir(), "vanessa-approved-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "vanessa-denied-"));
  privacyGuard.addAllowedFolder(approved);
  const target = path.join(outside, "secret.txt");
  await fs.writeFile(target, "not allowed", "utf8");
  const result = await new FolderAgent().execute("folder.resolve", { target });
  assert.equal(result.success, false);
  assert.match(result.error || "", /outside approved folders/i);
  await fs.rm(approved, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});
