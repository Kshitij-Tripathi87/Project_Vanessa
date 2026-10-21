import React from "react";
import { Task, AgentName } from "@vanessa/shared";
import { Cpu, Globe, Folder, Terminal, Cloud, CheckCircle2, Clock, AlertCircle, PlayCircle, XCircle, Database, Code2, Activity, BookOpen, ShieldCheck, Monitor } from "lucide-react";

interface TaskCardProps {
  task: Task;
}

const AGENT_CONFIG: Record<
  AgentName,
  { label: string; color: string; bg: string; icon: React.ReactNode }
> = {
  system: {
    label: "SYSTEM",
    color: "#38bdf8",
    bg: "rgba(56, 189, 248, 0.12)",
    icon: <Cpu size={14} />,
  },
  windows: {
    label: "WINDOWS",
    color: "#38bdf8",
    bg: "rgba(56, 189, 248, 0.12)",
    icon: <Monitor size={14} />,
  },
  browser: {
    label: "BROWSER",
    color: "#f472b6",
    bg: "rgba(244, 114, 182, 0.12)",
    icon: <Globe size={14} />,
  },
  files: {
    label: "FILES",
    color: "#fbbf24",
    bg: "rgba(251, 191, 36, 0.12)",
    icon: <Folder size={14} />,
  },
  developer: {
    label: "DEV",
    color: "#34d399",
    bg: "rgba(52, 211, 153, 0.12)",
    icon: <Terminal size={14} />,
  },
  coding: {
    label: "CODING",
    color: "#10b981",
    bg: "rgba(16, 185, 129, 0.15)",
    icon: <Code2 size={14} />,
  },
  it_ops: {
    label: "IT OPS",
    color: "#f97316",
    bg: "rgba(249, 115, 22, 0.15)",
    icon: <Activity size={14} />,
  },
  memory: {
    label: "MEMORY",
    color: "#a855f7",
    bg: "rgba(168, 85, 247, 0.15)",
    icon: <Database size={14} />,
  },
  knowledge: {
    label: "KNOWLEDGE",
    color: "#06b6d4",
    bg: "rgba(6, 182, 212, 0.15)",
    icon: <BookOpen size={14} />,
  },
  testing: {
    label: "TESTING",
    color: "#84cc16",
    bg: "rgba(132, 204, 22, 0.15)",
    icon: <ShieldCheck size={14} />,
  },
  cloud: {
    label: "CLOUD",
    color: "#a78bfa",
    bg: "rgba(167, 139, 250, 0.12)",
    icon: <Cloud size={14} />,
  },
  vanessa: {
    label: "VANESSA",
    color: "#00f2fe",
    bg: "rgba(0, 242, 254, 0.15)",
    icon: <Cpu size={14} />,
  },
  jarvis: {
    label: "VANESSA",
    color: "#00f2fe",
    bg: "rgba(0, 242, 254, 0.15)",
    icon: <Cpu size={14} />,
  },
  openjarvis: {
    label: "VANESSA",
    color: "#00f2fe",
    bg: "rgba(0, 242, 254, 0.15)",
    icon: <Cpu size={14} />,
  },
  incident: {
    label: "INCIDENT",
    color: "#f59e0b",
    bg: "rgba(245, 158, 11, 0.15)",
    icon: <Terminal size={14} />,
  },
};

export const TaskCard: React.FC<TaskCardProps> = ({ task }) => {
  const agentInfo = AGENT_CONFIG[task.agent] || AGENT_CONFIG.system;

  const renderStatus = () => {
    switch (task.status) {
      case "success":
        return (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", color: "#10b981", fontSize: "12px", fontWeight: 500 }}>
            <CheckCircle2 size={13} /> Completed
          </span>
        );
      case "running":
        return (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", color: "#38bdf8", fontSize: "12px", fontWeight: 500 }}>
            <PlayCircle size={13} style={{ animation: "pulse 1.5s infinite" }} /> Running
          </span>
        );
      case "awaiting_approval":
        return (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", color: "#f59e0b", fontSize: "12px", fontWeight: 500 }}>
            <AlertCircle size={13} /> Needs Approval
          </span>
        );
      case "failed":
        return (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", color: "#f43f5e", fontSize: "12px", fontWeight: 500 }}>
            <XCircle size={13} /> Failed
          </span>
        );
      case "partial":
      case "blocked":
      case "expired":
        return (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", color: "#fbbf24", fontSize: "12px", fontWeight: 500 }}>
            <AlertCircle size={13} /> Unverified
          </span>
        );
      case "cancelled":
        return (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", color: "#64748b", fontSize: "12px", fontWeight: 500 }}>
            Cancelled
          </span>
        );
      default:
        return (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", color: "#94a3b8", fontSize: "12px", fontWeight: 500 }}>
            <Clock size={13} /> Pending
          </span>
        );
    }
  };

  return (
    <div
      className="glass-panel"
      style={{
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        borderLeft: `3px solid ${agentInfo.color}`,
        background: "rgba(15, 20, 31, 0.65)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        {/* Agent badge */}
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            background: agentInfo.bg,
            color: agentInfo.color,
            padding: "3px 8px",
            borderRadius: "6px",
            fontSize: "11px",
            fontFamily: "var(--font-mono)",
            fontWeight: 600,
          }}
        >
          {agentInfo.icon}
          {agentInfo.label}
        </div>

        {/* Task status */}
        {renderStatus()}
      </div>

      {/* Action Title */}
      <div>
        <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-main)", letterSpacing: "0.01em" }}>
          {task.action}
        </div>
        <div style={{ fontSize: "11px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginTop: "2px" }}>
          ID: {task.id}
          {task.dependsOn.length > 0 && ` • Waits for: [${task.dependsOn.join(", ")}]`}
        </div>
      </div>

      {/* Result or Error preview */}
      {task.result && (
        <div
          style={{
            padding: "6px 10px",
            borderRadius: "6px",
            background: "rgba(16, 185, 129, 0.08)",
            border: "1px solid rgba(16, 185, 129, 0.2)",
            fontSize: "12px",
            color: "#6ee7b7",
            fontFamily: "var(--font-mono)",
          }}
        >
          {typeof task.result === "string"
            ? task.result
            : task.result.output || task.result.status || task.result.shareLink || JSON.stringify(task.result)}
        </div>
      )}

      {task.error && (
        <div
          style={{
            padding: "6px 10px",
            borderRadius: "6px",
            background: "rgba(244, 63, 94, 0.08)",
            border: "1px solid rgba(244, 63, 94, 0.2)",
            fontSize: "12px",
            color: "#fda4af",
            fontFamily: "var(--font-mono)",
          }}
        >
          {task.error}
        </div>
      )}

      {task.verification && (
        <div style={{ fontSize: "11px", color: task.verification.verified ? "#6ee7b7" : "#fbbf24" }}>
          {task.verification.verified ? "Verified" : "Not verified"}: {task.verification.details || task.verification.postconditions.join("; ")}
        </div>
      )}

      {task.evidence && task.evidence.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", color: "var(--text-muted)" }}>
          {task.evidence.slice(0, 3).map((item, index) => (
            <div key={`${item.source || "evidence"}-${index}`}>
              Evidence{item.source ? ` · ${item.source}` : ""}: {item.description}
            </div>
          ))}
          {task.evidence.length > 3 && <div>+{task.evidence.length - 3} more evidence item(s)</div>}
        </div>
      )}
    </div>
  );
};
