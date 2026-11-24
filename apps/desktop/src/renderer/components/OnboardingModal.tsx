import React from "react";
import { Shield, Check } from "lucide-react";

interface OnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Informational only. The former wizard's switches and workspace field never
 * changed the running service; presenting them as permissions was misleading.
 */
export const OnboardingModal: React.FC<OnboardingModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      style={{
        position: "fixed", inset: 0, backgroundColor: "rgba(0, 0, 0, 0.82)",
        backdropFilter: "blur(16px)", display: "flex", alignItems: "center",
        justifyContent: "center", zIndex: 1100, padding: "20px",
      }}
    >
      <div className="glass-panel" style={{
        width: "100%", maxWidth: "560px", padding: "28px", borderRadius: "18px",
        display: "flex", flexDirection: "column", gap: "16px",
        background: "linear-gradient(145deg, #121824 0%, #090c14 100%)",
        border: "1px solid rgba(0, 242, 254, 0.35)", color: "#fff",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <Shield size={24} color="var(--cyan-glow)" />
          <h2 id="onboarding-title" style={{ fontSize: "17px", margin: 0 }}>Welcome to Vanessa</h2>
        </div>
        <p style={{ fontSize: "13px", color: "var(--text-muted)", lineHeight: 1.5 }}>
          Vanessa can use local models and local voice, but local defaults are not a network firewall.
          Configured providers and some tools can access external services.
        </p>
        <ul style={{ fontSize: "13px", color: "var(--text-muted)", lineHeight: 1.6, paddingLeft: "20px", margin: 0 }}>
          <li>Some actions require confirmation; do not assume every action is reviewed.</li>
          <li>Guarded file operations use an allowlist; other tools have separate permissions.</li>
          <li>Local memory has best-effort redaction, but is not guaranteed to remove all sensitive data.</li>
          <li>Desktop conversation history is saved only when protected storage is available. Other local databases may not be encrypted.</li>
        </ul>
        <p style={{ fontSize: "12px", color: "var(--text-muted)", lineHeight: 1.5 }}>
          This screen is informational and does not change provider, folder, or tool permissions.
        </p>
        <button onClick={onClose} style={{
          alignSelf: "flex-end", padding: "10px 20px", borderRadius: "8px", border: "none",
          background: "linear-gradient(135deg, #00f2fe 0%, #0284c7 100%)",
          color: "#08090d", fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: "6px",
        }}>
          <Check size={16} /> Continue
        </button>
      </div>
    </div>
  );
};
