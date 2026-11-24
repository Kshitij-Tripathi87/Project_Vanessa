export type WakeWordPauseResult = "paused" | "busy" | "unconfirmed";

/** A pause acknowledgement concerns ambient listening only, never task cancellation. */
export function requestWakeWordPause(socket: WebSocket, requestId: string, timeoutMs = 3000): Promise<WakeWordPauseResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: WakeWordPauseResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onClose);
      resolve(result);
    };
    const onMessage = (event: MessageEvent) => {
      try {
        if (typeof event.data !== "string") return;
        const message: unknown = JSON.parse(event.data);
        if (!message || typeof message !== "object") return;
        const response = message as Record<string, unknown>;
        if (response.type === "wake_word_paused" && response.requestId === requestId && typeof response.ok === "boolean") {
          finish(response.ok ? "paused" : "busy");
        }
      } catch { /* ignore malformed unrelated frames */ }
    };
    const onClose = () => finish("unconfirmed");
    if (socket.readyState !== 1) return finish("unconfirmed");
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onClose);
    timer = setTimeout(() => finish("unconfirmed"), timeoutMs);
    try { socket.send(JSON.stringify({ type: "pause_wake_word", requestId })); }
    catch { finish("unconfirmed"); }
  });
}
