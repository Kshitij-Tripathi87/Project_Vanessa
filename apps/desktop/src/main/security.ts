import { app, session } from "electron";
import path from "node:path";
import { isTrustedLocalRendererUrl } from "./trustedRenderer.js";
import { rendererContentSecurityPolicy } from "./securityPolicy.js";
import { allowDevelopmentRenderer } from "./developmentPolicy.js";

export function configureSecurity() {
  const trustedRendererPath = path.resolve(__dirname, "../renderer/index.html");
  const isTrustedApp = (url: string) => isTrustedLocalRendererUrl(url, trustedRendererPath, allowDevelopmentRenderer(app.isPackaged, process.env));

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

  // The desktop renderer needs only local services; provider traffic, if
  // separately configured and authorized, belongs in the service boundary.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          rendererContentSecurityPolicy(allowDevelopmentRenderer(app.isPackaged, process.env)),
        ],
      },
    });
  });
}
