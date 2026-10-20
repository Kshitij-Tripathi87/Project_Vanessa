import React from "react";
import { AuditEntry } from "@vanessa/shared";
import { Shield, Smartphone, Mic, Terminal, Monitor, CheckCircle, Ban, AlertTriangle, ExternalLink } from "lucide-react";

interface AuditLogProps {
  logs: AuditEntry[];
  isOpen: boolean;
  onToggle: () => void;
}

export const AuditLog: React.FC<AuditLogProps> = ({ logs, isOpen, onToggle }) => {
  const getSourceIcon = (source?: string) => {
    switch (source) {
      case "remote_pwa":
        return <Smartphone size={12} color="#38bdf8" />;
      case "voice":
        return <Mic size={12} color="#a855f7" />;
      case "cli":
        return <Terminal size={12} color="#34d399" />;
      default:
        return <Monitor size={12} color="var(--cyan-glow)" />;
    }
  };

  const getSourceLabel = (source?: string) => {
    switch (source) {
      case "remote_pwa":
        return "PHONE PWA";
      case "voice":
        return "VOICE";
      case "cli":
        return "CLI";
      default:
        return "LOCAL HUD";
    }
  };

  return (
    <div
      className="glass-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        maxHeight: isOpen ? "380px" : "48px",
        transition: "max-height 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
        overflow: "hidden",
      }}
    >
      {/* Header bar */}
      <div
        onClick={onToggle}
        style={{
          padding: "12px 18px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          cursor: "pointer",
          borderBottom: isOpen ? "1px solid var(--border-subtle)" : "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Shield size={16} color="var(--cyan-glow)" />
          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-main)" }}>
            Security & Governance Audit Trail
          </span>
          <span
            style={{
              padding: "2px 8px",
              borderRadius: "10px",
              background: "rgba(255, 255, 255, 0.08)",
              fontSize: "11px",
              fontFamily: "var(--font-mono)",
              color: "var(--cyan-glow)",
              fontWeight: 600,
            }}
          >
            {logs.length} entries
          </span>
          <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
            • OWASP Least-Privilege & Provenance Active
          </span>
        </div>
        <span style={{ fontSize: "12px", color: "var(--text-dim)" }}>
          {isOpen ? "Collapse" : "Expand"}
        </span>
      </div>

      {/* Log list */}
      {isOpen && (
        <div
          style={{
            padding: "12px 18px",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
          }}
        >
          {logs.length === 0 ? (
            <div style={{ color: "var(--text-dim)", textAlign: "center", padding: "16px" }}>
              No audit entries recorded yet. Vanessa records every action on 127.0.0.1.
            </div>
          ) : (
            logs.map((log) => {
              const timeStr = typeof log.timestamp === "number"
                ? new Date(log.timestamp).toLocaleTimeString()
                : log.timestamp;

              const isSuccess = log.status === "success" || log.status === "approved";
              const isBlocked = log.status === "blocked";
              const isWarn = log.status === "warn";

              return (
                <div
                  key={log.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "7px 10px",
                    borderRadius: "6px",
                    background: isBlocked ? "rgba(244, 63, 94, 0.08)" : "rgba(0,0,0,0.25)",
                    borderLeft: `3px solid ${isBlocked ? "#f43f5e" : isSuccess ? "#10b981" : isWarn ? "#f59e0b" : "var(--cyan-glow)"}`,
                  }}
                >
                  <span style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                    [{timeStr}]
                  </span>

                  {/* Source Badge */}
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "4px",
                      background: "rgba(255, 255, 255, 0.06)",
                      padding: "2px 6px",
                      borderRadius: "4px",
                      color: "#fff",
                      fontSize: "10px",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {getSourceIcon(log.source)}
                    <span>{getSourceLabel(log.source)}</span>
                  </span>

                  {/* Agent */}
                  <span
                    style={{
                      color: "var(--cyan-glow)",
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {log.agent.toUpperCase()}
                  </span>

                  {/* Action */}
                  <span style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                    {log.action}
                  </span>

                  {/* Resource */}
                  {log.resource && (
                    <span style={{ color: "#38bdf8", whiteSpace: "nowrap" }}>
                      [{log.resource}]
                    </span>
                  )}

                  {/* Risk Badge */}
                  {log.risk && (
                    <span
                      style={{
                        fontSize: "10px",
                        padding: "1px 5px",
                        borderRadius: "3px",
                        background: log.risk === "blocked" ? "rgba(244, 63, 94, 0.2)" : log.risk === "high" || log.risk === "external_share" ? "rgba(245, 158, 11, 0.15)" : "rgba(255, 255, 255, 0.05)",
                        color: log.risk === "blocked" ? "#f43f5e" : log.risk === "high" || log.risk === "external_share" ? "#f59e0b" : "var(--text-muted)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {log.risk}
                    </span>
                  )}

                  {/* Details / Result */}
                  <span
                    style={{
                      color: "var(--text-main)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      flex: 1,
                    }}
                  >
                    {typeof log.details === "string" ? log.details : JSON.stringify(log.details)}
                  </span>

                  {/* Result Share Link If Available */}
                  {log.result && typeof log.result === "string" && log.result.startsWith("http") && (
                    <a
                      href={log.result}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "var(--cyan-glow)", display: "flex", alignItems: "center", gap: "2px", textDecoration: "none" }}
                    >
                      <span>Link</span> <ExternalLink size={10} />
                    </a>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};
