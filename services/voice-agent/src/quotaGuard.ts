/**
 * Voice Agent — Device Quota Guard
 *
 * The orchestrator is the sole custodian of FISH_API_KEY and the per-device
 * character quota.  This guard enforces that quota at the voice-agent edge
 * before any ASR/TTS traffic is allowed to flow.
 *
 * Flow:
 *   1. On `activate` the voice-agent asks the orchestrator for this device's
 *      quota status via GET /api/device/usage (with the device's Bearer token).
 *   2. If the device is over quota the session is rejected with a
 *      `quota_exhausted` message instead of opening the ASR/TTS transports.
 *   3. After each final transcript the voice-agent reports the character count
 *      back to the orchestrator so the ledger stays accurate.
 *
 * The orchestrator's preHandler hook already enforces the token; this guard is
 * the voice-agent's local view of the same quota so the user gets a clear
 * message instead of a silent transport failure.
 */

import { getVoiceUsageBudget } from "./usageBudget.js";

const QUOTA_CHECK_TIMEOUT_MS = 3000;

export interface QuotaStatus {
  ok: boolean;
  reason?: string;
  used: number;
  remaining: number;
  dailyLimit: number;
}

/**
 * Check the device's quota via the orchestrator.
 * Falls back to the local UsageBudget if the orchestrator is unreachable so
 * the voice agent still degrades gracefully during local testing.
 */
export async function checkDeviceQuota(
  orchestratorUrl: string,
  token: string
): Promise<QuotaStatus> {
  const url = `${orchestratorUrl.replace(/\/$/, "")}/api/device/usage`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(QUOTA_CHECK_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 401 = token invalid/expired; 429 = quota exhausted server-side.
      if (res.status === 429) {
        const body = await res.json().catch(() => ({})) as any;
        return {
          ok: false,
          reason: body.error || body.reason || "QUOTA_EXHAUSTED",
          used: 0,
          remaining: 0,
          dailyLimit: 0,
        };
      }
      return {
        ok: false,
        reason: `ORCHESTRATOR_${res.status}`,
        used: 0,
        remaining: 0,
        dailyLimit: 0,
      };
    }
    const body = await res.json() as any;
    return {
      ok: true,
      used: Number(body.used) || 0,
      remaining: Number(body.remaining) || 0,
      dailyLimit: Number(body.dailyLimit) || 0,
    };
  } catch {
    // Local fallback: use the in-process UsageBudget so the voice agent
    // still functions during local testing without the orchestrator.
    const snap = getVoiceUsageBudget().snapshot();
    return {
      ok: true,
      used: Number(snap.spentInr) || 0,
      remaining: Math.max(0, (snap.capInr || 0) - (Number(snap.spentInr) || 0)),
      dailyLimit: snap.capInr || 0,
    };
  }
}

/**
 * Report character usage back to the orchestrator so the per-device ledger
 * stays accurate.  Fire-and-forget: a failure here does not block the session.
 */
export function reportUsage(
  orchestratorUrl: string,
  token: string,
  chars: number
): void {
  const url = `${orchestratorUrl.replace(/\/$/, "")}/api/device/usage/report`;
  fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ charsUsed: chars }),
    signal: AbortSignal.timeout(QUOTA_CHECK_TIMEOUT_MS),
  }).catch(() => {
    // Best-effort; the local UsageBudget is the source of truth for testing.
  });
}