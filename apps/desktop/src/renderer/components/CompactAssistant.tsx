import React, { useState } from "react";
import { Check, ChevronDown, CircleStop, Ellipsis, Loader2, Mic, MicOff, ShieldCheck, X } from "lucide-react";
import type { Plan, Task } from "@vanessa/shared";
import type { ProviderStatus, VoiceProviderStatus } from "../hooks/useAudioCapture.js";
import type { TaskStage, VoiceState } from "../stores/vanessaStore.js";
import orbImage from "../assets/vanessa-orb.png";

type DockCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

interface CompactAssistantProps {
  expanded: boolean;
  dockCorner: DockCorner;
  voiceState: VoiceState;
  taskStage: TaskStage;
  progressMessage: string;
  partialTranscript: string;
  lastResponse: string;
  typedCommand: string;
  activePlan: Plan | null;
  activeTask: Task | null;
  pendingApproval: Task | null;
  providerStatus: VoiceProviderStatus | null;
  voiceConnectionState: "connecting" | "connected" | "disconnected" | "disabled";
  isMicActive: boolean;
  audioLevel: number;
  currentRequestId: string | null;
  currentTaskId: string | null;
  onOrbClick: () => void;
  onExpand: () => void;
  onCollapse: () => void;
  onDockCorner: (corner: DockCorner) => void;
  onStop: () => void;
  onTypedCommandChange: (value: string) => void;
  onExecute: () => void;
  onApprove: (taskId: string) => void;
  onReject: (taskId: string) => void;
}

const stageLabels: Record<TaskStage, string> = {
  idle: "Ready",
  accepted: "Received",
  planning: "Planning",
  executing: "Working",
  verifying: "Verifying",
  completed: "Completed",
  failed: "Needs attention",
  partial: "Partially completed",
  cancelled: "Stopped",
};

function providerLabel(provider: ProviderStatus | undefined) {
  if (!provider) return "Unknown";
  if (provider.state === "error") return "Unavailable";
  if (provider.state === "fallback") return "Fallback";
  return provider.active;
}

export function CompactAssistant({
  expanded,
  dockCorner,
  voiceState,
  taskStage,
  progressMessage,
  partialTranscript,
  lastResponse,
  typedCommand,
  activePlan,
  activeTask,
  pendingApproval,
  providerStatus,
  voiceConnectionState,
  isMicActive,
  audioLevel,
  currentRequestId,
  currentTaskId,
  onOrbClick,
  onExpand,
  onCollapse,
  onDockCorner,
  onStop,
  onTypedCommandChange,
  onExecute,
  onApprove,
  onReject,
}: CompactAssistantProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const taskBusy = taskStage !== "idle" && !["completed", "partial", "failed", "cancelled"].includes(taskStage);
  const voiceBusy = ["thinking", "executing", "responding", "speaking"].includes(voiceState);
  const isBusy = taskBusy || voiceBusy;
  const isListening = voiceState === "listening";
  const isSpeaking = voiceState === "speaking" || voiceState === "responding";
  const orbVoiceState = isListening
    ? "listening"
    : voiceState === "thinking"
      ? "thinking"
      : isSpeaking
        ? "speaking"
        : voiceState === "error"
          ? "failed"
          : voiceState === "interrupted"
            ? "cancelled"
            : taskStage === "accepted"
              ? "thinking"
              : taskStage;
  const orbScale = isMicActive ? 1 + Math.min(0.14, audioLevel * 0.3) : 1;

  if (!expanded) {
    return (
      <div className="orb-widget drag-region" title="Vanessa">
        <span className="orb-halo orb-halo-one" aria-hidden="true" />
        <span className="orb-halo orb-halo-two" aria-hidden="true" />
        <button
          className={`orb-button no-drag orb-${taskStage} orb-${orbVoiceState} voice-${voiceState}`}
          onClick={onOrbClick}
          aria-label={isListening ? "Finish speaking to Vanessa" : isSpeaking ? "Interrupt Vanessa and speak" : "Start speaking to Vanessa"}
          style={{ transform: `scale(${orbScale})` }}
        >
          <img src={orbImage} alt="Vanessa" />
          <span className="orb-status-dot" />
        </button>
        <button className="orb-expand no-drag" onClick={onExpand} aria-label="Open Vanessa panel">
          <ChevronDown size={11} />
        </button>
      </div>
    );
  }

  return (
    <section className="assistant-panel">
      <header className="assistant-header drag-region">
        <div className="assistant-identity">
          <div className="mini-orb"><img src={orbImage} alt="" /></div>
          <div>
            <strong className="wordmark"><span className="wordmark-dot" />Vanessa</strong>
            <span>Voice-native assistant</span>
          </div>
        </div>
        <div className="assistant-header-actions no-drag">
          <button className="icon-button" onClick={() => setMoreOpen((open) => !open)} aria-label="More options" aria-expanded={moreOpen}>
            <Ellipsis size={17} />
          </button>
          <button className="icon-button" onClick={onCollapse} aria-label="Collapse to orb">
            <ChevronDown size={17} />
          </button>
        </div>
        {moreOpen && (
          <div className="more-menu no-drag">
            <div className="menu-title">Connection</div>
            <div className="menu-row"><span>Voice service</span><span className={`status-inline connection-${voiceConnectionState}`}><i />{voiceConnectionState === "connected" ? "Connected" : voiceConnectionState === "connecting" ? "Connecting…" : voiceConnectionState === "disabled" ? "Text-only mode" : "Offline"}</span></div>
            <div className="menu-row"><span>Speech recognition</span><span>{providerLabel(providerStatus?.asr)}</span></div>
            <div className="menu-row"><span>Speech output</span><span>{providerLabel(providerStatus?.tts)}</span></div>
            <div className="menu-divider" />
            <div className="menu-title">Dock position</div>
            <div className="dock-options" role="group" aria-label="Dock Vanessa to a screen corner">
              {([
                ["top-left", "Top left"],
                ["top-right", "Top right"],
                ["bottom-left", "Bottom left"],
                ["bottom-right", "Bottom right"],
              ] as const).map(([corner, label]) => (
                <button
                  key={corner}
                  className={`dock-option ${dockCorner === corner ? "selected" : ""}`}
                  aria-pressed={dockCorner === corner}
                  onClick={() => { onDockCorner(corner); setMoreOpen(false); }}
                >{label}</button>
              ))}
            </div>
            <div className="menu-divider" />
            <button className="menu-action" onClick={() => setDetailsOpen((open) => !open)}>Task details</button>
          </div>
        )}
      </header>

      <div className="assistant-content">
        <div className={`assistant-status status-${taskStage}`}>
          <span className="status-kicker">{stageLabels[taskStage]}</span>
          <h1>{progressMessage}</h1>
          {partialTranscript ? <p className="transcript">“{partialTranscript}”</p> : lastResponse ? <p>{lastResponse}</p> : null}
        </div>

        {isBusy && (
          <div className="progress-steps" aria-label="Task progress">
            {(["accepted", "planning", "executing", "verifying"] as TaskStage[]).map((stage) => {
              const current = ["accepted", "planning", "executing", "verifying"].indexOf(taskStage);
              const index = ["accepted", "planning", "executing", "verifying"].indexOf(stage);
              return <span key={stage} className={index <= current ? "step-done" : ""}>{index < current ? <Check size={11} /> : <i />}{stageLabels[stage]}</span>;
            })}
          </div>
        )}

        {pendingApproval && (
          <div className="approval-card">
            <div className="approval-heading"><ShieldCheck size={16} /><span>Approval needed</span></div>
            <strong>{pendingApproval.action}</strong>
            <p>{pendingApproval.spokenSummary || pendingApproval.acceptanceCriteria?.[0] || "Vanessa is ready to perform this action."}</p>
            <div className="approval-actions no-drag">
              <button className="button button-primary" onClick={() => onApprove(pendingApproval.id)}><Check size={14} /> Allow</button>
              <button className="button button-quiet" onClick={() => onReject(pendingApproval.id)}><X size={14} /> Decline</button>
            </div>
          </div>
        )}

        {detailsOpen && (
          <div className="task-details">
            <div><span>Request</span><code>{currentRequestId || "—"}</code></div>
            <div><span>Task</span><code>{currentTaskId || activeTask?.id || "—"}</code></div>
            <div><span>Plan</span><code>{activePlan?.id || "—"}</code></div>
            {activeTask?.verification && <div><span>Verification</span><span>{activeTask.verification.verified ? "Passed" : "Not verified"}</span></div>}
          </div>
        )}
      </div>

      <footer className="assistant-footer no-drag">
        <div className="command-row">
          <button className={`talk-button ${isListening ? "talking" : ""}`} onClick={onOrbClick} aria-label={isListening ? "Finish speaking to Vanessa" : isSpeaking ? "Interrupt Vanessa and speak" : "Talk to Vanessa"}>
            {isListening ? <MicOff size={16} /> : <Mic size={16} />}
            <span>{isListening ? "Listening" : isSpeaking ? "Interrupt" : "Talk"}</span>
          </button>
          <input
            value={typedCommand}
            onChange={(event) => onTypedCommandChange(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && !isBusy) onExecute(); }}
            disabled={isBusy}
            placeholder={isBusy ? "Vanessa is working…" : "Type a request…"}
            aria-label="Type a request"
          />
          {isBusy ? <button className="stop-button" onClick={onStop}><CircleStop size={16} /> Stop</button> : <button className="send-button" onClick={onExecute} aria-label="Send request">Send</button>}
        </div>
        <div className="footer-hint">
          <span>{voiceConnectionState === "disabled" ? "Text-only mode · typed commands available" : voiceConnectionState !== "connected" ? (voiceConnectionState === "connecting" ? "Connecting to voice service…" : "Voice service offline; reconnecting") : voiceState === "error" ? "Voice service needs attention" : "Alt + Space to talk"}</span>
          {taskStage === "completed" && <span className="verified"><Check size={12} /> Verified</span>}
          {isBusy && taskStage === "planning" && <Loader2 size={13} className="spin" />}
        </div>
      </footer>
    </section>
  );
}
