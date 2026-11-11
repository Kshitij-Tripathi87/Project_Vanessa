import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { MobileTaskEngine } from "../core/mobileTaskEngine.js";
import { createMobileToolRegistry } from "../core/mobileToolRegistry.js";
import { executeWindowsAudio } from "../agents/windows-audio.js";

const waitFor = async (check: () => boolean, timeoutMs = 1500) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for mobile task state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

function withDb(run: (dbPath: string) => Promise<void>) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vanessa-mobile-"));
    const dbPath = path.join(dir, "agent.db");
    try { await run(dbPath); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

test("registry schemas reject missing and wrong-type arguments and all tools have verifiers", () => {
  for (const tool of createMobileToolRegistry()) {
    assert.equal(typeof tool.verifier, "function");
    assert.equal(tool.argsSchema.safeParse({ invalid: true }).success, false);
  }
  const status = createMobileToolRegistry().find((tool) => tool.name === "system_status")!;
  assert.equal(status.argsSchema.safeParse({}).success, true);
});

test("task execution verifies results and idempotency returns the original task", withDb(async (dbPath) => {
  let runs = 0;
  const tool = {
    name: "read_test", description: "Read test result.", argsSchema: z.object({ value: z.string() }).strict(),
    manifestSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    tier: 0 as const, timeoutMs: 1000, idempotent: true, queue: "read" as const,
    handler: async ({ value }: { value: string }) => { runs++; return { value }; },
    verifier: async (_args: unknown, result: unknown) => typeof (result as any)?.value === "string",
  };
  const engine = new MobileTaskEngine({ dbPath, tools: [tool] });
  try {
    const first = await engine.submit({ requestId: "request-1", idempotencyKey: "device:req-1", tool: "read_test", args: { value: "alice@example.com" } });
    const duplicate = await engine.submit({ requestId: "request-2", idempotencyKey: "device:req-1", tool: "read_test", args: { value: "alice@example.com" } });
    assert.equal(duplicate.taskId, first.taskId);
    assert.equal(duplicate.duplicate, true);
    await waitFor(() => engine.getTask(first.taskId)?.state === "done");
    assert.equal(runs, 1);
    assert.deepEqual(engine.getTask(first.taskId)?.result, { value: "[REDACTED_EMAIL]" });
    assert.ok(engine.recentAudit().length >= 2);
    assert.equal(JSON.stringify(engine.recentAudit()).includes("alice@example.com"), false);
  } finally { engine.close(); }
}));

test("ephemeral tool results reach the caller without entering task or audit storage", withDb(async (dbPath) => {
  const sent: unknown[] = [];
  const tool = {
    name: "ephemeral_test", description: "Return transient bytes.", argsSchema: z.object({}).strict(), manifestSchema: { type: "object", properties: {}, additionalProperties: false },
    tier: 1 as const, timeoutMs: 1000, idempotent: false, queue: "ui" as const, persistResult: false,
    handler: async () => ({ mimeType: "image/jpeg", data: "/9j/AA==" }),
    verifier: async (_args: unknown, result: unknown) => (result as any)?.mimeType === "image/jpeg",
  };
  const engine = new MobileTaskEngine({ dbPath, tools: [tool], notify: ({ ephemeralResult }) => { if (ephemeralResult) sent.push(ephemeralResult); } });
  try {
    const accepted = await engine.submit({ requestId: "request-image", idempotencyKey: "image-1", tool: "ephemeral_test", args: {} });
    await waitFor(() => engine.getTask(accepted.taskId)?.state === "done");
    assert.equal(engine.getTask(accepted.taskId)?.result, undefined);
    assert.deepEqual(sent, [{ mimeType: "image/jpeg", data: "/9j/AA==" }]);
    assert.equal(JSON.stringify(engine.recentAudit()).includes("/9j/AA=="), false);
  } finally { engine.close(); }
}));

test("tier 2 work requires an unexpired action-bound confirmation", withDb(async (dbPath) => {
  let now = 1000;
  let runs = 0;
  const tool = {
    name: "confirm_test", description: "Confirmed action.", argsSchema: z.object({ target: z.string() }).strict(),
    manifestSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false },
    tier: 2 as const, timeoutMs: 1000, idempotent: false, queue: "ui" as const,
    handler: async () => { runs++; return { deleted: true }; }, verifier: async () => true,
  };
  const engine = new MobileTaskEngine({ dbPath, now: () => now, tools: [tool] });
  try {
    const pending = await engine.submit({ requestId: "request-2", idempotencyKey: "device:req-2", tool: "confirm_test", args: { target: "report.pdf" } });
    assert.equal(pending.state, "awaiting_confirm");
    assert.equal(runs, 0);
    await assert.rejects(engine.confirm({ taskId: pending.taskId, approved: true, actionHash: "0".repeat(64) }), { code: "PERMISSION_DENIED" });
    await engine.confirm({ taskId: pending.taskId, approved: true, actionHash: pending.actionHash! });
    await waitFor(() => engine.getTask(pending.taskId)?.state === "done");
    assert.equal(runs, 1);
    const expired = await engine.submit({ requestId: "request-3", idempotencyKey: "device:req-3", tool: "confirm_test", args: { target: "other.pdf" } });
    now = expired.expiresAt! + 1;
    await assert.rejects(engine.confirm({ taskId: expired.taskId, approved: true, actionHash: expired.actionHash! }), { code: "CONFIRMATION_EXPIRED" });
    assert.equal(runs, 1);
  } finally { engine.close(); }
}));

test("restart marks previously running tasks failed and audit rows reject mutation", withDb(async (dbPath) => {
  const first = new MobileTaskEngine({ dbPath, tools: [] });
  first.close();
  const db = new DatabaseSync(dbPath);
  db.prepare("INSERT INTO mobile_tasks(task_id,request_id,idempotency_key,tool,args_json,tier,state,created_at,updated_at,transitions_json) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("task-1", "req-1", "idem-1", "tool", "{}", 0, "running", 1, 1, "[]");
  db.prepare("INSERT INTO mobile_audit(at,task_id,request_id,tool,args_json,tier,state) VALUES(?,?,?,?,?,?,?)").run(1, "task-1", "req-1", "tool", "{}", 0, "running");
  db.close();
  const restarted = new MobileTaskEngine({ dbPath, tools: [] });
  try {
    assert.equal(restarted.getTask("task-1")?.state, "failed");
    const auditDb = new DatabaseSync(dbPath);
    assert.throws(() => auditDb.prepare("DELETE FROM mobile_audit").run(), /append-only/);
    auditDb.close();
  } finally { restarted.close(); }
}));

test("Tier 2 delete moves one disposable allowlisted file to the Recycle Bin", { skip: process.platform !== "win32" }, withDb(async (dbPath) => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".mobile-delete-check-"));
  const filePath = path.join(dir, "Vanessa Mobile Recycle Bin Check.txt");
  fs.writeFileSync(filePath, "Disposable Phase 2 integration fixture; no user data.", "utf8");
  const engine = new MobileTaskEngine({ dbPath });
  try {
    const pending = await engine.submit({ requestId: "request-delete", idempotencyKey: `delete-${Date.now()}`, tool: "delete_file", args: { path: filePath } });
    assert.equal(pending.state, "awaiting_confirm");
    assert.match(pending.summary ?? "", /Vanessa Mobile Recycle Bin Check\.txt/);
    await engine.confirm({ taskId: pending.taskId, approved: true, actionHash: pending.actionHash! });
    await waitFor(() => ["done", "failed", "timed_out"].includes(engine.getTask(pending.taskId)?.state ?? ""), 25_000);
    assert.equal(engine.getTask(pending.taskId)?.state, "done", JSON.stringify(engine.getTask(pending.taskId)));
    assert.equal(fs.existsSync(filePath), false);
    assert.equal((engine.getTask(pending.taskId)?.result as any)?.movedToRecycleBin, true);
  } finally {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test("set_volume reads back the existing volume without changing the chosen level", { skip: process.platform !== "win32" }, async (t) => {
  const current = await executeWindowsAudio({ operation: "get" });
  if (!current.success || !current.observed) { t.skip("Windows audio output is unavailable on this host."); return; }
  const tool = createMobileToolRegistry().find((item) => item.name === "set_volume")!;
  const volumePercent = Math.round(current.observed.volumePercent);
  const result = await tool.handler({ volumePercent }, { signal: new AbortController().signal });
  assert.ok(await tool.verifier({ volumePercent }, result));
  assert.ok(Math.abs((result as any).observedVolume - volumePercent) <= 1);
});
