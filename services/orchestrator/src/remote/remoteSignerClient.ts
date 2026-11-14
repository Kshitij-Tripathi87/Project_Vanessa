import {
  computeKeyId,
  isSupportedIdentityKey,
  normalizeIdentityPublicKey,
  parseRemoteEnvelope,
  verifyRemoteEnvelopeSignature,
  type RemoteEnvelope,
  type RemoteMessageType,
} from "@vanessa/protocol";
import type { RemoteEnvelopeSigner, RemotePcPublicIdentity } from "./remoteWebSocketGateway.js";

type SignRequest = {
  type: RemoteMessageType;
  payload: Record<string, unknown>;
  sessionId: string;
  sequence: number;
};

function isIdentity(value: unknown): value is RemotePcPublicIdentity {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (typeof item.keyId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(item.keyId) ||
      typeof item.publicKeySpki !== "string" || typeof item.pcId !== "string" ||
      typeof item.pcName !== "string") return false;
  try {
    const publicKey = normalizeIdentityPublicKey(item.publicKeySpki);
    return isSupportedIdentityKey(publicKey) && computeKeyId(publicKey) === item.keyId;
  } catch {
    return false;
  }
}

/** Client for Electron main's ephemeral, loopback-only signing service. */
export class HttpRemoteEnvelopeSigner implements RemoteEnvelopeSigner {
  private identity?: RemotePcPublicIdentity;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly timeoutMs = 3_000,
  ) {
    if (!url.startsWith("http://127.0.0.1:")) {
      throw new Error("PC signer endpoint must use IPv4 loopback.");
    }
    if (!token || token.length < 32) throw new Error("PC signer token is missing or too short.");
  }

  async getIdentity(): Promise<RemotePcPublicIdentity> {
    if (this.identity) return this.identity;
    const response = await fetch(this.url + "/identity", {
      headers: { authorization: "Bearer " + this.token },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error("PC identity signer rejected the identity request.");
    const value: unknown = await response.json();
    if (!isIdentity(value)) throw new Error("PC identity signer returned an invalid identity.");
    this.identity = value;
    return value;
  }

  async sign(input: SignRequest): Promise<RemoteEnvelope> {
    const identity = await this.getIdentity();
    const response = await fetch(this.url + "/sign", {
      method: "POST",
      headers: {
        authorization: "Bearer " + this.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error("PC identity signer refused the requested protocol message.");
    const envelope = parseRemoteEnvelope(await response.json());
    if (envelope.type !== input.type || envelope.sessionId !== input.sessionId ||
        envelope.sequence !== input.sequence || envelope.keyId !== identity.keyId ||
        !verifyRemoteEnvelopeSignature(identity.publicKeySpki, envelope).ok) {
      throw new Error("PC identity signer returned an invalid or mismatched signature.");
    }
    return envelope;
  }
}
