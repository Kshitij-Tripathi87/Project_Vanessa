/**
 * Phase 2.5: Audit Log
 *
 * SQLite-based audit log that records all tool executions, permission checks,
 * and results. Searchable by time, tool, device, result.
 */

import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import { PermissionTier } from '@vanessa/protocol';

interface AuditEntry {
  id?: number;
  timestamp: number;
  deviceId: string;
  taskId: string;
  tool: string;
  tier: PermissionTier;
  args: string; // JSON
  result?: string; // JSON
  error?: string;
  duration: number; // ms
  confirmed?: boolean;
}

interface AuditQuery {
  deviceId?: string;
  tool?: string;
  tier?: PermissionTier;
  success?: boolean;
  startTime?: number;
  endTime?: number;
  limit?: number;
}

/**
 * Audit Log - persistent logging of all tool executions
 */
export class AuditLog {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const defaultPath = path.join(os.homedir(), '.vanessa', 'audit.db');
    const dbFile = dbPath || defaultPath;
    this.db = new Database(dbFile);
    this.initDatabase();
  }

  /**
   * Initialize database schema
   */
  private initDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        tier TEXT NOT NULL,
        args TEXT NOT NULL,
        result TEXT,
        error TEXT,
        duration INTEGER NOT NULL,
        confirmed INTEGER DEFAULT 0,

        -- Indexes for common queries
        UNIQUE(task_id)
      );

      CREATE INDEX IF NOT EXISTS idx_timestamp ON audit_log(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_device_id ON audit_log(device_id);
      CREATE INDEX IF NOT EXISTS idx_tool ON audit_log(tool);
      CREATE INDEX IF NOT EXISTS idx_tier ON audit_log(tier);
    `);

    console.log('[Audit] Database initialized');
  }

  /**
   * Log a tool execution
   */
  logExecution(entry: AuditEntry): void {
    const stmt = this.db.prepare(`
      INSERT INTO audit_log (
        timestamp, device_id, task_id, tool, tier, args, result, error, duration, confirmed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      entry.timestamp,
      entry.deviceId,
      entry.taskId,
      entry.tool,
      entry.tier,
      entry.args,
      entry.result || null,
      entry.error || null,
      entry.duration,
      entry.confirmed ? 1 : 0
    );
  }

  /**
   * Query audit log
   */
  query(query: AuditQuery): AuditEntry[] {
    let sql = 'SELECT * FROM audit_log WHERE 1=1';
    const params: any[] = [];

    if (query.deviceId) {
      sql += ' AND device_id = ?';
      params.push(query.deviceId);
    }

    if (query.tool) {
      sql += ' AND tool = ?';
      params.push(query.tool);
    }

    if (query.tier) {
      sql += ' AND tier = ?';
      params.push(query.tier);
    }

    if (query.success !== undefined) {
      if (query.success) {
        sql += ' AND error IS NULL';
      } else {
        sql += ' AND error IS NOT NULL';
      }
    }

    if (query.startTime) {
      sql += ' AND timestamp >= ?';
      params.push(query.startTime);
    }

    if (query.endTime) {
      sql += ' AND timestamp <= ?';
      params.push(query.endTime);
    }

    sql += ' ORDER BY timestamp DESC';

    if (query.limit) {
      sql += ' LIMIT ?';
      params.push(query.limit);
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];

    return rows.map(row => ({
      id: row.id,
      timestamp: row.timestamp,
      deviceId: row.device_id,
      taskId: row.task_id,
      tool: row.tool,
      tier: row.tier as PermissionTier,
      args: row.args,
      result: row.result || undefined,
      error: row.error || undefined,
      duration: row.duration,
      confirmed: row.confirmed === 1,
    }));
  }

  /**
   * Get statistics
   */
  getStats(): {
    total: number;
    byTool: Record<string, number>;
    byTier: Record<string, number>;
    successRate: number;
    avgDuration: number;
  } {
    const total = this.db.prepare('SELECT COUNT(*) as count FROM audit_log').get() as any;

    const byTool = this.db.prepare(`
      SELECT tool, COUNT(*) as count
      FROM audit_log
      GROUP BY tool
    `).all() as any[];

    const byTier = this.db.prepare(`
      SELECT tier, COUNT(*) as count
      FROM audit_log
      GROUP BY tier
    `).all() as any[];

    const success = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM audit_log
      WHERE error IS NULL
    `).get() as any;

    const avgDuration = this.db.prepare(`
      SELECT AVG(duration) as avg
      FROM audit_log
    `).get() as any;

    return {
      total: total.count,
      byTool: Object.fromEntries(byTool.map(r => [r.tool, r.count])),
      byTier: Object.fromEntries(byTier.map(r => [r.tier, r.count])),
      successRate: total.count > 0 ? (success.count / total.count) * 100 : 0,
      avgDuration: avgDuration.avg || 0,
    };
  }

  /**
   * Get recent executions
   */
  getRecent(limit: number = 50): AuditEntry[] {
    return this.query({ limit });
  }

  /**
   * Get executions for a specific task
   */
  getByTaskId(taskId: string): AuditEntry | undefined {
    const stmt = this.db.prepare('SELECT * FROM audit_log WHERE task_id = ?');
    const row = stmt.get(taskId) as any;

    if (!row) return undefined;

    return {
      id: row.id,
      timestamp: row.timestamp,
      deviceId: row.device_id,
      taskId: row.task_id,
      tool: row.tool,
      tier: row.tier as PermissionTier,
      args: row.args,
      result: row.result || undefined,
      error: row.error || undefined,
      duration: row.duration,
      confirmed: row.confirmed === 1,
    };
  }

  /**
   * Export audit log to JSON
   */
  export(query: AuditQuery = {}): string {
    const entries = this.query({ ...query, limit: query.limit || 10000 });
    return JSON.stringify(entries, null, 2);
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}