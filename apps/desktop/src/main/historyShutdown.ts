/**
 * Request a bounded renderer drain before destroying its window. Transport
 * authentication is supplied by the caller; the nonce prevents stale replies
 * from completing a later close attempt.
 */
export function waitForHistoryFlush(
  nonce: string,
  subscribe: (listener: (nonce: unknown, ok: unknown) => void) => () => void,
  request: (nonce: string) => void,
  timeoutMs = 8000,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      resolve(ok);
    };
    try {
      unsubscribe = subscribe((received, ok) => {
        if (received === nonce && typeof ok === "boolean") finish(ok);
      });
      if (settled) { unsubscribe(); return; }
      timer = setTimeout(() => finish(false), timeoutMs);
      request(nonce);
    } catch {
      finish(false);
    }
  });
}
