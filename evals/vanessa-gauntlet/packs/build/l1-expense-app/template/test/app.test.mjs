import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { registerUser, loginUser, authenticateRequest } from '../src/auth.mjs';
import { listExpenses, createExpense, getExpense, updateExpense, deleteExpense } from '../src/expenses.mjs';
import { getDashboard } from '../src/dashboard.mjs';

async function withDatabase(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vanessa-expense-tests-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  try { await fn(db); }
  finally { db.close(); await rm(directory, { recursive: true, force: true }); }
}

test('register, login and resolve an authenticated session', async () => {
  await withDatabase((db) => {
    const created = registerUser(db, { email: 'new-user@example.test', password: 'Long-Test-Password-42' });
    assert.equal(created.user.email, 'new-user@example.test');
    assert.ok(created.token);
    assert.equal(loginUser(db, { email: 'new-user@example.test', password: 'Long-Test-Password-42' }).user.id, created.user.id);
    assert.equal(authenticateRequest(db, `Bearer ${created.token}`).id, created.user.id);
    assert.throws(() => loginUser(db, { email: 'new-user@example.test', password: 'wrong-password-value' }), /Invalid credentials/);
  });
});

test('expense CRUD is scoped to its owner', async () => {
  await withDatabase((db) => {
    const created = createExpense(db, 'seed-user-a', { description: 'Gauntlet test', amountMinor: 12345, currency: 'INR' });
    assert.equal(getExpense(db, 'seed-user-a', created.id).amountMinor, 12345);
    assert.throws(() => getExpense(db, 'seed-user-b', created.id), /not found/i);
    const updated = updateExpense(db, 'seed-user-a', created.id, { amountMinor: 23456 });
    assert.equal(updated.amountMinor, 23456);
    assert.throws(() => deleteExpense(db, 'seed-user-b', created.id), /not found/i);
    assert.equal(getExpense(db, 'seed-user-a', created.id).id, created.id);
    deleteExpense(db, 'seed-user-a', created.id);
    assert.throws(() => getExpense(db, 'seed-user-a', created.id), /not found/i);
  });
});

test('expense validation rejects malformed values and empty updates', async () => {
  await withDatabase((db) => {
    assert.throws(() => createExpense(db, 'seed-user-a', { description: '', amountMinor: 0, currency: 'INR' }), /description/i);
    assert.throws(() => createExpense(db, 'seed-user-a', { description: 'Invalid', amountMinor: 1.5, currency: 'INR' }), /amount/i);
    assert.throws(() => createExpense(db, 'seed-user-a', { description: 'Invalid', amountMinor: 100, currency: 'usd' }), /currency/i);
    assert.throws(() => updateExpense(db, 'seed-user-a', 'seed-a-1', {}), /at least one/i);
  });
});

test('dashboard totals are per user and do not mix currencies', async () => {
  await withDatabase((db) => {
    const dashboard = getDashboard(db, 'seed-user-a');
    assert.equal(dashboard.count, 3);
    assert.equal(dashboard.totalMinor, 46500);
    assert.deepEqual(dashboard.totals, [{ currency: 'INR', totalMinor: 46500, count: 3 }]);
    assert.equal(getDashboard(db, 'seed-user-b').totalMinor, 99900);
  });
});
