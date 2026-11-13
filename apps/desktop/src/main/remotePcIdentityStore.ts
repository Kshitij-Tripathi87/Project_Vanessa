import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  computeKeyId,
  isSupportedIdentityKey,
  publicKeyFingerprint,
} from "@vanessa/protocol";

export type PcIdentityEncryptionAdapter = {
  /** Must report false when the OS key provider is unavailable or falls back to plaintext. */
  isAvailable(): boolean;
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
};

export type RemotePcIdentity = {
  readonly keyId: string;
  /** Base64url SPKI DER; safe to publish in the QR pairing payload. */
  readonly publicKeySpki: string;
  readonly fingerprint: string;
  /** Keep this KeyObject inside the trusted desktop main process only. */
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
};

type StoredPcIdentityV1 = {
  version: 1;
  algorithm: "ES256";
  keyId: string;
  publicKeySpki: string;
  encryptedPrivateKey: string;
};

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Stored PC public key encoding is invalid.");
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function sameBytes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Persists a single PC identity while keeping the private key encrypted by an
 * OS-backed key provider. Corrupt existing files fail closed; they are never
 * silently replaced, since doing that would strand all paired devices.
 */
export class RemotePcIdentityStore {
  private current?: RemotePcIdentity;
  private loading?: Promise<RemotePcIdentity>;

  constructor(
    private readonly filePath: string,
    private readonly encryption: PcIdentityEncryptionAdapter,
  ) {
    if (!filePath.trim()) throw new Error("Remote PC identity path is required.");
  }

  loadOrCreate(): Promise<RemotePcIdentity> {
    if (this.current) return Promise.resolve(this.current);
    if (this.loading) return this.loading;
    const operation = this.loadOrCreateInternal();
    this.loading = operation;
    return operation.then(
      (identity) => {
        this.current = identity;
        this.loading = undefined;
        return identity;
      },
      (error) => {
        this.loading = undefined;
        throw error;
      },
    );
  }

  /** Forget the cached key object. The encrypted identity file remains intact. */
  clearMemory(): void {
    this.current = undefined;
  }

  private async loadOrCreateInternal(): Promise<RemotePcIdentity> {
    if (!this.encryption.isAvailable()) {
      throw new Error("OS-backed encryption is unavailable; remote pairing remains disabled.");
    }
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return await this.generateAndPersist();
    }

    let stored: unknown;
    try {
      stored = JSON.parse(raw);
    } catch {
      throw new Error("PC identity file is corrupt. Refusing to replace the existing identity.");
    }
    return this.restoreStoredIdentity(stored);
  }

  private async generateAndPersist(): Promise<RemotePcIdentity> {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const identity = this.createIdentity(pair.privateKey, pair.publicKey);
    const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const encryptedPrivateKey = this.encryption.encrypt(privatePem).toString("base64");
    const stored: StoredPcIdentityV1 = {
      version: 1,
      algorithm: "ES256",
      keyId: identity.keyId,
      publicKeySpki: identity.publicKeySpki,
      encryptedPrivateKey,
    };
    await this.persist(stored);
    return identity;
  }

  private restoreStoredIdentity(value: unknown): RemotePcIdentity {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("PC identity file has an invalid structure.");
    }
    const stored = value as Partial<StoredPcIdentityV1>;
    if (stored.version !== 1 || stored.algorithm !== "ES256" ||
        typeof stored.keyId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(stored.keyId) ||
        typeof stored.publicKeySpki !== "string" || typeof stored.encryptedPrivateKey !== "string" ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(stored.encryptedPrivateKey)) {
      throw new Error("PC identity file has invalid fields.");
    }

    const publicDer = decodeBase64Url(stored.publicKeySpki);
    const publicKey = createPublicKey({ key: publicDer, format: "der", type: "spki" });
    if (!isSupportedIdentityKey(publicKey) || computeKeyId(publicKey) !== stored.keyId) {
      throw new Error("Stored PC identity public key is not a matching P-256 key.");
    }

    let privatePem: string;
    try {
      privatePem = this.encryption.decrypt(Buffer.from(stored.encryptedPrivateKey, "base64"));
    } catch {
      throw new Error("PC private identity could not be decrypted by this OS account.");
    }
    let privateKey: KeyObject;
    try {
      privateKey = createPrivateKey(privatePem);
    } catch {
      throw new Error("Decrypted PC private identity is malformed.");
    }
    if (privateKey.asymmetricKeyType !== "ec") {
      throw new Error("Stored PC private identity is not an EC key.");
    }
    const derivedPublic = createPublicKey(privateKey).export({ type: "spki", format: "der" }) as Buffer;
    if (!sameBytes(derivedPublic, publicDer)) {
      throw new Error("Stored PC public and private identities do not match.");
    }
    return this.createIdentity(privateKey, publicKey);
  }

  private createIdentity(privateKey: KeyObject, publicKey: KeyObject): RemotePcIdentity {
    if (!isSupportedIdentityKey(publicKey)) throw new Error("PC identity must use P-256.");
    const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
    return Object.freeze({
      keyId: computeKeyId(publicKey),
      publicKeySpki: der.toString("base64url"),
      fingerprint: publicKeyFingerprint(publicKey),
      privateKey,
      publicKey,
    });
  }

  private async persist(stored: StoredPcIdentityV1): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(stored, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
