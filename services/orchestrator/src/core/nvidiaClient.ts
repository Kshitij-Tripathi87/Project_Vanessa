import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { formatLlmError, redactLlmDiagnostic } from "./llmDiagnostics.js";

export const DEFAULT_NVIDIA_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";
const DEFAULT_TIMEOUT_MS = 60000;

export class NvidiaError extends Error {
  constructor(message: string, readonly code?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NvidiaError";
  }
}

/** The same generate interface and reusable transport as the preserved Gemini client. */
export class NvidiaClient {
  private readonly agent: HttpAgent;

  constructor(private readonly options: {
    baseUrl?: string;
    apiKey?: () => string | undefined;
    timeoutMs?: number;
  } = {}) {
    const baseUrl = this.options.baseUrl || process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";
    const Agent = new URL(baseUrl).protocol === "https:" ? HttpsAgent : HttpAgent;
    this.agent = new Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 2 });
  }

  async generate(prompt: string, systemPrompt: string, json: boolean, requestId?: string): Promise<string> {
    const key = (this.options.apiKey ? this.options.apiKey() : process.env.NVIDIA_API_KEY)?.trim();
    if (!key || /placeholder|your[_-].*key/i.test(key)) {
      throw new NvidiaError("Set NVIDIA_API_KEY in the root .env file before using NVIDIA.");
    }
    const model = process.env.NVIDIA_MODEL?.trim() || DEFAULT_NVIDIA_MODEL;
    const baseUrl = this.options.baseUrl || process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";
    const url = new URL(`${baseUrl.replace(/\/+$/, "")}/chat/completions`);
    const configuredTimeout = Number(process.env.NVIDIA_TIMEOUT_MS);
    const timeoutMs = this.options.timeoutMs ?? (
      Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : DEFAULT_TIMEOUT_MS
    );
    const startedAt = Date.now();
    const context = `request=${requestId || globalThis.crypto.randomUUID()} model=${model} mode=${json ? "plan-json" : "conversation"}`;
    let phase = "request";
    let httpStatus: number | undefined;
    let responseBytes = 0;
    let providerRequestId = "";
    const fail = (error: Error): never => {
      console.error(`[NVIDIA] failed ${context} phase=${phase} HTTP=${httpStatus ?? "none"} elapsedMs=${Date.now() - startedAt} timeoutMs=${timeoutMs} responseBytes=${responseBytes}${providerRequestId ? ` providerRequestId=${JSON.stringify(providerRequestId)}` : ""} error=${formatLlmError(error, [key])}`);
      throw error;
    };
    console.log(`[NVIDIA] request ${context} timeoutMs=${timeoutMs} keepAlive=true`);
    const body = JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      ...(model.startsWith("nvidia/nemotron-")
        ? { chat_template_kwargs: { enable_thinking: false } }
        : { reasoning_effort: "none" }),
      max_tokens: json ? 4096 : 256,
      stream: false,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    });

    const data: any = await new Promise((resolve, reject) => {
      const request = url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = request(url, {
        method: "POST",
        agent: this.agent,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${key}`,
        },
      }, (res) => {
        phase = "reading_response";
        httpStatus = res.statusCode;
        providerRequestId = redactLlmDiagnostic(String(res.headers["x-request-id"] || res.headers["x-nvidia-request-id"] || ""), [key]);
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          responseBytes += chunk.length;
          if (responseBytes > 1024 * 1024) {
            req.destroy(new NvidiaError("NVIDIA response exceeded the supported size."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", (error) => req.destroy(new NvidiaError(error.message, (error as NodeJS.ErrnoException).code, { cause: error })));
        res.on("end", () => {
          clearTimeout(timer);
          const responseBody = Buffer.concat(chunks).toString("utf8");
          let readableResponse = responseBody;
          try {
            const parsed = JSON.parse(responseBody);
            const message = parsed?.choices?.[0]?.message;
            if (message) {
              let content = message.content;
              if (typeof content === "string") {
                try { content = JSON.parse(content); } catch { /* Conversational replies remain plain text. */ }
              }
              readableResponse = JSON.stringify({ content, role: message.role }, null, 2);
            } else {
              readableResponse = JSON.stringify(parsed, null, 2);
            }
          } catch { /* Preserve malformed responses for debugging. */ }
          console.log(`[NVIDIA] response ${context} HTTP=${res.statusCode ?? "unknown"}\n${redactLlmDiagnostic(readableResponse, [key], Number.POSITIVE_INFINITY)}`);
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            let providerMessage = responseBody;
            try {
              const parsed = JSON.parse(responseBody);
              providerMessage = JSON.stringify(parsed.error ?? parsed.detail ?? parsed.message ?? parsed);
            } catch { /* Some gateways return plain-text or HTML errors. */ }
            reject(new NvidiaError(`NVIDIA request failed (HTTP ${res.statusCode || "unknown"}): ${redactLlmDiagnostic(providerMessage, [key])}`, `HTTP_${res.statusCode || "UNKNOWN"}`));
            return;
          }
          phase = "parsing_response";
          try {
            resolve(JSON.parse(responseBody));
          } catch (error) {
            reject(new NvidiaError("NVIDIA returned an invalid JSON response body.", "INVALID_JSON", { cause: error }));
          }
        });
      });
      const timer = setTimeout(() => {
        req.destroy(new NvidiaError(`NVIDIA request timed out after ${timeoutMs} ms.`, "ETIMEDOUT"));
      }, timeoutMs);
      req.on("error", (error) => {
        clearTimeout(timer);
        reject(error instanceof NvidiaError ? error : new NvidiaError(error.message, (error as NodeJS.ErrnoException).code, { cause: error }));
      });
      req.on("finish", () => { if (phase === "request") phase = "waiting_for_headers"; });
      req.end(body);
    }).catch(fail);

    phase = "validating_response";
    const choice = data.choices?.[0];
    if (choice?.finish_reason && choice.finish_reason !== "stop") {
      fail(new NvidiaError(`NVIDIA did not return a complete response (finish_reason=${choice.finish_reason}). No fallback was used.`, "INCOMPLETE_RESPONSE"));
    }
    const text = typeof choice?.message?.content === "string" ? choice.message.content.trim() : "";
    if (!text) fail(new NvidiaError(`NVIDIA returned no usable text (refusal=${JSON.stringify(redactLlmDiagnostic(String(choice?.message?.refusal || "none"), [key]))}). No fallback was used.`, "EMPTY_RESPONSE"));
    console.log(`[NVIDIA] complete ${context} HTTP=${httpStatus} elapsedMs=${Date.now() - startedAt} responseCharacters=${text.length}`);
    return text;
  }

  close(): void {
    this.agent.destroy();
  }
}
