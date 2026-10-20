import { app, BrowserWindow, globalShortcut, screen } from "electron";
import path from "node:path";
import fs from "node:fs";
import { configureSecurity } from "./security.js";
import { registerIpcHandlers } from "./ipc.js";

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  const initialSize = 90;
  const margin = 24;

  mainWindow = new BrowserWindow({
    width: initialSize,
    height: initialSize,
    minWidth: 70,
    minHeight: 70,
    x: screenWidth - initialSize - margin,
    y: screenHeight - initialSize - margin,
    title: "Vanessa",
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

app.whenReady().then(() => {
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
  globalShortcut.unregisterAll();
});
