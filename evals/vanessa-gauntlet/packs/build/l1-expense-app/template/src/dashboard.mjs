/**
 * TODO(L1): aggregate only the authenticated user's expenses. Never combine
 * amounts from different currencies. Return the stable response contract:
 * { totals: [{ currency, totalMinor, count }], totalMinor, count } when the
 * account has a single currency; totalMinor is null for multiple currencies.
 */
export function getDashboard(_db, _userId) {
  throw new Error('NOT_IMPLEMENTED: getDashboard');
}
