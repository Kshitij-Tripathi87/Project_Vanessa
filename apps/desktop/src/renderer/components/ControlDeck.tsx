import React, { useState } from "react";
import { Activity, ArrowUpRight, Bluetooth, CheckCircle2, CircleAlert, Eye, Globe, HardDrive, LoaderCircle, Monitor, RefreshCw, Search, ShieldCheck, Sun, Volume2, Wifi, XCircle } from "lucide-react";
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
  { title: "Open Chrome", description: "Launch Chrome", command: "Open Chrome", icon: Globe },
  { title: "Open Edge", description: "Launch Microsoft Edge", command: "Open Edge", icon: Globe },
  { title: "Check Wi-Fi", description: "Read the adapter's current state", command: "Check my Wi-Fi adapter status", icon: Wifi },
  { title: "Enable Bluetooth", description: "Request the radio state change and verify it", command: "Turn Bluetooth on", icon: Bluetooth },
  { title: "Disable Bluetooth", description: "Request the radio state change and verify it", command: "Turn Bluetooth off", icon: Bluetooth },
  { title: "Inspect active window", description: "List accessible controls without reading input values", command: "Inspect the active window", icon: Eye },
  { title: "Capture desktop", description: "Save a screenshot of the primary display", command: "Capture a screenshot of my desktop", icon: Monitor },
];

export function ControlDeck({ status, statusLoading, statusError, tasks, onRefresh, onExecute }: ControlDeckProps) {
  const [url, setUrl] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [formError, setFormError] = useState("");
  const [browserTarget, setBrowserTarget] = useState<"default" | "chrome" | "edge">("default");
  const [volumeTarget, setVolumeTarget] = useState(50);
  const [brightnessTarget, setBrightnessTarget] = useState(60);

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
    onExecute(browserTarget === "default" ? "Open " + parsed.toString() : "Open " + (browserTarget === "chrome" ? "Chrome" : "Edge") + " and open " + parsed.toString());
    setUrl("");
  };

  const runSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = searchQuery.trim();
    if (!query) return;
    onExecute(browserTarget === "default" ? "Search Google for " + query : "Open " + (browserTarget === "chrome" ? "Chrome" : "Edge") + " and search Google for " + query);
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
          <div className="control-browser-target no-drag">
            <label htmlFor="control-browser-target">Open/search using</label>
            <select
              id="control-browser-target"
              value={browserTarget}
              onChange={(event) => setBrowserTarget(event.target.value as "default" | "chrome" | "edge")}
            >
              <option value="default">System default browser</option>
              <option value="chrome">Google Chrome</option>
              <option value="edge">Microsoft Edge</option>
            </select>
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
          <div className="control-adjusters">
            <div className="control-adjuster">
              <div className="control-adjuster-heading">
                <span className="control-adjuster-icon"><Volume2 size={15} /></span>
                <label htmlFor="control-volume-target">Master volume target <strong>{volumeTarget}%</strong></label>
              </div>
              <input id="control-volume-target" className="control-range no-drag" type="range" min="0" max="100" step="5" value={volumeTarget} onChange={(event) => setVolumeTarget(Number(event.target.value))} />
              <div className="control-range-labels"><span>Mute</span><span>Maximum</span></div>
              <button className="control-apply-button no-drag" type="button" onClick={() => onExecute("Set system volume to " + volumeTarget + " percent")}>Apply volume target</button>
            </div>
            <div className="control-adjuster">
              <div className="control-adjuster-heading">
                <span className="control-adjuster-icon"><Sun size={15} /></span>
                <label htmlFor="control-brightness-target">Display brightness target <strong>{brightnessTarget}%</strong></label>
              </div>
              <input id="control-brightness-target" className="control-range no-drag" type="range" min="0" max="100" step="5" value={brightnessTarget} onChange={(event) => setBrightnessTarget(Number(event.target.value))} />
              <div className="control-range-labels"><span>Dimmest</span><span>Brightest</span></div>
              <button className="control-apply-button no-drag" type="button" onClick={() => onExecute("Set display brightness to " + brightnessTarget + " percent")}>Apply brightness target</button>
            </div>
            <p className="control-adjuster-note">These are requested target values, not live readings. Vanessa reports success only when Windows reads back the requested state; some external displays do not expose WMI brightness control.</p>
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
