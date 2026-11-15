# Vanessa Gauntlet Expense Tracker

A deliberately incomplete Node.js 22+ expense tracker used by the Vanessa Build Gauntlet. The HTTP server, SQLite schema, seeded users, route wiring and tests are supplied. Implement the TODO modules under `src/`.

## Requirements

- Node.js 22.16 or newer (uses the built-in `node:sqlite` module).
- No third-party packages are required.

## Install and start

```bash
npm install
npm start
```

The server binds to `127.0.0.1` and defaults to port `4319`. Set `PORT` to override the port and `DB_PATH` to override the SQLite database path.

## Tests

```bash
npm test
```

## Seed accounts (benchmark-only)

- `demo@vanessa.test` / `demo-password-L1`
- `other@vanessa.test` / `demo-password-L1`

These are deterministic benchmark fixtures, not production credentials. The first account starts with three INR expenses totaling 46,500 paise. The second account has separate seeded expenses and must not be able to access the first account's records.

## API

- `GET /health`
- `POST /api/auth/register` — `{ "email": "person@example.test", "password": "a-long-password" }`
- `POST /api/auth/login` — same credentials; returns a bearer token
- `GET /api/expenses` — authenticated list
- `POST /api/expenses` — `{ "description": "Coffee", "amountMinor": 25000, "currency": "INR" }`
- `GET /api/expenses/:id`
- `PATCH /api/expenses/:id`
- `DELETE /api/expenses/:id`
- `GET /api/dashboard`

Expense amounts are integer minor currency units. All expense endpoints require `Authorization: Bearer <token>`.
