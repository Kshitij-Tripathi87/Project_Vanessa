import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from "sql.js";
import type { PersistedConversationState } from "@vanessa/protocol/conversation";
import type { PcIdentityEncryptionAdapter } from "./remotePcIdentityStore.js";

const conversationProtocol = import("@vanessa/protocol/conversation");
const MAX_DATABASE_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const FORMAT_VERSION = 1;

/** Immutable local-only migrations. Their checksums are verified before use. */
export const LOCAL_CONVERSATION_MIGRATIONS = [
  {
    id: 1,
    sql: `CREATE TABLE vault_keys (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      wrapped_key BLOB NOT NULL
    );
    CREATE TABLE conversation_snapshots (
      slot TEXT PRIMARY KEY CHECK (slot = 'current'),
      conversation_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      nonce BLOB NOT NULL,
      ciphertext BLOB NOT NULL,
      auth_tag BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );`,
  },
  {
    id: 2,
    sql: "ALTER TABLE conversation_snapshots ADD COLUMN format_version INTEGER NOT NULL DEFAULT 1;",
  },
] as const;

export type ConversationStoreErrorCode = "encryption_unavailable" | "invalid_snapshot" | "conflict" | "corrupt" | "storage";

/** Error messages never contain a conversation, key, or filesystem path. */
export class ConversationStoreError extends Error {
  constructor(readonly code: ConversationStoreErrorCode, message: string) {
    super(message);
    this.name = "ConversationStoreError";
  }
}

export interface ConversationLoadResult {
  state: PersistedConversationState | null;
  revision: number;
}

type Row = Record<string, SqlValue>;

function firstRow(db: Database, sql: string, values: SqlValue[] = []): Row | undefined {
  const statement = db.prepare(sql);
  try {
    statement.bind(values);
    return statement.step() ? statement.getAsObject() : undefined;
  } finally {
    statement.free();
  }
}

function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

function applyMigrations(db: Database): boolean {
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  const names = tables[0]?.values.map((row) => String(row[0])) ?? [];
  if (!names.includes("schema_migrations")) {
    if (names.length !== 0) throw new ConversationStoreError("corrupt", "Local history has an unrecognized schema.");
    db.run("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)");
  }
  const existing = db.exec("SELECT id, checksum FROM schema_migrations ORDER BY id");
  const rows = existing[0]?.values ?? [];
  for (let index = 0; index < rows.length; index += 1) {
    const migration = LOCAL_CONVERSATION_MIGRATIONS[index];
    if (!migration || rows[index][0] !== migration.id || rows[index][1] !== migrationChecksum(migration.sql)) {
      throw new ConversationStoreError("corrupt", "Local history has an unsupported or altered migration.");
    }
  }
  if (rows.length === LOCAL_CONVERSATION_MIGRATIONS.length) return false;
  db.run("BEGIN TRANSACTION");
  try {
    for (const migration of LOCAL_CONVERSATION_MIGRATIONS.slice(rows.length)) {
      db.run(migration.sql);
      db.run("INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)", [migration.id, migrationChecksum(migration.sql), Date.now()]);
    }
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
  return true;
}

function atomicWrite(filePath: string, bytes: Uint8Array): void {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, filePath);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function associatedData(conversationId: string, revision: number): Buffer {
  return Buffer.from(`vanessa:desktop-conversation:${FORMAT_VERSION}:${conversationId}:${revision}`, "utf8");
}

function asBytes(value: SqlValue | undefined, length?: number): Buffer {
  if (!(value instanceof Uint8Array) || (length !== undefined && value.byteLength !== length)) {
    throw new ConversationStoreError("corrupt", "Local history contains invalid encrypted data.");
  }
  return Buffer.from(value);
}

/**
 * Single-device, single-writer repository for one bounded desktop conversation.
 * SQLite contains ciphertext and minimal metadata only. The random AES-GCM key
 * is wrapped by Electron's OS-backed safeStorage adapter and never reaches the
 * renderer. The application enforces a single Electron instance. This store is
 * not a multi-user ledger, task journal, sync service or key-recovery mechanism.
 */
export class LocalConversationStore {
  private sql?: SqlJsStatic;
  private db?: Database;
  private key?: Buffer;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly protector: PcIdentityEncryptionAdapter,
    private readonly writeBytes: (path: string, bytes: Uint8Array) => void = atomicWrite,
  ) {
    if (!filePath.trim()) throw new Error("A local history path is required.");
  }

  load(): Promise<ConversationLoadResult> {
    return this.enqueue(async () => {
      await this.open();
      return this.readSnapshot();
    });
  }

  save(value: unknown, expectedRevision: number): Promise<number> {
    return this.enqueue(async () => {
      await this.open();
      const { PersistedConversationStateSchema } = await conversationProtocol;
      const parsed = PersistedConversationStateSchema.safeParse(value);
      if (!parsed.success || parsed.data.turns.length === 0) {
        throw new ConversationStoreError("invalid_snapshot", "Local history snapshot is invalid or empty.");
      }
      const serialized = JSON.stringify(parsed.data);
      if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
        throw new ConversationStoreError("invalid_snapshot", "Local history snapshot is too large.");
      }
      const current = await this.readSnapshot();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision ||
          current.revision >= Number.MAX_SAFE_INTEGER ||
          (current.state && current.state.conversationId !== parsed.data.conversationId)) {
        throw new ConversationStoreError("conflict", "Local history changed; refusing to overwrite it.");
      }

      const db = this.db!;
      const before = db.export();
      let newKey: Buffer | undefined;
      try {
        db.run("BEGIN TRANSACTION");
        let key = this.key;
        if (!key) {
          newKey = randomBytes(32);
          const wrapped = this.protector.encrypt(newKey.toString("base64"));
          if (!Buffer.isBuffer(wrapped) || wrapped.length === 0) throw new Error("Key wrapping failed.");
          db.run("INSERT INTO vault_keys (id, wrapped_key) VALUES (1, ?)", [wrapped]);
          key = newKey;
        }
        const revision = current.revision + 1;
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(associatedData(parsed.data.conversationId, revision));
        const ciphertext = Buffer.concat([cipher.update(serialized, "utf8"), cipher.final()]);
        const tag = cipher.getAuthTag();
        db.run(`INSERT INTO conversation_snapshots
          (slot, conversation_id, revision, nonce, ciphertext, auth_tag, updated_at, format_version)
          VALUES ('current', ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(slot) DO UPDATE SET conversation_id=excluded.conversation_id, revision=excluded.revision,
          nonce=excluded.nonce, ciphertext=excluded.ciphertext, auth_tag=excluded.auth_tag,
          updated_at=excluded.updated_at, format_version=excluded.format_version`,
        [parsed.data.conversationId, revision, nonce, ciphertext, tag, Date.now(), FORMAT_VERSION]);
        db.run("COMMIT");
        this.writeBytes(this.filePath, db.export());
        if (newKey) this.key = newKey;
        return revision;
      } catch (error) {
        db.close();
        this.db = new this.sql!.Database(before);
        newKey?.fill(0);
        if (error instanceof ConversationStoreError) throw error;
        throw new ConversationStoreError("storage", "Local history could not be saved.");
      }
    });
  }

  /** Replace the active DB with an empty vault, including a new key on next save. */
  clear(expectedRevision: number): Promise<void> {
    return this.enqueue(async () => {
      await this.open();
      const current = await this.readSnapshot();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) {
        throw new ConversationStoreError("conflict", "Local history changed; refusing to clear it.");
      }
      const replacement = new this.sql!.Database();
      try {
        applyMigrations(replacement);
        this.writeBytes(this.filePath, replacement.export());
      } catch {
        replacement.close();
        throw new ConversationStoreError("storage", "Local history could not be cleared.");
      }
      this.db!.close();
      this.db = replacement;
      this.key?.fill(0);
      this.key = undefined;
    });
  }

  close(): Promise<void> {
    return this.enqueue(async () => {
      this.db?.close();
      this.db = undefined;
      this.key?.fill(0);
      this.key = undefined;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async open(): Promise<void> {
    if (!this.protector.isAvailable()) {
      throw new ConversationStoreError("encryption_unavailable", "OS-backed encryption is unavailable; local history is not saved.");
    }
    if (this.db) return;
    const sql = this.sql ?? await initSqlJs();
    this.sql = sql;
    let bytes: Buffer | undefined;
    try {
      const stat = statSync(this.filePath);
      if (!stat.isFile() || stat.size > MAX_DATABASE_BYTES) throw new ConversationStoreError("corrupt", "Local history is not a valid bounded database.");
      bytes = readFileSync(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof ConversationStoreError) throw error;
        throw new ConversationStoreError("storage", "Local history could not be opened.");
      }
    }

    let db: Database | undefined;
    try {
      db = bytes ? new sql.Database(bytes) : new sql.Database();
      const integrity = db.exec("PRAGMA integrity_check");
      if (integrity[0]?.values[0]?.[0] !== "ok") throw new ConversationStoreError("corrupt", "Local history failed its integrity check.");
      const migrated = applyMigrations(db);
      this.db = db;
      // A corrupt or undecryptable existing vault is never overwritten by a migration.
      await this.readSnapshot();
      if (bytes && migrated) this.writeBytes(this.filePath, db.export());
    } catch (error) {
      db?.close();
      this.db = undefined;
      this.key?.fill(0);
      this.key = undefined;
      if (error instanceof ConversationStoreError) throw error;
      throw new ConversationStoreError("corrupt", "Local history is corrupt or cannot be decrypted.");
    }
  }

  private async readSnapshot(): Promise<ConversationLoadResult> {
    const db = this.db!;
    const row = firstRow(db, "SELECT conversation_id, revision, nonce, ciphertext, auth_tag, format_version FROM conversation_snapshots WHERE slot='current'");
    const keyRow = firstRow(db, "SELECT wrapped_key FROM vault_keys WHERE id=1");
    if (!row && !keyRow) return { state: null, revision: 0 };
    if (!row || !keyRow || typeof row.conversation_id !== "string" ||
        typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 1 || row.format_version !== FORMAT_VERSION) {
      throw new ConversationStoreError("corrupt", "Local history metadata is invalid.");
    }
    try {
      if (!this.key) {
        const unwrapped = this.protector.decrypt(asBytes(keyRow.wrapped_key));
        if (!/^[A-Za-z0-9+/]{43}=$/.test(unwrapped)) throw new Error("Invalid key encoding.");
        const key = Buffer.from(unwrapped, "base64");
        if (key.length !== 32) throw new Error("Invalid key length.");
        this.key = key;
      }
      const ciphertext = asBytes(row.ciphertext);
      if (ciphertext.length > MAX_SNAPSHOT_BYTES) throw new Error("Snapshot too large.");
      const decipher = createDecipheriv("aes-256-gcm", this.key, asBytes(row.nonce, 12));
      decipher.setAAD(associatedData(row.conversation_id, row.revision));
      decipher.setAuthTag(asBytes(row.auth_tag, 16));
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      const { PersistedConversationStateSchema } = await conversationProtocol;
      const parsed = PersistedConversationStateSchema.parse(JSON.parse(plaintext));
      if (parsed.conversationId !== row.conversation_id || parsed.turns.length === 0) throw new Error("Mismatched conversation.");
      return { state: parsed, revision: row.revision };
    } catch {
      throw new ConversationStoreError("corrupt", "Local history is corrupt or cannot be decrypted.");
    }
  }
}
