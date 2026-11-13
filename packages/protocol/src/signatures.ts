import {
  KeyObject,
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  timingSafeEqual as cryptoTimingSafeEqual,
  verify as cryptoVerify,
} from "node:crypto";
import { canonicalize } from "./canonicalize.ts";
import { SIGNATURE_ALGORITHM, toSignedRemoteEnvelope, type RemoteEnvelope } from "./envelope.ts";
import type { ApprovalBinding } from "./messages.ts";

/**
 * Identity keys and signature verification for protocol v2.
 *
 * Every identity on this link is an ECDSA P-256 key pair. The private half
 * lives in the Android Keystore (or the PC's credential store) and never
 * leaves it; only the SPKI public key is transmitted, and the peer is
 * identified by `keyId` = SHA-256(SPKI DER), truncated.
 *
 * Verification order is deliberate: parse the public key, check the curve,
 * check the algorithm tag, then compare bytes. The final comparison is
 * constant-time. A failure at any step yields a typed reason rather than a
 * generic "bad signature", so the caller can log why without leaking details
 * to the peer.
 */

export const IDENTITY_KEY_ALGORITHM = "ES256" as const;
export const IDENTITY_CURVE = "P-256";

/** Byte length of the SPKI digest used as a key id. */
export const KEY_ID_DIGEST_BYTES = 16;

export type PublicKeyInput = string | Buffer | KeyObject;

/** Reason a signature check failed. Deliberately does not distinguish which byte differed. */
export type SignatureFailure =
  | "malformed_public_key"
  | "unsupported_curve"
  | "unsupported_algorithm"
  | "malformed_signature"
  | "invalid_signature";

export type SignatureVerification = { ok: true } | { ok: false; reason: SignatureFailure };

/* ------------------------------------------------------------------ *
 * Key handling
 * ------------------------------------------------------------------ */

function toBase64Url(text: string): string {
  return Buffer.from(text, "base64").toString("base64url");
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Accept a PEM string, a base64url/base64 DER SPKI blob, or a KeyObject. */
export function normalizeIdentityPublicKey(input: PublicKeyInput): KeyObject {
  if (typeof input !== "string") {
    if (Buffer.isBuffer(input)) {
      try {
        return createPublicKey({ key: input, format: "der", type: "spki" });
      } catch {
        throw new Error("Public key buffer is not a DER SPKI key.");
      }
    }
    return input as KeyObject;
  }
  if (input.includes("-----BEGIN")) {
    try {
      return createPublicKey(input);
    } catch {
      throw new Error("Public key is not a valid PEM SPKI key.");
    }
  }
  try {
    const der = decodeBase64Url(input);
    return createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new Error("Public key is not a valid base64url-encoded SPKI key.");
  }
}

/** Raw SPKI DER bytes for a public key. */
export function exportIdentityPublicKeyDer(input: PublicKeyInput): Buffer {
  const key = normalizeIdentityPublicKey(input);
  const exported = key.export({ type: "spki", format: "der" }) as unknown as Buffer;
  return Buffer.isBuffer(exported) ? exported : Buffer.from(exported);
}

/** Short key id: base64url of the first KEY_ID_DIGEST_BYTES of SHA-256(SPKI DER). */
export function computeKeyId(input: PublicKeyInput): string {
  const digest = createHash("sha256").update(exportIdentityPublicKeyDer(input)).digest();
  return digest.subarray(0, KEY_ID_DIGEST_BYTES).toString("base64url");
}

/** Full base64url fingerprint, for display and out-of-band comparison. */
export function publicKeyFingerprint(input: PublicKeyInput): string {
  return toBase64Url(createHash("sha256").update(exportIdentityPublicKeyDer(input)).digest("base64"));
}

/** True when the key is P-256, the only curve this protocol uses. */
export function isSupportedIdentityKey(input: PublicKeyInput): boolean {
  try {
    const key = normalizeIdentityPublicKey(input);
    if (key.asymmetricKeyType !== "ec") return false;
    // Only the public half is an identity key. A private KeyObject passed here
    // is a wiring error, and accepting it would let a signing half be used
    // where a verification half is expected.
    if (key.type === "private") return false;
    const jwk = key.export({ format: "jwk" }) as { crv?: string };
    return jwk.crv === IDENTITY_CURVE;
  } catch {
    return false;
  }
}

/** The DER-encoded signature bytes carried in `auth.signature`. */
export function signatureBytes(envelope: RemoteEnvelope): Buffer {
  return decodeBase64Url(envelope.auth.signature);
}

/* ------------------------------------------------------------------ *
 * Verification
 * ------------------------------------------------------------------ */

/**
 * Verify an envelope against the public key named by `envelope.auth.keyId`.
 *
 * The signed bytes are the canonicalized envelope WITHOUT `auth.signature`;
 * `auth.algorithm` and `keyId` are inside the signed material, so neither can
 * be swapped by a proxy.
 */
export function verifyRemoteEnvelopeSignature(
  publicKeyInput: PublicKeyInput,
  envelope: RemoteEnvelope,
): SignatureVerification {
  if (envelope.auth.algorithm !== SIGNATURE_ALGORITHM) return { ok: false, reason: "unsupported_algorithm" };
  let key: KeyObject;
  try {
    key = normalizeIdentityPublicKey(publicKeyInput);
  } catch {
    return { ok: false, reason: "malformed_public_key" };
  }
  if (key.asymmetricKeyType !== "ec") return { ok: false, reason: "unsupported_curve" };
  if (!isSupportedIdentityKey(key)) return { ok: false, reason: "unsupported_curve" };

  let signature: Buffer;
  try {
    signature = signatureBytes(envelope);
  } catch {
    return { ok: false, reason: "malformed_signature" };
  }
  if (signature.length === 0) return { ok: false, reason: "malformed_signature" };

  const data = Buffer.from(canonicalize(toSignedRemoteEnvelope(envelope)), "utf8");
  const ok = cryptoVerify("sha256", data, key, signature);
  return ok ? { ok: true } : { ok: false, reason: "invalid_signature" };
}

/** Constant-time comparison of two digests. Lengths are not secret. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return cryptoTimingSafeEqual(left, right);
}

/* ------------------------------------------------------------------ *
 * Signing (PC side, tests and fixtures only)
 * ------------------------------------------------------------------ */

/**
 * Sign an envelope. The PC uses this to seal messages it sends; tests and the
 * fixture generator use it with the throwaway key in `fixtures/`. Never ship a
 * signing routine into the phone app — the phone signs in the Keystore.
 */
export function signRemoteEnvelope(
  privateKeyInput: string | Buffer | KeyObject,
  envelope: Omit<RemoteEnvelope, "auth">,
): RemoteEnvelope {
  const key =
    privateKeyInput instanceof KeyObject
      ? // A KeyObject is used as-is: Node's options form does not re-import a
        // KeyObject, it expects key material (PEM text or DER bytes).
        privateKeyInput
      : typeof privateKeyInput === "string" && privateKeyInput.includes("-----BEGIN")
        ? createPrivateKey(privateKeyInput)
        : createPrivateKey({ key: privateKeyInput as Buffer, format: "der", type: "pkcs8" });
  const signed = { ...envelope, auth: { algorithm: SIGNATURE_ALGORITHM } } as RemoteEnvelope;
  const data = Buffer.from(canonicalize(toSignedRemoteEnvelope(signed)), "utf8");
  const signature = cryptoSign("sha256", data, key);
  return { ...signed, auth: { algorithm: SIGNATURE_ALGORITHM, signature: signature.toString("base64url") } };
}

/* ------------------------------------------------------------------ *
 * Action hashes
 * ------------------------------------------------------------------ */

/**
 * SHA-256 over the JCS bytes of the approval binding, hex-encoded.
 *
 * This is what the user approves. The response must carry the same string, and
 * the PC recomputes it at execution time from the task it is about to run, so
 * an approval is bound to exactly one (task, version, capability, arguments,
 * target, policy) tuple. See `ApprovalBindingSchema` for the field list.
 */
export function computeActionHash(binding: ApprovalBinding): string {
  return createHash("sha256").update(canonicalize(binding), "utf8").digest("hex");
}
