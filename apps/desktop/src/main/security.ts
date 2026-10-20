import { session } from "electron";

export function configureSecurity() {
  // Grant microphone permission automatically for native voice control
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === "media") {
      return callback(true);
    }
    callback(false);
  });

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    if (permission === "media") {
      return true;
    }
    return false;
  });

  session.defaultSession.setDevicePermissionHandler(() => {
    return true;
  });

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
