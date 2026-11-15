import http from 'node:http';
import { openDatabase } from './src/db.mjs';
import { registerUser, loginUser, authenticateRequest } from './src/auth.mjs';
import { listExpenses, createExpense, getExpense, updateExpense, deleteExpense } from './src/expenses.mjs';
import { getDashboard } from './src/dashboard.mjs';

const db = openDatabase();
const json = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
};

async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw Object.assign(new Error('Request body too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }); }
}

async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const method = req.method || 'GET';
  if (method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok', service: 'expense-app' });
  if (method === 'POST' && url.pathname === '/api/auth/register') {
    try { return json(res, 201, registerUser(db, await readBody(req))); }
    catch (error) { return json(res, error.statusCode || 400, { error: error.message }); }
  }
  if (method === 'POST' && url.pathname === '/api/auth/login') {
    try { return json(res, 200, loginUser(db, await readBody(req))); }
    catch (error) { return json(res, error.statusCode || 401, { error: error.message }); }
  }

  let user;
  try { user = authenticateRequest(db, req.headers.authorization); }
  catch (error) { return json(res, error.statusCode || 401, { error: error.message }); }

  try {
    if (method === 'GET' && url.pathname === '/api/expenses') return json(res, 200, { expenses: listExpenses(db, user.id) });
    if (method === 'POST' && url.pathname === '/api/expenses') return json(res, 201, { expense: createExpense(db, user.id, await readBody(req)) });
    if (method === 'GET' && url.pathname === '/api/dashboard') return json(res, 200, getDashboard(db, user.id));

    const expenseMatch = url.pathname.match(/^\/api\/expenses\/([a-zA-Z0-9-]+)$/);
    if (expenseMatch) {
      const expenseId = expenseMatch[1];
      if (method === 'GET') return json(res, 200, { expense: getExpense(db, user.id, expenseId) });
      if (method === 'PATCH') return json(res, 200, { expense: updateExpense(db, user.id, expenseId, await readBody(req)) });
      if (method === 'DELETE') {
        deleteExpense(db, user.id, expenseId);
        return json(res, 200, { deleted: true });
      }
    }
    return json(res, 404, { error: 'Not found.' });
  } catch (error) {
    return json(res, error.statusCode || 400, { error: error.message || 'Request failed.' });
  }
}

const server = http.createServer((req, res) => {
  void handle(req, res).catch((error) => json(res, 500, { error: 'Internal server error.' }));
});
const port = Number(process.env.PORT || 4319);
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  console.log(JSON.stringify({ event: 'listening', host: '127.0.0.1', port: address.port }));
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 3000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
