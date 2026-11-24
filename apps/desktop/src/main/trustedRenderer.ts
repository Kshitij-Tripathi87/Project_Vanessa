import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const DESKTOP_RENDERER_SCHEME = "vanessa";
export const DESKTOP_RENDERER_URL = "vanessa://desktop/index.html";

/** Only assets below the built renderer directory may be served by the app scheme. */
export function resolveDesktopRendererAsset(url: string, rendererDirectory: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "vanessa:" || parsed.hostname !== "desktop" || parsed.port ||
        parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    const decoded = decodeURIComponent(parsed.pathname);
    if (decoded.includes("\\") || decoded.includes("\0")) return null;
    const parts = (decoded === "/" || decoded === "" ? "index.html" : decoded.replace(/^\/+/, "")).split("/");
    if (parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))) return null;
    const base = resolve(rendererDirectory);
    const target = resolve(base, ...parts);
    return isPathWithin(base, target) ? target : null;
  } catch {
    return null;
  }
}

export function isPathWithin(directory: string, target: string): boolean {
  const rel = relative(resolve(directory), resolve(target));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Sensitive desktop history is available only to the app's own top-level UI. */
export function isTrustedLocalRendererUrl(url: string, rendererFile: string, allowDevelopment = false): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "vanessa:") {
      return parsed.hostname === "desktop" && !parsed.port && !parsed.username && !parsed.password &&
        (parsed.pathname === "/" || parsed.pathname === "/index.html") && !parsed.search && !parsed.hash;
    }
    if (parsed.protocol === "file:") {
      if (parsed.search || parsed.hash) return false;
      const actual = resolve(fileURLToPath(parsed));
      const expected = resolve(rendererFile);
      return process.platform === "win32" ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
    }
    return allowDevelopment && parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
      parsed.port === "5173" && (parsed.pathname === "/" || parsed.pathname === "/index.html") &&
      !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}
