import React, { useState } from "react";
import { Smartphone, Shield, Check, X, Copy, ExternalLink, ToggleLeft, ToggleRight, Laptop, KeyRound } from "lucide-react";

interface MobilePairingModalProps {
  isOpen: boolean;
  onClose: () => void;
  deviceName?: string;
  pairingCode?: string;
  remoteUrl?: string;
}

export const MobilePairingModal: React.FC<MobilePairingModalProps> = ({
  isOpen,
  onClose,
  deviceName = "Kshitij-Laptop",
  pairingCode = "482913",
  remoteUrl = "http://127.0.0.1:4319/remote",
}) => {
  const [remoteEnabled, setRemoteEnabled] = useState(true);
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(remoteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleToggle = async () => {
    const nextState = !remoteEnabled;
    setRemoteEnabled(nextState);
    try {
      await fetch("http://127.0.0.1:4319/api/remote/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: nextState }),
      });
    } catch {
      // Offline fallback
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.82)",
        backdropFilter: "blur(16px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1100,
        padding: "20px",
      }}
    >
      <div
        className="glass-panel"
        style={{
          width: "100%",
          maxWidth: "520px",
          background: "linear-gradient(145deg, #131926 0%, #090c14 100%)",
          border: "1px solid rgba(0, 242, 254, 0.35)",
          boxShadow: "0 0 60px rgba(0, 242, 254, 0.2)",
          padding: "26px",
          display: "flex",
          flexDirection: "column",
          gap: "18px",
          borderRadius: "18px",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div
              style={{
                width: "42px",
                height: "42px",
                borderRadius: "12px",
                background: "rgba(0, 242, 254, 0.15)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--cyan-glow)",
              }}
            >
              <Smartphone size={24} />
            </div>
            <div>
              <h2 style={{ fontSize: "16px", fontWeight: 700, color: "#fff" }}>
                Device Pairing & Remote Relay
              </h2>
              <p style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                “Vanessa lives on your PC, but you can command it from your phone.”
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Remote Access Toggle */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "12px 16px",
            background: "rgba(0, 0, 0, 0.35)",
            borderRadius: "10px",
            border: "1px solid rgba(255, 255, 255, 0.08)",
          }}
        >
          <div>
            <div style={{ fontSize: "13px", fontWeight: 600, color: "#fff" }}>
              Remote Access: {remoteEnabled ? <span style={{ color: "#34d399" }}>ACTIVE</span> : <span style={{ color: "#f43f5e" }}>OFF</span>}
            </div>
            <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
              {remoteEnabled ? "Relay accepting outbound WSS commands" : "Laptop completely ignores remote requests"}
            </div>
          </div>
          <button
            onClick={handleToggle}
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: remoteEnabled ? "#34d399" : "#64748b",
            }}
          >
            {remoteEnabled ? <ToggleRight size={32} /> : <ToggleLeft size={32} />}
          </button>
        </div>

        {/* In-App Authenticator-Style Device Pairing Card */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "12px",
            padding: "18px",
            background: "rgba(0, 0, 0, 0.4)",
            borderRadius: "14px",
            border: "1px solid rgba(0, 242, 254, 0.25)",
          }}
        >
          <div style={{ fontSize: "12px", color: "var(--cyan-glow)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Laptop Vanessa Credentials
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            {/* Device Name */}
            <div
              style={{
                padding: "12px 14px",
                background: "rgba(255, 255, 255, 0.04)",
                border: "1px solid rgba(255, 255, 255, 0.1)",
                borderRadius: "10px",
                display: "flex",
                flexDirection: "column",
                gap: "4px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: "var(--text-muted)" }}>
                <Laptop size={13} />
                <span>Device Name:</span>
              </div>
              <div style={{ fontSize: "16px", fontWeight: 700, color: "#ffffff", fontFamily: "var(--font-mono)" }}>
                {deviceName}
              </div>
            </div>

            {/* 6-Digit Pairing Code */}
            <div
              style={{
                padding: "12px 14px",
                background: "rgba(0, 242, 254, 0.08)",
                border: "1px solid var(--cyan-glow)",
                borderRadius: "10px",
                display: "flex",
                flexDirection: "column",
                gap: "4px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: "var(--cyan-glow)" }}>
                <KeyRound size={13} />
                <span>Pairing Code (6-digit):</span>
              </div>
              <div style={{ fontSize: "20px", fontWeight: 800, letterSpacing: "3px", color: "#ffffff", fontFamily: "var(--font-mono)" }}>
                {pairingCode}
              </div>
            </div>
          </div>

          {/* Simple Step-by-Step Flow */}
          <div
            style={{
              padding: "10px 14px",
              background: "rgba(0, 0, 0, 0.3)",
              borderRadius: "8px",
              fontSize: "12px",
              color: "var(--text-muted)",
              lineHeight: 1.6,
            }}
          >
            <div>📱 <strong>On your phone:</strong></div>
            <div>1. Enter device name: <strong style={{ color: "#fff" }}>{deviceName}</strong></div>
            <div>2. Enter pairing code: <strong style={{ color: "var(--cyan-glow)" }}>{pairingCode}</strong></div>
            <div style={{ color: "#34d399", fontWeight: 600 }}>→ Connected via secure outbound WebSocket relay</div>
          </div>
        </div>

        {/* Web Companion Link */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            Mobile Companion URL:
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              background: "rgba(0, 0, 0, 0.3)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "8px",
            }}
          >
            <span style={{ fontSize: "12px", color: "#38bdf8", fontFamily: "var(--font-mono)" }}>
              {remoteUrl}
            </span>
            <div style={{ display: "flex", gap: "6px" }}>
              <button
                onClick={handleCopy}
                style={{
                  padding: "5px 10px",
                  borderRadius: "6px",
                  background: "rgba(255, 255, 255, 0.08)",
                  border: "none",
                  color: "#fff",
                  fontSize: "11px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "4px",
                }}
              >
                {copied ? <Check size={12} color="#34d399" /> : <Copy size={12} />}
                <span>{copied ? "Copied" : "Copy"}</span>
              </button>
              <a
                href={remoteUrl}
                target="_blank"
                rel="noreferrer"
                style={{
                  padding: "5px 10px",
                  borderRadius: "6px",
                  background: "rgba(0, 242, 254, 0.15)",
                  border: "1px solid rgba(0, 242, 254, 0.3)",
                  color: "var(--cyan-glow)",
                  fontSize: "11px",
                  textDecoration: "none",
                  display: "flex",
                  alignItems: "center",
                  gap: "4px",
                }}
              >
                <span>Open</span>
                <ExternalLink size={12} />
              </a>
            </div>
          </div>
        </div>

        {/* Security Rules Banner */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            fontSize: "11px",
            color: "var(--text-muted)",
            background: "rgba(52, 211, 153, 0.06)",
            padding: "10px 14px",
            borderRadius: "8px",
            border: "1px solid rgba(52, 211, 153, 0.15)",
            lineHeight: 1.4,
          }}
        >
          <Shield size={16} color="#34d399" style={{ flexShrink: 0 }} />
          <span>
            <strong>Zero Internet Inbound Exposure:</strong> Both laptop & phone connect outbound via WSS. Relay never sees decrypted local files. Risky actions require approval.
          </span>
        </div>
      </div>
    </div>
  );
};
