import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { scryptSync } from 'node:crypto';

const seedPasswordHash = scryptSync('demo-password-L1', 'vanessa-gauntlet-fixed-seed-salt', 64).toString('hex');

export function openDatabase(filename = process.env.DB_PATH || path.resolve('data/expenses.sqlite')) {
  const absolute = path.resolve(filename);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const db = new DatabaseSync(absolute);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
      currency TEXT NOT NULL CHECK (length(currency) = 3),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS expenses_user_created_idx ON expenses(user_id, created_at DESC);
  `);
  seedDatabase(db);
  return db;
}

function seedDatabase(db) {
  const insertUser = db.prepare('INSERT OR IGNORE INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)');
  insertUser.run('seed-user-a', 'demo@vanessa.test', seedPasswordHash, '2026-01-01T00:00:00.000Z');
  insertUser.run('seed-user-b', 'other@vanessa.test', seedPasswordHash, '2026-01-01T00:00:00.000Z');
  const insertExpense = db.prepare(`INSERT OR IGNORE INTO expenses
    (id, user_id, description, amount_minor, currency, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'INR', ?, ?)`);
  const seeded = [
    ['seed-a-1', 'seed-user-a', 'Desk supplies', 12500, '2026-01-02T00:00:00.000Z'],
    ['seed-a-2', 'seed-user-a', 'Travel', 28900, '2026-01-03T00:00:00.000Z'],
    ['seed-a-3', 'seed-user-a', 'Lunch', 5100, '2026-01-04T00:00:00.000Z'],
    ['seed-b-1', 'seed-user-b', 'Other account expense', 99900, '2026-01-05T00:00:00.000Z'],
  ];
  for (const [id, userId, description, amount, createdAt] of seeded) {
    insertExpense.run(id, userId, description, amount, createdAt, createdAt);
  }
}
