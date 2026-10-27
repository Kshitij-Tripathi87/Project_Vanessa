import {
  AgentEvidence,
  AgentResult,
  AgentRunContext,
  AgentTask,
  SpecialistAgent,
} from "@vanessa/shared";
import { privacyGuard } from "../core/privacy.js";
import { eventBus } from "../core/eventBus.js";
import { memoryPalace, type MemoryPalace } from "../memory/memoryPalace.js";
import { resolveManagedAction } from "../core/actionRegistry.js";

function sanitizeMemoryMetadata(input: Record<string, any> | undefined): { value?: Record<string, any>; redactedCount: number } {
  if (!input) return { value: undefined, redactedCount: 0 };
  let redactedCount = 0;
  const sensitiveKey = /(password|passwd|secret|token|api[-_]?key|authorization|credential|private[-_]?key)/i;
  const clean = (value: any, key = "", depth = 0): any => {
    if (sensitiveKey.test(key)) {
      redactedCount++;
      return "[REDACTED]";
    }
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") {
      const redacted = privacyGuard.redactSensitiveData(value);
      redactedCount += redacted.redactedCount;
      return redacted.cleanText.slice(0, 4000);
    }
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => clean(item, "", depth + 1));
    if (typeof value === "object" && depth < 5) {
      const entries = Object.entries(value).slice(0, 100);
      return Object.fromEntries(entries.map(([childKey, childValue]) => [childKey, clean(childValue, childKey, depth + 1)]));
    }
    return "[OMITTED]";
  };
  return { value: clean(input) as Record<string, any>, redactedCount };
}

export class MemoryAgent implements SpecialistAgent {
  constructor(private readonly memory: MemoryPalace = memoryPalace) {}

  id = "memory";
  capabilities = ["recall", "contextualize", "preserve_knowledge", "incident_history", "user_preferences"];
  allowedTools = ["memory_retrieve", "memory_store", "memory_search", "memory_list", "memory_delete"];

  private blocked(action: string, reason: string): AgentResult {
    return {
      agentId: this.id, status: "blocked", success: false, summary: reason,
      spokenSummary: "I blocked that memory operation because it did not match the registered memory contract.",
      error: reason,
      evidence: [{
        description: "The request was rejected before a process or memory mutation was started.",
        source: "memory-agent-policy", timestamp: new Date().toISOString(), confidence: 1,
        data: { outcome: "blocked", actionId: action, processStarted: false },
      }],
      artifacts: [], verification: { passed: false, details: reason },
      data: { outcome: "blocked", actionId: action, processStarted: false },
    };
  }

  async execute(
    actionOrTask: string | AgentTask,
    paramsOrContext?: Record<string, any> | AgentRunContext,
    context?: AgentRunContext
  ): Promise<AgentResult> {
    const action = typeof actionOrTask === "string" ? actionOrTask : actionOrTask.action || actionOrTask.objective;
    const params = typeof actionOrTask === "string" ? (paramsOrContext as Record<string, any>) || {} : actionOrTask.params || {};
    const runCtx = typeof actionOrTask === "string" ? context : (paramsOrContext as AgentRunContext);

    const policy = resolveManagedAction(action, params);
    if (!policy.managed || policy.blocked) {
      return this.blocked(action, policy.reason || ("Unregistered memory action '" + action + "' is blocked."));
    }
    const canonicalAction = policy.canonicalId || action;

    switch (canonicalAction) {
      case "memory.retrieve":
        return this.retrieve(String(params.query ?? params.keyword ?? ""), runCtx);
      case "memory.store":
        return this.store(String(params.content ?? params.text ?? ""), params.metadata, runCtx);
      case "memory.list":
        return this.list(params.limit ?? 10, runCtx);
      default:
        return this.blocked(action, "No executor is registered for memory action '" + canonicalAction + "'.");
    }
  }

  private async retrieve(query: string, _ctx?: AgentRunContext): Promise<AgentResult> {
    const startTime = new Date().toISOString();
    const normalizedQuery = query.trim();
    let records;
    try {
      records = this.memory.retrieve(normalizedQuery, 3);
    } catch (error: any) {
      const reason = "Memory Palace query failed: " + (typeof error?.message === "string" ? error.message : "unknown database error");
      return {
        agentId: this.id, status: "failed", success: false, summary: reason,
        spokenSummary: "I could not read Vanessa's local memory store.", error: reason,
        evidence: [{ description: reason, source: "memoryPalace.retrieve", timestamp: startTime, confidence: 1 }],
        artifacts: [], verification: { passed: false, details: reason },
        data: { outcome: "failed", query: normalizedQuery, resultCount: 0 },
      };
    }

    if (records.length === 0) {
      const detail = "No active Memory Palace records matched the query" +
        (normalizedQuery ? " '" + normalizedQuery + "'" : "") +
        ". No seeded or fallback record was substituted.";
      const evidence: AgentEvidence[] = [{
        description: detail, source: "memoryPalace.retrieve", timestamp: startTime, confidence: 1,
        data: { query: normalizedQuery, resultCount: 0 },
      }];
      eventBus.emitEvent("audit:log", {
        id: "audit-" + Date.now(), timestamp: Date.now(), source: "desktop_hud", agent: this.id,
        action: "memory.retrieve", resource: "memoryPalace.retrieve", risk: "low", permission: "allowed",
        status: "warn", result: { query: normalizedQuery, resultCount: 0 }, details: detail,
      });
      return {
        agentId: this.id, status: "partial", success: false, summary: detail,
        spokenSummary: "I found no matching records in Vanessa's local memory.",
        evidence, artifacts: [], verification: { passed: false, details: detail },
        data: { outcome: "inconclusive", query: normalizedQuery, records: [], resultCount: 0, source: "memoryPalace" },
      };
    }

    const first = records[0];
    const detail = "Retrieved " + records.length + " matching active Memory Palace record(s) from the local SQLite database.";
    const evidence: AgentEvidence[] = records.map((record) => ({
      description: "Retrieved memory record '" + record.title + "' (id " + record.id + ").",
      source: "memoryPalace.retrieve", timestamp: new Date(record.createdAt).toISOString(), confidence: 1,
      data: { id: record.id, title: record.title, type: record.type, agent: record.agent, status: record.status, expiresAt: record.expiresAt },
    }));
    eventBus.emitEvent("audit:log", {
      id: "audit-" + Date.now(), timestamp: Date.now(), source: "desktop_hud", agent: this.id,
      action: "memory.retrieve", resource: "memoryPalace.retrieve", risk: "low", permission: "allowed",
      status: "success", result: { query: normalizedQuery, resultCount: records.length, recordIds: records.map((record) => record.id) },
      details: detail,
    });
    return {
      agentId: this.id, status: "completed", success: true, summary: detail,
      spokenSummary: "I retrieved " + records.length + " matching memory record(s). The most recent match is " + first.title + ".",
      evidence, artifacts: records.map((record) => "memory:" + record.id),
      verification: { passed: true, details: detail },
      data: { outcome: "succeeded", query: normalizedQuery, resultCount: records.length, records, source: "memoryPalace", freshness: "active" },
    };
  }

  private async store(content: string, metadata?: Record<string, any>, _ctx?: AgentRunContext): Promise<AgentResult> {
    const startTime = new Date().toISOString();
    const normalizedContent = content.trim();
    if (!normalizedContent) return this.blocked("memory.store", "Memory content must be a non-empty string.");
    if (normalizedContent.length > 20000) return this.blocked("memory.store", "Memory content exceeds the 20,000-character limit.");

    const redacted = privacyGuard.redactSensitiveData(normalizedContent);
    try {
      const safeMetadata = sanitizeMemoryMetadata(metadata);
      const cleanTitle = privacyGuard.redactSensitiveData(
        typeof safeMetadata.value?.title === "string" && safeMetadata.value.title.trim() ? safeMetadata.value.title.trim() : "Stored Memory"
      );
      const record = this.memory.storeMemory({
        type: "knowledge",
        title: cleanTitle.cleanText.slice(0, 200),
        content: redacted.cleanText, rawData: safeMetadata.value, agent: this.id, ttlDays: 30,
      });
      const totalRedactedCount = redacted.redactedCount + safeMetadata.redactedCount + cleanTitle.redactedCount;
      const safeRecord = {
        id: record.id, type: record.type, title: record.title, content: record.content,
        agent: record.agent, status: record.status, createdAt: record.createdAt, expiresAt: record.expiresAt,
      };
      const detail = "Persisted local memory record '" + record.id + "' after privacy redaction.";
      const evidence: AgentEvidence[] = [{
        description: detail, source: "memoryPalace.storeMemory", timestamp: startTime, confidence: 1,
        data: { id: record.id, title: record.title, createdAt: record.createdAt, expiresAt: record.expiresAt, redactedCount: totalRedactedCount },
      }];
      eventBus.emitEvent("audit:log", {
        id: "audit-" + Date.now(), timestamp: Date.now(), source: "desktop_hud", agent: this.id,
        action: "memory.store", resource: "Memory Palace:" + record.id, risk: "low", permission: "allowed",
        status: "success", result: { id: record.id, title: record.title, redactedCount: totalRedactedCount }, details: detail,
      });
      return {
        agentId: this.id, status: "completed", success: true, summary: detail,
        spokenSummary: "Saved the redacted record to Vanessa's local memory store.",
        evidence, artifacts: ["memory:" + record.id], verification: { passed: true, details: detail },
        data: { outcome: "succeeded", stored: true, record: safeRecord, redactedCount: totalRedactedCount },
      };
    } catch (error: any) {
      const reason = "Memory Palace write failed: " + (typeof error?.message === "string" ? error.message : "unknown database error");
      return {
        agentId: this.id, status: "failed", success: false, summary: reason,
        spokenSummary: "I could not save the memory record.", error: reason,
        evidence: [{ description: reason, source: "memoryPalace.storeMemory", timestamp: startTime, confidence: 1 }],
        artifacts: [], verification: { passed: false, details: reason },
        data: { outcome: "failed", stored: false, redactedCount: totalRedactedCount },
      };
    }
  }

  private async list(limit: number, _ctx?: AgentRunContext): Promise<AgentResult> {
    const startTime = new Date().toISOString();
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      return this.blocked("memory.list", "Memory list limit must be an integer from 1 to 50.");
    }
    try {
      const records = this.memory.retrieve("", limit);
      const detail = "Listed " + records.length + " active Memory Palace record(s) (limit " + limit + ").";
      const evidence: AgentEvidence[] = [{
        description: detail, source: "memoryPalace.retrieve", timestamp: startTime, confidence: 1,
        data: { resultCount: records.length, requestedLimit: limit, recordIds: records.map((record) => record.id) },
      }];
      eventBus.emitEvent("audit:log", {
        id: "audit-" + Date.now(), timestamp: Date.now(), source: "desktop_hud", agent: this.id,
        action: "memory.list", resource: "memoryPalace.retrieve", risk: "low", permission: "allowed",
        status: "success", result: { resultCount: records.length, requestedLimit: limit }, details: detail,
      });
      return {
        agentId: this.id, status: "completed", success: true, summary: detail,
        spokenSummary: "I listed " + records.length + " active memory record(s).",
        evidence, artifacts: records.map((record) => "memory:" + record.id),
        verification: { passed: true, details: detail },
        data: { outcome: "succeeded", records, resultCount: records.length, limit, source: "memoryPalace" },
      };
    } catch (error: any) {
      const reason = "Memory Palace list failed: " + (typeof error?.message === "string" ? error.message : "unknown database error");
      return {
        agentId: this.id, status: "failed", success: false, summary: reason,
        spokenSummary: "I could not list Vanessa's local memory records.", error: reason,
        evidence: [{ description: reason, source: "memoryPalace.retrieve", timestamp: startTime, confidence: 1 }],
        artifacts: [], verification: { passed: false, details: reason },
        data: { outcome: "failed", resultCount: 0 },
      };
    }
  }
}

export const memoryAgent = new MemoryAgent();
