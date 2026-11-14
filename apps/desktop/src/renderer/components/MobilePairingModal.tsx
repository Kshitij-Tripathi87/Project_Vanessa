import React, { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { Check, Copy, KeyRound, Laptop, RefreshCw, ShieldCheck, Smartphone, Trash2, X } from "lucide-react";

type PairingWindow = {
  pairingId: string;
  expiresAt: number;
  endpoint: string;
  qrPayload: string;
  qrDataUrl: string;
};

type PendingPairing = {
  pairingId: string;
  keyId: string;
  deviceHint: string;
  platform: string;
  appVersion: string;
  requestedAt: number;
  expiresAt: number;
};

type TrustedDevice = {
  deviceId: string;
  deviceHint: string;
  platform: string;
  appVersion: string;
  grantedScopes: string[];
  pairedAt: number;
  revoked: boolean;
};

type ScopeOption = { id: string; label: string; description: string; defaultGrant?: boolean };

const SCOPES: ScopeOption[] = [
  { id: "system.read", label: "Read PC status", description: "Battery, CPU and system information", defaultGrant: true },
  { id: "files.read", label: "Find files", description: "Search file names and metadata", defaultGrant: true },
  { id: "apps.launch", label: "Launch applications", description: "Open an installed desktop application", defaultGrant: true },
  { id: "browser.open", label: "Open web pages", description: "Navigate the PC browser to a URL", defaultGrant: true },
  { id: "files.open", label: "Open files", description: "Open a selected file with its registered application", defaultGrant: true },
  { id: "screen.capture", label: "Capture screen", description: "Request a PC screenshot", defaultGrant: false },
  { id: "system.control", label: "Change system settings", description: "Change approved Windows settings", defaultGrant: false },
  { id: "media.control", label: "Control media", description: "Play, pause and change media state", defaultGrant: false },
  { id: "system.lock", label: "Lock the PC", description: "Lock the current Windows session", defaultGrant: false },
  { id: "files.delete", label: "Delete files", description: "Move an exact selected file to Recycle Bin; requires biometric approval", defaultGrant: false },
];

const DEFAULT_SCOPES = SCOPES.filter((scope) => scope.defaultGrant).map((scope) => scope.id);

interface MobilePairingModalProps {
  isOpen: boolean;
  onClose: () => void;
  deviceName?: string;
}

export const MobilePairingModal: React.FC<MobilePairingModalProps> = ({
  isOpen,
  onClose,
  deviceName = "This PC",
}) => {
  const [pairingWindow, setPairingWindow] = useState<PairingWindow | null>(null);
  const [pending, setPending] = useState<PendingPairing[]>([]);
  const [devices, setDevices] = useState<TrustedDevice[]>([]);
  const [selectedScopes, setSelectedScopes] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    const [pendingResult, devicesResult] = await Promise.all([
      window.vanessa.getRemoteV2PendingPairings(),
      window.vanessa.getRemoteV2Devices(),
    ]);
    if (!Array.isArray(pendingResult)) {
      setError(pendingResult.error || "The v2 pairing service is not available.");
      return;
    }
    if (!Array.isArray(devicesResult)) {
      setError(devicesResult.error || "The trusted-device registry is not available.");
      return;
    }
    setPending(pendingResult);
    setDevices(devicesResult);
    setError(null);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 2500);
    return () => window.clearInterval(timer);
  }, [isOpen, refresh]);

  if (!isOpen) return null;

  const createPairingQr = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.vanessa.createRemoteV2PairingWindow();
      if (!result.qrPayload || !result.endpoint || !result.expiresAt || !result.pairingId) {
        throw new Error(result.error || "The v2 pairing listener is disabled or Tailscale Serve is not configured.");
      }
      const qrDataUrl = await QRCode.toDataURL(result.qrPayload, {
        width: 280,
        margin: 2,
        errorCorrectionLevel: "M",
        color: { dark: "#101722", light: "#ffffff" },
      });
      setPairingWindow({
        pairingId: result.pairingId,
        expiresAt: result.expiresAt,
        endpoint: result.endpoint,
        qrPayload: result.qrPayload,
        qrDataUrl,
      });
      setNotice("One-time QR created. It expires at " + new Date(result.expiresAt).toLocaleTimeString() + ".");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the pairing QR.");
      setPairingWindow(null);
    } finally {
      setBusy(false);
    }
  };

  const copyEndpoint = async () => {
    if (!pairingWindow) return;
    await navigator.clipboard.writeText(pairingWindow.endpoint);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const selectedFor = (pairingId: string) => selectedScopes[pairingId] ?? DEFAULT_SCOPES;

  const toggleScope = (pairingId: string, scopeId: string, checked: boolean) => {
    const current = selectedFor(pairingId);
    setSelectedScopes((previous) => ({
      ...previous,
      [pairingId]: checked
        ? Array.from(new Set([...current, scopeId]))
        : current.filter((scope) => scope !== scopeId),
    }));
  };

  const approve = async (pairingId: string) => {
    const scopes = selectedFor(pairingId);
    if (scopes.length === 0) {
      setError("Grant at least one capability scope, or reject this pairing.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await window.vanessa.approveRemoteV2Pairing(pairingId, scopes);
    if (result.success) {
      setNotice("Device approved with " + scopes.length + " capability scopes.");
      setSelectedScopes((previous) => {
        const next = { ...previous };
        delete next[pairingId];
        return next;
      });
      await refresh();
    } else {
      setError(result.error || "The device could not be approved.");
    }
    setBusy(false);
  };

  const reject = async (pairingId: string) => {
    setBusy(true);
    const result = await window.vanessa.rejectRemoteV2Pairing(pairingId);
    if (result.success) {
      setNotice("Pairing request rejected.");
      await refresh();
    } else {
      setError(result.error || "The pairing request could not be rejected.");
    }
    setBusy(false);
  };

  const revoke = async (deviceId: string) => {
    setBusy(true);
    const result = await window.vanessa.revokeRemoteV2Device(deviceId);
    if (result.success) {
      setNotice("Device revoked. Its active remote sessions have been closed.");
      await refresh();
    } else {
      setError(result.error || "The device could not be revoked.");
    }
    setBusy(false);
  };

  const cardStyle: React.CSSProperties = {
    background: "rgba(10, 16, 26, 0.92)",
    border: "1px solid rgba(140, 160, 190, 0.18)",
    borderRadius: 12,
    padding: 14,
  };
  const actionStyle: React.CSSProperties = {
    border: "1px solid rgba(140, 160, 190, 0.24)",
    borderRadius: 8,
    padding: "8px 11px",
    color: "#e8eef8",
    background: "rgba(255,255,255,0.06)",
    cursor: "pointer",
    fontSize: 12,
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1200,
      background: "rgba(0,0,0,0.78)", backdropFilter: "blur(12px)",
      display: "flex", justifyContent: "center", alignItems: "center", padding: 18,
    }}>
      <section style={{
        width: "min(920px, 100%)", maxHeight: "92vh", overflowY: "auto",
        background: "#0b111b", color: "#e8eef8", border: "1px solid rgba(130,160,195,0.24)",
        borderRadius: 16, padding: 20, display: "flex", flexDirection: "column", gap: 16,
        boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
      }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div style={{ width: 38, height: 38, borderRadius: 10, display: "grid", placeItems: "center", background: "rgba(86,177,255,0.12)" }}>
              <Smartphone size={20} color="#75c2ff" />
            </div>
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Paired devices</h2>
              <p style={{ fontSize: 11, color: "#93a4ba", margin: "4px 0 0" }}>{deviceName} · protocol v2 · ES256</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close device pairing" style={{ ...actionStyle, padding: 7, background: "transparent" }}><X size={17} /></button>
        </header>

        {error && <div role="alert" style={{ ...cardStyle, color: "#ffb6b6", borderColor: "rgba(255,100,100,.35)" }}>{error}</div>}
        {notice && <div role="status" style={{ ...cardStyle, color: "#9de6c6", borderColor: "rgba(70,200,150,.25)" }}>{notice}</div>}

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(250px, 320px)", gap: 14 }}>
          <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 650 }}>Pair a new Android device</div>
                <p style={{ margin: "5px 0 0", color: "#93a4ba", fontSize: 11, lineHeight: 1.5 }}>
                  Scan this one-time QR from the phone while both devices are connected to your tailnet.
                </p>
              </div>
              <button disabled={busy} onClick={() => void createPairingQr()} style={actionStyle}>
                <RefreshCw size={13} style={{ marginRight: 6, verticalAlign: "middle" }} />
                Generate QR
              </button>
            </div>

            {pairingWindow ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
                <div style={{ background: "white", borderRadius: 10, padding: 8, width: 208, height: 208, display: "grid", placeItems: "center" }}>
                  <img src={pairingWindow.qrDataUrl} alt="Vanessa protocol v2 pairing QR" style={{ width: 192, height: 192 }} />
                </div>
                <div style={{ minWidth: 210, flex: 1, display: "flex", flexDirection: "column", gap: 9 }}>
                  <div style={{ fontSize: 11, color: "#93a4ba" }}>Secure endpoint</div>
                  <div style={{ fontSize: 12, overflowWrap: "anywhere" }}>{pairingWindow.endpoint}</div>
                  <button onClick={() => void copyEndpoint()} style={{ ...actionStyle, alignSelf: "flex-start" }}>
                    <Copy size={12} style={{ marginRight: 6, verticalAlign: "middle" }} />{copied ? "Copied" : "Copy endpoint"}
                  </button>
                  <div style={{ fontSize: 11, color: "#93a4ba" }}>QR expires: {new Date(pairingWindow.expiresAt).toLocaleString()}</div>
                  <div style={{ fontSize: 11, color: "#93a4ba" }}>The code and PC public-key pin are encoded in the QR. The PC private key is not.</div>
                </div>
              </div>
            ) : (
              <div style={{ border: "1px dashed rgba(140,160,190,.25)", borderRadius: 10, padding: 22, textAlign: "center", color: "#93a4ba", fontSize: 12 }}>
                Configure Tailscale Serve, then generate a short-lived pairing QR.
              </div>
            )}
          </div>

          <div style={{ ...cardStyle }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 9 }}>
              <ShieldCheck size={16} color="#8cc9ff" />
              <strong style={{ fontSize: 13 }}>Security boundaries</strong>
            </div>
            <ul style={{ paddingLeft: 17, margin: 0, color: "#a8b6c9", fontSize: 11, lineHeight: 1.65 }}>
              <li>WSS through Tailscale Serve; listener stays on PC loopback.</li>
              <li>New devices require local approval here.</li>
              <li>Scopes are assigned by the PC, not the phone.</li>
              <li>Destructive actions require a separate biometric-bound signature.</li>
              <li>Revocation closes the phone's active sockets.</li>
            </ul>
          </div>
        </div>

        <div style={{ ...cardStyle }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <strong style={{ fontSize: 13 }}>Waiting for PC approval</strong>
            <span style={{ color: "#93a4ba", fontSize: 11 }}>{pending.length} pending</span>
          </div>
          {pending.length === 0 ? (
            <p style={{ color: "#7f91a8", fontSize: 11, margin: 0 }}>No phone is waiting for approval. Scan the QR above from Android.</p>
          ) : pending.map((item) => (
            <div key={item.pairingId} style={{ borderTop: "1px solid rgba(140,160,190,.14)", padding: "12px 0", display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 650 }}><Smartphone size={13} style={{ marginRight: 6, verticalAlign: "middle" }} />{item.deviceHint}</div>
                  <div style={{ fontSize: 10, color: "#93a4ba", marginTop: 4 }}>{item.platform} · app {item.appVersion} · expires {new Date(item.expiresAt).toLocaleTimeString()}</div>
                </div>
                <div style={{ fontSize: 10, color: "#93a4ba" }}>Key ID: {item.keyId.slice(0, 9)}…</div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 8 }}>
                {SCOPES.map((scope) => (
                  <label key={scope.id} style={{ display: "flex", gap: 7, alignItems: "flex-start", fontSize: 11, color: "#d5dfec" }}>
                    <input type="checkbox" checked={selectedFor(item.pairingId).includes(scope.id)}
                      onChange={(event) => toggleScope(item.pairingId, scope.id, event.target.checked)} />
                    <span><strong>{scope.label}</strong><br /><span style={{ color: "#8799b0" }}>{scope.description}</span></span>
                  </label>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button disabled={busy} onClick={() => void approve(item.pairingId)} style={{ ...actionStyle, background: "rgba(54,150,115,.16)", borderColor: "rgba(54,190,140,.35)" }}>
                  <Check size={12} style={{ marginRight: 5, verticalAlign: "middle" }} />Approve selected scopes
                </button>
                <button disabled={busy} onClick={() => void reject(item.pairingId)} style={actionStyle}>Reject</button>
              </div>
            </div>
          ))}
        </div>

        <div style={{ ...cardStyle }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <strong style={{ fontSize: 13 }}>Trusted devices</strong>
            <span style={{ color: "#93a4ba", fontSize: 11 }}>{devices.filter((device) => !device.revoked).length} active</span>
          </div>
          {devices.length === 0 ? (
            <p style={{ color: "#7f91a8", fontSize: 11, margin: 0 }}>No phone has been paired with this PC yet.</p>
          ) : devices.map((device) => (
            <div key={device.deviceId} style={{ borderTop: "1px solid rgba(140,160,190,.14)", padding: "10px 0", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600 }}><Laptop size={13} style={{ marginRight: 6, verticalAlign: "middle" }} />{device.deviceHint}</div>
                <div style={{ fontSize: 10, color: "#93a4ba", marginTop: 4 }}>
                  {device.platform} · paired {new Date(device.pairedAt).toLocaleDateString()} · {device.grantedScopes.length} scopes · {device.revoked ? "revoked" : "active"}
                </div>
              </div>
              {!device.revoked && <button disabled={busy} onClick={() => void revoke(device.deviceId)} style={{ ...actionStyle, color: "#ffb6b6" }}>
                <Trash2 size={12} style={{ marginRight: 5, verticalAlign: "middle" }} />Revoke
              </button>}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};
