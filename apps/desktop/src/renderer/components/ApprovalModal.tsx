import React from "react";
import { Task } from "@vanessa/shared";
import { ShieldAlert, Check, X, Folder, Share2, AlertTriangle } from "lucide-react";

interface ApprovalModalProps {
  task: Task | null;
  onApprove: (taskId: string) => void;
  onReject: (taskId: string) => void;
}

export const ApprovalModal: React.FC<ApprovalModalProps> = ({ task, onApprove, onReject }) => {
  if (!task) return null;

  const requestDetails = Object.entries(task.params || {})
    .filter(([key]) => !/(password|secret|token|credential|api.?key)/i.test(key))
    .slice(0, 8)
    .map(([key, value]) => {
      const rendered = typeof value === "string" ? value : JSON.stringify(value);
      return [key, (rendered || "").slice(0, 280)] as const;
    });

  // Determine human-friendly copy based on action
  let actionTitle = `Execute ${task.action}`;
  let accessRequested = task.agent.toUpperCase();
  const rawFolderScope = task.params?.targetPath || task.params?.filePath || task.params?.path || task.params?.basePath;
  const folderScope = typeof rawFolderScope === "string" ? rawFolderScope : "No local folder specified";
  let riskLevel = task.risk ? task.risk.toUpperCase() : "Unclassified";

  if (task.action.includes("drive.upload")) {
    const filename = task.params?.file || "Q3_Report.pdf";
    actionTitle = `Upload "${filename}" to Google Drive and create a shareable link.`;
    accessRequested = "Google Drive (Cloud)";
    riskLevel = "External sharing";
  } else if (task.action.includes("wifi.restart")) {
    actionTitle = "Restart Wi-Fi network adapter to restore connectivity.";
    accessRequested = "Network Hardware / System Adapter";
    // Network actions do not request file-system access.
    riskLevel = "Elevated OS setting (temporary connection drop)";
  } else if (task.action.includes("gmail.send")) {
    actionTitle = `Send email to ${task.params?.to || "recipient"} via Gmail.`;
    accessRequested = "Google Mail (Cloud)";
    riskLevel = "External transmission";
  } else if (task.action.includes("claude_code")) {
    actionTitle = "Open Claude Code with autonomous tool permissions.";
    accessRequested = "Developer CLI / Terminal";
    riskLevel = "Autonomous code execution";
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.78)",
        backdropFilter: "blur(14px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: "20px",
      }}
    >
      <div
        className="glass-panel"
        style={{
          width: "100%",
          maxWidth: "520px",
          background: "linear-gradient(145deg, #151b28 0%, #0c0f18 100%)",
          border: "1px solid rgba(245, 158, 11, 0.45)",
          boxShadow: "0 0 60px rgba(245, 158, 11, 0.25)",
          padding: "26px",
          display: "flex",
          flexDirection: "column",
          gap: "20px",
          borderRadius: "16px",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
          <div
            style={{
              width: "48px",
              height: "48px",
              borderRadius: "14px",
              background: "rgba(245, 158, 11, 0.15)",
              border: "1px solid rgba(245, 158, 11, 0.3)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#f59e0b",
              flexShrink: 0,
            }}
          >
            <ShieldAlert size={28} />
          </div>
          <div>
            <div style={{ fontSize: "17px", fontWeight: 700, color: "#ffffff" }}>
              Action Approval Required
            </div>
            <div style={{ fontSize: "12px", color: "#f59e0b", fontWeight: 500 }}>
              Vanessa Safety Policy: Ask before external sharing or system changes
            </div>
          </div>
        </div>

        {requestDetails.length > 0 && (
          <div
            style={{
              padding: "12px 14px",
              borderRadius: "10px",
              background: "rgba(0, 0, 0, 0.28)",
              border: "1px solid rgba(255, 255, 255, 0.08)",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              maxHeight: "140px",
              overflowY: "auto",
              fontSize: "11px",
              fontFamily: "var(--font-mono)",
            }}
          >
            <strong style={{ color: "var(--text-main)" }}>Request details</strong>
            {requestDetails.map(([key, value]) => (
              <div key={key} style={{ color: "var(--text-muted)", overflowWrap: "anywhere" }}>
                <span style={{ color: "#38bdf8" }}>{key}: </span>{value || "(empty)"}
              </div>
            ))}
          </div>
        )}

        {/* Action Details Card */}
        <div
          style={{
            padding: "16px",
            borderRadius: "12px",
            background: "rgba(0, 0, 0, 0.4)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
          }}
        >
          <div style={{ fontSize: "14px", color: "#ffffff", fontWeight: 600, lineHeight: 1.4 }}>
            Vanessa wants to: <span style={{ color: "var(--cyan-glow)" }}>{actionTitle}</span>
          </div>

          <div style={{ height: "1px", background: "rgba(255, 255, 255, 0.06)", margin: "4px 0" }} />

          <div style={{ display: "grid", gridTemplateColumns: "130px 1fr", gap: "6px", fontSize: "13px" }}>
            <span style={{ color: "var(--text-muted)" }}>Access requested:</span>
            <strong style={{ color: "var(--text-main)" }}>{accessRequested}</strong>

            <span style={{ color: "var(--text-muted)" }}>Folder scope:</span>
            <span style={{ color: "#38bdf8", display: "flex", alignItems: "center", gap: "4px" }}>
              <Folder size={13} /> {folderScope}
            </span>

            <span style={{ color: "var(--text-muted)" }}>Risk level:</span>
            <span style={{ color: "#f59e0b", fontWeight: 600, display: "flex", alignItems: "center", gap: "4px" }}>
              <Share2 size={13} /> {riskLevel}
            </span>
          </div>
        </div>

        {/* Safety Note */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            fontSize: "12px",
            color: "var(--text-muted)",
          }}
        >
          <AlertTriangle size={14} color="#f59e0b" />
          <span>Local memory and private files outside approved folders remain restricted.</span>
        </div>

        {/* OWASP Approval Buttons */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
          <button
            id="decline-button"
            onClick={() => onReject(task.id)}
            style={{
              padding: "11px 12px",
              borderRadius: "8px",
              background: "rgba(244, 63, 94, 0.12)",
              color: "#fda4af",
              border: "1px solid rgba(244, 63, 94, 0.3)",
              fontWeight: 600,
              fontSize: "12px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "5px",
              cursor: "pointer",
            }}
          >
            <X size={14} /> Deny
          </button>

          <button
            id="approve-button"
            onClick={() => onApprove(task.id)}
            style={{
              padding: "11px 12px",
              borderRadius: "8px",
              background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
              color: "#ffffff",
              boxShadow: "0 0 15px rgba(16, 185, 129, 0.4)",
              fontWeight: 600,
              fontSize: "12px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "5px",
              cursor: "pointer",
            }}
          >
            <Check size={14} /> Approve once
          </button>
        </div>
      </div>
    </div>
  );
};
