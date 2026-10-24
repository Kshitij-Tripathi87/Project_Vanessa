import { app, BrowserWindow, globalShortcut, screen, Tray, Menu, nativeImage } from "electron";
import path from "node:path";
import fs from "node:fs";
import { configureSecurity } from "./security.js";
import { registerIpcHandlers } from "./ipc.js";
import { calculateDockPosition, readDockPosition, type DockPosition } from "./docking.js";
import { loadUserEnvironment, startPackagedServices, stopPackagedServices } from "./runtimeServices.js";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

const DEFAULT_ORB_SIZE = 90;
const WINDOW_MARGIN = 16;
const TRAY_ICON_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABMklEQVR42u1XPQvCMBB1vH/v4OjgUNDJQVDo6KCgiw4ODi6ugjhIB6eeeYbCGfph2sgFMXBQ0st7L3eXa9rr/YfvuOdcayqkXxVTAkyDMdNwyjSaWcOzmQsrwiXtJ0zJgmm+YlrumbZHpt3JGp4xh3fwMb7dhLjk2GW6sWTnK9PtwZTl74Y5vIMPfM2a9iIk+SRlWh8suEtaZfDFGrPWX4BLjvBess/JC8MarPUS4YYdu2hDLkUAw01Hk4BXwSGPPmGvSwewZGE2CkAlo5i6khcGLINZL0CGH8cpxO5lFAxmfRpkk8GZLjtqbQ1YwJTNqlIAuhqqNxR5YcA02M0CUP0h8y/rQJ6GeAWop0C7CPWOoXojiqkV632M1D/HUVxIoriSqV9Ko7iWR/NjEsWv2S+PJ1o1EjpH/3yBAAAAAElFTkSuQmCC";

function getDockSettingsPath(): string {
  return path.join(app.getPath("userData"), "dock-preference.json");
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const dockPosition = readDockPosition(getDockSettingsPath(), "bottom-right");
  const initial = calculateDockPosition(display.workArea, [DEFAULT_ORB_SIZE, DEFAULT_ORB_SIZE], dockPosition, WINDOW_MARGIN);

  mainWindow = new BrowserWindow({
    width: DEFAULT_ORB_SIZE,
    height: DEFAULT_ORB_SIZE,
    minWidth: 90,
    minHeight: 90,
    x: initial.x,
    y: initial.y,
    title: "Vanessa",
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    movable: true,
    skipTaskbar: true,
    hasShadow: false,
    autoHideMenuBar: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setAlwaysOnTop(true, "floating");

  configureSecurity();
  registerIpcHandlers(mainWindow);

  mainWindow.webContents.on("console-message", (_event, _level, message) => {
    console.log("[Vanessa UI] " + message);
  });
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, description, validatedURL) => {
    console.error("[Electron] Failed to load " + validatedURL + ": " + description + " (" + errorCode + ")");
  });
  mainWindow.webContents.on("did-finish-load", () => {
    console.log("[Electron] Floating Vanessa orb loaded at " + dockPosition + ".");
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  const localRendererHtml = path.join(__dirname, "../renderer/index.html");
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else if (fs.existsSync(localRendererHtml)) {
    mainWindow.loadFile(localRendererHtml);
  } else {
    mainWindow.loadURL("http://localhost:5173");
  }

  // Hiding the surface keeps the voice/wake-word process alive. Only Quit from
  // the tray or an operating-system shutdown closes the app and releases the mic.
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  globalShortcut.register("Alt+Space", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send("vanessa:trigger-ptt");
    }
  });
  globalShortcut.register("Escape", () => {
    mainWindow?.webContents.send("vanessa:trigger-cancel");
  });
}

function showOrb(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
}

function openChat(): void {
  showOrb();
  mainWindow?.webContents.send("vanessa:open-chat");
}

function createTray(): void {
  if (tray) return;
  const candidates = [
    path.join(process.resourcesPath, "vanessa-tray.png"),
    path.join(app.getAppPath(), "assets", "vanessa-tray.png"),
  ];
  const iconPath = candidates.find((candidate) => fs.existsSync(candidate));
  const icon = iconPath
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createFromDataURL("data:image/png;base64," + TRAY_ICON_BASE64);
  tray = new Tray(icon);
  tray.setToolTip("Vanessa — say Hey Vanessa or click the orb");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show Vanessa", click: showOrb },
    { label: "Open chat", click: openChat },
    { type: "separator" },
    { label: "Quit Vanessa", click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on("click", () => {
    if (mainWindow?.isVisible()) openChat();
    else showOrb();
  });
}

function configureLaunchAtLogin(): void {
  if (!app.isPackaged || process.env.VANESSA_AUTO_START === "false") return;
  if (process.platform === "win32" || process.platform === "darwin") {
    try { app.setLoginItemSettings({ openAtLogin: true }); }
    catch (error) { console.warn("[Vanessa] Could not configure launch at login:", error); }
  }
}

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  if (app.isPackaged) {
    try {
      const envPath = loadUserEnvironment();
      console.info("[Vanessa Runtime] Loaded user configuration from " + envPath + " (credential values are not logged).");
    } catch (error) {
      console.error("[Vanessa Runtime] Could not load user configuration:", error);
    }
  }
  createWindow();
  createTray();
  configureLaunchAtLogin();

  if (app.isPackaged) {
    void startPackagedServices().catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("[Vanessa Runtime] Backend startup failed:", detail);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("vanessa:runtime-status", { state: "error", message: detail });
      }
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    showOrb();
  });
});

// Do not quit when the orb is hidden; the tray owns the normal lifecycle.
app.on("window-all-closed", () => {});
app.on("before-quit", () => { isQuitting = true; stopPackagedServices(); });
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  tray?.destroy();
  tray = null;
});
