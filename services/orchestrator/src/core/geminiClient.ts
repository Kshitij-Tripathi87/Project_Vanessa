import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";

const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_TIMEOUT_MS = 8000;

export class GeminiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiError";
  }
}

/** One reusable transport per process, with independent context for each call. */
export class GeminiClient {
  private readonly baseUrl: string;
  private readonly agent: HttpAgent;

  constructor(private readonly options: {
    baseUrl?: string;
    apiKey?: () => string | undefined;
    timeoutMs?: number;
  } = {}) {
    this.baseUrl = options.baseUrl || "https://generativelanguage.googleapis.com/v1beta/";
    const Agent = new URL(this.baseUrl).protocol === "https:" ? HttpsAgent : HttpAgent;
    this.agent = new Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 2 });
  }

  async generate(prompt: string, systemPrompt: string, json: boolean): Promise<string> {
    // Read credentials at request time: dotenv may load after module imports.
    const key = (this.options.apiKey ? this.options.apiKey() : process.env.GEMINI_API_KEY)?.trim();
    if (!key || /placeholder|your[_-].*key/i.test(key)) {
      throw new GeminiError("Set GEMINI_API_KEY in the root .env file before using Gemini.");
    }
    const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
    const startedAt = Date.now();
    console.log(`[Gemini] request model=${model} mode=${json ? "plan-json" : "conversation"} keepAlive=true`);
    const url = new URL(`models/${encodeURIComponent(model)}:generateContent`, this.baseUrl);
    const configuredTimeout = Number(process.env.GEMINI_TIMEOUT_MS);
    const timeoutMs = this.options.timeoutMs ?? (
      Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : DEFAULT_TIMEOUT_MS
    );
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        thinkingConfig: { thinkingLevel: "minimal" },
        maxOutputTokens: json ? 4096 : 256,
        ...(json ? { responseMimeType: "application/json" } : {}),
      },
    });

    const data: any = await new Promise((resolve, reject) => {
      const request = url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = request(url, {
        method: "POST",
        agent: this.agent,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "x-goog-api-key": key,
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            req.destroy(new GeminiError("Gemini response exceeded the supported size."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", () => req.destroy(new GeminiError("Gemini response connection failed.")));
        res.on("end", () => {
          clearTimeout(timer);
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            console.error(`[Gemini] failed HTTP=${res.statusCode || "unknown"} elapsedMs=${Date.now() - startedAt}`);
            // Never expose the provider body, request headers, or credential.
            reject(new GeminiError(`Gemini request failed (HTTP ${res.statusCode || "unknown"}).`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new GeminiError("Gemini returned an invalid response body."));
          }
        });
      });
      // Bound the whole request, including connecting and reading the body.
      const timer = setTimeout(() => {
        req.destroy(new GeminiError(`Gemini request timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      req.on("error", (error) => {
        console.error(`[Gemini] transport failed elapsedMs=${Date.now() - startedAt} reason=${error instanceof GeminiError ? error.message : "connection error"}`);
        clearTimeout(timer);
        reject(error instanceof GeminiError ? error : new GeminiError("Could not connect to Gemini."));
      });
      req.end(body);
    });

    const candidate = data.candidates?.[0];
    if (candidate?.finishReason && candidate.finishReason !== "STOP") {
      throw new GeminiError("Gemini did not return a complete response. No fallback was used.");
    }
    const text = candidate?.content?.parts
      ?.filter((part: any) => !part.thought && typeof part.text === "string")
      .map((part: any) => part.text).join("").trim();
    if (!text) throw new GeminiError("Gemini returned no usable text. No fallback was used.");
    console.log(`[Gemini] complete elapsedMs=${Date.now() - startedAt} responseCharacters=${text.length}`);
    return text;
  }

  close(): void {
    this.agent.destroy();
  }
}
