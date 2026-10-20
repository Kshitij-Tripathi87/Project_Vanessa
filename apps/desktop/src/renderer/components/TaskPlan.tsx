import React from "react";
import { Plan, Task } from "@vanessa/shared";
import { TaskCard } from "./TaskCard.js";
import { Zap, ShieldCheck, Layers } from "lucide-react";

interface TaskPlanProps {
  plan: Plan | null;
}

export const TaskPlan: React.FC<TaskPlanProps> = ({ plan }) => {
  if (!plan) {
    return (
      <div
        className="glass-panel"
        style={{
          padding: "36px 24px",
          textAlign: "center",
          color: "var(--text-muted)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "12px",
        }}
      >
        <Layers size={32} color="var(--text-dim)" />
        <div style={{ fontSize: "15px", fontWeight: 500 }}>No Active Plan</div>
        <div style={{ fontSize: "13px", color: "var(--text-dim)", maxWidth: "340px" }}>
          Speak a command or type a task below. Vanessa will construct and execute a parallel agent plan.
        </div>
      </div>
    );
  }

  const runningCount = plan.tasks.filter((t: Task) => t.status === "running").length;
  const completedCount = plan.tasks.filter((t: Task) => t.status === "success").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Plan Header */}
      <div
        className="glass-panel"
        style={{
          padding: "16px 20px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: "linear-gradient(135deg, rgba(20, 26, 42, 0.7) 0%, rgba(13, 17, 28, 0.7) 100%)",
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <span style={{ fontSize: "11px", fontWeight: 700, color: "var(--cyan-glow)", fontFamily: "var(--font-mono)" }}>
              PLAN #{plan.id.slice(-6)}
            </span>
            <span
              style={{
                fontSize: "11px",
                padding: "1px 6px",
                borderRadius: "4px",
                background:
                  plan.risk === "high"
                    ? "rgba(244, 63, 94, 0.2)"
                    : plan.risk === "medium"
                    ? "rgba(245, 158, 11, 0.2)"
                    : "rgba(16, 185, 129, 0.2)",
                color:
                  plan.risk === "high" ? "#fda4af" : plan.risk === "medium" ? "#fcd34d" : "#6ee7b7",
                fontWeight: 600,
              }}
            >
              {plan.risk.toUpperCase()} RISK
            </span>
          </div>
          <div style={{ fontSize: "15px", fontWeight: 600, color: "#ffffff" }}>
            "{plan.command}"
          </div>
        </div>

        {/* Parallel execution stats badge */}
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "12px",
              color: runningCount > 0 ? "var(--cyan-glow)" : "var(--text-muted)",
              background: "rgba(0, 242, 254, 0.08)",
              padding: "6px 12px",
              borderRadius: "8px",
              border: "1px solid rgba(0, 242, 254, 0.15)",
            }}
          >
            <Zap size={14} />
            <span>
              {runningCount > 0 ? `${runningCount} Running in Parallel` : `${completedCount}/${plan.tasks.length} Completed`}
            </span>
          </div>
        </div>
      </div>

      {/* Task Cards Grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: "12px",
        }}
      >
        {plan.tasks.map((task: Task) => (
          <TaskCard key={task.id} task={task} />
        ))}
      </div>
    </div>
  );
};
