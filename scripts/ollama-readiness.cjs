const DEFAULT_TIMEOUT_MS = 2500;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

async function probeOllama(baseUrl, model, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const now = options.now || Date.now;
  const start = now();
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { status: "OFFLINE", ok: false, latencyMs: now() - start, message: "OLLAMA_BASE_URL is invalid. Use http://127.0.0.1:11434." };
  }

  if (parsed.protocol !== "http:" || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) ||
      parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    return {
      status: "OFFLINE",
      ok: false,
      latencyMs: now() - start,
      message: "Ollama readiness only probes a local loopback HTTP origin; remote endpoints are refused.",
    };
  }

  let response;
  try {
    response = await fetchImpl(parsed.origin + "/api/tags", {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return {
      status: "OFFLINE",
      ok: false,
      latencyMs: now() - start,
      message: "Local Ollama is not reachable. Start Ollama and rerun Vanessa diagnostics.",
    };
  }
  if (!response?.ok) {
    return {
      status: "OFFLINE",
      ok: false,
      latencyMs: now() - start,
      message: "Local Ollama returned HTTP " + String(response?.status || "unknown") + ". Restart Ollama and retry.",
    };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return {
      status: "OFFLINE",
      ok: false,
      latencyMs: now() - start,
      message: "Local Ollama returned an invalid model list. Restart Ollama and retry.",
    };
  }

  const installed = Array.isArray(body?.models) && body.models.some((item) =>
    item && (item.name === model || item.model === model),
  );
  if (!installed) {
    return {
      status: "DEGRADED",
      ok: false,
      latencyMs: now() - start,
      message: "Ollama is reachable, but model \"" + String(model) + "\" is not installed. Run the Vanessa setup/repair flow.",
    };
  }

  return {
    status: "ONLINE",
    ok: true,
    latencyMs: now() - start,
    message: "Local Ollama and model \"" + String(model) + "\" are ready.",
  };
}

module.exports = { probeOllama };
