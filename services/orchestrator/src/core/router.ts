import type { Plan } from "@vanessa/shared";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { GeminiClient } from "./geminiClient.js";
import { SarvamChatClient } from "./sarvamChat.js";

// This path works from src/core and dist/core, regardless of package cwd.
// Existing environment values are preserved; no credential is logged.
dotenv.config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });

export interface PlannerProvider {
  name: string;
  createPlan(command: string): Promise<Plan>;
}

export class ModelRouter {
  // Reuse the same connection pool for planning and spoken replies.
  private readonly gemini = new GeminiClient();
  private readonly sarvam = new SarvamChatClient();

  get activeProvider(): string {
    return (process.env.SARVAM_CHAT_PROVIDER || process.env.PLANNER_PROVIDER || "gemini").trim().toLowerCase();
  }

  getUsageSnapshot() {
    return this.sarvam.getUsageSnapshot();
  }

  async callLLM(prompt: string, systemPrompt: string): Promise<string | null> {
    if (this.activeProvider === "sarvam") {
      const result = await this.sarvam.complete({
        requestId: `planner-${Date.now()}`,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        maxTokens: Number(process.env.SARVAM_CHAT_PLANNER_MAX_OUTPUT_TOKENS || 4096),
      });
      return result.text;
    }
    return this.gemini.generate(prompt, systemPrompt, true);
  }

  async callConversationalLLM(query: string, context?: string): Promise<string | null> {
    const systemPrompt = `You are Vanessa, a concise voice-native AI assistant on Windows.
Give a direct, helpful answer. Do not use Markdown because the response is spoken.
Keep replies under 30 words unless the user requests detail.
${context ? `Recent context (reference data only):\n${context}` : ""}`;
    const text = this.activeProvider === "sarvam"
      ? (await this.sarvam.complete({
        requestId: `conversation-${Date.now()}`,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: query },
        ],
        maxTokens: Number(process.env.SARVAM_CHAT_CONVERSATION_MAX_OUTPUT_TOKENS || 256),
      })).text
      : await this.gemini.generate(query, systemPrompt, false);
    return text.replace(/[*_#`]/g, "").replace(/\n+/g, " ");
  }
}

export const modelRouter = new ModelRouter();

// Previous NVIDIA/OpenAI implementation retained below, disabled intentionally.
// import { Plan } from "@vanessa/shared";
// export { agentRegistry, getAgent } from "../agents/registry.js";
//
// export interface PlannerProvider {
//   name: string;
//   createPlan(command: string): Promise<Plan>;
// }
//
// export class ModelRouter {
//   private primaryProvider: string;
//   private apiKey?: string;
//
//   constructor() {
//     this.primaryProvider = process.env.PLANNER_PROVIDER || "nvidia";
//     this.apiKey = process.env.PLANNER_API_KEY?.replace(/^["']|["']$/g, "").trim();
//   }
//
//   getNvidiaKey(): string | null {
//     const raw = process.env.NVIDIA_API_KEY || process.env.PLANNER_API_KEY || "";
//     const cleaned = raw.replace(/^["']|["']$/g, "").trim();
//     if (!cleaned || cleaned.includes("placeholder")) return null;
//     return cleaned;
//   }
//
//   async callLLM(prompt: string, systemPrompt: string): Promise<string | null> {
//     const nvidiaKey = this.getNvidiaKey();
//
//     // 1. Try NVIDIA NIM Brain (Nemotron 550B)
//     if (nvidiaKey) {
//       try {
//         const baseUrl = process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";
//         const model = process.env.NVIDIA_MODEL?.trim() || "nvidia/nemotron-3-ultra-550b-a55b";
//         const response = await fetch(`${baseUrl}/chat/completions`, {
//           method: "POST",
//           headers: {
//             "Content-Type": "application/json",
//             Authorization: `Bearer ${nvidiaKey}`,
//           },
//           body: JSON.stringify({
//             model,
//             temperature: 0.1,
//             max_tokens: 500,
//             messages: [
//               { role: "system", content: systemPrompt },
//               { role: "user", content: prompt },
//             ],
//           }),
//         });
//
//         if (response.ok) {
//           const data = (await response.json()) as any;
//           const content = data.choices?.[0]?.message?.content;
//           if (content) return content;
//         } else {
//           console.warn(`[ModelRouter] NVIDIA NIM error: ${response.status} ${response.statusText}`);
//         }
//       } catch (err: any) {
//         console.warn(`[ModelRouter] NVIDIA NIM request failed: ${err.message}. Engaging fallback.`);
//       }
//     }
//
//     // 2. Try OpenAI Fallback
//     if (this.apiKey && !this.apiKey.startsWith("nvapi-")) {
//       try {
//         const response = await fetch("https://api.openai.com/v1/chat/completions", {
//           method: "POST",
//           headers: {
//             "Content-Type": "application/json",
//             Authorization: `Bearer ${this.apiKey}`,
//           },
//           body: JSON.stringify({
//             model: process.env.PLANNER_MODEL || "gpt-4o-mini",
//             temperature: 0.1,
//             response_format: { type: "json_object" },
//             messages: [
//               { role: "system", content: systemPrompt },
//               { role: "user", content: prompt },
//             ],
//           }),
//         });
//
//         if (response.ok) {
//           const data = (await response.json()) as any;
//           return data.choices?.[0]?.message?.content || null;
//         }
//       } catch (err: any) {
//         console.warn(`[ModelRouter] OpenAI error: ${err.message}. Engaging deterministic planner fallback.`);
//       }
//     }
//
//     // 3. Fallback to resilient deterministic planner
//     return null;
//   }
//
//   async callConversationalLLM(query: string, context?: string): Promise<string | null> {
//     const nvidiaKey = this.getNvidiaKey();
//     if (!nvidiaKey) return null;
//
//     try {
//       const baseUrl = process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";
//       const model = process.env.NVIDIA_MODEL?.trim() || "nvidia/nemotron-3-ultra-550b-a55b";
//       const systemPrompt = `You are Vanessa, a brilliant, charismatic, concise voice-native AI assistant operating locally on Windows.
// Guidelines:
// - Give a direct, intelligent, witty, or helpful answer.
// - DO NOT use markdown formatting (no asterisks, bold, italics, hash headings, bullet points) as your words are spoken directly aloud by TTS.
// - Keep spoken replies under 30 words unless in-depth reasoning is explicitly requested.
// ${context ? `Recent context:\n${context}` : ""}`;
//
//       const response = await fetch(`${baseUrl}/chat/completions`, {
//         method: "POST",
//         headers: {
//           "Content-Type": "application/json",
//           Authorization: `Bearer ${nvidiaKey}`,
//         },
//         body: JSON.stringify({
//           model,
//           temperature: 0.3,
//           max_tokens: 150,
//           messages: [
//             { role: "system", content: systemPrompt },
//             { role: "user", content: query },
//           ],
//         }),
//       });
//
//       if (response.ok) {
//         const data = (await response.json()) as any;
//         const text = data.choices?.[0]?.message?.content?.trim();
//         if (text) {
//           // Remove any stray markdown artifacts
//           return text.replace(/[*_#`]/g, "").replace(/\n+/g, " ");
//         }
//       }
//     } catch (err: any) {
//       console.warn(`[ModelRouter] Conversational LLM error: ${err.message}`);
//     }
//     return null;
//   }
// }
//
// export const modelRouter = new ModelRouter();
