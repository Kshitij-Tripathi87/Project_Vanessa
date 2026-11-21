import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileAgent } from "../agents/file.agent.js";
import { privacyGuard } from "../core/privacy.js";

async function withApprovedRoot<T>(prefix: string, run: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  privacyGuard.addAllowedFolder(root);
  try {
    return await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("inspects supported text files and returns bounded content with evidence", async () => {
  await withApprovedRoot("vanessa-file-", async (root) => {
    const target = path.join(root, "notes.md");
    await fs.writeFile(target, "# Findings\nThe result is 42.\n", "utf8");
    const result = await new FileAgent().execute("file.inspect", { path: target });
    assert.equal(result.success, true);
    assert.match(String((result.data as any).content), /The result is 42/);
    assert.equal((result.data as any).truncated, false);
    assert.equal(result.verification?.passed, true);
    assert.equal(result.evidence.length, 1);
  });
});

test("refuses to read outside approved filesystem roots", async () => {
  const approved = await fs.mkdtemp(path.join(os.tmpdir(), "vanessa-file-approved-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "vanessa-file-denied-"));
  privacyGuard.addAllowedFolder(approved);
  const target = path.join(outside, "secret.txt");
  try {
    await fs.writeFile(target, "secret", "utf8");
    await assert.rejects(() => new FileAgent().execute("file.inspect", { path: target }), /outside approved folders/i);
  } finally {
    await fs.rm(approved, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("folder.create creates only the requested directory under an approved root", async () => {
  await withApprovedRoot("vanessa-folder-create-", async (root) => {
    const result = await new FileAgent().execute("folder.create", {
      name: "reports/weekly",
      basePath: root,
    });
    const target = path.join(root, "reports", "weekly");
    assert.equal(result.success, true);
    assert.equal(result.verification?.passed, true);
    assert.equal(await fs.stat(target).then((stat) => stat.isDirectory()), true);
    assert.deepEqual(await fs.readdir(target), [], "folder creation must not add an unsolicited demo note");
    assert.deepEqual(result.artifacts, [await fs.realpath(target)]);
  });
});

test("folder.create rejects an absolute target outside approved roots before creating it", async () => {
  const approved = await fs.mkdtemp(path.join(os.tmpdir(), "vanessa-folder-approved-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "vanessa-folder-outside-"));
  privacyGuard.addAllowedFolder(approved);
  const target = path.join(outside, "not-allowed");
  try {
    await assert.rejects(
      () => new FileAgent().execute("folder.create", { name: target, basePath: approved }),
      /outside approved filesystem roots/i,
    );
    await assert.rejects(() => fs.stat(target), { code: "ENOENT" });
  } finally {
    await fs.rm(approved, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("file.search keeps the established filename result shape and includes evidence", async () => {
  await withApprovedRoot("vanessa-file-search-", async (root) => {
    await fs.writeFile(path.join(root, "report-final.md"), "done", "utf8");
    await fs.writeFile(path.join(root, "notes.txt"), "notes", "utf8");
    const result = await new FileAgent().execute("file.search", { query: "report", path: root });
    assert.equal(result.success, true);
    assert.deepEqual((result.data as any).matches, ["report-final.md"]);
    assert.equal((result.data as any).bestMatch.name, "report-final.md");
    assert.equal(result.verification?.passed, true);
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].source, await fs.realpath(root));
  });
});

test("file.search rejects directories outside approved roots", async () => {
  const approved = await fs.mkdtemp(path.join(os.tmpdir(), "vanessa-search-approved-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "vanessa-search-outside-"));
  privacyGuard.addAllowedFolder(approved);
  try {
    await assert.rejects(
      () => new FileAgent().execute("file.search", { query: "", path: outside }),
      /outside approved filesystem roots/i,
    );
  } finally {
    await fs.rm(approved, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("file.search rejects an approved-root symlink that resolves outside the root", async () => {
  const approved = await fs.mkdtemp(path.join(os.tmpdir(), "vanessa-search-link-approved-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "vanessa-search-link-outside-"));
  privacyGuard.addAllowedFolder(approved);
  const linkPath = path.join(approved, "external");
  try {
    await fs.writeFile(path.join(outside, "private.txt"), "private", "utf8");
    await fs.symlink(outside, linkPath, "junction");
    await assert.rejects(
      () => new FileAgent().execute("file.search", { query: "private", path: linkPath }),
      /outside approved filesystem roots/i,
    );
  } finally {
    await fs.rm(approved, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("file.rename uses an exclusive destination and verifies the source removal", async () => {
  await withApprovedRoot("vanessa-file-rename-", async (root) => {
    const source = path.join(root, "draft.txt");
    const destination = path.join(root, "final.txt");
    await fs.writeFile(source, "verified contents", "utf8");
    const result = await new FileAgent().execute("file.rename", { oldPath: source, newPath: destination });
    assert.equal(result.success, true);
    assert.equal(result.verification?.passed, true);
    assert.equal(await fs.readFile(destination, "utf8"), "verified contents");
    await assert.rejects(() => fs.stat(source), { code: "ENOENT" });
  });
});

test("file.rename refuses an existing destination without overwriting either file", async () => {
  await withApprovedRoot("vanessa-file-rename-collision-", async (root) => {
    const source = path.join(root, "source.txt");
    const destination = path.join(root, "destination.txt");
    await fs.writeFile(source, "source", "utf8");
    await fs.writeFile(destination, "destination", "utf8");
    await assert.rejects(
      () => new FileAgent().execute("file.rename", { oldPath: source, newPath: destination }),
      /already exists.*overwriting is not permitted/i,
    );
    assert.equal(await fs.readFile(source, "utf8"), "source");
    assert.equal(await fs.readFile(destination, "utf8"), "destination");
  });
});

test("file.rename refuses destinations outside approved roots", async () => {
  const approved = await fs.mkdtemp(path.join(os.tmpdir(), "vanessa-rename-approved-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "vanessa-rename-outside-"));
  privacyGuard.addAllowedFolder(approved);
  const source = path.join(approved, "source.txt");
  const destination = path.join(outside, "stolen.txt");
  try {
    await fs.writeFile(source, "source", "utf8");
    await assert.rejects(
      () => new FileAgent().execute("file.rename", { oldPath: source, newPath: destination }),
      /destination parent is outside approved filesystem roots/i,
    );
    assert.equal(await fs.readFile(source, "utf8"), "source");
    await assert.rejects(() => fs.stat(destination), { code: "ENOENT" });
  } finally {
    await fs.rm(approved, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("file.rename refuses directories rather than using an unverified recursive move", async () => {
  await withApprovedRoot("vanessa-rename-directory-", async (root) => {
    const source = path.join(root, "folder");
    const destination = path.join(root, "renamed-folder");
    await fs.mkdir(source);
    await assert.rejects(
      () => new FileAgent().execute("file.rename", { oldPath: source, newPath: destination }),
      /regular files only/i,
    );
    assert.equal(await fs.stat(source).then((stat) => stat.isDirectory()), true);
    await assert.rejects(() => fs.stat(destination), { code: "ENOENT" });
  });
});

test("file.zip rejects an unapproved source before invoking the archive tool", async () => {
  const approved = await fs.mkdtemp(path.join(os.tmpdir(), "vanessa-zip-approved-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "vanessa-zip-outside-"));
  privacyGuard.addAllowedFolder(approved);
  try {
    await assert.rejects(
      () => new FileAgent().execute("file.zip", {
        sourceDir: outside,
        destinationDir: approved,
        zipName: "archive.zip",
      }),
      /archive source directory is outside approved filesystem roots/i,
    );
    assert.deepEqual(await fs.readdir(approved), []);
  } finally {
    await fs.rm(approved, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("legacy Drive actions never fabricate upload or share-link success", async () => {
  for (const action of ["drive.upload", "drive.share_link"]) {
    const result = await new FileAgent().execute(action, { file: "report.pdf", fileId: "claimed-id" });
    assert.equal(result.success, false);
    assert.equal(result.status, "failed");
    assert.equal(result.verification?.passed, false);
    assert.equal((result.data as any).uploadPerformed, false);
    assert.equal((result.data as any).sharePermissionChanged, false);
    assert.equal(JSON.stringify(result).includes("drive.google.com"), false);
  }
});
