import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { mobileToolRegistry, type MobileTool } from "./mobileToolRegistry.js";
import { privacyGuard } from "./privacy.js";

export type MobileTaskState = "queued" | "validating" | "awaiting_confirm" | "running" | "verifying" | "done" | "failed" | "cancelled" | "timed_out";
export type MobileTaskRecord = { taskId: string; requestId: string; tool: string; state: MobileTaskState; result?: unknown; error?: string; actionHash?: string };
export type MobileTaskEngineOptions = { dbPath?: string; tools?: MobileTool[]; now?: () => number; notify?: (event: { task: MobileTaskRecord; deviceId?: string; ephemeralResult?: unknown }) => void };

function redactStructured(value: unknown): unknown {
  if (typeof value === "string") return privacyGuard.redactSensitiveData(value).cleanText;
  if (Array.isArray(value)) return value.map(redactStructured);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactStructured(entry)]));
  return value;
}

export class MobileTaskEngine {
  private readonly db: DatabaseSync;
  private readonly tools: MobileTool[];
  private readonly now: () => number;
  private readonly notify?: MobileTaskEngineOptions["notify"];
  private readonly active = new Map<string, AbortController>();
  private uiTail: Promise<void> = Promise.resolve();

  constructor(options: MobileTaskEngineOptions = {}) {
    this.tools = options.tools ?? mobileToolRegistry;
    this.now = options.now ?? Date.now;
    this.notify = options.notify;
    const dbPath = options.dbPath ?? process.env.VANESSA_MOBILE_DB ?? path.resolve(process.cwd(), "data", "vanessa_mobile_agent.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mobile_tasks (
        task_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        device_id TEXT, tool TEXT NOT NULL, args_json TEXT NOT NULL, tier INTEGER NOT NULL,
        state TEXT NOT NULL, action_hash TEXT, confirm_expires_at INTEGER, result_json TEXT, error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, transitions_json TEXT NOT NULL,
        UNIQUE(device_id,idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS mobile_audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, device_id TEXT,
        task_id TEXT NOT NULL, request_id TEXT NOT NULL, tool TEXT NOT NULL, args_json TEXT NOT NULL,
        tier INTEGER NOT NULL, state TEXT NOT NULL, result_summary TEXT, duration_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS mobile_audit_task ON mobile_audit(task_id, seq);
      CREATE TRIGGER IF NOT EXISTS mobile_audit_no_update BEFORE UPDATE ON mobile_audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS mobile_audit_no_delete BEFORE DELETE ON mobile_audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
    `);
    const columns = this.db.prepare("PRAGMA table_info(mobile_tasks)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "confirm_expires_at")) this.db.exec("ALTER TABLE mobile_tasks ADD COLUMN confirm_expires_at INTEGER");
    const stamp = this.now();
    this.db.prepare("UPDATE mobile_tasks SET state='failed', error='Orchestrator restarted while task was active.', updated_at=? WHERE state IN ('queued','validating','running','verifying')").run(stamp);
  }

  getManifest() { return { version: "1.0.0", tools: this.tools.map(({ name, description, manifestSchema, tier }) => ({ name, description, argsSchema: manifestSchema, tier })) }; }

  async submit(input: { requestId: string; idempotencyKey: string; tool: string; args: Record<string, unknown>; deviceId?: string }): Promise<{ taskId: string; state: MobileTaskState; actionHash?: string; expiresAt?: number; summary?: string; duplicate: boolean }> {
    const deviceId = input.deviceId ?? "unknown";
    const found = this.db.prepare("SELECT task_id, state, action_hash, confirm_expires_at, tool, args_json FROM mobile_tasks WHERE device_id=? AND idempotency_key=?").get(deviceId, input.idempotencyKey) as any;
    if (found) {
      const existingTool = this.tools.find((item) => item.name === found.tool);
      const existingArgs = JSON.parse(found.args_json);
      return { taskId: found.task_id, state: found.state, ...(found.action_hash ? { actionHash: found.action_hash } : {}), ...(found.confirm_expires_at ? { expiresAt: found.confirm_expires_at } : {}), ...(existingTool?.confirmSummary ? { summary: existingTool.confirmSummary(existingArgs) } : {}), duplicate: true };
    }
    const tool = this.tools.find((item) => item.name === input.tool);
    if (!tool) throw Object.assign(new Error("Tool is not available on this PC."), { code: "INVALID_ARGUMENTS" });
    const parsed = tool.argsSchema.safeParse(input.args);
    if (!parsed.success) throw Object.assign(new Error("Tool arguments are invalid."), { code: "INVALID_ARGUMENTS" });
    const taskId = randomUUID();
    const initialState: MobileTaskState = tool.tier === 2 ? "awaiting_confirm" : "queued";
    const actionHash = tool.tier === 2 ? this.actionHash(taskId, tool.name, parsed.data) : undefined;
    const expiresAt = tool.tier === 2 ? this.now() + 120_000 : undefined;
    const safeArgs = JSON.stringify(parsed.data);
    const transitions = [{ state: initialState, at: this.now() }];
    this.db.prepare(`INSERT INTO mobile_tasks(task_id,request_id,idempotency_key,device_id,tool,args_json,tier,state,action_hash,confirm_expires_at,created_at,updated_at,transitions_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(taskId, input.requestId, input.idempotencyKey, deviceId, tool.name, safeArgs, tool.tier, initialState, actionHash ?? null, expiresAt ?? null, this.now(), this.now(), JSON.stringify(transitions));
    this.audit(taskId, input.requestId, input.deviceId, tool, parsed.data, initialState, "Task accepted.");
    const record = { taskId, requestId: input.requestId, tool: tool.name, state: initialState, ...(actionHash ? { actionHash } : {}) };
    this.notify?.({ task: record, deviceId: input.deviceId });
    if (initialState === "queued") void this.execute(taskId, tool, parsed.data, input.deviceId);
    return { taskId, state: initialState, ...(actionHash ? { actionHash } : {}), ...(expiresAt ? { expiresAt } : {}), ...(tool.confirmSummary ? { summary: tool.confirmSummary(parsed.data) } : {}), duplicate: false };
  }

  async confirm(input: { taskId: string; approved: boolean; actionHash: string }): Promise<void> {
    const task = this.getTask(input.taskId);
    if (!task || task.state !== "awaiting_confirm") throw Object.assign(new Error("Task is not awaiting confirmation."), { code: "TASK_NOT_FOUND" });
    const expiry = this.db.prepare("SELECT confirm_expires_at FROM mobile_tasks WHERE task_id=?").get(input.taskId) as any;
    if (typeof expiry.confirm_expires_at === "number" && expiry.confirm_expires_at <= this.now()) {
      this.transition(task, "cancelled", { error: "Confirmation expired." });
      throw Object.assign(new Error("Confirmation has expired."), { code: "CONFIRMATION_EXPIRED" });
    }
    const expected = Buffer.from(task.actionHash ?? "");
    const supplied = Buffer.from(input.actionHash);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw Object.assign(new Error("Confirmation does not match the approved action."), { code: "PERMISSION_DENIED" });
    if (!input.approved) { this.transition(task, "cancelled", { error: "User denied confirmation." }); return; }
    const tool = this.tools.find((item) => item.name === task.tool)!;
    const row = this.db.prepare("SELECT args_json, device_id FROM mobile_tasks WHERE task_id=?").get(input.taskId) as any;
    this.transition(task, "queued");
    void this.execute(input.taskId, tool, JSON.parse(row.args_json), row.device_id ?? undefined);
  }

  async cancel(taskId: string): Promise<void> {
    const task = this.getTask(taskId);
    if (!task || ["done", "failed", "cancelled", "timed_out"].includes(task.state)) throw Object.assign(new Error("Task is not active."), { code: "TASK_NOT_FOUND" });
    this.active.get(taskId)?.abort();
    if (!this.active.has(taskId)) this.transition(task, "cancelled", { error: "Cancelled by phone." });
  }

  getTask(taskId: string): MobileTaskRecord | undefined {
    const row = this.db.prepare("SELECT task_id, request_id, tool, state, result_json, error, action_hash FROM mobile_tasks WHERE task_id=?").get(taskId) as any;
    if (!row) return undefined;
    return { taskId: row.task_id, requestId: row.request_id, tool: row.tool, state: row.state, ...(row.result_json ? { result: JSON.parse(row.result_json) } : {}), ...(row.error ? { error: row.error } : {}), ...(row.action_hash ? { actionHash: row.action_hash } : {}) };
  }

  recentAudit(limit = 100) {
    const count = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.db.prepare("SELECT seq,at,device_id AS deviceId,task_id AS taskId,request_id AS requestId,tool,args_json AS args,tier,state,result_summary AS resultSummary,duration_ms AS durationMs FROM mobile_audit ORDER BY seq DESC LIMIT ?").all(count);
  }

  close(): void { this.db.close(); }

  private actionHash(taskId: string, tool: string, args: unknown): string {
    return createHash("sha256").update(JSON.stringify({ taskId, tool, args })).digest("hex");
  }

  private async execute(taskId: string, tool: MobileTool, args: unknown, deviceId?: string): Promise<void> {
    const run = async () => this.executeOne(taskId, tool, args, deviceId);
    if (tool.queue === "ui") {
      const next = this.uiTail.then(run, run).then(() => undefined, () => undefined);
      this.uiTail = next;
      await next;
    } else await run();
  }

  private async executeOne(taskId: string, tool: MobileTool, args: unknown, deviceId?: string): Promise<void> {
    let task = this.getTask(taskId);
    if (!task || task.state !== "queued") return;
    this.transition(task, "validating");
    const valid = tool.argsSchema.safeParse(args);
    if (!valid.success) { this.transition(task, "failed", { error: "Arguments failed validation." }); return; }
    this.transition(task, "running");
    const controller = new AbortController();
    this.active.set(taskId, controller);
    const started = this.now();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error("Tool timed out."), { code: "TASK_TIMED_OUT" })); }, tool.timeoutMs);
    });
    try {
      let result: unknown;
      for (let attempt = 0; ; attempt++) {
        try { result = await Promise.race([tool.handler(valid.data, { signal: controller.signal }), timeout]); break; }
        catch (error) {
          if (!tool.idempotent || attempt >= 1 || controller.signal.aborted) throw error;
          await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
        }
      }
      task = this.getTask(taskId)!;
      if (task.state === "cancelled") return;
      this.transition(task, "verifying");
      if (!(await tool.verifier(valid.data, result))) throw Object.assign(new Error("Tool result did not pass verification."), { code: "TASK_FAILED" });
      task = this.getTask(taskId)!;
      const safeResult = tool.persistResult === false ? undefined : redactStructured(result);
      this.audit(taskId, task.requestId, deviceId, tool, valid.data, "done", "Verified result returned.", this.now() - started);
      this.transition(task, "done", { ...(safeResult !== undefined ? { result: safeResult } : {}) }, tool.persistResult === false ? result : undefined);
    } catch (error) {
      task = this.getTask(taskId)!;
      const code = (error as any)?.code;
      const state: MobileTaskState = code === "TASK_CANCELLED" ? "cancelled" : code === "TASK_TIMED_OUT" ? "timed_out" : "failed";
      this.audit(taskId, task.requestId, deviceId, tool, valid.data, state, "Task ended without a verified result.", this.now() - started);
      if (!["done", "failed", "cancelled", "timed_out"].includes(task.state)) this.transition(task, state, { error: privacyGuard.redactSensitiveData(String((error as Error)?.message ?? "Tool failed.")).cleanText.slice(0, 500) });
    } finally {
      if (timer) clearTimeout(timer);
      this.active.delete(taskId);
    }
  }

  private transition(task: MobileTaskRecord, state: MobileTaskState, extra: { result?: unknown; error?: string } = {}, ephemeralResult?: unknown): void {
    const now = this.now();
    const row = this.db.prepare("SELECT transitions_json, device_id FROM mobile_tasks WHERE task_id=?").get(task.taskId) as any;
    const transitions = JSON.parse(row.transitions_json) as Array<{ state: MobileTaskState; at: number }>;
    transitions.push({ state, at: now });
    this.db.prepare("UPDATE mobile_tasks SET state=?,result_json=?,error=?,updated_at=?,transitions_json=? WHERE task_id=?").run(state, extra.result === undefined ? null : JSON.stringify(extra.result), extra.error ?? null, now, JSON.stringify(transitions), task.taskId);
    const updated = { ...task, state, ...extra };
    this.notify?.({ task: updated, deviceId: row.device_id ?? undefined, ...(ephemeralResult !== undefined ? { ephemeralResult } : {}) });
  }

  private audit(taskId: string, requestId: string, deviceId: string | undefined, tool: MobileTool, args: unknown, state: string, summary: string, duration?: number): void {
    const redactedArgs = JSON.stringify(redactStructured(args));
    const redactedSummary = privacyGuard.redactSensitiveData(summary).cleanText;
    this.db.prepare("INSERT INTO mobile_audit(at,device_id,task_id,request_id,tool,args_json,tier,state,result_summary,duration_ms) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(this.now(), deviceId ?? null, taskId, requestId, tool.name, redactedArgs, tool.tier, state, redactedSummary, duration ?? null);
  }
}
