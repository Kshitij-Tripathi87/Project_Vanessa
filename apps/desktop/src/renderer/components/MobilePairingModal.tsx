import React, { useCallback, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { Check, Copy, KeyRound, Laptop, Plus, RefreshCw, Shield, Smartphone, X } from "lucide-react";

interface MobilePairingModalProps {
  isOpen: boolean;
  onClose: () => void;
  deviceName?: string;
  pairingCode?: string;
  remoteUrl?: string;
}

const SCOPE_OPTIONS = [
  { id: "system.read", label: "Read system status", safe: true },
  { id: "files.read", label: "Search and read file metadata", safe: true },
  { id: "apps.launch", label: "Launch applications", safe: true },
  { id: "browser.open", label: "Open browser URLs", safe: true },
  { id: "files.open", label: "Open files", safe: true },
  { id: "system.control", label: "Change system settings", safe: false },
  { id: "media.control", label: "Control media playback", safe: false },
  { id: "screen.capture", label: "Capture PC screenshots", safe: false },
  { id: "files.delete", label: "Delete files (strong biometric required)", safe: false },
  { id: "system.lock", label: "Lock the Windows session", safe: false },
] as const;

const DEFAULT_SCOPES = ["system.read", "files.read", "apps.launch", "browser.open", "files.open"];

const panelStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: "650px",
  maxHeight: "90vh",
  overflowY: "auto",
  background: "linear-gradient(145deg, #131926 0%, #090c14 100%)",
  border: "1px solid rgba(0, 242, 254, 0.25)",
  padding: "24px",
  display: "flex",
  flexDirection: "column",
  gap: "18px",
  borderRadius: "18px",
  color: "#fff",
};

const actionStyle: React.CSSProperties = {
  background: "rgba(0, 242, 254, 0.12)",
  border: "1px solid rgba(0, 242, 254, 0.3)",
  borderRadius: "8px",
  padding: "9px 12px",
  color: "#b8f8ff",
  cursor: "pointer",
};

export const MobilePairingModal: React.FC<MobilePairingModalProps> = ({ isOpen, onClose }) => {
  const [status, setStatus] = useState<VanessaRemoteStatus | null>(null);
  const [pairing, setPairing] = useState<VanessaRemotePairingWindow | null>(null);
  const [qrImage, setQrImage] = useState("");
  const [pending, setPending] = useState<VanessaRemotePendingPairing[]>([]);
  const [devices, setDevices] = useState<VanessaTrustedRemoteDevice[]>([]);
  const [grantedScopes, setGrantedScopes] = useState<string[]>(DEFAULT_SCOPES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const expiresIn = useMemo(
    () => pairing ? Math.max(0, Math.ceil((pairing.expiresAt - Date.now()) / 1000)) : 0,
    [pairing],
  );

  const refresh = useCallback(async () => {
    const [nextStatus, nextPending, nextDevices] = await Promise.all([
      window.vanessa.remoteV2Status(),
      window.vanessa.remoteV2PendingPairings().catch(() => ({ pairings: [] })),
      window.vanessa.remoteV2Devices().catch(() => ({ devices: [] })),
    ]);
    setStatus(nextStatus);
    setPending(nextPending.pairings ?? []);
    setDevices(nextDevices.devices ?? []);
    return nextStatus;
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const nextStatus = await window.vanessa.remoteV2Status();
        const [nextPending, nextDevices] = await Promise.all([
          window.vanessa.remoteV2PendingPairings().catch(() => ({ pairings: [] })),
          window.vanessa.remoteV2Devices().catch(() => ({ devices: [] })),
        ]);
        if (cancelled) return;
        setStatus(nextStatus);
        setPending(nextPending.pairings ?? []);
        setDevices(nextDevices.devices ?? []);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not read remote status.");
      }
    };
    void tick();
    const interval = window.setInterval(() => { void tick(); }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!pairing) {
      setQrImage("");
      return;
    }
    const payload = JSON.stringify(pairing);
    void QRCode.toDataURL(payload, {
      errorCorrectionLevel: "H",
      margin: 2,
      width: 280,
      color: { dark: "#07111d", light: "#ffffff" },
    }).then(setQrImage).catch((cause) => {
      setError(cause instanceof Error ? cause.message : "Could not generate QR code.");
    });
  }, [pairing]);

  useEffect(() => {
    if (!isOpen || !pairing) return;
    const interval = window.setInterval(() => {
      if (pairing.expiresAt <= Date.now()) setPairing(null);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [isOpen, pairing]);

  if (!isOpen) return null;

  const createPairing = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const state = await refresh();
      if (!state.enabled) throw new Error(state.error || "Remote v2 is offline. Check that Tailscale is connected and the Windows service is running.");
      const created = await window.vanessa.remoteV2CreatePairing();
      setPairing(created);
      setNotice("Pairing window created. Scan this QR code from Vanessa on Android.");
    } catch (cause) {
      setPairing(null);
      setError(cause instanceof Error ? cause.message : "Could not create pairing window.");
    } finally {
      setBusy(false);
    }
  };

  const approve = async (item: VanessaRemotePendingPairing) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await window.vanessa.remoteV2ApprovePairing({
        pairingId: item.pairingId,
        grantedScopes,
      });
      setNotice("Phone approved. It can now authenticate using its registered device key.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not approve this device.");
    } finally {
      setBusy(false);
    }
  };

  const reject = async (item: VanessaRemotePendingPairing) => {
    setBusy(true);
    setError(null);
    try {
      await window.vanessa.remoteV2RejectPairing(item.pairingId);
      setNotice("Pairing request rejected.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reject pairing.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (device: VanessaTrustedRemoteDevice) => {
    setBusy(true);
    setError(null);
    try {
      await window.vanessa.remoteV2RevokeDevice(device.deviceId);
      setNotice("Device trust revoked. Its active session has been closed.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke this device.");
    } finally {
      setBusy(false);
    }
  };

  const copyEndpoint = async () => {
    if (!pairing) return;
    await navigator.clipboard.writeText(pairing.scheme + "://" + pairing.pcIp + ":" + pairing.port + pairing.path);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const toggleScope = (scope: string) => {
    setGrantedScopes((current) => current.includes(scope)
      ? current.filter((item) => item !== scope)
      : [...current, scope]);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.82)", backdropFilter: "blur(14px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100, padding: "18px" }}>
      <div className="glass-panel" style={panelStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 11, background: "rgba(0,242,254,.12)", display: "grid", placeItems: "center", color: "#67e8f9" }}>
              <Smartphone size={22} />
            </div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>Remote device access</div>
              <div style={{ fontSize: 11, color: "#94a3b8" }}>Authenticated protocol v2 · PC-authorized capabilities</div>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: "transparent", border: 0, color: "#94a3b8", cursor: "pointer" }}><X size={20} /></button>
        </div>

        <div style={{ borderRadius: 10, padding: 13, background: "rgba(0,0,0,.3)", border: "1px solid rgba(255,255,255,.08)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <strong style={{ fontSize: 12 }}>TAILNET GATEWAY</strong>
            <span style={{ color: status?.enabled && status.tailscale ? "#34d399" : "#fbbf24", fontSize: 11, fontWeight: 700 }}>
              {status?.enabled ? status.tailscale ? "TAILSCALE WSS ONLINE" : "LOCAL TEST MODE" : "OFFLINE"}
            </span>
          </div>
          <p style={{ fontSize: 12, color: "#94a3b8", margin: "7px 0 0", lineHeight: 1.5 }}>
            {status?.enabled
              ? (status.scheme || "wss") + "://" + status.host + ":" + status.port + (status.path || "/remote-v2")
              : status?.error || "The gateway has not been started. The packaged Windows app requires a running Tailscale client for remote access."}
          </p>
          {status?.enabled && <p style={{ fontSize: 11, color: "#94a3b8", margin: "5px 0 0" }}>{status.connections ?? 0} active authenticated connection(s)</p>}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ fontWeight: 650, fontSize: 13 }}>One-time pairing QR</div>
            <div style={{ fontSize: 11, color: "#94a3b8" }}>QR expires after five minutes and pins the PC's ES256 public identity.</div>
          </div>
          <button onClick={createPairing} disabled={busy || !status?.enabled} style={{ ...actionStyle, opacity: busy || !status?.enabled ? .5 : 1, display: "inline-flex", alignItems: "center", gap: 7 }}>
            <Plus size={14} /> Create QR
          </button>
        </div>

        {pairing && qrImage && (
          <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", padding: 14, borderRadius: 12, background: "rgba(0,0,0,.35)" }}>
            <img src={qrImage} alt="One-time Vanessa v2 pairing QR code" width={176} height={176} style={{ borderRadius: 8, background: "#fff" }} />
            <div style={{ flex: 1, minWidth: 210 }}>
              <div style={{ fontSize: 12, color: "#67e8f9", fontWeight: 700 }}>{pairing.pcName}</div>
              <div style={{ fontSize: 12, color: "#fff", fontFamily: "monospace", overflowWrap: "anywhere", marginTop: 5 }}>
                {pairing.scheme}://{pairing.pcIp}:{pairing.port}{pairing.path}
              </div>
              <div style={{ fontSize: 12, color: "#fbbf24", marginTop: 9 }}>Expires in {Math.floor((pairing.expiresAt - Date.now()) / 1000)}s</div>
              <button onClick={copyEndpoint} style={{ ...actionStyle, marginTop: 10, display: "inline-flex", alignItems: "center", gap: 7 }}>
                {copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "Copied" : "Copy endpoint"}
              </button>
            </div>
          </div>
        )}

        <div style={{ borderTop: "1px solid rgba(255,255,255,.08)", paddingTop: 14 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
            <div>
              <strong style={{ fontSize: 13 }}>Pending phone approvals</strong>
              <div style={{ fontSize: 11, color: "#94a3b8" }}>Approvals must be confirmed locally on this Windows PC.</div>
            </div>
            <button onClick={() => void refresh().catch((cause) => setError(cause.message))} disabled={busy} style={{ ...actionStyle, padding: 7 }}><RefreshCw size={14} /></button>
          </div>
          {pending.length === 0 ? <p style={{ color: "#64748b", fontSize: 12 }}>No phones are waiting for approval.</p> : pending.map((item) => (
            <div key={item.pairingId} style={{ padding: 12, borderRadius: 10, background: "rgba(0,0,0,.3)", marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <strong style={{ fontSize: 12 }}>{item.deviceHint} · {item.platform}</strong>
                <span style={{ fontSize: 10, color: "#94a3b8" }}>expires {new Date(item.expiresAt).toLocaleTimeString()}</span>
              </div>
              <p style={{ fontSize: 11, color: "#94a3b8", margin: "5px 0" }}>App {item.appVersion} · key {item.keyId.slice(0, 12)}…</p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 7, marginTop: 8 }}>
                {SCOPE_OPTIONS.map((scope) => (
                  <label key={scope.id} style={{ fontSize: 10, color: scope.safe ? "#cbd5e1" : "#fbbf24", display: "flex", gap: 6, alignItems: "flex-start" }}>
                    <input type="checkbox" checked={grantedScopes.includes(scope.id)} onChange={() => toggleScope(scope.id)} />
                    <span>{scope.label}</span>
                  </label>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 11 }}>
                <button disabled={busy || grantedScopes.length === 0} onClick={() => void approve(item)} style={{ ...actionStyle, background: "rgba(52,211,153,.12)", borderColor: "rgba(52,211,153,.3)", color: "#86efac", flex: 1 }}>Approve selected scopes</button>
                <button disabled={busy} onClick={() => void reject(item)} style={{ ...actionStyle, background: "rgba(244,63,94,.1)", borderColor: "rgba(244,63,94,.3)", color: "#fda4af" }}>Reject</button>
              </div>
            </div>
          ))}
        </div>

        <div style={{ borderTop: "1px solid rgba(255,255,255,.08)", paddingTop: 14 }}>
          <strong style={{ fontSize: 13 }}>Trusted phones</strong>
          {devices.length === 0 ? <p style={{ color: "#64748b", fontSize: 12 }}>No trusted phones.</p> : devices.map((device) => (
            <div key={device.deviceId} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "9px 0", borderBottom: "1px solid rgba(255,255,255,.06)" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{device.deviceHint} {device.revoked ? "(revoked)" : ""}</div>
                <div style={{ fontSize: 10, color: "#94a3b8" }}>{device.platform} · {device.grantedScopes.length} scope(s) · {device.keyId.slice(0, 12)}…</div>
              </div>
              {!device.revoked && <button disabled={busy} onClick={() => void revoke(device)} style={{ ...actionStyle, color: "#fda4af", borderColor: "rgba(244,63,94,.3)" }}>Revoke</button>}
            </div>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "flex-start", gap: 9, padding: 11, background: "rgba(52,211,153,.06)", border: "1px solid rgba(52,211,153,.16)", borderRadius: 9 }}>
          <Shield size={17} color="#34d399" style={{ flexShrink: 0 }} />
          <div style={{ fontSize: 11, lineHeight: 1.5, color: "#94a3b8" }}>
            Tailscale Serve publishes WSS only to the tailnet, not the public internet. Phone identity is pinned to the PC key. The PC enforces scopes and verifies tasks. Destructive capabilities are hidden until the phone registers a separate strong-biometric key and each operation receives action-bound approval.
          </div>
        </div>

        {(error || notice) && (
          <div role="status" style={{ fontSize: 12, color: error ? "#fda4af" : "#86efac" }}>
            {error || notice}
          </div>
        )}
      </div>
    </div>
  );
};
