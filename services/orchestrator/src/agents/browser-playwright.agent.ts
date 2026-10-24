import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import * as fs from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { privacyGuard } from "../core/privacy.js";

function isPrivateIpv4(host: string): boolean {
  if (isIP(host) !== 4) return false;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const a = parts[0];
  const b = parts[1];
  const c = parts[2];
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    (a === 192 && b === 88 && c === 99);
}

function isPrivateIp(host: string): boolean {
  if (isIP(host) === 4) return isPrivateIpv4(host);
  if (isIP(host) === 6) {
    const normalized = host.toLowerCase();
    // Treat IPv6 loopback, unspecified, unique-local, link-local and mapped-private addresses as local.
    if (normalized === "::" || normalized === "::1" || /^(?:fc|fd|fe[89ab])/i.test(normalized)) return true;
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIpv4(mapped[1]);
    // Fail closed on IPv6 literals until zone/scoped and transition addresses can be canonicalized.
    return true;
  }
  return false;
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host === "localhost.localdomain" ||
      /\.(?:localhost|local|internal|lan|home\.arpa|test|invalid)$/.test(host)) return true;
  return isPrivateIp(host);
}

async function assertAllowedRemoteHost(url: URL, allowLocal: boolean): Promise<void> {
  if (allowLocal) return;
  if (isPrivateHostname(url.hostname)) {
    throw new Error("Navigation to local or private network targets is blocked. Set BROWSER_ALLOW_LOCAL_URLS=true only for a trusted local development workflow.");
  }
  if (isIP(url.hostname)) return;
  try {
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some((entry) => isPrivateIp(entry.address))) {
      throw new Error("The target hostname resolves to a local, private, or reserved IP address.");
    }
  } catch (error) {
    if (error instanceof Error && /local, private, or reserved/.test(error.message)) throw error;
    // DNS errors are surfaced by navigation itself; do not transform them into access.
  }
}

/** Validate remote navigation URLs. Local/private targets require explicit opt-in. */
export function normalizeRemoteBrowserUrl(input: string, allowLocal = process.env.BROWSER_ALLOW_LOCAL_URLS === "true"): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("A complete, valid HTTP or HTTPS URL is required.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP or HTTPS URLs can be opened by the remote browser action.");
  }
  if (parsed.username || parsed.password) throw new Error("URLs containing embedded credentials are not allowed.");
  if (!allowLocal && isPrivateHostname(parsed.hostname)) {
    throw new Error("Navigation to local or private network targets is blocked. Set BROWSER_ALLOW_LOCAL_URLS=true only for a trusted local development workflow.");
  }
  return parsed.toString();
}

export class PlaywrightBrowserAgent {
  id = "browser-playwright";
  capabilities = ["browser_navigation", "web_search", "page_inspection", "automation"];
  allowedTools = ["browser_navigate", "browser_screenshot", "browser_click", "browser_fill", "browser_extract"];
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private activePage: Page | null = null;

  private async getPage(): Promise<Page> {
    if (!this.browser) {
      const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
      this.browser = await chromium.launch({
        headless: process.env.BROWSER_HEADLESS !== "false",
        ...(executablePath ? { executablePath } : {}),
        args: process.platform === "linux" ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
      });
    }
    if (!this.context) {
      this.context = await this.browser.newContext();
      await this.context.route("**/*", async (route) => {
        const requestUrl = route.request().url();
        if (/^(?:about|data|blob):/i.test(requestUrl)) {
          await route.continue();
          return;
        }
        if (/^file:/i.test(requestUrl)) {
          try {
            const localPath = fileURLToPath(requestUrl);
            if (privacyGuard.isPathAllowed(localPath)) await route.continue();
            else await route.abort("blockedbyclient");
          } catch {
            await route.abort("blockedbyclient");
          }
          return;
        }
        try {
          const parsed = new URL(requestUrl);
          normalizeRemoteBrowserUrl(requestUrl);
          await assertAllowedRemoteHost(parsed, process.env.BROWSER_ALLOW_LOCAL_URLS === "true");
          await route.continue();
        } catch {
          await route.abort("blockedbyclient");
        }
      });
    }
    if (!this.activePage || this.activePage.isClosed()) this.activePage = await this.context.newPage();
    return this.activePage;
  }

  async navigate(url: string): Promise<{ success: boolean; title: string; url: string; error?: string }> {
    let normalized: string;
    try {
      normalized = normalizeRemoteBrowserUrl(url);
      await assertAllowedRemoteHost(new URL(normalized), process.env.BROWSER_ALLOW_LOCAL_URLS === "true");
    } catch (error) {
      return { success: false, title: "", url, error: error instanceof Error ? error.message : String(error) };
    }
    try {
      const page = await this.getPage();
      await page.goto(normalized, { waitUntil: "domcontentloaded", timeout: 30000 });
      const finalUrl = page.url();
      if (finalUrl.startsWith("http://") || finalUrl.startsWith("https://")) {
        const finalNormalized = normalizeRemoteBrowserUrl(finalUrl);
        await assertAllowedRemoteHost(new URL(finalNormalized), process.env.BROWSER_ALLOW_LOCAL_URLS === "true");
      }
      return { success: true, title: await page.title(), url: finalUrl };
    } catch (error) {
      return { success: false, title: "", url: normalized, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async search(query: string): Promise<{ success: boolean; snippets: string[]; url: string; error?: string }> {
    if (!query.trim()) return { success: false, snippets: [], url: "", error: "A non-empty search query is required." };
    const searchUrl = "https://www.google.com/search?q=" + encodeURIComponent(query);
    const nav = await this.navigate(searchUrl);
    if (!nav.success) return { success: false, snippets: [], url: nav.url, error: nav.error };
    try {
      const page = await this.getPage();
      const bodyText = await page.locator("body").innerText({ timeout: 5000 });
      const lines = bodyText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 15);
      const unique = [...new Set(lines)].slice(0, 10);
      return { success: unique.length > 0, snippets: unique, url: page.url(), error: unique.length ? undefined : "The search page loaded, but no readable result snippets were found." };
    } catch (error) {
      return { success: false, snippets: [], url: nav.url, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async inspectPage(url?: string): Promise<{ success: boolean; title: string; url: string; text: string; links: { text: string; url: string }[]; error?: string }> {
    if (url) {
      const nav = await this.navigate(url);
      if (!nav.success) return { success: false, title: nav.title, url: nav.url, text: "", links: [], error: nav.error };
    }
    try {
      const page = await this.getPage();
      const title = await page.title();
      const currentUrl = page.url();
      const body = (await page.locator("body").innerText({ timeout: 5000 })).slice(0, 12000);
      const links = await page.locator("a[href]").evaluateAll((anchors) => anchors.slice(0, 50).map((anchor) => ({
        text: (anchor.textContent || "").trim().slice(0, 200),
        url: (anchor as HTMLAnchorElement).href,
      })).filter((link) => Boolean(link.text || link.url)));
      return { success: true, title, url: currentUrl, text: body, links };
    } catch (error) {
      return { success: false, title: "", url: "", text: "", links: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  async openLocalFile(filePath: string): Promise<{ success: boolean; title: string; url: string; error?: string }> {
    try {
      const canonical = await fs.realpath(filePath);
      if (!privacyGuard.isPathAllowed(canonical)) throw new Error("The local HTML file is outside approved folders.");
      if (!/\.(?:html?|xhtml)$/i.test(canonical)) throw new Error("Local browser preview supports HTML/XHTML files only.");
      if (!(await fs.stat(canonical)).isFile()) throw new Error("The requested local browser target is not a file.");
      const page = await this.getPage();
      await page.goto(pathToFileURL(canonical).href, { waitUntil: "domcontentloaded", timeout: 30000 });
      return { success: true, title: await page.title(), url: page.url() };
    } catch (error) {
      return { success: false, title: "", url: filePath, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async click(url: string | undefined, selector: string): Promise<{ success: boolean; title: string; url: string; text: string; error?: string }> {
    if (!selector.trim()) return { success: false, title: "", url: url || "", text: "", error: "A CSS or Playwright locator selector is required." };
    if (url) {
      const nav = await this.navigate(url);
      if (!nav.success) return { success: false, title: nav.title, url: nav.url, text: "", error: nav.error };
    }
    try {
      const page = await this.getPage();
      await page.locator(selector).first().click({ timeout: 10000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
      const text = (await page.locator("body").innerText({ timeout: 5000 })).slice(0, 8000);
      return { success: true, title: await page.title(), url: page.url(), text };
    } catch (error) {
      return { success: false, title: "", url: url || "", text: "", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async verifyPageState(url: string, expectedText: string): Promise<{ success: boolean; found: boolean; error?: string }> {
    if (!expectedText.trim()) return { success: false, found: false, error: "Expected text is required for page verification." };
    const inspected = await this.inspectPage(url);
    if (!inspected.success) return { success: false, found: false, error: inspected.error };
    return { success: true, found: inspected.text.includes(expectedText) };
  }

  async close(): Promise<void> {
    if (this.context) await this.context.close().catch(() => undefined);
    if (this.browser) await this.browser.close().catch(() => undefined);
    this.activePage = null;
    this.context = null;
    this.browser = null;
  }
}

export const playwrightBrowserAgent = new PlaywrightBrowserAgent();
