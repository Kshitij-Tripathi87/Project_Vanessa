/** Electron's Linux `unknown` and `basic_text` backends are not proof of encryption. */
export function isProtectedLinuxStorageBackend(backend: string): boolean {
  return ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(backend);
}
