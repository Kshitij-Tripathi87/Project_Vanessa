/**
 * TODO(L1): implement the authentication contract described in spec.md.
 * The database schema is in src/db.mjs. Never store plaintext passwords or
 * raw bearer tokens. All database access must use prepared statements.
 */
export function registerUser(_db, _input) {
  throw new Error('NOT_IMPLEMENTED: registerUser');
}

export function loginUser(_db, _input) {
  throw new Error('NOT_IMPLEMENTED: loginUser');
}

export function authenticateRequest(_db, _authorizationHeader) {
  throw new Error('NOT_IMPLEMENTED: authenticateRequest');
}
