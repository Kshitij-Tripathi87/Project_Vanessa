/**
 * Phase 3.3: Message Signing and Security
 *
 * HMAC-SHA256 signing for protocol messages.
 *
 * Signing contract (must match the Kotlin bridge client):
 *
 *   signature = hex(HMAC-SHA256(secret, canonicalJson(message without `signature`)))
 *
 * `canonicalJson` serialises objects with their keys sorted at every depth and
 * no insignificant whitespace, so TypeScript and Kotlin produce byte-identical
 * input independent of property insertion order. `timestamp` and `nonce` are
 * ordinary fields of the message, which means the signed bytes never include
 * the signature itself (the previous contract signed `{payload, timestamp,
 * nonce}` where `payload` already contained both, so a valid signature could
 * not be produced).
 */

import crypto from "crypto";

export interface SecurityConfig {
  maxMessageAge: number; // ms
  replayWindowSize: number; // number of recent nonces to track
}

const DEFAULT_CONFIG: SecurityConfig = {
  maxMessageAge: 60000, // 60 seconds
  replayWindowSize: 1000, // track last 1000 nonces
};

/** Allowed clock skew for timestamps in the future. */
const FUTURE_SKEW_MS = 5000;

export type VerifyError =
  | "invalid_signature"
  | "stale_message"
  | "replayed_message"
  | "missing_timestamp";

export interface VerifyResult {
  valid: boolean;
  error?: VerifyError;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Deterministic JSON: keys sorted at every depth, no whitespace.
 * Throws on values that cannot be represented (undefined, functions, NaN).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("Canonical JSON does not support non-finite numbers");
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      const record = value as Record<string, unknown>;
      const entries = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
      return `{${entries.join(",")}}`;
    }
    default:
      throw new Error(`Canonical JSON does not support ${typeof value}`);
  }
}

/** Strip the signature so the signed bytes do not depend on themselves. */
export function unsignedMessage(message: Record<string, unknown>): Record<string, unknown> {
  const { signature: _signature, ...rest } = message;
  return rest;
}

/** Compute the hex HMAC for a message (excluding any existing signature). */
export function computeSignature(message: Record<string, unknown>, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(canonicalJson(unsignedMessage(message)), "utf8")
    .digest("hex");
}

/** Return a copy of the message carrying a freshly computed signature. */
export function signMessage<T extends Record<string, unknown>>(message: T, secret: string): T & { signature: string } {
  return { ...message, signature: computeSignature(message, secret) };
}

/** Constant-time hex comparison. */
function signaturesMatch(expected: string, supplied: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(supplied, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Message Signer - signs messages and verifies inbound ones, including
 * replay and clock-skew protection keyed on the message `nonce`.
 */
export class MessageSigner {
  private config: SecurityConfig;
  private recentNonces: Set<string> = new Set();
  private nonceQueue: string[] = [];

  constructor(config: Partial<SecurityConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  sign<T extends Record<string, unknown>>(message: T, secret: string): T & { signature: string } {
    return signMessage(message, secret);
  }

  verify(message: Record<string, unknown>, secret: string): VerifyResult {
    const unsigned = unsignedMessage(message);
    const timestamp = unsigned.timestamp;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
      return { valid: false, error: "missing_timestamp" };
    }

    const age = Date.now() - timestamp;
    if (age > this.config.maxMessageAge || age < -FUTURE_SKEW_MS) {
      return { valid: false, error: "stale_message" };
    }

    const nonce = unsigned.nonce;
    if (typeof nonce === "string" && nonce.length > 0 && this.recentNonces.has(nonce)) {
      return { valid: false, error: "replayed_message" };
    }

    const supplied = (message as { signature?: unknown }).signature;
    if (typeof supplied !== "string" || supplied.length === 0 || !signaturesMatch(computeSignature(message, secret), supplied)) {
      return { valid: false, error: "invalid_signature" };
    }

    if (typeof nonce === "string" && nonce.length > 0) this.addNonce(nonce);
    return { valid: true };
  }

  private addNonce(nonce: string): void {
    this.recentNonces.add(nonce);
    this.nonceQueue.push(nonce);

    if (this.nonceQueue.length > this.config.replayWindowSize) {
      const oldNonce = this.nonceQueue.shift()!;
      this.recentNonces.delete(oldNonce);
    }
  }

  clearNonces(): void {
    this.recentNonces.clear();
    this.nonceQueue = [];
  }

  getStats(): { trackedNonces: number; maxAge: number } {
    return { trackedNonces: this.recentNonces.size, maxAge: this.config.maxMessageAge };
  }
}

/**
 * Security Manager - coordinates signing, verification, and device secrets.
 */
export class SecurityManager {
  private signer: MessageSigner;
  private deviceSecrets: Map<string, string> = new Map();

  constructor(config: Partial<SecurityConfig> = {}) {
    this.signer = new MessageSigner(config);
  }

  /** Register (or rotate) the HMAC secret for a paired device. */
  registerDevice(deviceId: string, secret: string): void {
    this.deviceSecrets.set(deviceId, secret);
    console.log(`[Security] Device registered: ${deviceId}`);
  }

  unregisterDevice(deviceId: string): void {
    this.deviceSecrets.delete(deviceId);
    console.log(`[Security] Device unregistered: ${deviceId}`);
  }

  isDeviceRegistered(deviceId: string): boolean {
    return this.deviceSecrets.has(deviceId);
  }

  /** Sign a message for a specific device; null when the device is unknown. */
  signForDevice<T extends Record<string, unknown>>(deviceId: string, message: T): (T & { signature: string }) | null {
    const secret = this.deviceSecrets.get(deviceId);
    if (!secret) {
      console.error(`[Security] No secret for device: ${deviceId}`);
      return null;
    }
    return this.signer.sign(message, secret);
  }

  /** Verify a message that claims to come from a specific paired device. */
  verifyFromDevice(deviceId: string, message: Record<string, unknown>): VerifyResult {
    const secret = this.deviceSecrets.get(deviceId);
    if (!secret) {
      return { valid: false, error: "invalid_signature" };
    }
    return this.signer.verify(message, secret);
  }

  getStats(): { registeredDevices: number; signer: { trackedNonces: number; maxAge: number } } {
    return { registeredDevices: this.deviceSecrets.size, signer: this.signer.getStats() };
  }
}

/** Generate a secure random secret (base64). */
export function generateSecret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64");
}

/** Hash a secret for storage where the raw secret is not needed. */
export function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

/** Constant-time string comparison to prevent timing attacks. */
export function secureCompare(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export type { Json };
