import { validateRemoteBrowserUrl, playwrightBrowserAgent } from "./browser-playwright.agent.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentEvidence, AgentResult, AgentRunContext, AgentTask, SpecialistAgent } from "@vanessa/shared";

const execFileAsync = promisify(execFile);

export function buildYouTubeSearchUrl(query: string): string {
  const normalized = query.trim();
  if (!normalized) throw new Error("A non-empty YouTube search query is required.");
  if (normalized.length > 500) throw new Error("YouTube search queries must be 500 characters or shorter.");
  const url = new URL("https://www.youtube.com/results");
  url.searchParams.set("search_query", normalized);
  return url.toString();
}

function normalizeBrowserTarget(value: unknown): "chrome" | "edge" | undefined {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (normalized !== "chrome" && normalized !== "edge") {
    throw new Error("Unsupported browser target. Supported explicit targets are Chrome and Edge.");
  }
  return normalized;
}

async function openDefaultBrowser(url: string, browserName?: string): Promise<void> {
  const browser = normalizeBrowserTarget(browserName);
  const windowsExecutable = browser === "chrome" ? "chrome.exe" : browser === "edge" ? "msedge.exe" : undefined;
  const macApplication = browser === "chrome" ? "Google Chrome" : browser === "edge" ? "Microsoft Edge" : undefined;
  const linuxExecutable = browser === "chrome" ? "google-chrome" : browser === "edge" ? "microsoft-edge" : undefined;

  if (process.platform === "win32") {
    // Both values are passed through environment variables, never interpolated
    // into PowerShell source. An explicit browser target is selected by a static
    // alias map so user-controlled text cannot choose an arbitrary executable.
    const script = windowsExecutable
      ? "Start-Process -FilePath $env:VANESSA_BROWSER -ArgumentList @($env:VANESSA_TARGET_URL)"
      : "Start-Process -FilePath $env:VANESSA_TARGET_URL";
    await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", script,
    ], {
      windowsHide: true,
      timeout: 5000,
      env: {
        ...process.env,
        VANESSA_TARGET_URL: url,
        ...(windowsExecutable ? { VANESSA_BROWSER: windowsExecutable } : {}),
      },
    });
    return;
  }
  if (process.platform === "darwin") {
    if (macApplication) await execFileAsync("open", ["-a", macApplication, url], { timeout: 5000 });
    else await execFileAsync("open", [url], { timeout: 5000 });
    return;
  }
  if (process.platform === "linux") {
    if (linuxExecutable) await execFileAsync(linuxExecutable, [url], { timeout: 5000 });
    else await execFileAsync("xdg-open", [url], { timeout: 5000 });
    return;
  }
  throw new Error("Opening the browser is not supported on " + process.platform + ".");
}

export interface BrowserAgentOptions {
  openExternalBrowser?: (url: string, browserName?: string) => Promise<void>;
  validateExternalUrl?: (url: string) => Promise<string>;
}

/** System-browser handoff stays distinct from Vanessa's isolated Playwright session. */
export class BrowserAgent implements SpecialistAgent {
  private readonly openExternalBrowser: (url: string, browserName?: string) => Promise<void>;
  private readonly validateExternalUrl: (url: string) => Promise<string>;

  constructor(options: BrowserAgentOptions = {}) {
    this.openExternalBrowser = options.openExternalBrowser || openDefaultBrowser;
    this.validateExternalUrl = options.validateExternalUrl || validateRemoteBrowserUrl;
  }

  id = "browser";
  capabilities = ["browser_navigation", "web_search", "page_inspection", "local_html_preview", "playwright_automation"];
  allowedTools = ["browser_navigate", "browser_extract", "browser_click", "browser_open_file"];

  async execute(
    actionOrTask: string | AgentTask,
    paramsOrContext?: Record<string, any> | AgentRunContext,
    _context?: AgentRunContext,
  ): Promise<AgentResult> {
    const action = typeof actionOrTask === "string" ? actionOrTask : actionOrTask.action || actionOrTask.objective;
    const params = typeof actionOrTask === "string" ? (paramsOrContext as Record<string, any>) || {} : actionOrTask.params || {};
    const timestamp = new Date().toISOString();

    switch (action) {
      case "browser.open_url": {
        const requestedUrl = String(params.url || "");
        let url: string;
        let browserName: "chrome" | "edge" | undefined;
        try {
          url = await this.validateExternalUrl(requestedUrl);
          browserName = normalizeBrowserTarget(params.browser);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return this.result(false, "Browser URL or browser target was rejected by safety validation.", "I could not open that URL or browser target because it did not pass safety checks.", [], [], { url: requestedUrl, error: detail, externalBrowser: false });
        }
        try {
          await this.openExternalBrowser(url, browserName);
          return this.result(
            true,
            "The operating system accepted the " + (browserName || "default-browser") + " launch request for " + url + ".",
            "I sent the page to " + (browserName ? (browserName === "chrome" ? "Chrome" : "Edge") : "your default browser") + ". I have not verified that it loaded.",
            [{ description: "Operating system accepted the default-browser launch request for " + url, source: "Desktop browser handoff", timestamp, confidence: 0.95, data: { url, browser: browserName || "default", pageLoadVerified: false } }],
            [url],
            { url, browser: browserName || "default", externalBrowser: true, pageLoadVerified: false },
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return this.result(false, "Could not open the requested URL in the default browser.", "I could not open that page in your default browser.", [], [], { url, externalBrowser: false, error: detail, pageLoadVerified: false });
        }
      }

      case "browser.search": {
        const query = String(params.query || "").trim();
        if (!query) return this.result(false, "A non-empty search query is required.", "Tell me what you want me to search for.", [], [], { query, error: "A non-empty search query is required." });
        const search = new URL("https://www.google.com/search");
        search.searchParams.set("q", query);
        const url = search.toString();
        let browserName: "chrome" | "edge" | undefined;
        try {
          browserName = normalizeBrowserTarget(params.browser);
          await this.openExternalBrowser(url, browserName);
          return this.result(
            true,
            "The operating system accepted a " + (browserName || "default-browser") + " search launch for " + query + ".",
            "I opened search results in " + (browserName ? (browserName === "chrome" ? "Chrome" : "Edge") : "your default browser") + ". I have not independently inspected the results.",
            [{ description: "Operating system accepted the browser launch request for search query: " + query, source: "Desktop browser handoff", timestamp, confidence: 0.95, data: { query, url, browser: browserName || "default", resultsExtracted: false } }],
            [url],
            { query, url, browser: browserName || "default", externalBrowser: true, resultsExtracted: false },
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return this.result(false, "Could not open search results in the default browser.", "I could not open those search results in your default browser.", [], [], { query, url, externalBrowser: false, resultsExtracted: false, error: detail });
        }
      }

            case "browser.research": {
        const query = String(params.goal || params.query || params.prompt || "");
        const result = await (await import("./openjarvis.agent.js")).vanessaAgent.runGoal(query, ["web_search", "browser_navigate"]);
        const success = result.success === true;
        const steps = Array.isArray(result.steps) ? result.steps : [];
        return this.result(success,
          success ? String(result.final_answer || ("Research completed for " + query)) : "Research did not complete successfully.",
          success ? "Finished the requested web research." : "The web research task did not complete successfully.",
          steps.map((step: any) => ({ description: String(step.thought || "") + ": " + String(step.action || ""), source: "Vanessa research bridge", timestamp })),
          [], result);
      }

      case "youtube.search_and_play": {
        const query = String(params.query || "").trim();
        const url = buildYouTubeSearchUrl(query);
        let browserName: "chrome" | "edge" | undefined;
        try {
          browserName = normalizeBrowserTarget(params.browser);
          await this.openExternalBrowser(url, browserName);
          return this.result(
            true,
            "Opened YouTube search results for " + query + " in " + (browserName || "the default browser") + ".",
            "YouTube search results are open. Video playback has not been verified.",
            [{ description: "Operating system accepted the default-browser launch request for " + url, source: "Desktop browser handoff", timestamp, confidence: 0.95, data: { query, url } }],
            [url],
            { query, url, browser: browserName || "default", externalBrowser: true, playbackVerified: false },
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return this.result(
            false,
            "Could not open YouTube search results in the default browser.",
            "I could not open YouTube in your browser.",
            [],
            [],
            { query, url, externalBrowser: false, error: detail },
          );
        }
      }

      case "browser.verify_page_state": {
        const url = String(params.url || "");
        const expectedText = String(params.expectedText || "");
        const result = await playwrightBrowserAgent.verifyPageState(url, expectedText);
        const verified = result.success && result.found;
        return this.result(verified,
          verified ? "Verified expected text on " + url : result.success ? "Expected text was not found on " + url : "Page verification could not run.",
          verified ? "The expected text was found." : result.success ? "I could not find the expected text on the page." : "I could not verify the page.",
          result.success ? [{ description: "Expected text " + (result.found ? "was found" : "was not found") + " on " + url, source: "Rendered page text", timestamp, confidence: 1, data: { expectedText, found: result.found } }] : [],
          result.success ? [url] : [], { url, expectedText, found: result.found, error: result.error });
      }

      case "browser.inspect_page":
      case "browser.extract": {
        const result = await playwrightBrowserAgent.inspectPage(typeof params.url === "string" && params.url ? params.url : undefined);
        return this.result(result.success,
          result.success ? "Inspected " + result.url + "; extracted " + result.links.length + " link(s)." : "Could not inspect the browser page.",
          result.success ? "The page inspection is ready." : "I could not inspect that page.",
          result.success ? [{ description: "Rendered page content inspected at " + result.url, source: "Playwright rendered DOM", timestamp, confidence: 1, data: { title: result.title, links: result.links.length } }] : [],
          result.success ? [result.url] : [], { title: result.title, url: result.url, text: result.text, links: result.links, error: result.error });
      }

      case "browser.open_file": {
        const filePath = String(params.path || "");
        const result = await playwrightBrowserAgent.openLocalFile(filePath);
        return this.result(result.success,
          result.success ? "Opened local HTML preview at " + result.url : "Local HTML preview failed.",
          result.success ? "The local page is open in Vanessa’s isolated browser session." : "I could not open that local page in Vanessa’s browser session.",
          result.success ? [{ description: "Opened approved local HTML file in browser session", source: filePath, timestamp, confidence: 1, data: { title: result.title, url: result.url } }] : [],
          result.success ? [filePath] : [], { path: filePath, title: result.title, url: result.url, error: result.error });
      }

      case "browser.click": {
        const result = await playwrightBrowserAgent.click(typeof params.url === "string" ? params.url : undefined, String(params.selector || ""));
        return this.result(result.success,
          result.success ? "Clicked the requested page element at " + result.url : "The requested browser click failed.",
          result.success ? "The page element was clicked." : "I could not click that page element.",
          result.success ? [{ description: "Clicked requested locator and inspected resulting page", source: "Playwright", timestamp, confidence: 0.9, data: { selector: params.selector, url: result.url } }] : [],
          result.success ? [result.url] : [], { selector: params.selector, url: result.url, title: result.title, text: result.text, error: result.error });
      }

      case "browser.read_title": {
        const url = String(params.url || "");
        const result = url ? await playwrightBrowserAgent.navigate(url) : await playwrightBrowserAgent.inspectPage();
        return this.result(result.success,
          result.success ? "Page title: " + result.title : "Could not read the page title.",
          result.success ? "Read the page title." : "I could not read the page title.",
          result.success ? [{ description: "Read browser page title", source: "Playwright", timestamp, confidence: 1 }] : [],
          result.success ? [result.url] : [], { title: result.title, url: result.url, error: result.error });
      }

      default:
        throw new Error("BrowserAgent: Unknown action '" + action + "'");
    }
  }

  private result(success: boolean, summary: string, spokenSummary: string, evidence: AgentEvidence[], artifacts: string[], data: unknown): AgentResult {
    return {
      agentId: this.id, status: success ? "completed" : "failed", success, summary, spokenSummary, evidence, artifacts,
      verification: { passed: success, details: summary }, data,
      ...(success ? {} : { error: summary }),
    };
  }
}

export const browserAgent = new BrowserAgent();
