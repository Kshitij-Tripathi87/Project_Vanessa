/** Redact credentials; response logging can use Infinity to avoid truncation. */
export function redactLlmDiagnostic(message: string, extraSecrets: string[] = [], maxLength = 8192): string {
  const secrets = [
    ...extraSecrets,
    ...Object.entries(process.env)
      .filter(([name]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(name))
      .map(([, value]) => value || ""),
  ];
  let safe = message;
  for (const secret of secrets) {
    if (secret.length >= 6) safe = safe.split(secret).join("[REDACTED]");
  }
  return safe
    .replace(/\b(?:nvapi-|sk-|ghp_)[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [REDACTED]")
    .slice(0, maxLength);
}

export function formatLlmError(error: unknown, extraSecrets: string[] = []): string {
  const describe = (value: unknown, depth = 0): Record<string, unknown> => {
    const source = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
    return {
      name: typeof source?.name === "string" ? source.name : "Error",
      message: redactLlmDiagnostic(typeof source?.message === "string" ? source.message : String(value), extraSecrets),
      ...(typeof source?.code === "string" || typeof source?.code === "number" ? { code: source.code } : {}),
      ...(source?.cause !== undefined && depth < 2 ? { cause: describe(source.cause, depth + 1) } : {}),
    };
  };
  return JSON.stringify(describe(error));
}
