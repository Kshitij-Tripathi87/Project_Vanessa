import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";

export interface BrowserPageState {
  url: string;
  title: string;
  readyState: string;
  bodyText?: string;
  httpStatus?: number;
}

export interface YouTubeCandidate {
  title: string;
  url: string;
  channel?: string;
}

export interface VideoState {
  url: string;
  title: string;
  paused: boolean;
  currentTime: number;
  readyState: number;
  error?: string | null;
}

export interface BrowserDriver {
  navigate(url: string): Promise<BrowserPageState>;
  getPageState(): Promise<BrowserPageState>;
  getYouTubeResults(timeoutMs?: number): Promise<YouTubeCandidate[]>;
  getVideoState(): Promise<VideoState>;
  startVideoPlayback(): Promise<{ attempted: boolean; details: string }>;
}

type CdpMessage = { id?: number; method?: string; params?: any; result?: any; error?: { message?: string } };
type EventHandler = (params: any) => void;
type CdpTarget = { type?: string; url?: string; webSocketDebuggerUrl?: string };

class CdpConnection {
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private listeners = new Map<string, Set<EventHandler>>();

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      let message: CdpMessage;
      try { message = JSON.parse(raw.toString()) as CdpMessage; } catch { return; }
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || "CDP command failed"));
        else pending.resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
      }
    });
    socket.on("close", () => this.rejectAll(new Error("Browser debugging connection closed")));
    socket.on("error", (error) => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
  }

  static async connect(url: string): Promise<CdpConnection> {
    const socket = new WebSocket(url, { handshakeTimeout: 5000 });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out connecting to browser debugging target")), 5000);
      socket.once("open", () => { clearTimeout(timer); resolve(); });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    return new CdpConnection(socket);
  }

  isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 12000): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Browser debugging socket is not open"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  on(method: string, handler: EventHandler): () => void {
    const list = this.listeners.get(method) || new Set<EventHandler>();
    list.add(handler);
    this.listeners.set(method, list);
    return () => {
      list.delete(handler);
      if (list.size === 0) this.listeners.delete(method);
    };
  }

  waitForEvent(method: string, timeoutMs = 10000, predicate: (params: any) => boolean = () => true): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error(`Timed out waiting for browser event ${method}`)); }, timeoutMs);
      const unsubscribe = this.on(method, (params) => {
        if (!predicate(params)) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(params);
      });
    });
  }

  close(): void {
    try { this.socket.close(); } catch { /* already closed */ }
    this.rejectAll(new Error("Browser debugging connection closed"));
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("Could not allocate browser debugging port");
  return port;
}

async function waitForJson(url: string, child: ChildProcess, timeoutMs = 12000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "Browser debugging endpoint is not ready";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Browser exited during startup with code ${child.exitCode}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
      if (response.ok) return await response.json();
      lastError = `Browser endpoint returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Browser debugging endpoint failed to start: ${lastError}`);
}

function resolveEdgePath(): string {
  const candidates = [
    process.env.VANESSA_BROWSER_PATH,
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
    process.env["PROGRAMFILES(X86)"] ? path.join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Microsoft Edge was not found. Install Edge or set VANESSA_BROWSER_PATH to its executable.");
}

export class EdgeCdpBrowserDriver implements BrowserDriver {
  private connection?: CdpConnection;
  private child?: ChildProcess;
  private port?: number;
  private profileDir?: string;
  private lastDocumentStatus?: number;

  async navigate(url: string): Promise<BrowserPageState> {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Browser navigation only permits HTTP and HTTPS URLs");
    const connection = await this.ensureConnected();
    this.lastDocumentStatus = undefined;
    const loaded = connection.waitForEvent("Page.loadEventFired", 15000);
    connection.waitForEvent("Network.responseReceived", 15000, (event) => event.type === "Document")
      .then((event) => { this.lastDocumentStatus = Number(event.response?.status) || undefined; })
      .catch(() => undefined);
    const result = await connection.send<{ errorText?: string }>("Page.navigate", { url: parsed.toString() });
    if (result?.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
    await loaded;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const state = await this.getPageState();
    return { ...state, httpStatus: this.lastDocumentStatus };
  }

  async getPageState(): Promise<BrowserPageState> {
    const connection = await this.ensureConnected();
    const response = await connection.send<any>("Runtime.evaluate", {
      expression: "({url: location.href, title: document.title || '', readyState: document.readyState, bodyText: (document.body?.innerText || '').slice(0, 1500)})",
      returnByValue: true,
      awaitPromise: true,
    });
    const value = response?.result?.value;
    if (!value || typeof value.url !== "string") throw new Error("Browser page state was not observable");
    return {
      url: value.url,
      title: String(value.title || ""),
      readyState: String(value.readyState || "unknown"),
      bodyText: String(value.bodyText || ""),
      httpStatus: this.lastDocumentStatus,
    };
  }

  async getYouTubeResults(timeoutMs = 8000): Promise<YouTubeCandidate[]> {
    const connection = await this.ensureConnected();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = await connection.send<any>("Runtime.evaluate", {
        expression: `Array.from(document.querySelectorAll('ytd-video-renderer a#video-title, a#video-title[href*="/watch"]')).map(a => ({title: (a.textContent || a.getAttribute('title') || '').trim(), url: a.href || '', channel: (a.closest('ytd-video-renderer')?.querySelector('#channel-name')?.textContent || '').trim()})).filter(v => v.title && v.url)`,
        returnByValue: true,
        awaitPromise: true,
      });
      const value = response?.result?.value;
      if (Array.isArray(value) && value.length) {
        return value
          .filter((item: any) => typeof item.title === "string" && typeof item.url === "string" && item.url.includes("youtube.com/watch"))
          .map((item: any) => ({ title: item.title, url: item.url, channel: item.channel || undefined }));
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return [];
  }

  async getVideoState(): Promise<VideoState> {
    const connection = await this.ensureConnected();
    const response = await connection.send<any>("Runtime.evaluate", {
      expression: "(() => { const v = document.querySelector('video.html5-main-video, video'); return {url: location.href, title: document.title || '', paused: v ? Boolean(v.paused) : true, currentTime: v ? Number(v.currentTime || 0) : 0, readyState: v ? Number(v.readyState || 0) : 0, error: v && v.error ? String(v.error.message || v.error.code) : null}; })()",
      returnByValue: true,
      awaitPromise: true,
    });
    const value = response?.result?.value;
    if (!value) throw new Error("Video state was not observable");
    return {
      url: String(value.url || ""),
      title: String(value.title || ""),
      paused: Boolean(value.paused),
      currentTime: Number(value.currentTime || 0),
      readyState: Number(value.readyState || 0),
      error: value.error == null ? null : String(value.error),
    };
  }

  async startVideoPlayback(): Promise<{ attempted: boolean; details: string }> {
    const connection = await this.ensureConnected();

    // Prefer a real browser input event on YouTube's visible play control. This
    // can satisfy user-activation requirements that a bare video.play() call may not.
    const buttonResponse = await connection.send<any>("Runtime.evaluate", {
      expression: `(() => {
        const button = document.querySelector('.ytp-play-button');
        if (!button) return { found: false };
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') {
          return { found: false };
        }
        return { found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, label: button.getAttribute('aria-label') || '' };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });

    const button = buttonResponse?.result?.value;
    if (button?.found && Number.isFinite(button.x) && Number.isFinite(button.y)) {
      await connection.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: button.x,
        y: button.y,
        button: "left",
        clickCount: 1,
      });
      await connection.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: button.x,
        y: button.y,
        button: "left",
        clickCount: 1,
      });
      return { attempted: true, details: `Dispatched a browser input click to the visible YouTube player control (${button.label || "play button"}); playback state still requires verification.` };
    }

    // Generic fallback: attempt the HTMLMediaElement API but never treat its
    // resolution as final proof; the caller must inspect currentTime and paused.
    const playResponse = await connection.send<any>("Runtime.evaluate", {
      expression: `(() => {
        const video = document.querySelector('video.html5-main-video, video');
        if (!video) return { attempted: false, details: 'No video element was present.' };
        return video.play().then(
          () => ({ attempted: true, details: 'video.play() resolved; playback state still requires verification.' }),
          (error) => ({ attempted: true, details: 'video.play() rejected: ' + String(error && (error.message || error.name) || error) })
        );
      })()`,
      returnByValue: true,
      awaitPromise: true,
      timeout: 5000,
    }, 6000);
    const result = playResponse?.result?.value;
    return {
      attempted: Boolean(result?.attempted),
      details: String(result?.details || "Could not invoke a video playback control."),
    };
  }

  async dispose(): Promise<void> {
    this.connection?.close();
    this.connection = undefined;
    if (this.child && this.child.exitCode === null) this.child.kill();
    this.child = undefined;
    // Keep the browser profile so the user can retain Vanessa-specific site state.
  }

  private async connectToExistingPage(): Promise<CdpConnection> {
    if (!this.port || !this.child) throw new Error("Browser process is not available for reconnection");
    const targets = await waitForJson(`http://127.0.0.1:${this.port}/json/list`, this.child, 5000);
    const target = (targets as CdpTarget[]).find((item) => item.type === "page" && item.webSocketDebuggerUrl);
    if (!target?.webSocketDebuggerUrl) throw new Error("No browser page target is available for reconnection");
    const connection = await CdpConnection.connect(target.webSocketDebuggerUrl);
    await connection.send("Page.enable");
    await connection.send("Runtime.enable");
    await connection.send("Network.enable");
    this.connection = connection;
    return connection;
  }

  private async launchManagedBrowser(): Promise<CdpConnection> {
    const executable = resolveEdgePath();
    this.profileDir = process.env.VANESSA_BROWSER_PROFILE || path.join(os.homedir(), ".vanessa", "browser-profile");
    await fs.mkdir(this.profileDir, { recursive: true });
    this.port = await getFreePort();
    this.child = spawn(executable, [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      "about:blank",
    ], { stdio: "ignore", windowsHide: true });

    this.child.once("error", () => {
      this.connection?.close();
      this.connection = undefined;
    });
    this.child.once("exit", () => {
      this.connection?.close();
      this.connection = undefined;
    });

    await waitForJson(`http://127.0.0.1:${this.port}/json/version`, this.child);
    return this.connectToExistingPage();
  }

  private async ensureConnected(): Promise<CdpConnection> {
    if (this.connection?.isOpen()) return this.connection;
    if (this.connection) {
      this.connection.close();
      this.connection = undefined;
    }
    if (process.platform !== "win32") {
      throw new Error("The current browser driver supports Windows only; macOS requires its platform adapter.");
    }

    if (this.child && this.child.exitCode === null && this.port) {
      try {
        // Recover a dropped DevTools WebSocket by reattaching to the still-running browser.
        await waitForJson(`http://127.0.0.1:${this.port}/json/version`, this.child, 4000);
        return await this.connectToExistingPage();
      } catch {
        // If the browser or debugging endpoint is gone, relaunch the managed instance below.
      }
      try { this.child.kill(); } catch { /* process may already have exited */ }
      this.child = undefined;
      this.port = undefined;
    }

    return this.launchManagedBrowser();
  }
}
