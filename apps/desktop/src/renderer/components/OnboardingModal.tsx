import React, { useState } from "react";
import { Shield, Folder, Wrench, Lock, Check, ChevronRight, ChevronLeft, Eye, HardDrive, Smartphone } from "lucide-react";

interface OnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const OnboardingModal: React.FC<OnboardingModalProps> = ({ isOpen, onClose }) => {
  const [step, setStep] = useState(1);
  const [workspacePath, setWorkspacePath] = useState("Documents/VanessaDemo");
  const [capabilities, setCapabilities] = useState({
    system: true,
    browser: true,
    files: true,
    developer: true,
    email: false,
    cloud: false,
    whatsapp: false,
  });
  const [autonomy, setAutonomy] = useState({
    autoRunLowRisk: true,
    askBeforeSharing: true,
    askBeforeDeleting: true,
    recordEveryAction: true,
  });
  const [privacyRules, setPrivacyRules] = useState({
    localMemoryOnly: true,
    noRawApiKeys: true,
    redactSensitiveData: true,
  });

  if (!isOpen) return null;

  const toggleCap = (key: keyof typeof capabilities) => {
    setCapabilities((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleAuto = (key: keyof typeof autonomy) => {
    setAutonomy((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const togglePriv = (key: keyof typeof privacyRules) => {
    setPrivacyRules((prev) => ({ ...prev, [key]: !prev[key] }));
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
          maxWidth: "560px",
          background: "linear-gradient(145deg, #121824 0%, #090c14 100%)",
          border: "1px solid rgba(0, 242, 254, 0.35)",
          boxShadow: "0 0 60px rgba(0, 242, 254, 0.15)",
          padding: "28px",
          display: "flex",
          flexDirection: "column",
          gap: "20px",
          borderRadius: "18px",
        }}
      >
        {/* Modal Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
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
              <Shield size={24} />
            </div>
            <div>
              <h2 style={{ fontSize: "17px", fontWeight: 700, color: "#fff" }}>
                Welcome to Vanessa
              </h2>
              <p style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                Your private, voice-native operating brain. Runs locally and asks before it acts.
              </p>
            </div>
          </div>
          <div
            style={{
              fontSize: "11px",
              padding: "3px 8px",
              borderRadius: "12px",
              background: "rgba(255, 255, 255, 0.08)",
              color: "var(--cyan-glow)",
              fontWeight: 600,
            }}
          >
            Step {step} of 4
          </div>
        </div>

        {/* Step Progress Pills */}
        <div style={{ display: "flex", gap: "6px" }}>
          {[1, 2, 3, 4].map((s) => (
            <div
              key={s}
              style={{
                flex: 1,
                height: "4px",
                borderRadius: "2px",
                background: s <= step ? "var(--cyan-glow)" : "rgba(255, 255, 255, 0.1)",
                transition: "all 0.3s ease",
              }}
            />
          ))}
        </div>

        {/* Step 1: Workspace Selection */}
        {step === 1 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <div style={{ fontSize: "14px", fontWeight: 600, color: "#fff", display: "flex", alignItems: "center", gap: "8px" }}>
              <Folder size={16} color="var(--cyan-glow)" /> Step 1 — Choose Workspace Folder
            </div>
            <p style={{ fontSize: "13px", color: "var(--text-muted)", lineHeight: 1.5 }}>
              Vanessa uses least-privilege folder allowlisting. By default, it operates strictly inside your chosen folder and cannot browse the entire disk.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "12px", color: "var(--text-muted)", fontWeight: 500 }}>Approved Folder Scope:</label>
              <input
                type="text"
                value={workspacePath}
                onChange={(e) => setWorkspacePath(e.target.value)}
                style={{
                  padding: "10px 14px",
                  borderRadius: "8px",
                  background: "rgba(0, 0, 0, 0.4)",
                  border: "1px solid var(--border-subtle)",
                  color: "#fff",
                  fontSize: "13px",
                  outline: "none",
                }}
              />
            </div>
            <div
              style={{
                fontSize: "12px",
                color: "#34d399",
                background: "rgba(52, 211, 153, 0.08)",
                padding: "8px 12px",
                borderRadius: "8px",
                border: "1px solid rgba(52, 211, 153, 0.2)",
              }}
            >
              ✓ Default allowed scope: <strong>Documents/VanessaDemo</strong>
            </div>
          </div>
        )}

        {/* Step 2: Capabilities */}
        {step === 2 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <div style={{ fontSize: "14px", fontWeight: 600, color: "#fff", display: "flex", alignItems: "center", gap: "8px" }}>
              <Wrench size={16} color="var(--cyan-glow)" /> Step 2 — Choose Enabled Capabilities
            </div>
            <p style={{ fontSize: "13px", color: "var(--text-muted)" }}>
              Per-tool permission scoping: select which modules Vanessa can interface with.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              {[
                { id: "system", label: "System settings", desc: "Wi-Fi, Bluetooth, volume", state: capabilities.system },
                { id: "browser", label: "Browser & Web", desc: "Chrome, YouTube search", state: capabilities.browser },
                { id: "files", label: "Files & Folders", desc: "Approved folder only", state: capabilities.files },
                { id: "developer", label: "Developer tools", desc: "Claude Code, tests, git", state: capabilities.developer },
                { id: "email", label: "Email (Gmail)", desc: "Requires confirmation", state: capabilities.email },
                { id: "cloud", label: "Cloud Upload", desc: "Requires confirmation", state: capabilities.cloud },
                { id: "whatsapp", label: "WhatsApp links", desc: "Requires confirmation", state: capabilities.whatsapp },
              ].map((item) => (
                <div
                  key={item.id}
                  onClick={() => toggleCap(item.id as any)}
                  style={{
                    padding: "10px 12px",
                    borderRadius: "8px",
                    background: item.state ? "rgba(0, 242, 254, 0.08)" : "rgba(255, 255, 255, 0.03)",
                    border: item.state ? "1px solid var(--cyan-glow)" : "1px solid rgba(255, 255, 255, 0.08)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "8px",
                  }}
                >
                  <div
                    style={{
                      width: "16px",
                      height: "16px",
                      borderRadius: "4px",
                      background: item.state ? "var(--cyan-glow)" : "transparent",
                      border: item.state ? "none" : "1px solid var(--text-muted)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#000",
                      marginTop: "2px",
                      flexShrink: 0,
                    }}
                  >
                    {item.state && <Check size={12} strokeWidth={3} />}
                  </div>
                  <div>
                    <div style={{ fontSize: "12px", fontWeight: 600, color: "#fff" }}>{item.label}</div>
                    <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>{item.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Step 3: Autonomy */}
        {step === 3 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <div style={{ fontSize: "14px", fontWeight: 600, color: "#fff", display: "flex", alignItems: "center", gap: "8px" }}>
              <Lock size={16} color="var(--cyan-glow)" /> Step 3 — Set Autonomy & Safety Boundaries
            </div>
            <p style={{ fontSize: "13px", color: "var(--text-muted)" }}>
              Vanessa will ask for your explicit confirmation before taking actions with external impact.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {[
                { id: "autoRunLowRisk", label: "Auto-run low-risk actions", desc: "Inspect files, check Wi-Fi, open approved apps", state: autonomy.autoRunLowRisk },
                { id: "askBeforeSharing", label: "Ask before sharing anything", desc: "Upload to Drive, send email, share links", state: autonomy.askBeforeSharing },
                { id: "askBeforeDeleting", label: "Ask before deleting anything", desc: "File deletion or folder destruction", state: autonomy.askBeforeDeleting },
                { id: "recordEveryAction", label: "Record every action locally", desc: "Append all operations to OWASP audit trail", state: autonomy.recordEveryAction },
              ].map((item) => (
                <div
                  key={item.id}
                  onClick={() => toggleAuto(item.id as any)}
                  style={{
                    padding: "10px 14px",
                    borderRadius: "8px",
                    background: item.state ? "rgba(16, 185, 129, 0.08)" : "rgba(255, 255, 255, 0.03)",
                    border: item.state ? "1px solid rgba(16, 185, 129, 0.3)" : "1px solid rgba(255, 255, 255, 0.08)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                  }}
                >
                  <div
                    style={{
                      width: "18px",
                      height: "18px",
                      borderRadius: "4px",
                      background: item.state ? "#10b981" : "transparent",
                      border: item.state ? "none" : "1px solid var(--text-muted)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#fff",
                      flexShrink: 0,
                    }}
                  >
                    {item.state && <Check size={14} strokeWidth={3} />}
                  </div>
                  <div>
                    <div style={{ fontSize: "13px", fontWeight: 600, color: "#fff" }}>{item.label}</div>
                    <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>{item.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Step 4: Privacy Guarantees */}
        {step === 4 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <div style={{ fontSize: "14px", fontWeight: 600, color: "#fff", display: "flex", alignItems: "center", gap: "8px" }}>
              <Eye size={16} color="var(--cyan-glow)" /> Step 4 — Privacy & Local Memory Guarantees
            </div>
            <p style={{ fontSize: "13px", color: "var(--text-muted)" }}>
              “Your computer. Your files. Your assistant. Vanessa runs locally and asks before it acts.”
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {[
                { id: "localMemoryOnly", label: "Keep memory on this PC (127.0.0.1)", desc: "SQLite/Rust vector storage stored locally in ~/.openjarvis/memory.db", state: privacyRules.localMemoryOnly },
                { id: "noRawApiKeys", label: "Do not store API keys or passwords in memory", desc: "Credentials are never persisted into long-term retrieval indices", state: privacyRules.noRawApiKeys },
                { id: "redactSensitiveData", label: "Local redaction layer before persistence", desc: "Automatically strips emails, phone numbers, tokens, and credit cards", state: privacyRules.redactSensitiveData },
              ].map((item) => (
                <div
                  key={item.id}
                  onClick={() => togglePriv(item.id as any)}
                  style={{
                    padding: "12px 14px",
                    borderRadius: "8px",
                    background: item.state ? "rgba(0, 242, 254, 0.08)" : "rgba(255, 255, 255, 0.03)",
                    border: item.state ? "1px solid var(--cyan-glow)" : "1px solid rgba(255, 255, 255, 0.08)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "10px",
                  }}
                >
                  <div
                    style={{
                      width: "18px",
                      height: "18px",
                      borderRadius: "4px",
                      background: item.state ? "var(--cyan-glow)" : "transparent",
                      border: item.state ? "none" : "1px solid var(--text-muted)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#000",
                      marginTop: "2px",
                      flexShrink: 0,
                    }}
                  >
                    {item.state && <Check size={14} strokeWidth={3} />}
                  </div>
                  <div>
                    <div style={{ fontSize: "13px", fontWeight: 600, color: "#fff" }}>{item.label}</div>
                    <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>{item.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer Navigation */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "8px" }}>
          {step > 1 ? (
            <button
              onClick={() => setStep(step - 1)}
              style={{
                padding: "8px 16px",
                borderRadius: "8px",
                background: "rgba(255, 255, 255, 0.06)",
                border: "1px solid var(--border-subtle)",
                color: "var(--text-muted)",
                fontSize: "13px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <ChevronLeft size={16} /> Back
            </button>
          ) : <div />}

          {step < 4 ? (
            <button
              onClick={() => setStep(step + 1)}
              style={{
                padding: "10px 20px",
                borderRadius: "8px",
                background: "linear-gradient(135deg, #00f2fe 0%, #0284c7 100%)",
                color: "#08090d",
                fontWeight: 600,
                fontSize: "13px",
                cursor: "pointer",
                border: "none",
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              Continue <ChevronRight size={16} />
            </button>
          ) : (
            <button
              onClick={onClose}
              style={{
                padding: "10px 22px",
                borderRadius: "8px",
                background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
                color: "#ffffff",
                boxShadow: "0 0 15px rgba(16, 185, 129, 0.4)",
                fontWeight: 600,
                fontSize: "13px",
                cursor: "pointer",
                border: "none",
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <Check size={16} /> Complete Setup & Enter HUD
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
