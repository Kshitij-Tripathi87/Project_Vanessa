type RuntimeEnvironment = {
  VANESSA_PORT?: string;
  VOICE_AGENT_PORT?: string;
  ORCHESTRATOR_URL?: string;
  ORCHESTRATOR_WS?: string;
};

function parsePort(raw: string | undefined, fallback: number, name: string): number {
  const value = raw?.trim();
  const port = value ? Number(value) : fallback;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer TCP port between 1 and 65535.`);
  }
  return port;
}

/** The orchestrator server reads VANESSA_PORT and defaults to 4319. */
export function resolveOrchestratorPort(env: RuntimeEnvironment = process.env): number {
  return parsePort(env.VANESSA_PORT, 4319, "VANESSA_PORT");
}

/** The voice agent reads VOICE_AGENT_PORT and defaults to 4500. */
export function resolveVoiceAgentPort(env: RuntimeEnvironment = process.env): number {
  const port = parsePort(env.VOICE_AGENT_PORT, 4500, "VOICE_AGENT_PORT");
  // The current Electron renderer connects to the voice service on port 4500.
  // Reject mismatches instead of shipping an installed app with a dead voice UI.
  if (port !== 4500) {
    throw new Error("VOICE_AGENT_PORT must be 4500 because the desktop renderer currently uses the fixed voice endpoint.");
  }
  return port;
}

/** Main-process HTTP clients resolve this lazily, after the per-user .env is loaded. */
export function resolveOrchestratorHttpUrl(env: RuntimeEnvironment = process.env): string {
  const configured = env.ORCHESTRATOR_URL?.trim();
  if (!configured) return `http://127.0.0.1:${resolveOrchestratorPort(env)}`;
  const url = new URL(configured);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("ORCHESTRATOR_URL must use http or https.");
  }
  if (url.username || url.password) throw new Error("ORCHESTRATOR_URL must not contain credentials.");
  return url.origin;
}

/** Resolve the event socket from the same authority/port as the HTTP API. */
export function resolveOrchestratorWebSocketUrl(env: RuntimeEnvironment = process.env): string {
  const configured = env.ORCHESTRATOR_WS?.trim();
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new Error("ORCHESTRATOR_WS must use ws or wss.");
    }
    if (url.username || url.password) throw new Error("ORCHESTRATOR_WS must not contain credentials.");
    return url.toString();
  }
  const url = new URL(resolveOrchestratorHttpUrl(env));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/events";
  url.search = "";
  url.hash = "";
  return url.toString();
}
