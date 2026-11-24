import { safeStorage } from "electron";
import type { PcIdentityEncryptionAdapter } from "./remotePcIdentityStore.js";
import { isProtectedLinuxStorageBackend } from "./safeStoragePolicy.js";

/**
 * Electron 34's safeStorage implementation uses the platform key store:
 * Windows DPAPI, macOS Keychain, or a Linux secret store. Do not accept Linux
 * basic_text fallback because it does not provide OS-protected at-rest storage.
 */
export class ElectronPcIdentityEncryption implements PcIdentityEncryptionAdapter {
  isAvailable(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (process.platform === "linux") {
      // Unknown is not proof of an OS-backed secret store either.
      return isProtectedLinuxStorageBackend(safeStorage.getSelectedStorageBackend());
    }
    return true;
  }

  encrypt(plaintext: string): Buffer {
    if (!this.isAvailable()) throw new Error("OS-backed encryption is unavailable.");
    return safeStorage.encryptString(plaintext);
  }

  decrypt(ciphertext: Buffer): string {
    if (!this.isAvailable()) throw new Error("OS-backed encryption is unavailable.");
    return safeStorage.decryptString(ciphertext);
  }
}
