import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import initSqlJs from "sql.js";
import { applyConversationEvent, initialConversationState, projectPersistedConversation } from "@vanessa/protocol/conversation";
import { LOCAL_CONVERSATION_MIGRATIONS, LocalConversationStore, ConversationStoreError } from "./localConversationStore.js";
import type { PcIdentityEncryptionAdapter } from "./remotePcIdentityStore.js";

/** Synthetic key wrapper; real application uses Electron OS-backed safeStorage. */
class TestProtector implements PcIdentityEncryptionAdapter {
  available = true;
  private readonly key = randomBytes(32);
  isAvailable() { return this.available; }
  encrypt(plaintext: string): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    return Buffer.concat([nonce, cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  }
  decrypt(ciphertext: Buffer): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key, ciphertext.subarray(0, 12));
    decipher.setAuthTag(ciphertext.subarray(-16));
    return Buffer.concat([decipher.update(ciphertext.subarray(12, -16)), decipher.final()]).toString("utf8");
  }
}

const conversationId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";

function snapshot(content = "private synthetic conversation", id = conversationId) {
  let state = initialConversationState(id);
  state = applyConversationEvent(state, { type: "turn.received", conversationId: id, turnId, requestId, role: "user", source: "text", createdAt: 42 });
  state = applyConversationEvent(state, { type: "transcript.final", conversationId: id, turnId, text: content });
  return projectPersistedConversation(state);
}

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "vanessa-conversation-store-"));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function hasCode(code: ConversationStoreError["code"]) {
  return (error: unknown) => error instanceof ConversationStoreError && error.code === code;
}

test("encrypted SQLite conversation survives restart without plaintext on disk", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "data", "conversation.sqlite");
    const protector = new TestProtector();
    const first = new LocalConversationStore(path, protector);
    assert.deepEqual(await first.load(), { state: null, revision: 0 });
    const state = snapshot();
    assert.equal(await first.save(state, 0), 1);
    const bytes = await readFile(path);
    assert.equal(bytes.subarray(0, 15).toString("utf8"), "SQLite format 3");
    assert.equal(bytes.includes(Buffer.from(state.turns[0].text)), false);
    await first.close();

    const reopened = new LocalConversationStore(path, protector);
    assert.deepEqual(await reopened.load(), { state, revision: 1 });
    assert.equal(await reopened.save(snapshot("another private turn"), 1), 2);
    assert.equal((await reopened.load()).revision, 2);
    assert.equal((await readFile(path)).includes(Buffer.from("another private turn")), false);
    await reopened.close();
  });
});

test("missing OS encryption never creates or overwrites history", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "history.sqlite");
    const protector = new TestProtector();
    protector.available = false;
    const store = new LocalConversationStore(path, protector);
    await assert.rejects(store.load(), hasCode("encryption_unavailable"));
    await assert.rejects(store.save(snapshot(), 0), hasCode("encryption_unavailable"));
    assert.equal(existsSync(path), false);
    protector.available = true;
    await store.save(snapshot(), 0);
    const before = await readFile(path);
    protector.available = false;
    await assert.rejects(store.save(snapshot("must not be saved"), 1), hasCode("encryption_unavailable"));
    assert.deepEqual(await readFile(path), before);
    await store.close();
  });
});

test("a wrong OS account or tampered metadata fails closed without replacing the file", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "history.sqlite");
    const protector = new TestProtector();
    const store = new LocalConversationStore(path, protector);
    await store.save(snapshot(), 0);
    await store.close();
    const original = await readFile(path);
    await assert.rejects(new LocalConversationStore(path, new TestProtector()).load(), hasCode("corrupt"));
    assert.deepEqual(await readFile(path), original);

    const SQL = await initSqlJs();
    const db = new SQL.Database(original);
    db.run("UPDATE conversation_snapshots SET revision=revision+1");
    await writeFile(path, db.export());
    db.close();
    const tampered = await readFile(path);
    await assert.rejects(new LocalConversationStore(path, protector).load(), hasCode("corrupt"));
    assert.deepEqual(await readFile(path), tampered);
  });
});

test("stale concurrent saves and unrelated conversation IDs cannot overwrite history", async () => {
  await withDirectory(async (directory) => {
    const store = new LocalConversationStore(join(directory, "history.sqlite"), new TestProtector());
    const outcomes = await Promise.allSettled([store.save(snapshot("first"), 0), store.save(snapshot("second"), 0)]);
    assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await store.load()).state?.turns[0].text, "first");
    await assert.rejects(store.save(snapshot("another conversation", otherId), 1), hasCode("conflict"));
    assert.equal((await store.load()).state?.turns[0].text, "first");
    await store.close();
  });
});

test("invalid, unfinished and empty snapshots are rejected before persistence", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "history.sqlite");
    const store = new LocalConversationStore(path, new TestProtector());
    const good = snapshot();
    await assert.rejects(store.save({ ...good, turns: [] }, 0), hasCode("invalid_snapshot"));
    await assert.rejects(store.save({ ...good, activeTurnId: turnId }, 0), hasCode("invalid_snapshot"));
    await assert.rejects(store.save({ ...good, turns: [{ ...good.turns[0], text: "x".repeat(4001) }] }, 0), hasCode("invalid_snapshot"));
    assert.equal(existsSync(path), false);
    await store.close();
  });
});

test("a failed write leaves both the on-disk and in-memory previous revision intact", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "history.sqlite");
    const protector = new TestProtector();
    const first = new LocalConversationStore(path, protector);
    await first.save(snapshot("original"), 0);
    await first.close();
    const original = await readFile(path);
    const failing = new LocalConversationStore(path, protector, () => { throw new Error("synthetic disk failure"); });
    await assert.rejects(failing.save(snapshot("new"), 1), hasCode("storage"));
    assert.deepEqual(await readFile(path), original);
    assert.deepEqual(await failing.load(), { state: snapshot("original"), revision: 1 });
    await failing.close();
  });
});

test("clear removes the current key and snapshot, and a new conversation gets a new key", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "history.sqlite");
    const protector = new TestProtector();
    const store = new LocalConversationStore(path, protector);
    await store.save(snapshot(), 0);
    const SQL = await initSqlJs();
    const oldDb = new SQL.Database(await readFile(path));
    const oldWrapped = oldDb.exec("SELECT wrapped_key FROM vault_keys")[0].values[0][0] as Uint8Array;
    oldDb.close();
    await assert.rejects(store.clear(0), hasCode("conflict"));
    await store.clear(1);
    assert.deepEqual(await store.load(), { state: null, revision: 0 });
    const cleared = new SQL.Database(await readFile(path));
    assert.equal(cleared.exec("SELECT count(*) FROM vault_keys")[0].values[0][0], 0);
    assert.equal(cleared.exec("SELECT count(*) FROM conversation_snapshots")[0].values[0][0], 0);
    cleared.close();
    await store.save(snapshot("new conversation", otherId), 0);
    const newDb = new SQL.Database(await readFile(path));
    const newWrapped = newDb.exec("SELECT wrapped_key FROM vault_keys")[0].values[0][0] as Uint8Array;
    assert.notDeepEqual(Buffer.from(newWrapped), Buffer.from(oldWrapped));
    newDb.close();
    await store.close();
  });
});

test("versioned migrations upgrade an older database and reject a changed checksum", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "history.sqlite");
    const SQL = await initSqlJs();
    const old = new SQL.Database();
    old.run("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)");
    const migration = LOCAL_CONVERSATION_MIGRATIONS[0];
    old.run(migration.sql);
    old.run("INSERT INTO schema_migrations VALUES (?, ?, ?)", [migration.id, createHash("sha256").update(migration.sql).digest("hex"), 1]);
    await writeFile(path, old.export());
    old.close();
    const protector = new TestProtector();
    const store = new LocalConversationStore(path, protector);
    assert.deepEqual(await store.load(), { state: null, revision: 0 });
    await store.close();
    const upgraded = new SQL.Database(await readFile(path));
    assert.equal(upgraded.exec("SELECT count(*) FROM schema_migrations")[0].values[0][0], 2);
    upgraded.run("UPDATE schema_migrations SET checksum='changed' WHERE id=1");
    await writeFile(path, upgraded.export());
    upgraded.close();
    const bad = await readFile(path);
    await assert.rejects(new LocalConversationStore(path, protector).load(), hasCode("corrupt"));
    assert.deepEqual(await readFile(path), bad);
  });
});

test("revision overflow is rejected without replacing a valid vault", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "history.sqlite");
    const protector = new TestProtector();
    const state = snapshot("synthetic overflow boundary");
    const original = new LocalConversationStore(path, protector);
    await original.save(state, 0);
    await original.close();
    const SQL = await initSqlJs();
    const db = new SQL.Database(await readFile(path));
    const wrapped = db.exec("SELECT wrapped_key FROM vault_keys WHERE id=1")[0].values[0][0] as Uint8Array;
    const key = Buffer.from(protector.decrypt(Buffer.from(wrapped)), "base64");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(`vanessa:desktop-conversation:1:${conversationId}:${Number.MAX_SAFE_INTEGER}`, "utf8"));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
    db.run("UPDATE conversation_snapshots SET revision=?, nonce=?, ciphertext=?, auth_tag=?", [Number.MAX_SAFE_INTEGER, nonce, encrypted, cipher.getAuthTag()]);
    await writeFile(path, db.export());
    db.close();
    key.fill(0);
    const before = await readFile(path);
    const reopened = new LocalConversationStore(path, protector);
    assert.equal((await reopened.load()).revision, Number.MAX_SAFE_INTEGER);
    await assert.rejects(reopened.save(state, Number.MAX_SAFE_INTEGER), hasCode("conflict"));
    assert.deepEqual(await readFile(path), before);
    await reopened.close();
  });
});
