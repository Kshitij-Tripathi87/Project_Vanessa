# Vanessa Build Gauntlet — L1 Expense Application

## Objective

Complete the existing expense-tracker application in this workspace. The project has its HTTP server, SQLite database, schema, seed data, routes, package scripts, README, and tests wired already. Implement the missing authentication, expense-ownership, and dashboard logic without weakening or changing the tests.

## Constraints

- Work only inside the workspace directory provided by the Gauntlet adapter.
- Keep the existing stack: Node.js 22+ and its built-in `node:sqlite` module. Do not add third-party dependencies.
- Preserve the existing HTTP routes and data model. Make the smallest reasonable changes.
- Do not change `package.json` or files under `test/`.
- Do not weaken, skip, delete, or rewrite tests. Do not hard-code acceptance responses.
- Use parameterized SQL statements; never interpolate user-controlled values into SQL.
- Store password hashes, never plaintext passwords. Use cryptographically secure tokens.
- Scope every expense read, update, delete, and aggregation to the authenticated owner.
- Amounts are integer minor units (paise); currencies are three-letter uppercase codes.
- Report truthfully. A clean coding-agent exit is not proof of completion.

## Required functionality

1. Implement registration and login in `src/auth.mjs`.
   - Validate email and password inputs.
   - Hash passwords using a salted password-hashing function from `node:crypto`.
   - Return generic invalid-credentials errors on login.
   - Create opaque, unpredictable bearer tokens and persist sessions.
   - Resolve the authenticated user from a bearer token; reject expired or unknown sessions.
2. Implement owner-scoped expense CRUD in `src/expenses.mjs`.
   - Create, list, read, update and delete expenses.
   - Validate description, integer `amountMinor`, and currency.
   - A user must never read or mutate another user's expense.
3. Implement the dashboard in `src/dashboard.mjs`.
   - Aggregate the authenticated user's expenses by currency.
   - Return stable totals and counts; do not mix currencies.
4. Keep the existing server contract and seeded data intact.
5. Run the project's test suite and resolve failures without modifying protected tests or package scripts.

## Completion evidence

Before reporting success, record the commands run, exit codes, files changed, and any remaining limitations. Do not claim the task passed unless the independent acceptance suite reports 7/7.
