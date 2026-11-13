import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  PRE_SESSION_ID,
  RemoteSessionGuard,
  computeKeyId,
  isSupportedIdentityKey,
  normalizeIdentityPublicKey,
  safeParseRemoteEnvelope,
  safeParseRemotePayload,
  type PublicKeyInput,
  type RemoteEnvelope,
  type RemotePayloadFor,
} from "@vanessa/protocol";

export type PairingRegistryErrorCode =
  | "PAIRING_CODE_INVALID"
  | "PAIRING_EXPIRED"
  | "PAIRING_ALREADY_CLAIMED"
  | "PAIRING_PROOF_INVALID"
  | "PAIRING_STATE_INVALID"
  | "PAIRING_DENIED";

export class PairingRegistryError extends Error {
  constructor(readonly code: PairingRegistryErrorCode, message: string) {
    super(message);
    this.name = "PairingRegistryError";
  }
}

export type CreatedPairingWindow = {
  pairingId: string;
  code: string;
  createdAt: number;
  expiresAt: number;
};

export type PendingRemotePairing = {
  pairingId: string;
  keyId: string;
  deviceHint: string;
  platform: "android" | "desktop" | "web" | "unknown";
  appVersion: string;
  requestedAt: number;
  expiresAt: number;
};

export type TrustedRemoteDevice = {
  deviceId: string;
  keyId: string;
  /** Base64url SPKI DER. Public material only; the phone's private key stays in Android Keystore. */
  publicKeySpki: string;
  deviceHint: string;
  platform: "android" | "desktop" | "web" | "unknown";
  appVersion: string;
  grantedScopes: string[];
  pairedAt: number;
  revoked: boolean;
};

type PairingState = "ready" | "challenge_issued" | "awaiting_approval" | "approved" | "rejected" | "expired";

type PairingEntry = {
  pairingId: string;
  codeDigest: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  state: PairingState;
  phoneGuard?: RemoteSessionGuard;
  keyId?: string;
  publicKeySpki?: string;
  deviceHint?: string;
  platform?: PendingRemotePairing["platform"];
  appVersion?: string;
  clientNonce?: string;
  challengeNonce?: string;
  challengeExpiresAt?: number;
  requestedAt?: number;
};

export type RemotePairingRegistryOptions = {
  storePath: string;
  now?: () => number;
  pairingTtlMs?: number;
  challengeTtlMs?: number;
  sessionTtlMs?: number;
  maxCodeAttempts?: number;
};

const DEFAULT_PAIRING_TTL_MS = 5 * 60_000;
const DEFAULT_CHALLENGE_TTL_MS = 2 * 60_000;
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_MAX_CODE_ATTEMPTS = 5;

function codeDigest(code: string): Buffer {
  return createHash("sha256").update(code, "utf8").digest();
}

function constantTimeCodeMatch(code: string, expectedHex: string): boolean {
  const supplied = codeDigest(code);
  const expected = Buffer.from(expectedHex, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function validScope(scope: string): boolean {
  return /^[a-z][a-z0-9_.]{0,63}$/.test(scope);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * PC-owned one-time pairing and trusted-device registry.
 *
 * The registry verifies a phone's self-signed P-256 pairing claim, issues a
 * short-lived proof challenge, verifies the signed completion, and then waits
 * for explicit local approval. It never trusts a phone merely because it knows
 * the QR code. It persists only public device keys, scopes and revocation state.
 */
export class RemotePairingRegistry {
  private readonly now: () => number;
  private readonly pairingTtlMs: number;
  private readonly challengeTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly maxCodeAttempts: number;
  private readonly pairings = new Map<string, PairingEntry>();
  private readonly trustedDevices = new Map<string, TrustedRemoteDevice>();
  private initialized = false;
  private persistenceTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: RemotePairingRegistryOptions) {
    if (!options.storePath.trim()) throw new Error("A trusted-device store path is required.");
    this.now = options.now ?? Date.now;
    this.pairingTtlMs = options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS;
    this.challengeTtlMs = options.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.maxCodeAttempts = options.maxCodeAttempts ?? DEFAULT_MAX_CODE_ATTEMPTS;
    for (const [name, value] of [
      ["pairingTtlMs", this.pairingTtlMs],
      ["challengeTtlMs", this.challengeTtlMs],
      ["sessionTtlMs", this.sessionTtlMs],
      ["maxCodeAttempts", this.maxCodeAttempts],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer.`);
    }
  }

  /** Load trusted public keys. A malformed store fails closed rather than silently forgetting trust. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      const source = await readFile(this.options.storePath, "utf8");
      const parsed: unknown = JSON.parse(source);
      if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.devices)) {
        throw new Error("Trusted-device store has an unsupported format.");
      }
      const restored = new Map<string, TrustedRemoteDevice>();
      for (const raw of parsed.devices) {
        const device = this.validateStoredDevice(raw);
        if (restored.has(device.keyId)) throw new Error("Trusted-device store contains a duplicate keyId.");
        restored.set(device.keyId, device);
      }
      for (const [keyId, device] of restored) this.trustedDevices.set(keyId, device);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.initialized = true;
  }

  /** Generate a fresh, one-use QR pairing code. The raw code is returned exactly once. */
  createPairingWindow(nowMs = this.now()): CreatedPairingWindow {
    this.ensureInitialized();
    this.expirePending(nowMs);
    for (const entry of this.pairings.values()) {
      if (entry.state === "ready") entry.state = "expired";
    }
    const pairingId = `pair_${randomBytes(12).toString("hex")}`;
    const code = randomBytes(24).toString("hex");
    const createdAt = nowMs;
    const expiresAt = nowMs + this.pairingTtlMs;
    this.pairings.set(pairingId, {
      pairingId,
      codeDigest: codeDigest(code).toString("hex"),
      createdAt,
      expiresAt,
      attempts: 0,
      state: "ready",
    });
    return { pairingId, code, createdAt, expiresAt };
  }

  /** Verify a new phone identity and return the nonce challenge for the next signed frame. */
  claim(value: unknown, nowMs = this.now()): RemotePayloadFor<"pairing.challenge"> {
    this.ensureInitialized();
    const envelope = this.parsePreSessionEnvelope(value, "pairing.claim");
    const parsed = safeParseRemotePayload("pairing.claim", envelope.payload);
    if (!parsed.success) throw new PairingRegistryError("PAIRING_PROOF_INVALID", "Pairing claim payload is invalid.");
    const payload = parsed.data;

    const entry = this.pairings.get(payload.pairingId);
    if (!entry) throw new PairingRegistryError("PAIRING_CODE_INVALID", "Pairing code is invalid or expired.");
    if (entry.expiresAt <= nowMs) {
      entry.state = "expired";
      throw new PairingRegistryError("PAIRING_EXPIRED", "Pairing code has expired.");
    }
    if (entry.state !== "ready") {
      throw new PairingRegistryError("PAIRING_ALREADY_CLAIMED", "Pairing code has already been claimed.");
    }

    let phonePublicKey;
    try {
      phonePublicKey = normalizeIdentityPublicKey(payload.publicKey);
    } catch {
      throw new PairingRegistryError("PAIRING_PROOF_INVALID", "Phone identity key is invalid.");
    }
    if (!isSupportedIdentityKey(phonePublicKey)) {
      throw new PairingRegistryError("PAIRING_PROOF_INVALID", "Phone identity must use P-256.");
    }
    const derivedKeyId = computeKeyId(phonePublicKey);
    if (derivedKeyId !== payload.keyId || derivedKeyId !== envelope.keyId) {
      throw new PairingRegistryError("PAIRING_PROOF_INVALID", "Phone key ID does not match the supplied public key.");
    }
    if (!payload.clientNonce) {
      throw new PairingRegistryError("PAIRING_PROOF_INVALID", "Pairing claim must include a fresh client nonce.");
    }

    const guard = new RemoteSessionGuard({
      sessionId: PRE_SESSION_ID,
      keyId: derivedKeyId,
      publicKey: phonePublicKey,
      direction: "client_to_server",
      lastAcceptedSequence: envelope.sequence - 1,
      maxMessageAgeMs: this.pairingTtlMs,
      maxFutureSkewMs: 5_000,
    });
    const proof = guard.verifyAndAccept(envelope, nowMs);
    if (!proof.accepted) {
      throw new PairingRegistryError("PAIRING_PROOF_INVALID", "Phone pairing signature or freshness check failed.");
    }

    entry.attempts += 1;
    if (!constantTimeCodeMatch(payload.code, entry.codeDigest)) {
      if (entry.attempts >= this.maxCodeAttempts) entry.state = "expired";
      throw new PairingRegistryError("PAIRING_CODE_INVALID", "Pairing code is invalid or expired.");
    }

    entry.state = "challenge_issued";
    entry.phoneGuard = guard;
    entry.keyId = derivedKeyId;
    entry.publicKeySpki = payload.publicKey;
    entry.deviceHint = payload.deviceHint;
    entry.platform = payload.platform;
    entry.appVersion = payload.appVersion;
    entry.clientNonce = payload.clientNonce;
    entry.requestedAt = nowMs;
    entry.challengeNonce = randomBytes(32).toString("base64url");
    entry.challengeExpiresAt = Math.min(entry.expiresAt, nowMs + this.challengeTtlMs);

    return {
      pairingId: entry.pairingId,
      nonce: entry.challengeNonce,
      issuedAt: nowMs,
      expiresAt: entry.challengeExpiresAt,
      clientNonce: entry.clientNonce,
    };
  }

  /** Verify the phone's signed challenge response. Successful completion still requires local approval. */
  complete(value: unknown, nowMs = this.now()): RemotePayloadFor<"pairing.pending"> {
    this.ensureInitialized();
    const envelope = this.parsePreSessionEnvelope(value, "pairing.complete");
    const parsed = safeParseRemotePayload("pairing.complete", envelope.payload);
    if (!parsed.success) throw new PairingRegistryError("PAIRING_PROOF_INVALID", "Pairing completion payload is invalid.");
    const payload = parsed.data;

    const entry = this.pairings.get(payload.pairingId);
    if (!entry || entry.state !== "challenge_issued" || !entry.phoneGuard || !entry.challengeNonce || !entry.challengeExpiresAt) {
      throw new PairingRegistryError("PAIRING_STATE_INVALID", "Pairing challenge is not active.");
    }
    if (entry.challengeExpiresAt <= nowMs) {
      entry.state = "expired";
      throw new PairingRegistryError("PAIRING_EXPIRED", "Pairing challenge has expired.");
    }
    if (!constantTimeCodeMatch(payload.challengeNonce, createHash("sha256").update(entry.challengeNonce).digest("hex"))) {
      throw new PairingRegistryError("PAIRING_PROOF_INVALID", "Pairing challenge response does not match.");
    }

    const proof = entry.phoneGuard.verifyAndAccept(envelope, nowMs);
    if (!proof.accepted) {
      throw new PairingRegistryError("PAIRING_PROOF_INVALID", "Phone did not prove possession of its paired identity key.");
    }

    entry.state = "awaiting_approval";
    return {
      pairingId: entry.pairingId,
      state: "awaiting_approval",
      expiresAt: entry.challengeExpiresAt,
    };
  }

  /** Local-only approval. Callers must expose this through a trusted PC UI/API, never a remote message. */
  async approve(
    pairingId: string,
    grantedScopes: string[],
    nowMs = this.now(),
  ): Promise<RemotePayloadFor<"pairing.approved">> {
    this.ensureInitialized();
    const entry = this.pairings.get(pairingId);
    if (!entry || entry.state !== "awaiting_approval" || !entry.keyId || !entry.publicKeySpki ||
        !entry.deviceHint || !entry.platform || !entry.appVersion || !entry.challengeNonce || !entry.clientNonce) {
      throw new PairingRegistryError("PAIRING_STATE_INVALID", "Pairing is not waiting for local approval.");
    }
    if ((entry.challengeExpiresAt ?? 0) <= nowMs) {
      entry.state = "expired";
      throw new PairingRegistryError("PAIRING_EXPIRED", "Pairing approval window has expired.");
    }
    if (grantedScopes.length > 32 || new Set(grantedScopes).size !== grantedScopes.length ||
        grantedScopes.some((scope) => !validScope(scope))) {
      throw new PairingRegistryError("PAIRING_PROOF_INVALID", "Granted scopes are invalid.");
    }
    if (this.trustedDevices.has(entry.keyId)) {
      const existing = this.trustedDevices.get(entry.keyId)!;
      if (!existing.revoked) throw new PairingRegistryError("PAIRING_ALREADY_CLAIMED", "This phone is already paired.");
    }

    const device: TrustedRemoteDevice = {
      deviceId: randomUUID(),
      keyId: entry.keyId,
      publicKeySpki: entry.publicKeySpki,
      deviceHint: entry.deviceHint,
      platform: entry.platform,
      appVersion: entry.appVersion,
      grantedScopes: [...grantedScopes],
      pairedAt: nowMs,
      revoked: false,
    };
    this.trustedDevices.set(device.keyId, device);
    entry.state = "approved";
    await this.persistTrustedDevices();

    return {
      deviceId: device.deviceId,
      keyId: device.keyId,
      grantedScopes: [...device.grantedScopes],
      sessionExpiresAt: nowMs + this.sessionTtlMs,
      serverNonce: entry.challengeNonce,
      clientNonce: entry.clientNonce,
    };
  }

  reject(pairingId: string): RemotePayloadFor<"pairing.rejected"> {
    this.ensureInitialized();
    const entry = this.pairings.get(pairingId);
    if (!entry || entry.state !== "awaiting_approval") {
      throw new PairingRegistryError("PAIRING_STATE_INVALID", "Pairing is not waiting for local approval.");
    }
    entry.state = "rejected";
    return { pairingId, reason: "declined_on_pc" };
  }

  getPendingApprovals(): PendingRemotePairing[] {
    this.ensureInitialized();
    this.expirePending(this.now());
    return [...this.pairings.values()]
      .filter((entry) => entry.state === "awaiting_approval" && entry.keyId && entry.deviceHint &&
        entry.platform && entry.appVersion && entry.requestedAt !== undefined && entry.challengeExpiresAt !== undefined)
      .map((entry) => ({
        pairingId: entry.pairingId,
        keyId: entry.keyId!,
        deviceHint: entry.deviceHint!,
        platform: entry.platform!,
        appVersion: entry.appVersion!,
        requestedAt: entry.requestedAt!,
        expiresAt: entry.challengeExpiresAt!,
      }))
      .sort((a, b) => a.requestedAt - b.requestedAt);
  }

  getTrustedDeviceByKeyId(keyId: string): TrustedRemoteDevice | undefined {
    this.ensureInitialized();
    const device = this.trustedDevices.get(keyId);
    return device ? { ...device, grantedScopes: [...device.grantedScopes] } : undefined;
  }

  listTrustedDevices(): TrustedRemoteDevice[] {
    this.ensureInitialized();
    return [...this.trustedDevices.values()].map((device) => ({ ...device, grantedScopes: [...device.grantedScopes] }));
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    this.ensureInitialized();
    const device = [...this.trustedDevices.values()].find((candidate) => candidate.deviceId === deviceId);
    if (!device) return false;
    if (!device.revoked) {
      device.revoked = true;
      await this.persistTrustedDevices();
    }
    return true;
  }

  private parsePreSessionEnvelope(value: unknown, expectedType: "pairing.claim" | "pairing.complete"): RemoteEnvelope {
    const parsed = safeParseRemoteEnvelope(value);
    if (!parsed.success) throw new PairingRegistryError("PAIRING_PROOF_INVALID", "Pairing envelope is malformed.");
    if (parsed.data.type !== expectedType || parsed.data.sessionId !== PRE_SESSION_ID) {
      throw new PairingRegistryError("PAIRING_PROOF_INVALID", "Pairing message is not valid for the pre-session handshake.");
    }
    return parsed.data;
  }

  private validateStoredDevice(value: unknown): TrustedRemoteDevice {
    if (!isObject(value) ||
        typeof value.deviceId !== "string" ||
        typeof value.keyId !== "string" ||
        typeof value.publicKeySpki !== "string" ||
        typeof value.deviceHint !== "string" ||
        !["android", "desktop", "web", "unknown"].includes(String(value.platform)) ||
        typeof value.appVersion !== "string" ||
        !Array.isArray(value.grantedScopes) ||
        typeof value.pairedAt !== "number" ||
        typeof value.revoked !== "boolean") {
      throw new Error("Trusted-device store contains an invalid record.");
    }
    const publicKey = normalizeIdentityPublicKey(value.publicKeySpki);
    if (!isSupportedIdentityKey(publicKey) || computeKeyId(publicKey) !== value.keyId) {
      throw new Error("Trusted-device store contains an invalid P-256 identity.");
    }
    if (value.grantedScopes.length > 32 || value.grantedScopes.some((scope) => typeof scope !== "string" || !validScope(scope))) {
      throw new Error("Trusted-device store contains invalid permission scopes.");
    }
    return {
      deviceId: value.deviceId,
      keyId: value.keyId,
      publicKeySpki: value.publicKeySpki,
      deviceHint: value.deviceHint,
      platform: value.platform as TrustedRemoteDevice["platform"],
      appVersion: value.appVersion,
      grantedScopes: [...value.grantedScopes] as string[],
      pairedAt: value.pairedAt,
      revoked: value.revoked,
    };
  }

  private async persistTrustedDevices(): Promise<void> {
    const document = JSON.stringify({ version: 1, devices: [...this.trustedDevices.values()] }, null, 2);
    const next = this.persistenceTail.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.options.storePath), { recursive: true });
      const tempPath = `${this.options.storePath}.${randomUUID()}.tmp`;
      await writeFile(tempPath, document, { encoding: "utf8" });
      try {
        await rename(tempPath, this.options.storePath);
      } catch {
        await rm(this.options.storePath, { force: true });
        await rename(tempPath, this.options.storePath);
      }
    });
    this.persistenceTail = next;
    await next;
  }

  private expirePending(nowMs: number): void {
    for (const entry of this.pairings.values()) {
      const pairingWindowExpired = entry.expiresAt <= nowMs;
      const challengeExpired = entry.challengeExpiresAt !== undefined && entry.challengeExpiresAt <= nowMs;
      if (entry.state === "ready" && pairingWindowExpired) {
        entry.state = "expired";
      } else if ((entry.state === "challenge_issued" || entry.state === "awaiting_approval") &&
          (pairingWindowExpired || challengeExpired)) {
        entry.state = "expired";
      }
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) throw new Error("RemotePairingRegistry.initialize() must complete before use.");
  }
}
