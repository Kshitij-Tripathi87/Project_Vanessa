import React, { useState } from "react";
import { Activity, ArrowUpRight, Bluetooth, CheckCircle2, CircleAlert, Globe, HardDrive, LoaderCircle, Monitor, RefreshCw, Search, ShieldCheck, Wifi, XCircle } from "lucide-react";
import type { Task } from "@vanessa/shared";
import { TaskCard } from "./TaskCard.js";

interface ControlDeckProps {
  status: VanessaControlStatus | null;
  statusLoading: boolean;
  statusError: string | null;
  tasks: Task[];
  onRefresh: () => void;
  onExecute: (command: string) => void;
}

const quickActions = [
  { title: "Open File Explorer", description: "Bring up folders and files", command: "Open File Explorer", icon: HardDrive },
  { title: "Open Chrome", description: "Launch the installed browser", command: "Open Chrome", icon: Globe },
  { title: "Check Wi-Fi", description: "Read the adapter's current state", command: "Check my Wi-Fi adapter status", icon: Wifi },
  { title: "Enable Bluetooth", description: "Request the radio state change and verify it", command: "Turn Bluetooth on", icon: Bluetooth },
  { title: "Capture desktop", description: "Save a screenshot of the primary display", command: "Capture a screenshot of my desktop", icon: Monitor },
];

export function ControlDeck({ status, statusLoading, statusError, tasks, onRefresh, onExecute }: ControlDeckProps) {
  const [url, setUrl] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [formError, setFormError] = useState("");

  const runUrl = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError("");
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      setFormError("Enter a complete URL, including https://.");
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      setFormError("Only HTTP and HTTPS URLs can be opened.");
      return;
    }
    if (parsed.username || parsed.password) {
      setFormError("URLs containing embedded credentials are not accepted.");
      return;
    }
    onExecute("Open this URL in my default browser: " + parsed.toString());
    setUrl("");
  };

  const runSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = searchQuery.trim();
    if (!query) return;
    onExecute("Search Google for " + query);
    setSearchQuery("");
  };

  const recentTasks = tasks
    .filter((task) => ["windows", "system", "browser"].includes(task.agent))
    .slice()
    .reverse()
    .slice(0, 4);

  const online = status?.orchestratorOnline === true;
  const policyLabel = status?.autonomousMode === true
    ? "Autonomy enabled"
    : status?.autonomousMode === false
      ? "Approval gates active"
      : "Policy status unavailable";

  return (
    <section className="control-deck" aria-label="Windows and browser controls">
      <header className="control-deck-hero">
        <div className="control-deck-hero-copy">
          <div className="control-deck-eyebrow"><span className="control-deck-live-dot" /> VANESSA CONTROL SYSTEMS</div>
          <h2>Windows &amp; Browser</h2>
          <p>Control the computer, open destinations, and track what Vanessa actually managed to do.</p>
        </div>
        <button type="button" className="control-refresh-button no-drag" onClick={onRefresh} disabled={statusLoading} title="Refresh system status">
          {statusLoading ? <LoaderCircle size={15} className="control-spin" /> : <RefreshCw size={15} />}
          <span>{statusLoading ? "Checking" : "Refresh status"}</span>
        </button>
      </header>

      <div className="control-status-grid">
        <article className="control-status-card">
          <div className="control-status-icon"><Activity size={17} /></div>
          <div className="control-status-label">ORCHESTRATOR</div>
          <div className={"control-status-value " + (online ? "is-online" : "is-offline")}>
            <span className={"control-status-dot " + (online ? "is-online" : "is-offline")} />
            {statusLoading && !status ? "Checking…" : online ? "Online" : "Offline"}
          </div>
          <div className="control-status-detail">{status?.orchestratorPort ? "Loopback · port " + status.orchestratorPort : "Local service status unavailable"}</div>
        </article>
        <article className="control-status-card">
          <div className="control-status-icon"><Monitor size={17} /></div>
          <div className="control-status-label">DEVICE</div>
          <div className="control-status-value">{status?.platform === "win32" ? "Windows" : status?.platform || "Unknown"}</div>
          <div className="control-status-detail">{status ? status.activeTasksCount + " active task(s)" : "Task count unavailable"}</div>
        </article>
        <article className="control-status-card">
          <div className="control-status-icon"><ShieldCheck size={17} /></div>
          <div className="control-status-label">EXECUTION POLICY</div>
          <div className={"control-status-value " + (status?.autonomousMode === true ? "is-caution" : status?.autonomousMode === false ? "is-online" : "")}>{policyLabel}</div>
          <div className="control-status-detail">Sensitive actions still follow backend policy</div>
        </article>
      </div>

      {(statusError || status?.errors?.length) && (
        <div className="control-inline-warning" role="status">
          <CircleAlert size={15} />
          <span>{statusError || status?.errors?.join(" · ")}</span>
        </div>
      )}

      <div className="control-main-grid">
        <article className="control-panel">
          <div className="control-panel-heading">
            <span className="control-panel-icon browser-icon"><Globe size={17} /></span>
            <div><h3>Open a destination</h3><p>Use your system default browser</p></div>
          </div>
          <form className="control-form no-drag" onSubmit={runUrl}>
            <label htmlFor="control-url">Website URL</label>
            <div className="control-input-row">
              <input id="control-url" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com" />
              <button type="submit" disabled={!url.trim()} aria-label="Open URL" title="Open URL"><ArrowUpRight size={16} /></button>
            </div>
          </form>
          <form className="control-form no-drag" onSubmit={runSearch}>
            <label htmlFor="control-search">Search the web</label>
            <div className="control-input-row">
              <input id="control-search" type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search for anything…" />
              <button type="submit" disabled={!searchQuery.trim()} aria-label="Search the web" title="Search"><Search size={16} /></button>
            </div>
          </form>
          {formError && <p className="control-form-error" role="alert">{formError}</p>}
          <div className="control-note">
            <CheckCircle2 size={13} />
            <span>Opening a URL confirms the OS accepted the launch request; it does not prove the page finished loading.</span>
          </div>
        </article>

        <article className="control-panel">
          <div className="control-panel-heading">
            <span className="control-panel-icon windows-icon"><Monitor size={17} /></span>
            <div><h3>Windows quick actions</h3><p>Every command goes through Vanessa’s orchestrator</p></div>
          </div>
          <div className="control-quick-actions">
            {quickActions.map((item) => {
              const Icon = item.icon;
              return (
                <button className="control-quick-action no-drag" type="button" key={item.title} onClick={() => onExecute(item.command)}>
                  <span className="control-quick-icon"><Icon size={16} /></span>
                  <span className="control-quick-copy"><strong>{item.title}</strong><small>{item.description}</small></span>
                  <ArrowUpRight className="control-quick-arrow" size={14} />
                </button>
              );
            })}
          </div>
        </article>
      </div>

      <article className="control-panel control-browser-note">
        <div className="control-panel-heading">
          <span className="control-panel-icon browser-icon"><Globe size={17} /></span>
          <div><h3>Two browser modes, by design</h3><p>Choose the right execution path for the task</p></div>
        </div>
        <div className="control-browser-modes">
          <div><strong>Default browser</strong><span>Opens URLs and search pages in the browser you use every day.</span></div>
          <div><strong>Vanessa automation session</strong><span>Playwright inspects rendered pages and performs approved interactions in its own browser context. It is not automatically signed in to your personal browser profile.</span></div>
        </div>
        <p className="control-security-footnote"><ShieldCheck size={13} /> Local/private destinations are blocked by default in remote browser navigation. Consequential browser interactions still require the relevant approval.</p>
      </article>

      <section className="control-recent-section">
        <div className="control-section-heading">
          <div><h3>Recent Windows &amp; Browser work</h3><p>Live task results and verification from Vanessa’s event stream</p></div>
          <span className="control-recent-count">{recentTasks.length} shown</span>
        </div>
        {recentTasks.length > 0 ? (
          <div className="control-task-list">
            {recentTasks.map((task) => <TaskCard key={task.id} task={task} />)}
          </div>
        ) : (
          <div className="control-empty-state">
            <XCircle size={18} />
            <div><strong>No Windows or browser tasks yet</strong><span>Launch a quick action or ask Vanessa in chat to see execution state and evidence here.</span></div>
          </div>
        )}
      </section>
      <footer className="control-deck-footer">
        <span>Last status check: {status?.checkedAt ? new Date(status.checkedAt).toLocaleTimeString() : "not checked"}</span>
        <span>Local control plane · no direct renderer-to-OS access</span>
      </footer>
    </section>
  );
}
