import React, { useState, useEffect } from "react";
import { Database, Clock, Search, ShieldCheck, RefreshCw, Sparkles, Brain } from "lucide-react";

interface MemoryRecord {
  id: string;
  type: string;
  title: string;
  content: string;
  agent: string;
  status: string;
  createdAt: number;
  expiresAt: number;
}

export const MemoryPalaceViewer: React.FC = () => {
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const fetchMemories = async () => {
    setIsLoading(true);
    try {
      const res = await fetch("http://127.0.0.1:4139/api/memory");
      if (res.ok) {
        const data = await res.json();
        setMemories(data);
      }
    } catch (err) {
      console.error("Failed to fetch memories:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchMemories();
    const interval = setInterval(fetchMemories, 10000);
    return () => clearInterval(interval);
  }, []);

  const filtered = memories.filter((m) =>
    m.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
    m.content.toLowerCase().includes(searchTerm.toLowerCase()) ||
    m.agent.toLowerCase().includes(searchTerm.toLowerCase()) ||
    m.type.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const formatDaysLeft = (expiresAt: number) => {
    const msLeft = expiresAt - Date.now();
    const days = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
    if (days <= 0) return "Expiring soon";
    return `${days}d retention remaining`;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: "10px" }}>
      {/* Search & Refresh Bar */}
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            gap: "8px",
            background: "rgba(255, 255, 255, 0.04)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "8px",
            padding: "6px 10px",
          }}
        >
          <Search size={14} color="var(--text-muted)" />
          <input
            type="text"
            placeholder="Search 30-day memories & incidents..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-main)",
              fontSize: "12px",
              outline: "none",
              width: "100%",
            }}
          />
        </div>
        <button
          onClick={fetchMemories}
          title="Refresh Memory Palace"
          style={{
            background: "rgba(255, 255, 255, 0.05)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "8px",
            padding: "7px 10px",
            color: "var(--text-muted)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
          }}
        >
          <RefreshCw size={13} className={isLoading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* Retention Policy Banner */}
      <div
        style={{
          background: "rgba(0, 242, 254, 0.05)",
          border: "1px solid rgba(0, 242, 254, 0.2)",
          borderRadius: "8px",
          padding: "8px 12px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: "11px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "var(--cyan-glow)" }}>
          <Brain size={13} />
          <span>Local SQLite Memory Palace: <strong>30-Day Retention Active</strong></span>
        </div>
        <span style={{ color: "var(--text-muted)", fontSize: "10px" }}>Immutable Ledger</span>
      </div>

      {/* Memory List */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          paddingRight: "4px",
        }}
      >
        {filtered.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "30px 10px",
              color: "var(--text-muted)",
              fontSize: "12px",
            }}
          >
            No records found. Executed plans and knowledge are automatically stored here for 30 days.
          </div>
        ) : (
          filtered.map((mem) => (
            <div
              key={mem.id}
              style={{
                background: "rgba(18, 22, 33, 0.6)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "8px",
                padding: "10px 12px",
                display: "flex",
                flexDirection: "column",
                gap: "4px",
                fontSize: "12px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 600, color: "#fff" }}>{mem.title}</span>
                <span
                  style={{
                    fontSize: "10px",
                    color: "var(--cyan-glow)",
                    background: "rgba(0, 242, 254, 0.08)",
                    padding: "2px 6px",
                    borderRadius: "4px",
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                  }}
                >
                  <Clock size={10} />
                  {formatDaysLeft(mem.expiresAt)}
                </span>
              </div>
              <p style={{ color: "var(--text-muted)", fontSize: "11px", margin: 0 }}>
                {mem.content}
              </p>
              <div
                style={{
                  display: "flex",
                  gap: "10px",
                  fontSize: "10px",
                  color: "var(--text-dim)",
                  marginTop: "2px",
                }}
              >
                <span>Agent: <strong>{mem.agent}</strong></span>
                <span>Type: <strong>{mem.type}</strong></span>
                <span>Created: <strong>{new Date(mem.createdAt).toLocaleDateString()}</strong></span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
