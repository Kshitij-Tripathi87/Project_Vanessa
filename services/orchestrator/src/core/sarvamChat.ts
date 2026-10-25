import { UsageBudget, type UsageReservation } from "@vanessa/shared";

export interface SarvamChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface SarvamChatOptions {
  apiKey?: string;
  url?: string;
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
  budget?: UsageBudget;
}

export interface SarvamChatResult {
  text: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

function isPlaceholder(value: string | undefined): boolean {
  return !value || /placeholder|replace[-_ ]with|your[_-].*key/i.test(value);
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function safeProviderDetail(value: unknown, secrets: string[] = []): string {
  let text = String(value ?? "");
  for (const secret of secrets) if (secret) text = text.split(secret).join("[REDACTED]");
  return text
    .replace(/Bearer\s+[^\s"<>]+/gi, "Bearer [REDACTED]")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .slice(0, 600);
}

function readContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => typeof part === "string" ? part : (part as any)?.text || (part as any)?.content || "")
      .join("");
  }
  return "";
}

/**
 * OpenAI-compatible Sarvam chat-completions client.
 *
 * It intentionally lives in the trusted orchestrator process. The renderer
 * never receives the API key or provider response headers.
 */
export class SarvamChatClient {
  private readonly apiKey: string;
  private readonly url: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly budget: UsageBudget;

  constructor(options: SarvamChatOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.SARVAM_API_KEY ?? "";
    this.url = options.url ?? process.env.SARVAM_CHAT_URL ?? "https://api.sarvam.ai/v1/chat/completions";
    this.model = options.model ?? process.env.SARVAM_CHAT_MODEL ?? "sarvam-105b-conversations";
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs ?? process.env.SARVAM_CHAT_TIMEOUT_MS ?? 30000));
    this.maxTokens = Math.max(16, Math.floor(Number(options.maxTokens ?? process.env.SARVAM_CHAT_MAX_OUTPUT_TOKENS ?? 512)));
    this.budget = options.budget ?? new UsageBudget({
      capInr: Number(process.env.VOICE_BUDGET_CAP_INR || 0),
      perUserCapInr: Number(process.env.VOICE_BUDGET_PER_USER_CAP_INR || 0),
    });
  }

  isConfigured(): boolean {
    return !isPlaceholder(this.apiKey) && Boolean(this.model.trim()) && Boolean(this.url.trim());
  }

  getModel(): string {
    return this.model;
  }

  getUsageSnapshot() {
    return this.budget.snapshot();
  }

  async complete(input: {
    messages: SarvamChatMessage[];
    requestId?: string;
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<SarvamChatResult> {
    const configurationError = this.getConfigurationError();
    if (configurationError) throw new Error(configurationError);
    input.signal?.throwIfAborted();

    const requestId = input.requestId || `sarvam-chat-${Date.now()}`;
    const promptText = input.messages.map((message) => `${message.role}: ${message.content}`).join("\n");
    const inputTokensEstimate = estimateTokens(promptText);
    const outputTokensEstimate = input.maxTokens || this.maxTokens;
    if (!Number.isFinite(outputTokensEstimate) || outputTokensEstimate < 1) throw new Error("Invalid Sarvam chat token limit.");
    let inputReservation = this.reserve(requestId, "llm_input_tokens", inputTokensEstimate, process.env.SARVAM_CHAT_INR_PER_1K_INPUT_TOKENS);
    let outputReservation: UsageReservation | undefined;
    try {
      outputReservation = this.reserve(requestId, "llm_output_tokens", outputTokensEstimate, process.env.SARVAM_CHAT_INR_PER_1K_OUTPUT_TOKENS);
    } catch (error) {
      if (inputReservation) this.budget.release(inputReservation, { reason: "output_reservation_failed" });
      throw error;
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-subscription-key": this.apiKey,
        },
        body: JSON.stringify({
          model: this.model,
          messages: input.messages,
          stream: true,
          reasoning_effort: null,
          temperature: 0.2,
          max_tokens: input.maxTokens || this.maxTokens,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Sarvam chat request failed (HTTP ${response.status}): ${safeProviderDetail(body, [this.apiKey])}`);
      }

      const parsed = response.body && !response.headers.get("content-type")?.includes("application/json")
        ? await this.readStream(response.body)
        : await this.readJsonResponse(response);
      const text = parsed.text.trim();
      if (!text) throw new Error("Sarvam chat returned no usable text.");

      if (parsed.usage && Object.values(parsed.usage).some(value => !Number.isFinite(value) || value < 0)) throw new Error("Sarvam returned invalid usage metadata.");
      const inputTokens = parsed.usage?.inputTokens ?? inputTokensEstimate;
      const outputTokens = parsed.usage?.outputTokens ?? estimateTokens(text);
      if (inputReservation) this.budget.settle(inputReservation, {
        quantity: inputTokens,
        actualCostInr: this.costInr(inputTokens, process.env.SARVAM_CHAT_INR_PER_1K_INPUT_TOKENS),
        metadata: { requestId, provider: "sarvam", costBasis: "estimate", providerUsageReported: Boolean(parsed.usage) },
      });
      inputReservation = undefined;
      if (outputReservation) this.budget.settle(outputReservation, {
        quantity: outputTokens,
        actualCostInr: this.costInr(outputTokens, process.env.SARVAM_CHAT_INR_PER_1K_OUTPUT_TOKENS),
        metadata: { requestId, provider: "sarvam", costBasis: "estimate", providerUsageReported: Boolean(parsed.usage) },
      });
      outputReservation = undefined;
      return {
        text,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: parsed.usage?.totalTokens || inputTokens + outputTokens,
        },
      };
    } catch (error: any) {
      const detail = error?.name === "AbortError"
        ? "Sarvam chat request timed out or was cancelled."
        : safeProviderDetail(error?.message || "Sarvam chat request failed.", [this.apiKey]);
      // An aborted/failed HTTP stream may already be billable. Do not refund
      // its reservation merely because the reply could not be confirmed.
      if (inputReservation) this.budget.settle(inputReservation, { quantity: inputTokensEstimate, metadata: { requestId, costBasis: "estimate", providerUsageReported: false, outcome: "failed", potentiallyBillable: true } });
      if (outputReservation) this.budget.settle(outputReservation, { quantity: outputTokensEstimate, metadata: { requestId, costBasis: "estimate", providerUsageReported: false, outcome: "failed", potentiallyBillable: true } });
      throw new Error(detail);
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }

  private getConfigurationError(): string | undefined {
    if (isPlaceholder(this.apiKey)) return "Set SARVAM_API_KEY in the root .env file before using Sarvam chat.";
    if (!this.model.trim() || /placeholder|your[_-].*model|replace[-_ ]with/i.test(this.model)) return "Set SARVAM_CHAT_MODEL in the root .env file.";
    if (!this.url.trim()) return "SARVAM_CHAT_URL is not configured.";
    return undefined;
  }

  private reserve(requestId: string, kind: "llm_input_tokens" | "llm_output_tokens", quantity: number, rateValue: string | undefined): UsageReservation | undefined {
    return this.budget.reserve({
      requestId,
      model: this.model,
      kind,
      estimatedCostInr: this.costInr(quantity, rateValue),
      metadata: { provider: "sarvam" },
    });
  }

  private costInr(quantity: number, rateValue: string | undefined): number {
    return Math.max(0, Number(rateValue || 0)) * Math.max(0, quantity) / 1000;
  }

  private async readStream(body: ReadableStream<Uint8Array>): Promise<{ text: string; usage?: SarvamChatResult["usage"] }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let usage: SarvamChatResult["usage"];
    let completed = false;

    const consume = (line: string) => {
      const value = line.trim();
      if (!value || !value.startsWith("data:")) return;
      const payload = value.slice(5).trim();
      if (!payload) return;
      if (payload === "[DONE]") { completed = true; return; }
      try {
        const event = JSON.parse(payload);
        if (event.error) throw new Error("Sarvam returned a stream error.");
        const choice = event.choices?.[0];
        if (choice?.finish_reason === "length") throw new Error("Sarvam response exceeded its token limit.");
        if (choice?.finish_reason === "stop") completed = true;
        const delta = readContent(choice?.delta?.content ?? choice?.message?.content);
        if (delta) text += delta;
        const rawUsage = event.usage;
        if (rawUsage) {
          usage = {
            inputTokens: Number(rawUsage.prompt_tokens ?? rawUsage.input_tokens ?? 0),
            outputTokens: Number(rawUsage.completion_tokens ?? rawUsage.output_tokens ?? 0),
            totalTokens: Number(rawUsage.total_tokens ?? 0),
          };
        }
      } catch {
        throw new Error("Sarvam returned an invalid or truncated chat event.");
      }
    };

    try { while (true) {
      const next = await reader.read();
      buffer += decoder.decode(next.value || new Uint8Array(), { stream: !next.done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) consume(line);
      if (next.done) break;
      if (buffer.length + text.length > 1024 * 1024) throw new Error("Sarvam chat exceeded the response size limit.");
    }
    if (buffer) consume(buffer);
    if (!completed) throw new Error("Sarvam chat stream ended before completion.");
    return { text, usage };
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

  private async readJsonResponse(response: Response): Promise<{ text: string; usage?: SarvamChatResult["usage"] }> {
    const body: any = await response.json();
    const message = body.choices?.[0]?.message;
    const text = readContent(message?.content ?? body.output_text ?? body.text);
    const usage = body.usage ? {
      inputTokens: Number(body.usage.prompt_tokens ?? body.usage.input_tokens ?? 0),
      outputTokens: Number(body.usage.completion_tokens ?? body.usage.output_tokens ?? 0),
      totalTokens: Number(body.usage.total_tokens ?? 0),
    } : undefined;
    return { text, usage };
  }
}
