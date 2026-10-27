export const DEFAULT_OLLAMA_MODEL = "qwen2.5:3b";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface OllamaClientOptions {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Local-only Ollama client: no key is accepted, and non-loopback destinations are rejected. */
export class OllamaClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaClientOptions = {}) {
    const rawBaseUrl = options.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;
    let parsed: URL;
    try { parsed = new URL(rawBaseUrl); }
    catch { throw new Error("OLLAMA_BASE_URL must be a valid local HTTP URL."); }
    const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
    if (parsed.protocol !== "http:" || !localHosts.has(parsed.hostname.toLowerCase()) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("OLLAMA_BASE_URL must be an HTTP loopback origin such as http://127.0.0.1:11434.");
    }
    this.baseUrl = parsed.origin;
    this.model = (options.model ?? process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL).trim();
    if (!this.model || this.model.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(this.model)) throw new Error("OLLAMA_MODEL must be a valid local model tag.");
    const timeout = Number(options.timeoutMs ?? process.env.OLLAMA_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 300_000) throw new Error("OLLAMA_TIMEOUT_MS must be between 1000 and 300000 milliseconds.");
    this.timeoutMs = timeout;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  getModel(): string { return this.model; }

  async generate(prompt: string, systemPrompt: string, json: boolean, requestId?: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (typeof prompt !== "string" || typeof systemPrompt !== "string" || !prompt.trim() || !systemPrompt.trim()) throw new Error("Ollama requires a non-empty prompt and system instruction.");
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    try {
      const safeId = (requestId || globalThis.crypto.randomUUID()).replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 160);
      const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(safeId ? { "X-Request-ID": safeId } : {}) },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }],
          stream: false,
          ...(json ? { format: "json" } : {}),
          options: { temperature: json ? 0.1 : 0.3, num_predict: json ? 4096 : 256 },
        }),
        signal: controller.signal,
      });
      const responseText = await response.text();
      if (responseText.length > MAX_RESPONSE_BYTES) throw new Error("Ollama response exceeded the supported size limit.");
      if (!response.ok) throw new Error(`Ollama local request failed (HTTP ${response.status}). Verify the local model and Ollama service.`);
      let body: any;
      try { body = JSON.parse(responseText); }
      catch { throw new Error("Ollama returned an invalid JSON response."); }
      if (body?.done === false || body?.done_reason === "length") throw new Error("Ollama returned an incomplete response; increase the local model output limit or retry.");
      if (typeof body?.message?.content !== "string" || !body.message.content.trim()) throw new Error("Ollama returned no usable response text.");
      return body.message.content.trim();
    } catch (error) {
      if (signal?.aborted) throw new Error("Ollama request was cancelled.");
      if (timedOut) throw new Error(`Ollama request timed out after ${this.timeoutMs} ms.`);
      if (error instanceof Error && error.message.startsWith("Ollama ")) throw error;
      throw new Error("Ollama local service could not be reached. Start Ollama and verify the selected model is installed.");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
