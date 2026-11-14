import { randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalize,
  computeActionHash,
  type ApprovalBinding,
  type RemoteCapability,
  type RemotePermissionTier,
  type RemoteTaskState,
  type TaskSnapshot,
  type TargetDescriptor,
} from "@vanessa/protocol";
import * as fs from "node:fs";
import * as path from "node:path";
import { mobileToolRegistry, type MobileTool } from "./mobileToolRegistry.js";
import { privacyGuard } from "./privacy.js";

export type MobileTaskState = "queued" | "validating" | "awaiting_confirm" | "running" | "verifying" | "done" | "failed" | "cancelled" | "timed_out";
export type MobileTaskRecord = { taskId: string; requestId: string; tool: string; state: MobileTaskState; result?: unknown; error?: string; actionHash?: string };
export type MobileTaskRecoveryRecord = {
  snapshot: TaskSnapshot;
  task: MobileTaskRecord;
  canonicalArguments: Record<string, unknown>;
  confirmation?: { expiresAt: number; tier: MobileTool["tier"] };
};
export type MobileTaskEngineOptions = { dbPath?: string; tools?: MobileTool[]; now?: () => number; notify?: (event: { task: MobileTaskRecord; deviceId?: string; ephemeralResult?: unknown }) => void };

function redactStructured(value: unknown): unknown {
  if (typeof value === "string") return privacyGuard.redactSensitiveData(value).cleanText;
  if (Array.isArray(value)) return value.map(redactStructured);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactStructured(entry)]));
  return value;
}

/** Explicit PC-side capability scopes. Unknown tools are never exposed remotely. */
const REMOTE_CAPABILITY_SCOPES: Readonly<Record<string, readonly string[]>> = {
  system_status: ["system.read"],
  find_file: ["files.read"],
  open_app: ["apps.launch"],
  open_url: ["browser.open"],
  open_file: ["files.open"],
  set_volume: ["system.control"],
  delete_file: ["files.delete"],
  media_control: ["media.control"],
  lock_pc: ["system.lock"],
  take_screenshot: ["screen.capture"],
};

export const REMOTE_POLICY_VERSION = "mobile-policy-v1";

function remoteTier(tier: MobileTool["tier"]): RemotePermissionTier {
  return `T${tier}` as RemotePermissionTier;
}

export function createRemoteTargetDescriptor(tool: string, args: Record<string, unknown>): TargetDescriptor {
  if (tool === "delete_file" || tool === "open_file") {
    return { kind: "file", value: String(args.path ?? tool) };
  }
  if (tool === "open_url") return { kind: "url", value: String(args.url ?? "unknown URL") };
  if (tool === "open_app") return { kind: "app", value: String(args.app ?? "unknown app") };
  if (tool === "set_volume") return { kind: "setting", value: "Windows output volume" };
  if (tool === "media_control") return { kind: "media", value: String(args.control ?? "media control") };
  if (tool === "take_screenshot") return { kind: "system", value: "PC desktop screenshot" };
  if (tool === "lock_pc") return { kind: "system", value: "Windows session lock" };
  return { kind: "system", value: tool };
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

  /** Return only explicitly-reviewed capabilities with server-owned scopes and policy tiers. */
  getRemoteCapabilities(): RemoteCapability[] {
    return this.tools.flatMap((tool) => {
      const scopes = REMOTE_CAPABILITY_SCOPES[tool.name];
      if (!scopes) return [];
      return [{
        name: tool.name,
        version: 1,
        description: tool.description.slice(0, 300),
        tier: remoteTier(tool.tier),
        scopes: [...scopes],
        idempotent: tool.idempotent,
        timeoutMs: tool.timeoutMs,
        argumentsSchema: tool.manifestSchema,
      }];
    });
  }

  async submit(input: { requestId: string; idempotencyKey: string; tool: string; args: Record<string, unknown>; deviceId?: string }): Promise<{ taskId: string; requestId: string; acceptedAt: number; state: MobileTaskState; actionHash?: string; expiresAt?: number; summary?: string; duplicate: boolean }> {
    const deviceId = input.deviceId ?? "unknown";
    const found = this.db.prepare("SELECT task_id, request_id, created_at, state, action_hash, confirm_expires_at, tool, args_json FROM mobile_tasks WHERE device_id=? AND idempotency_key=?").get(deviceId, input.idempotencyKey) as any;

    // An idempotency key identifies one immutable operation, not merely one
    // response slot. Reusing it for a different capability or argument set
    // must fail closed instead of returning the old task as if it represented
    // the new request. Arguments are parsed first so schema defaults/coercions
    // are included, then compared using the protocol's JCS canonicalization.
    if (found && found.tool !== input.tool) {
      throw Object.assign(new Error("Idempotency key was already used for a different capability."), { code: "IDEMPOTENCY_CONFLICT" });
    }
    const tool = this.tools.find((item) => item.name === input.tool);
    if (!tool) throw Object.assign(new Error("Tool is not available on this PC."), { code: "INVALID_ARGUMENTS" });
    const parsed = tool.argsSchema.safeParse(input.args);
    if (!parsed.success) throw Object.assign(new Error("Tool arguments are invalid."), { code: "INVALID_ARGUMENTS" });
    if (found) {
      const existingTool = this.tools.find((item) => item.name === found.tool);
      const existingArgs = JSON.parse(found.args_json);
      if (canonicalize(existingArgs) !== canonicalize(parsed.data)) {
        throw Object.assign(new Error("Idempotency key was already used for different arguments."), { code: "IDEMPOTENCY_CONFLICT" });
      }
      return { taskId: found.task_id, requestId: found.request_id, acceptedAt: found.created_at, state: found.state, ...(found.action_hash ? { actionHash: found.action_hash } : {}), ...(found.confirm_expires_at ? { expiresAt: found.confirm_expires_at } : {}), ...(existingTool?.confirmSummary ? { summary: existingTool.confirmSummary(existingArgs) } : {}), duplicate: true };
    }
    const taskId = randomUUID();
    const initialState: MobileTaskState = tool.tier === 2 ? "awaiting_confirm" : "queued";
    const expiresAt = tool.tier === 2 ? this.now() + 120_000 : undefined;
    const actionHash = tool.tier === 2 ? this.actionHash(taskId, tool.name, parsed.data, expiresAt!) : undefined;
    const safeArgs = JSON.stringify(parsed.data);
    const createdAt = this.now();
    const transitions = [{ state: initialState, at: createdAt }];
    this.db.prepare(`INSERT INTO mobile_tasks(task_id,request_id,idempotency_key,device_id,tool,args_json,tier,state,action_hash,confirm_expires_at,created_at,updated_at,transitions_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(taskId, input.requestId, input.idempotencyKey, deviceId, tool.name, safeArgs, tool.tier, initialState, actionHash ?? null, expiresAt ?? null, createdAt, createdAt, JSON.stringify(transitions));
    this.audit(taskId, input.requestId, input.deviceId, tool, parsed.data, initialState, "Task accepted.");
    const record = { taskId, requestId: input.requestId, tool: tool.name, state: initialState, ...(actionHash ? { actionHash } : {}) };
    this.notify?.({ task: record, deviceId: input.deviceId });
    if (initialState === "queued") void this.execute(taskId, tool, parsed.data, input.deviceId);
    return { taskId, requestId: input.requestId, acceptedAt: createdAt, state: initialState, ...(actionHash ? { actionHash } : {}), ...(expiresAt ? { expiresAt } : {}), ...(tool.confirmSummary ? { summary: tool.confirmSummary(parsed.data) } : {}), duplicate: false };
  }

  async confirm(input: { taskId: string; approved: boolean; actionHash: string; deviceId: string }): Promise<void> {
    this.assertTaskOwner(input.taskId, input.deviceId);
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

  async cancel(taskId: string, deviceId: string): Promise<void> {
    this.assertTaskOwner(taskId, deviceId);
    const task = this.getTask(taskId);
    if (!task || ["done", "failed", "cancelled", "timed_out"].includes(task.state)) throw Object.assign(new Error("Task is not active."), { code: "TASK_NOT_FOUND" });
    this.active.get(taskId)?.abort();
    if (!this.active.has(taskId)) this.transition(task, "cancelled", { error: "Cancelled by phone." });
  }

  /** Resolve task ownership from the durable row, never from client-supplied payload fields. */
  private assertTaskOwner(taskId: string, deviceId: string): void {
    const row = this.db.prepare("SELECT device_id FROM mobile_tasks WHERE task_id=?").get(taskId) as { device_id?: string } | undefined;
    if (!row || typeof row.device_id !== "string" || row.device_id !== deviceId) {
      throw Object.assign(new Error("Task was not found for this device."), { code: "TASK_NOT_FOUND" });
    }
  }

  /**
   * Restore only task IDs supplied by the phone and owned by its authenticated
   * device identity. All state and results come from durable PC-side SQLite rows.
   */
  getTaskRecoveryForDevice(taskIds: string[], deviceId: string): MobileTaskRecoveryRecord[] {
    const ids = [...new Set(taskIds)]
      .filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      .slice(0, 50);
    const select = this.db.prepare(
      "SELECT task_id, request_id, tool, tier, state, created_at, updated_at, args_json, confirm_expires_at FROM mobile_tasks WHERE task_id=? AND device_id=?"
    );
    const stateMap: Record<MobileTaskState, RemoteTaskState> = {
      queued: "queued", validating: "validating", awaiting_confirm: "awaiting_approval",
      running: "running", verifying: "verifying", done: "succeeded", failed: "failed",
      cancelled: "cancelled", timed_out: "timed_out",
    };
    const remoteNames = new Set(this.getRemoteCapabilities().map((capability) => capability.name));
    const recovered: MobileTaskRecoveryRecord[] = [];
    for (const taskId of ids) {
      const row = select.get(taskId, deviceId) as {
        task_id: string; request_id: string; tool: string; tier: number; state: MobileTaskState;
        created_at: number; updated_at: number; args_json: string; confirm_expires_at: number | null;
      } | undefined;
      if (!row || !remoteNames.has(row.tool as never)) continue;
      const task = this.getTask(taskId);
      if (!task) continue;
      const terminal = ["done", "failed", "cancelled", "timed_out"].includes(row.state);
      const safeSummary = row.state === "done"
        ? "The PC task completed and passed its independent verifier."
        : row.state === "awaiting_confirm"
          ? "The PC task is awaiting an approval decision."
          : terminal
            ? "The PC task ended without a verified successful result."
            : "The PC task is " + row.state.replace(/_/g, " ") + " on the PC.";
      recovered.push({
        snapshot: {
          taskId: row.task_id,
          requestId: row.request_id,
          capability: row.tool as TaskSnapshot["capability"],
          state: stateMap[row.state] ?? "unknown",
          tier: remoteTier(row.tier as MobileTool["tier"]),
          taskVersion: 1,
          acceptedAt: row.created_at,
          updatedAt: row.updated_at,
          ...(terminal ? { completedAt: row.updated_at } : {}),
          safeSummary,
        },
        task,
        canonicalArguments: JSON.parse(row.args_json) as Record<string, unknown>,
        ...(row.state === "awaiting_confirm" && task.actionHash && typeof row.confirm_expires_at === "number"
          ? { confirmation: { expiresAt: row.confirm_expires_at, tier: row.tier as MobileTool["tier"] } }
          : {}),
      });
    }
    return recovered;
  }

  /** Read a task only after validating its durable device ownership. */
  getTaskForDevice(taskId: string, deviceId: string): MobileTaskRecord | undefined {
    this.assertTaskOwner(taskId, deviceId);
    return this.getTask(taskId);
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

  private actionHash(taskId: string, tool: string, args: unknown, expiresAt: number): string {
    const canonicalArguments = args as Record<string, unknown>;
    const binding: ApprovalBinding = {
      taskId,
      taskVersion: 1,
      capability: tool,
      capabilityVersion: 1,
      canonicalArguments,
      target: createRemoteTargetDescriptor(tool, canonicalArguments),
      policyVersion: REMOTE_POLICY_VERSION,
      expiresAt,
    };
    return computeActionHash(binding);
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
