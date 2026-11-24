export type HostedEgressPurpose = "planning" | "conversation" | "speech_input" | "speech_output";

export interface HostedEgressRequest {
  provider: "sarvam" | "nvidia" | "fish" | "elevenlabs";
  purpose: HostedEgressPurpose;
  /** Exact normalized transport origin, including scheme and non-default port. */
  origin: string;
}

/**
 * A trusted runtime must supply a separately authorized policy. Selecting a
 * provider, configuring a key, or setting an endpoint is never a grant.
 * No production grant UI/storage is wired yet, so the default is deny-all.
 */
export interface HostedEgressPolicy {
  allows(request: Readonly<HostedEgressRequest>): boolean;
}
export const denyHostedEgress: HostedEgressPolicy = Object.freeze({ allows: () => false });

export function assertHostedEgress(
  policy: HostedEgressPolicy,
  provider: HostedEgressRequest["provider"],
  purpose: HostedEgressPurpose,
  endpoint: string,
): void {
  let origin: string;
  try {
    const url = new URL(endpoint);
    if (!["https:", "http:", "wss:", "ws:"].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error();
    // Plaintext transport is permitted only for literal loopback fixtures.
    // A future grant must not authorize cleartext credentials or content to a
    // remote host, even if a permissive policy is accidentally injected.
    if ((url.protocol === "http:" || url.protocol === "ws:") &&
        url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") throw new Error();
    origin = url.origin;
  } catch {
    throw new Error(`Hosted ${purpose} endpoint is invalid.`);
  }
  let allowed = false;
  try { allowed = policy.allows(Object.freeze({ provider, purpose, origin })) === true; } catch { /* fail closed */ }
  if (!allowed) {
    throw new Error(`Hosted ${purpose} with ${provider} is blocked: a separate scoped user permission is not available.`);
  }
}
