import { app, BrowserWindow, dialog, globalShortcut, ipcMain, net, protocol, screen, type IpcMainEvent } from "electron";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { configureSecurity } from "./security.js";
import { registerIpcHandlers } from "./ipc.js";
import { loadUserEnvironment, startPackagedServices, stopPackagedServices } from "./runtimeServices.js";
import { RemotePcIdentityStore } from "./remotePcIdentityStore.js";
import { ElectronPcIdentityEncryption } from "./electronRemoteIdentityStore.js";
import { RemotePcSignerServer } from "./remotePcSignerServer.js";
import { RemotePairingWindowController } from "./remotePairingWindowController.js";
import { LocalConversationStore } from "./localConversationStore.js";
import { DESKTOP_RENDERER_SCHEME, DESKTOP_RENDERER_URL, isPathWithin, isTrustedLocalRendererUrl, resolveDesktopRendererAsset } from "./trustedRenderer.js";
import { waitForHistoryFlush } from "./historyShutdown.js";
import { rendererContentSecurityPolicy } from "./securityPolicy.js";
import { allowDevelopmentRenderer, restrictPackagedEnvironment } from "./developmentPolicy.js";

// An inherited shell or stale user configuration cannot make an installed
// app trust a local development server or enable development service origins.
if (app.isPackaged) restrictPackagedEnvironment(process.env);

// A fixed, secure application origin avoids handing stored history to whatever
// process happens to be listening on a localhost development port.
protocol.registerSchemesAsPrivileged([{
  scheme: DESKTOP_RENDERER_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

let mainWindow: BrowserWindow | null = null;
let remotePcSignerServer: RemotePcSignerServer | null = null;
let remotePairingWindowController: RemotePairingWindowController | null = null;
let localConversationStore: LocalConversationStore | null = null;
let quitRequested = false;
let quitFinalizing = false;
let quitPermitted = false;

function requestRendererHistoryFlush(window: BrowserWindow): Promise<boolean> {
  return waitForHistoryFlush(randomUUID(), (listener) => {
    const receive = (event: IpcMainEvent, nonce: unknown, ok: unknown) => {
      if (window.isDestroyed() || event.sender !== window.webContents ||
          !event.senderFrame || event.senderFrame !== window.webContents.mainFrame ||
          !isTrustedLocalRendererUrl(event.senderFrame.url, path.join(__dirname, "../renderer/index.html"), allowDevelopmentRenderer(app.isPackaged, process.env))) return;
      listener(nonce, ok);
    };
    ipcMain.on("vanessa:history-flush-result", receive);
    return () => ipcMain.removeListener("vanessa:history-flush-result", receive);
  }, (nonce) => window.webContents.send("vanessa:history-flush-request", nonce));
}

function finishQuit(): void {
  if (quitFinalizing) return;
  quitFinalizing = true;
  void (localConversationStore?.close() ?? Promise.resolve()).catch(() => undefined).finally(() => {
    quitPermitted = true;
    app.quit();
  });
}

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { x: workAreaX, y: workAreaY, width: screenWidth, height: screenHeight } = primaryDisplay.workArea;
  const initialSize = 90;
  const margin = 24;

  mainWindow = new BrowserWindow({
    width: initialSize,
    height: initialSize,
    minWidth: 70,
    minHeight: 70,
    x: workAreaX + screenWidth - initialSize - margin,
    y: workAreaY + screenHeight - initialSize - margin,
    title: "Vanessa",
    icon: path.join(__dirname, "../../assets/vanessa.png"),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  configureSecurity();
  localConversationStore ??= new LocalConversationStore(
    path.join(app.getPath("userData"), "data", "conversation.sqlite"),
    new ElectronPcIdentityEncryption(),
  );
  const ownedWindow = mainWindow;
  const disposeIpc = registerIpcHandlers(ownedWindow, localConversationStore);
  let closeAllowed = false;
  let closePending = false;
  ownedWindow.on("close", (event) => {
    if (closeAllowed) return;
    event.preventDefault();
    if (closePending) return;
    closePending = true;
    void (async () => {
      const flushed = await requestRendererHistoryFlush(ownedWindow);
      if (ownedWindow.isDestroyed()) return;
      if (!flushed) {
        const choice = await dialog.showMessageBox(ownedWindow, {
          type: "warning",
          message: "Vanessa cannot finish saving this conversation yet.",
          detail: "A voice turn, task, or history operation may still be active, or local storage may be unavailable. Keep Vanessa open and wait, or close without saving. Closing does not confirm task cancellation; later responses may be lost.",
          buttons: ["Keep Vanessa open", "Close without saving"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (choice.response === 0) {
          quitRequested = false;
          closePending = false;
          if (!ownedWindow.isDestroyed()) ownedWindow.webContents.send("vanessa:history-flush-cancelled");
          return;
        }
      }
      closeAllowed = true;
      ownedWindow.close();
    })().catch(() => {
      quitRequested = false;
      closePending = false;
      if (!ownedWindow.isDestroyed()) ownedWindow.webContents.send("vanessa:history-flush-cancelled");
    });
  });

  mainWindow.webContents.on("console-message", (_event, level, message) => {
    console.log(`[Renderer Console] ${message}`);
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[Electron] Failed to load ${validatedURL}: ${errorDescription} (${errorCode})`);
  });

  mainWindow.webContents.on("did-finish-load", () => {
    console.log("[Electron] Renderer window loaded successfully in bottom-right corner!");
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  const localRendererHtml = path.join(__dirname, "../renderer/index.html");
  const allowDevelopment = allowDevelopmentRenderer(app.isPackaged, process.env);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedLocalRendererUrl(url, localRendererHtml, allowDevelopment)) event.preventDefault();
  });

  if (allowDevelopment && devServerUrl && isTrustedLocalRendererUrl(devServerUrl, localRendererHtml, true)) {
    console.log(`[Electron] Loading explicitly enabled development UI: ${devServerUrl}`);
    void mainWindow.loadURL(devServerUrl);
  } else {
    console.log("[Electron] Loading the built application renderer.");
    void mainWindow.loadURL(DESKTOP_RENDERER_URL);
  }

  // Register push-to-talk and emergency kill-switch shortcuts
  globalShortcut.register("Alt+Space", () => {
    mainWindow?.webContents.send("vanessa:trigger-ptt");
  });

  globalShortcut.register("Escape", () => {
    mainWindow?.webContents.send("vanessa:trigger-cancel");
  });

  mainWindow.on("closed", () => {
    disposeIpc();
    if (mainWindow === ownedWindow) mainWindow = null;
    if (quitRequested) finishQuit();
  });
}

app.disableHardwareAcceleration();

// The SQLite snapshot repository has one writer. Electron's OS-level lock is
// released on process exit/crash, avoiding competing desktop instances.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

app.whenReady().then(async () => {
  if (!isPrimaryInstance) return;
  protocol.handle(DESKTOP_RENDERER_SCHEME, async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Not found", { status: 404 });
    const rendererDirectory = path.join(__dirname, "../renderer");
    const target = resolveDesktopRendererAsset(request.url, rendererDirectory);
    if (!target) return new Response("Not found", { status: 404 });
    try {
      // Reject symlink escapes as well as lexical traversal. Only built UI
      // assets can ever be served from the privileged application origin.
      const realDirectory = fs.realpathSync(rendererDirectory);
      const realTarget = fs.realpathSync(target);
      if (!isPathWithin(realDirectory, realTarget) || !fs.statSync(realTarget).isFile()) return new Response("Not found", { status: 404 });
      const response = await net.fetch(pathToFileURL(realTarget).toString(), { method: request.method });
      const headers = new Headers(response.headers);
      headers.set("Content-Security-Policy", rendererContentSecurityPolicy(false));
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  if (app.isPackaged && process.platform === "win32") {
    loadUserEnvironment();
    // Keep the long-lived PC identity inside Electron main. The orchestrator
    // child receives only a random loopback signing capability and public key.
    try {
      const remoteStateDirectory = path.join(app.getPath("userData"), "remote-v2");
      const identityStore = new RemotePcIdentityStore(
        path.join(remoteStateDirectory, "pc-identity.json"),
        new ElectronPcIdentityEncryption(),
      );
      remotePcSignerServer = new RemotePcSignerServer(identityStore);
      const signer = await remotePcSignerServer.start();
      process.env.VANESSA_PC_SIGNER_URL = signer.url;
      process.env.VANESSA_PC_SIGNER_TOKEN = signer.token;
      process.env.VANESSA_PC_KEY_ID = signer.keyId;
      process.env.VANESSA_PC_PUBLIC_KEY_SPKI = signer.publicKeySpki;
      process.env.VANESSA_PC_FINGERPRINT = signer.fingerprint;
      process.env.VANESSA_REMOTE_STATE_DIR = remoteStateDirectory;
      process.env.VANESSA_REMOTE_V2_ENABLED = "true";
      process.env.VANESSA_REMOTE_V2_PORT = process.env.VANESSA_REMOTE_V2_PORT || "4321";
    } catch (error) {
      process.env.VANESSA_REMOTE_V2_ENABLED = "false";
      console.error("[Vanessa Remote v2] OS-backed PC identity is unavailable; pairing is disabled:", error);
    }

    // Never switch back to the legacy HMAC/secret WebSocket gateway.
    process.env.VANESSA_MOBILE_GATEWAY_ENABLED = "false";
    process.env.VANESSA_MOBILE_GATEWAY_ALLOW_UNAUTHENTICATED_REMOTE = "false";
    try {
      await startPackagedServices();
    } catch (error) {
      console.error("[Vanessa Runtime] Packaged backend startup failed:", error);
      // Keep the desktop surface available so diagnostics and retry remain possible.
    }
  }

  createWindow();
  remotePairingWindowController = new RemotePairingWindowController();
  const pairingShortcutRegistered = globalShortcut.register("CommandOrControl+Shift+P", () => {
    void remotePairingWindowController?.open().catch((error) => {
      console.error("[Vanessa Remote Pairing] Could not open pairing window:", error);
    });
  });
  if (!pairingShortcutRegistered) {
    console.warn("[Vanessa Remote Pairing] Could not register Ctrl/Cmd+Shift+P.");
  }
  const revokeShortcutRegistered = globalShortcut.register("CommandOrControl+Shift+R", () => {
    void remotePairingWindowController?.manageTrustedDevices().catch((error) => {
      console.error("[Vanessa Remote Pairing] Could not manage trusted devices:", error);
    });
  });
  if (!revokeShortcutRegistered) {
    console.warn("[Vanessa Remote Pairing] Could not register Ctrl/Cmd+Shift+R.");
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (!isPrimaryInstance || quitPermitted) return;
  event.preventDefault();
  quitRequested = true;
  // Closing the window first drains the renderer queue. Then the main-process
  // store drains admitted operations and releases its key before quitting.
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  else finishQuit();
});

app.on("will-quit", () => {
  remotePairingWindowController?.close();
  remotePairingWindowController = null;
  stopPackagedServices();
  void remotePcSignerServer?.stop();
  remotePcSignerServer = null;
  globalShortcut.unregisterAll();
});
