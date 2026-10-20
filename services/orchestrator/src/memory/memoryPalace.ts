import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import * as fs from "node:fs";
import { privacyGuard } from "../core/privacy.js";
import { eventBus } from "../core/eventBus.js";

export interface MemoryRecord {
  id: string;
  type: "task" | "plan" | "incident" | "user_preference" | "knowledge";
  title: string;
  content: string;
  rawData?: any;
  agent: string;
  status: "success" | "failed" | "active";
  createdAt: number;
  expiresAt: number;
}

export class MemoryPalace {
  private db: DatabaseSync;
  private dbPath: string;
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor(customPath?: string) {
    const dataDir = path.resolve(process.cwd(), "data");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.dbPath = customPath || path.join(dataDir, "vanessa_memory_palace.db");
    this.db = new DatabaseSync(this.dbPath);

    this.initSchema();
    this.pruneExpired();

    // Automated 30-day retention prune check every 6 hours
    this.pruneTimer = setInterval(() => {
      this.pruneExpired();
    }, 6 * 60 * 60 * 1000);
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_palace (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        raw_data TEXT,
        agent TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mem_created ON memory_palace(created_at);
      CREATE INDEX IF NOT EXISTS idx_mem_expires ON memory_palace(expires_at);
      CREATE INDEX IF NOT EXISTS idx_mem_type ON memory_palace(type);
    `);

    // Seed default historical incident if empty
    const countRow: any = this.db.prepare("SELECT count(*) as count FROM memory_palace").get();
    if (!countRow || countRow.count === 0) {
      this.storeMemory({
        id: "INC-842",
        type: "incident",
        title: "INC-842: Checkout 500 Promo Error",
        content: "Checkout service failing with 500 error due to null promo discount. Fix: null-safe accessor promo?.discountRate ?? 0",
        agent: "it_ops",
        status: "success",
        ttlDays: 30,
      });
    }
  }

  /**
   * Store new contextual memory record with automatic privacy redaction and 30-day retention TTL
   */
  storeMemory(params: {
    id?: string;
    type: "task" | "plan" | "incident" | "user_preference" | "knowledge";
    title: string;
    content: string;
    rawData?: any;
    agent: string;
    status?: "success" | "failed" | "active";
    ttlDays?: number;
  }): MemoryRecord {
    const id = params.id || `mem_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const now = Date.now();
    const ttlDays = params.ttlDays ?? 30; // 30-day retention palace
    const expiresAt = now + (ttlDays * 24 * 60 * 60 * 1000);

    // Apply strict privacy redaction before writing
    const redacted = privacyGuard.redactSensitiveData(params.content);
    const cleanContent = redacted.cleanText;

    let serializedData = "";
    if (params.rawData) {
      try {
        const rawStr = JSON.stringify(params.rawData);
        serializedData = privacyGuard.redactSensitiveData(rawStr).cleanText;
      } catch {
        serializedData = "{}";
      }
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memory_palace 
      (id, type, title, content, raw_data, agent, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      params.type,
      params.title,
      cleanContent,
      serializedData,
      params.agent,
      params.status || "success",
      now,
      expiresAt
    );

    eventBus.emitEvent("audit:log", {
      id: `audit-${Date.now()}`,
      timestamp: Date.now(),
      source: "desktop_hud",
      agent: params.agent,
      action: "memory_palace.store",
      resource: `MemoryPalace:${params.type}:${id}`,
      risk: "low",
      permission: "allowed",
      status: "success",
      result: { id, title: params.title, retentionDays: ttlDays },
      details: `Persisted record to Memory Palace with 30-day TTL (expires ${new Date(expiresAt).toISOString()})`,
    });

    return {
      id,
      type: params.type,
      title: params.title,
      content: cleanContent,
      rawData: params.rawData,
      agent: params.agent,
      status: params.status || "success",
      createdAt: now,
      expiresAt,
    };
  }

  /**
   * Search memory palace with keyword/context matching within active 30-day window
   */
  retrieve(query: string, limit = 10): MemoryRecord[] {
    const cleanQuery = `%${(query || "").trim().toLowerCase()}%`;
    const now = Date.now();

    const stmt = this.db.prepare(`
      SELECT * FROM memory_palace 
      WHERE expires_at > ? 
        AND (LOWER(content) LIKE ? OR LOWER(title) LIKE ? OR LOWER(type) LIKE ?)
      ORDER BY created_at DESC 
      LIMIT ?
    `);

    const rows = stmt.all(now, cleanQuery, cleanQuery, cleanQuery, limit) as any[];

    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      content: r.content,
      agent: r.agent,
      status: r.status,
      createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at),
    }));
  }

  /**
   * Get all active contextual memories for planning
   */
  getRecentContext(limit = 10): string[] {
    const now = Date.now();
    const stmt = this.db.prepare(`
      SELECT title, content FROM memory_palace
      WHERE expires_at > ?
      ORDER BY created_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(now, limit) as any[];
    return rows.map((r) => `${r.title}: ${r.content}`);
  }

  /**
   * Automated pruning: Purges entries strictly older than 30 days.
   * No manual deletion is permitted.
   */
  pruneExpired(): number {
    const now = Date.now();
    const stmt = this.db.prepare("DELETE FROM memory_palace WHERE expires_at <= ?");
    const result = stmt.run(now);
    const count = Number(result.changes);

    if (count > 0) {
      console.log(`[MemoryPalace] Pruned ${count} memories older than 30 days.`);
      eventBus.emitEvent("audit:log", {
        id: `audit-${Date.now()}`,
        timestamp: Date.now(),
        source: "orchestrator",
        agent: "memory",
        action: "memory_palace.prune_ttl",
        resource: "SQLite Memory Palace",
        risk: "low",
        permission: "allowed",
        status: "info",
        details: `Cleaned up ${count} records older than 30-day retention window`,
      });
    }

    return count;
  }

  /**
   * Enforcement: Manual deletion is strictly blocked to maintain immutable audit memory
   */
  deleteManual(_id: string): { success: false; reason: string } {
    return {
      success: false,
      reason: "Memory Palace is immutable and cannot be manually deleted. Records are automatically retained for 30 days and pruned thereafter.",
    };
  }

  close(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    this.db.close();
  }
}

export const memoryPalace = new MemoryPalace();
