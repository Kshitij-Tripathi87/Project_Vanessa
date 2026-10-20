import { session } from "electron";

export function configureSecurity() {
  const isTrustedApp = (url: string) => {
    if (url.startsWith("file://")) return true;
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(parsed.hostname) &&
        parsed.port === "5173";
    } catch {
      return false;
    }
  };

  // Grant microphone permission automatically for native voice control
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === "media" && isTrustedApp(webContents.getURL())) {
      return callback(true);
    }
    callback(false);
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return permission === "media" && isTrustedApp(webContents?.getURL() ?? "");
  });

  // Microphone access is handled above. Do not grant arbitrary HID, USB, or
  // other device permissions to renderer content.
  session.defaultSession.setDevicePermissionHandler(() => false);

  // Enforce secure CSP headers while allowing local orchestrator, voice agent, and audio APIs
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' http://127.0.0.1:* ws://127.0.0.1:* https://*.fish.audio wss://*.fish.audio https://unpkg.com https://api.elevenlabs.io https://fonts.googleapis.com https://fonts.gstatic.com data: blob:",
        ],
      },
    });
  });
}
