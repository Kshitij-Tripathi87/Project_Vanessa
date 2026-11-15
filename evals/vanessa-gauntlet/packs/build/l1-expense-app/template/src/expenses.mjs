/**
 * TODO(L1): implement owner-scoped expense CRUD. Every query which reads or
 * mutates an expense must include the authenticated user ID in its predicate.
 * Keep amountMinor as a positive integer and currency as a 3-letter uppercase
 * code. Use prepared statements for every SQL operation.
 */
export function listExpenses(_db, _userId) {
  throw new Error('NOT_IMPLEMENTED: listExpenses');
}

export function createExpense(_db, _userId, _input) {
  throw new Error('NOT_IMPLEMENTED: createExpense');
}

export function getExpense(_db, _userId, _expenseId) {
  throw new Error('NOT_IMPLEMENTED: getExpense');
}

export function updateExpense(_db, _userId, _expenseId, _input) {
  throw new Error('NOT_IMPLEMENTED: updateExpense');
}

export function deleteExpense(_db, _userId, _expenseId) {
  throw new Error('NOT_IMPLEMENTED: deleteExpense');
}
