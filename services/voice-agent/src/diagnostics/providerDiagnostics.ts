import type WebSocket from "ws";

export function safeProviderDetail(value: unknown, extraSecrets: string[] = []): string {
  let text = typeof value === "string" ? value : String(value ?? "");
  const secrets = [...extraSecrets, ...Object.entries(process.env)
    .filter(([key, secret]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key) && (secret?.length || 0) >= 6)
    .map(([, secret]) => secret!)];
  for (const secret of secrets) if (secret) text = text.split(secret).join("[REDACTED]");
  return text.replace(/Bearer\s+[^\s"<>]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[a-z0-9_-]+/gi, "[REDACTED]")
    .replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 600);
}

export function providerHttpHint(status: number, provider = "Fish"): string {
  switch (status) {
    case 401: return `Authentication rejected. Check ${provider === "Sarvam" ? "SARVAM_API_KEY" : "FISH_API_KEY"} and restart Vanessa after editing .env.`;
    case 402: return "Payment/access rejected. Check API balance and realtime ASR access for the account owning this key; another key on the same account may have the same restriction.";
    case 403: return "Access forbidden. Check account/model permissions.";
    case 404: return `Endpoint not found. Check the configured ${provider} WebSocket URL.`;
    case 429: return "Rate/concurrency limit reached. Close other sessions and retry later.";
    default: return status >= 500 ? `${provider} service error. Retry later.` : "Inspect the provider message and endpoint configuration.";
  }
}

export function providerTransportError(error: Error, secrets: string[] = []): string {
  const causes = [error, ...((error as any).errors || [])];
  return safeProviderDetail(causes.map((cause) => [cause.name, cause.code, cause.message]
    .filter(Boolean).join(": ")).join("; "), secrets);
}

/** ws otherwise discards the HTTP rejection body during upgrade failure. */
export function diagnoseUpgradeRejection(socket: WebSocket, stage: string, apiKey: string, reject: (error: Error) => void, provider = "Fish"): void {
  socket.on("unexpected-response", (_request, response) => {
    const status = response.statusCode || 0;
    const hint = providerHttpHint(status, provider);
    const requestId = response.headers["x-request-id"] || response.headers["request-id"] || "not supplied";
    console.error(`[${stage}] HTTP upgrade rejected status=${status} requestId=${safeProviderDetail(requestId, [apiKey])}. ${hint}`);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      let detail = Buffer.concat(chunks).toString("utf8");
      try {
        const body = JSON.parse(detail);
        detail = [body.message, body.detail, body.reason, typeof body.error === "string" ? body.error : body.error?.message, body.code]
          .filter((value) => typeof value === "string" || typeof value === "number").join("; ");
      } catch { detail = detail.replace(/<[^>]*>/g, " "); }
      const safe = safeProviderDetail(detail, [apiKey]) || "No provider explanation returned.";
      console.error(`[${stage}] providerMessage=${safe}`);
      reject(new Error(`${provider} ${stage} HTTP ${status}: ${safe} ${hint}`));
      response.destroy();
      socket.terminate();
    };
    const timer = setTimeout(finish, 1500);
    response.on("data", (chunk: Buffer) => {
      const buffer = Buffer.from(chunk);
      chunks.push(buffer.subarray(0, Math.max(0, 4096 - bytes)));
      bytes += buffer.length;
      if (bytes >= 4096) finish();
    });
    response.once("end", finish);
    response.once("error", finish);
    response.once("aborted", finish);
  });
}
