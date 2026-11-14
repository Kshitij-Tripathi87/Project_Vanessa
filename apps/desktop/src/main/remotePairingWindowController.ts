import { BrowserWindow, dialog } from "electron";
import QRCode from "qrcode";

type PairingCreated = {
  protocolVersion: 2;
  transport: "websocket";
  endpoint: string;
  pcId: string;
  pcName: string;
  pcKeyId: string;
  pcPublicKeySpki: string;
  pcFingerprint: string;
  pairingId: string;
  code: string;
  createdAt: number;
  expiresAt: number;
  biometricApprovalAvailable: boolean;
};

type TrustedDeviceSummary = {
  deviceId: string;
  keyId: string;
  deviceHint: string;
  platform: string;
  appVersion: string;
  grantedScopes: string[];
  pairedAt: number;
  revoked: boolean;
};

type PendingPairing = {
  pairingId: string;
  keyId: string;
  deviceHint: string;
  platform: string;
  appVersion: string;
  requestedAt: number;
  expiresAt: number;
  biometricApprovalAvailable: boolean;
};

const GRANTED_DEFAULT_SCOPES = [
  "system.read",
  "files.read",
  "apps.launch",
  "browser.open",
  "files.open",
] as const;

/**
 * Desktop-main controller for one-time QR pairing and explicit PC-local
 * approval. The renderer never receives the control token, private key, or
 * ability to approve arbitrary scopes.
 */
export class RemotePairingWindowController {
  private window?: BrowserWindow;
  private pollTimer?: NodeJS.Timeout;
  private pollInFlight = false;
  private readonly handledPairings = new Set<string>();

  async open(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) {
      this.window.focus();
      return;
    }
    const token = process.env.VANESSA_PC_SIGNER_TOKEN || "";
    const port = Number(process.env.VANESSA_PORT || "4319");
    if (!token || !Number.isInteger(port) || port < 1 || port > 65535) {
      await dialog.showMessageBox({
        type: "error",
        title: "Vanessa Remote Pairing",
        message: "Remote pairing is not initialized.",
        detail: "The PC identity signer or local orchestrator is unavailable. Restart Vanessa and confirm Tailscale is connected.",
        buttons: ["OK"],
      });
      return;
    }

    const response = await this.localRequest<PairingCreated>(
      port,
      token,
      "/internal/remote-v2/pairing/create",
      "POST",
    );
    if (response.protocolVersion !== 2 || response.transport !== "websocket" ||
        !response.endpoint || !response.pcKeyId || !response.pcPublicKeySpki ||
        !response.pcFingerprint || !response.pairingId || !response.code) {
      throw new Error("The PC returned an incomplete v2 pairing payload.");
    }

    const qrPayload = JSON.stringify(response);
    const qrDataUrl = await QRCode.toDataURL(qrPayload, {
      width: 360,
      margin: 2,
      errorCorrectionLevel: "M",
      type: "image/png",
    });
    const html = this.buildWindowHtml(response, qrDataUrl, qrPayload);
    const window = new BrowserWindow({
      width: 560,
      height: 790,
      minWidth: 480,
      minHeight: 680,
      show: false,
      title: "Vanessa — Pair Android Phone",
      resizable: true,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.window = window;
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      if (this.window === window) this.window = undefined;
      this.stopPolling();
    });
    await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    this.startPolling(port, token);
  }

  close(): void {
    this.stopPolling();
    if (this.window && !this.window.isDestroyed()) this.window.close();
    this.window = undefined;
  }

  async manageTrustedDevices(): Promise<void> {
    const token = process.env.VANESSA_PC_SIGNER_TOKEN || "";
    const port = Number(process.env.VANESSA_PORT || "4319");
    if (!token || !Number.isInteger(port) || port < 1 || port > 65535) {
      await dialog.showMessageBox({
        type: "error",
        title: "Vanessa Trusted Devices",
        message: "The local orchestrator is unavailable.",
        buttons: ["OK"],
      });
      return;
    }
    try {
      const status = await this.localRequest<{ trustedDevices: TrustedDeviceSummary[] }>(
        port, token, "/internal/remote-v2/status", "GET",
      );
      const devices = status.trustedDevices.filter((device) => !device.revoked);
      if (devices.length === 0) {
        await dialog.showMessageBox({
          type: "info",
          title: "Vanessa Trusted Devices",
          message: "No active paired phones.",
          detail: "Pair a phone with Ctrl+Shift+P.",
          buttons: ["OK"],
        });
        return;
      }

      const names = devices.map((device) =>
        device.deviceHint + " (" + device.platform + ") · " + device.grantedScopes.join(", "),
      );
      const buttons = [...names.map((name) => "Revoke: " + name), "Done"];
      const doneIndex = buttons.length - 1;
      const selected = await dialog.showMessageBox({
        type: "warning",
        title: "Manage trusted Vanessa phones",
        message: "Select a device to revoke its access.",
        detail: "Revocation closes its live session and prevents future authentication with this PC.",
        buttons,
        defaultId: doneIndex,
        cancelId: doneIndex,
        noLink: true,
      });
      if (selected.response === doneIndex) return;

      const device = devices[selected.response];
      if (!device) return;
      const confirmation = await dialog.showMessageBox({
        type: "warning",
        title: "Revoke phone access?",
        message: "Revoke " + device.deviceHint + "?",
        detail: "The phone will need to be paired again. Any active task owned by it remains subject to the task engine's cancellation and audit rules.",
        buttons: ["Revoke device", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (confirmation.response !== 0) return;

      await this.localRequest(
        port,
        token,
        "/internal/remote-v2/devices/" + encodeURIComponent(device.deviceId) + "/revoke",
        "POST",
        {},
      );
      await dialog.showMessageBox({
        type: "info",
        title: "Device revoked",
        message: device.deviceHint + " can no longer connect to this PC.",
        buttons: ["OK"],
      });
    } catch (error) {
      await dialog.showMessageBox({
        type: "error",
        title: "Device revocation failed",
        message: "Vanessa could not revoke the selected phone.",
        detail: error instanceof Error ? error.message : String(error),
        buttons: ["OK"],
      });
    }
  }



  private buildWindowHtml(data: PairingCreated, qr: string, payload: string): string {
    const escapeHtml = (value: string) => value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
    const safePayload = escapeHtml(payload);
    const expiresAt = new Date(data.expiresAt).toLocaleTimeString();
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline';">
<title>Vanessa Remote Pairing</title>
<style>
:root{color-scheme:dark;font-family:Inter,Segoe UI,Arial,sans-serif;background:#090c12;color:#e8edf5}
body{margin:0;padding:28px;display:flex;justify-content:center}
main{width:100%;max-width:480px}
.eyebrow{font:600 11px ui-monospace,monospace;letter-spacing:.14em;color:#8ca6c5}
h1{font-size:25px;margin:10px 0 7px}
p{color:#a7b4c6;line-height:1.5;font-size:13px}
.card{margin-top:18px;background:#111722;border:1px solid #263244;border-radius:18px;padding:20px}
.qr{display:flex;justify-content:center;padding:12px;background:#fff;border-radius:12px;width:fit-content;margin:0 auto 16px}
.qr img{width:300px;height:300px;display:block}
.meta{font:12px ui-monospace,monospace;color:#95a9c2;overflow-wrap:anywhere}
.code{font-size:18px;letter-spacing:.12em;color:#fff}
textarea{box-sizing:border-box;width:100%;height:98px;margin-top:8px;border-radius:9px;border:1px solid #334155;background:#090f18;color:#dbeafe;padding:10px;font:11px ui-monospace,monospace}
.note{font-size:12px;color:#d4b77a}
</style>
</head>
<body><main>
<div class="eyebrow">CORTEX / VANESSA · REMOTE V2</div>
<h1>Pair an Android phone</h1>
<p>Connect your phone to this PC over your private Tailscale network. The PC identity is pinned in the QR payload. Pairing expires at ${escapeHtml(expiresAt)}.</p>
<section class="card">
<div class="qr"><img src="${qr}" alt="One-time Vanessa pairing QR code"></div>
<div class="meta">PC: ${escapeHtml(data.pcName)}<br>TAILNET: ${escapeHtml(data.endpoint)}<br>KEY: ${escapeHtml(data.pcKeyId)}<br>FINGERPRINT: ${escapeHtml(data.pcFingerprint)}</div>
<p class="code">PAIRING CODE · ${escapeHtml(data.code)}</p>
<p class="note">After the phone completes the cryptographic challenge, approve the device in the Windows prompt. Never approve a device you do not recognize.</p>
</section>
<section class="card">
<strong>QR payload (manual fallback)</strong>
<p>Use this only when the phone camera cannot scan the QR image.</p>
<textarea readonly spellcheck="false">${safePayload}</textarea>
</section>
</main></body></html>`;
  }

  private startPolling(port: number, token: string): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      void this.pollApprovals(port, token);
    }, 1000);
    void this.pollApprovals(port, token);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.handledPairings.clear();
  }

  private async pollApprovals(port: number, token: string): Promise<void> {
    if (this.pollInFlight || !this.window || this.window.isDestroyed()) return;
    this.pollInFlight = true;
    try {
      const pending = await this.localRequest<PendingPairing[]>(
        port,
        token,
        "/internal/remote-v2/pairings/pending",
        "GET",
      );
      for (const pairing of pending) {
        if (this.handledPairings.has(pairing.pairingId)) continue;
        this.handledPairings.add(pairing.pairingId);
        await this.promptForApproval(port, token, pairing);
        if (!this.window || this.window.isDestroyed()) return;
      }
    } catch (error) {
      // Do not close the pairing window on transient polling failures.
      console.warn("[Vanessa Remote Pairing] Approval polling failed:", error instanceof Error ? error.message : String(error));
    } finally {
      this.pollInFlight = false;
    }
  }

  private async promptForApproval(port: number, token: string, pairing: PendingPairing): Promise<void> {
    if (!this.window || this.window.isDestroyed()) return;
    const buttons = pairing.biometricApprovalAvailable
      ? ["Approve limited access", "Allow file deletion (biometric each time)", "Deny"]
      : ["Approve limited access", "Deny"];
    const denyIndex = buttons.length - 1;
    const decision = await dialog.showMessageBox(this.window, {
      type: "question",
      title: "Approve phone pairing?",
      message: "A phone has completed the cryptographic pairing proof.",
      detail: [
        "Device: " + pairing.deviceHint,
        "Platform: " + pairing.platform,
        "App version: " + pairing.appVersion,
        "Key ID: " + pairing.keyId,
        "PC-verified strong-biometric key attestation: " + (pairing.biometricApprovalAvailable ? "verified" : "not verified"),
        "",
        "Limited access: read PC status, search approved files, launch allow-listed apps/URLs, and open approved files.",
        pairing.biometricApprovalAvailable
          ? "Optional file deletion: moves selected files to the Windows Recycle Bin. Every deletion still requires a separate strong-biometric approval on this phone."
          : "File deletion is disabled because the PC has not verified an Android hardware-attestation chain for this phone's approval key.",
        "Lock, system-control and screen-capture scopes remain disabled.",
      ].join("\n"),
      buttons,
      defaultId: denyIndex,
      cancelId: denyIndex,
      noLink: true,
    });
    if (decision.response === 0 || (pairing.biometricApprovalAvailable && decision.response === 1)) {
      const scopes: string[] = [...GRANTED_DEFAULT_SCOPES];
      if (pairing.biometricApprovalAvailable && decision.response === 1) scopes.push("files.delete");
      await this.localRequest(
        port,
        token,
        "/internal/remote-v2/pairings/" + encodeURIComponent(pairing.pairingId) + "/approve",
        "POST",
        { scopes },
      );
    } else {
      await this.localRequest(
        port,
        token,
        "/internal/remote-v2/pairings/" + encodeURIComponent(pairing.pairingId) + "/reject",
        "POST",
        {},
      );
    }
  }

  private async localRequest<T = unknown>(
    port: number,
    token: string,
    route: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<T> {
    const response = await fetch("http://127.0.0.1:" + port + route, {
      method,
      headers: {
        "x-vanessa-control-token": token,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    });
    const value = await response.json().catch(() => ({})) as { error?: string } & T;
    if (!response.ok) {
      const error = typeof (value as { error?: unknown }).error === "string"
        ? (value as { error: string }).error
        : "HTTP_" + response.status;
      throw new Error("Remote pairing API: " + error);
    }
    return value as T;
  }
}
