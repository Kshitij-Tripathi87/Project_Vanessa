import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ITOpsAgent, resolveIncidentLabLogPath } from "../agents/it_ops.agent.js";

async function withIncidentFixture<T>(
  run: (root: string, logPath: string) => Promise<T> | T
): Promise<T> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vanessa-itops-log-"));
  const incidentRoot = path.join(tempRoot, "packages", "incident-lab");
  const logDir = path.join(incidentRoot, "logs");
  const logPath = path.join(logDir, "checkout-service.log");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(logPath, [
    "2026-10-18T14:10:00Z [ERROR] TypeError: Cannot read properties of undefined (reading 'discountRate')",
    "2026-10-18T14:18:00Z [ERROR] discountRate was missing in checkout request",
    "2026-10-18T14:25:30Z [ERROR] Cannot read properties of null",
  ].join("\n"), "utf8");

  try {
    return await run(incidentRoot, logPath);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

test("normalizes supported target spellings and basename shorthand to the same incident log", async () => {
  await withIncidentFixture((root, expected) => {
    const targets = [
      "logs/checkout-service.log",
      "packages/incident-lab/logs/checkout-service.log",
      "packages\\incident-lab\\logs\\checkout-service.log",
      "checkout-service.log",
      expected,
    ];
    for (const target of targets) {
      assert.equal(resolveIncidentLabLogPath(target, root), expected, `target spelling: ${target}`);
    }
  });
});

test("rejects traversal, out-of-scope absolute paths, duplicate basenames, and symlink escapes", async () => {
  await withIncidentFixture((root, expected) => {
    assert.throws(() => resolveIncidentLabLogPath("../../../../outside.log", root));
    const outside = path.join(path.dirname(root), "outside.log");
    fs.writeFileSync(outside, "not part of incident-lab", "utf8");
    assert.throws(() => resolveIncidentLabLogPath(outside, root));

    const duplicate = path.join(root, "fixtures", "checkout-service.log");
    fs.mkdirSync(path.dirname(duplicate), { recursive: true });
    fs.writeFileSync(duplicate, "[ERROR] duplicate fixture", "utf8");
    assert.throws(() => resolveIncidentLabLogPath("checkout-service.log", root), /ambiguous/i);

    const symlink = path.join(root, "logs", "outside-link.log");
    try {
      fs.symlinkSync(outside, symlink, "file");
      assert.throws(() => resolveIncidentLabLogPath("logs/outside-link.log", root));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(code || "")) throw err;
    }
    assert.ok(fs.existsSync(expected));
  });
});

test("a nonexistent or invalid target returns a failed result instead of a zero-line success", async () => {
  await withIncidentFixture(async (root) => {
    const agent = new ITOpsAgent();
    (agent as unknown as { incidentLabDir: string }).incidentLabDir = root;

    const missing = await agent.execute("it_ops.analyze_logs", { target: "logs/missing.log" });
    assert.equal(missing.success, false);
    assert.equal(missing.status, "failed");
    assert.equal(missing.verification?.passed, false);
    assert.match(missing.verification?.details || "", /not found/i);

    const invalid = await agent.execute("it_ops.analyze_logs", { target: "../../outside.log" });
    assert.equal(invalid.success, false);
    assert.equal(invalid.status, "failed");
    assert.equal(invalid.verification?.passed, false);
  });
});

test("reads and verifies the requested log, returning counts and a relative evidence path", async () => {
  await withIncidentFixture(async (root) => {
    const agent = new ITOpsAgent();
    (agent as unknown as { incidentLabDir: string }).incidentLabDir = root;

    const result = await agent.execute("it_ops.analyze_logs", {
      target: "packages\\incident-lab\\logs\\checkout-service.log",
    });

    assert.equal(result.success, true);
    assert.equal(result.status, "completed");
    assert.equal(result.verification?.passed, true);
    const data = result.data as Record<string, unknown>;
    assert.equal(data.logPath, "logs/checkout-service.log");
    assert.equal(data.logLineCount, 3);
    assert.equal(data.totalErrorsDetected, 3);
    assert.equal(data.signatureMatches, 3);
    assert.match(result.verification?.details || "", /3 non-empty log lines/);
  });
});

test("analyzing a non-empty log without the checkout signature does not fabricate a diagnosis", async () => {
  await withIncidentFixture(async (root) => {
    const noErrorLog = path.join(root, "logs", "healthy.log");
    fs.writeFileSync(noErrorLog, "2026-10-18T14:10:00Z [INFO] service started\n", "utf8");
    const agent = new ITOpsAgent();
    (agent as unknown as { incidentLabDir: string }).incidentLabDir = root;

    const result = await agent.execute("it_ops.analyze_logs", { target: "logs/healthy.log" });
    assert.equal(result.success, true);
    assert.equal(result.verification?.passed, true);
    assert.match(result.summary || "", /no discountRate\/null-related checkout signature/i);
    const data = result.data as Record<string, unknown>;
    assert.equal(data.signatureMatches, 0);
    assert.deepEqual(data.probableCauses, []);
  });
});
