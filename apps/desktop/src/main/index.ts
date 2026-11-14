import { app, BrowserWindow, globalShortcut, screen } from "electron";
import path from "node:path";
import fs from "node:fs";
import { configureSecurity } from "./security.js";
import { registerIpcHandlers } from "./ipc.js";
import { loadUserEnvironment, startPackagedServices, stopPackagedServices } from "./runtimeServices.js";
import { RemotePcIdentityStore } from "./remotePcIdentityStore.js";
import { ElectronPcIdentityEncryption } from "./electronRemoteIdentityStore.js";
import { RemotePcSignerServer } from "./remotePcSignerServer.js";

let mainWindow: BrowserWindow | null = null;
let remotePcSignerServer: RemotePcSignerServer | null = null;

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
  registerIpcHandlers(mainWindow);

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

  if (devServerUrl) {
    console.log(`[Electron] Loading dev server: ${devServerUrl}`);
    mainWindow.loadURL(devServerUrl);
  } else if (fs.existsSync(localRendererHtml)) {
    console.log(`[Electron] Loading static bundle: ${localRendererHtml}`);
    mainWindow.loadFile(localRendererHtml);
  } else {
    console.log(`[Electron] Falling back to default URL http://localhost:5173`);
    mainWindow.loadURL("http://localhost:5173");
  }

  // Register push-to-talk and emergency kill-switch shortcuts
  globalShortcut.register("Alt+Space", () => {
    mainWindow?.webContents.send("vanessa:trigger-ptt");
  });

  globalShortcut.register("Escape", () => {
    mainWindow?.webContents.send("vanessa:trigger-cancel");
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
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

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  stopPackagedServices();
  void remotePcSignerServer?.stop();
  remotePcSignerServer = null;
  globalShortcut.unregisterAll();
});
