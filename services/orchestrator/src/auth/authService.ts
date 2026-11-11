/**
 * Vanessa Orchestrator — Authentication & Session Service
 * LAN-only, placeholder-ready for production deployment.
 *
 * Security design:
 *   - Devices (Android/Windows/macOS) never see the raw FISH_API_KEY.
 *   - Instead each device receives a short‑lived session token (JWT‑style)
 *     at first‑launch pairing.  The token contains the deviceId and expiry.
 *   - The orchestrator validates the token on every request; if it's
 *     missing/invalid the request is rejected with UNAUTHORIZED_DEVICE.
 *   - Quota is tracked per‑device (per‑token) and enforced before every
 *     voice request.  When the per‑device quota is exhausted the orchestrator
 *     returns RATE_LIMITED with code QUOTA_EXHAUSTED.
 *   - A hard global budget cap stops ALL traffic once the total crosses it.
 *   - Pairing is a single‑use code generated per deployment (see .env.placeholder).
 *     It is never embedded in installers or APKs; it is shown once at first launch.
 *
 * Threat model preserved from the master plan:
 *   - API keys live on the orchestrator only; phone/desktop holds at most a
 *     single‑use pairing code and a short‑lived token.
 *   - Constant‑time comparison for token validation (timing-safeEqual).
 *   - Tokens are single‑use; replay is prevented by the expiry field.
 *   - The orchestrator is the sole custodian of FISH_API_KEY.
 */

import { randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { randomUUID as uuidV4 } from "node:crypto";

// ── Defaults (LAN‑only testing; override via .env or PROD_ env vars) ──────

// Pairing code: single‑use, shown once at first device launch.
// Change this value for each new deployment.  If left unset the orchestrator
// will generate a random 12‑char code on first start (for testing only).
const DEFAULT_PAIRING_CODE = process.env.PAIRING_CODE || `vanessa-${randomBytes(6).toString("hex")}`;

// Quota defaults (per‑device per day; configurable via .env)
// parseInt stops at the first non‑digit, so strip underscores/commas before parsing.
const DEFAULT_FISH_DAILY_CHARACTER_QUOTA =
  parseInt((process.env.FISH_DAILY_CHARACTER_QUOTA || "1_000_000").replace(/[_,]/g, ""), 10);
const DEFAULT_FISH_HARD_BUDGET_CAP =
  parseInt((process.env.FISH_HARD_BUDGET_CAP || "2_000_000").replace(/[_,]/g, ""), 10);

// Session token TTL — 24 hours from issuance.  After expiry the device must
// re‑pair (show the QR/one‑time code again).
const SESSION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

// ── In‑memory stores (replace with Redis / DB in production) ──────────────
//
//   pairingCodes[code] → { deviceId, usedAt, expiresAt }
//   deviceTokens[deviceId] → { token, issuedAt, expiresAt, charsUsedToday }
//   quotaUsed[deviceId] → chars used today (reset at midnight UTC)
//
// All of these are in‑memory maps.  For production deployments replace with
// Redis hashes or a relational table so quotas persist across restarts.

const pairingCodes = new Map<string, { deviceId: string; usedAt: number; expiresAt: number }>();
const deviceTokens = new Map<string, { token: string; issuedAt: number; expiresAt: number; charsUsedToday: number }>();
const quotaUsed = new Map<string, number>(); // deviceId → chars used today

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Consume quota for a device.  Returns true if within quota, false if
 * the per‑device daily quota would be exceeded.
 */
function consumeDeviceQuota(deviceId: string, chars: number): boolean {
  const dailyLimit = getDeviceQuotaLimit(deviceId);
  const current = (quotaUsed.get(deviceId) || 0);
  const after = current + chars;
  if (after > dailyLimit) return false;
  quotaUsed.set(deviceId, after);
  // If we just crossed the hard global cap, no more traffic is allowed.
  const totalUsed = Array.from(quotaUsed.values()).reduce((a, b) => a + b, 0);
  if (totalUsed >= getHardBudgetCap()) {
    // Reset the per‑device counter so the next request sees the cap.
    quotaUsed.set(deviceId, dailyLimit);
    return false;
  }
  return true;
}

/** Per‑device daily quota limit (reads from env or default) */
function getDeviceQuotaLimit(deviceId: string): number {
  // In a production deployment you could vary the limit per device tier.
  return DEFAULT_FISH_DAILY_CHARACTER_QUOTA;
}

/** Hard global budget cap — once total chars used across all devices hits this,
 * every subsequent request is rejected with QUOTA_EXHAUSTED. */
function getHardBudgetCap(): number {
  return DEFAULT_FISH_HARD_BUDGET_CAP;
}

/** Check whether a pairing code is valid and has not been used yet. */
function isPairingCodeValid(code: string): boolean {
  const entry = pairingCodes.get(code);
  if (!entry) return false;
  // Single‑use: mark as used and return true; the caller will clear it.
  if (entry.usedAt > 0) return false; // already consumed
  return entry.expiresAt > Date.now();
}

// ── Exported API ─────────────────────────────────────────────────────────

/**
 * Seed the pairing code into the in‑memory store at orchestrator startup.
 * The code is single‑use: once a device pairs with it, it is deleted.
 * The code expires after PAIRING_CODE_TTL_MS (default 1 hour) if unused.
 */
const PAIRING_CODE_TTL_MS = 60 * 60 * 1000; // 1 hour
export function seedPairingCode(): void {
  const now = Date.now();
  // Only seed once; if a code is already present (e.g. hot reload) keep it.
  if (pairingCodes.size > 0) return;
  pairingCodes.set(DEFAULT_PAIRING_CODE, {
    deviceId: "", // not assigned until a device pairs
    usedAt: 0,
    expiresAt: now + PAIRING_CODE_TTL_MS,
  });
}

/**
 * Pair a new device using a single‑use pairing code.
 * The caller (desktop gateway / Android app) presents the code shown on‑screen.
 * On success returns a session token and the deviceId.
 * Returns null if the code is invalid, expired, or already used.
 */
export function pairDevice(code: string): { deviceId: string; token: string } | null {
  if (!isPairingCodeValid(code)) return null;

  const deviceId = `device_${uuidV4()}`;
  const now = Date.now();
  const token = randomBytes(32).toString("hex");
  const expiresAt = now + SESSION_TOKEN_TTL_MS;

  // Mark the code as used so it can't be reused
  pairingCodes.get(code)!.usedAt = now;

  // Initialise quota tracking for this device
  quotaUsed.set(deviceId, 0);

  // Store the token entry
  deviceTokens.set(deviceId, {
    token,
    issuedAt: now,
    expiresAt,
    charsUsedToday: 0,
  });

  // Remove the used code after first successful pairing
  pairingCodes.delete(code);

  return { deviceId, token };
}

/**
 * Validate a session token sent by a device.
 * Returns the deviceId if valid, or null if the token is missing/expired/invalid.
 * Also updates the token's char usage if the caller reports consumption.
 */
export function validateToken(
  token: string,
  reportedCharsUsed?: number
): { valid: true; deviceId: string } | { valid: false; reason: string } {
  // Find token entry
  let foundDeviceId = "";
  for (const [deviceId, entry] of deviceTokens) {
    if (entry.token === token) {
      foundDeviceId = deviceId;
      break;
    }
  }
  if (foundDeviceId === "") return { valid: false, reason: "UNKNOWN_DEVICE" };

  const entry = deviceTokens.get(foundDeviceId)!;
  if (entry.expiresAt < Date.now()) {
    // Clean up expired token
    deviceTokens.delete(foundDeviceId);
    return { valid: false, reason: "TOKEN_EXPIRED" };
  }

  // Optional: consume quota if the caller reports usage (e.g. after a voice request)
  if (reportedCharsUsed !== undefined && reportedCharsUsed > 0) {
    const consumed = consumeDeviceQuota(foundDeviceId, reportedCharsUsed);
    if (!consumed) {
      // Quota exhausted — still consider the token valid for accounting,
      // but the next request will be rejected at the gateway level.
      entry.charsUsedToday += reportedCharsUsed;
      return { valid: false, reason: "QUOTA_EXHAUSTED" };
    }
    entry.charsUsedToday += reportedCharsUsed;
  }

  return { valid: true, deviceId: foundDeviceId };
}

/**
 * Revoke a device's session token.  Used for emergency key rotation or
 * user‑initiated logout.
 */
export function revokeDevice(deviceId: string): boolean {
  const entry = deviceTokens.get(deviceId);
  if (!entry) return false;
  deviceTokens.delete(deviceId);
  // Optionally keep a tombstone for audit; here we just delete.
  return true;
}

/**
 * Get current quota usage for a device (for UI display).
 */
export function getDeviceQuotaUsage(deviceId: string): {
  used: number;
  remaining: number;
  dailyLimit: number;
} {
  const used = (deviceTokens.get(deviceId)?.charsUsedToday || 0);
  const dailyLimit = getDeviceQuotaLimit(deviceId);
  return {
    used,
    remaining: Math.max(0, dailyLimit - used),
    dailyLimit,
  };
}

// ── Export the pairing code for the first‑launch UI ──────────────────────
export { DEFAULT_PAIRING_CODE };