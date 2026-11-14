import {
  safeParseRemoteEnvelope,
  verifyRemoteEnvelopeSignature,
  type RemoteEnvelope,
} from "@vanessa/protocol";
import type { RemotePcSigner } from "./remoteV2Gateway.js";

/** Remote signing bridge to the Electron main process. Private key bytes never enter this process. */
export async function createRemotePcSignerFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RemotePcSigner> {
  const baseUrl = env.VANESSA_REMOTE_SIGNER_URL;
  const token = env.VANESSA_REMOTE_SIGNER_TOKEN;
  if (!baseUrl || !token) throw new Error("The Electron PC identity signing broker is not configured.");
  const parsedUrl = new URL(baseUrl);
  if (parsedUrl.protocol !== "http:" || parsedUrl.hostname !== "127.0.0.1") {
    throw new Error("The PC identity signing broker must use loopback HTTP.");
  }
  const headers = { authorization: "Bearer " + token };
  const identityResponse = await fetch(baseUrl + "/identity", {
    headers,
    signal: AbortSignal.timeout(2500),
  });
  if (!identityResponse.ok) throw new Error("The PC identity signing broker is unavailable.");
  const identity = await identityResponse.json() as { keyId?: string; publicKeySpki?: string };
  if (typeof identity.keyId !== "string" || typeof identity.publicKeySpki !== "string") {
    throw new Error("The PC identity broker returned an invalid public identity.");
  }
  return {
    keyId: identity.keyId,
    publicKeySpki: identity.publicKeySpki,
    async sign(envelope) {
      const response = await fetch(baseUrl + "/sign", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ envelope }),
        signal: AbortSignal.timeout(3500),
      });
      if (!response.ok) throw new Error("The PC identity broker rejected a signing request.");
      const value: unknown = await response.json();
      const parsed = safeParseRemoteEnvelope(value);
      if (!parsed.success || parsed.data.keyId !== identity.keyId ||
          !verifyRemoteEnvelopeSignature(identity.publicKeySpki, parsed.data).ok) {
        throw new Error("The PC identity broker returned an invalid signature.");
      }
      return parsed.data;
    },
  };
}
