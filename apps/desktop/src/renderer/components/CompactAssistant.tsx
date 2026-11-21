import React, { useEffect, useRef, useState } from "react";
import type { ConversationState } from "@vanessa/protocol/conversation";
import { Check, ChevronDown, CircleStop, Ellipsis, Loader2, Mic, MicOff, ShieldCheck, VolumeX, X } from "lucide-react";
import type { Plan, Task } from "@vanessa/shared";
import type { MicrophoneTestState, SpeechOutputTestState, ProviderStatus, VoiceProviderStatus } from "../hooks/useAudioCapture.js";
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
  tasks: Task[];
  pendingApproval: Task | null;
  providerStatus: VoiceProviderStatus | null;
  voiceConnectionState: "connecting" | "connected" | "disconnected" | "disabled";
  wakeWordActive: boolean;
  microphoneTestState: MicrophoneTestState;
  microphoneTestMessage: string;
  onTestMicrophone: () => void;
  speechOutputTestState: SpeechOutputTestState;
  speechOutputTestMessage: string;
  onTestSpeechOutput: () => void;
  isMicActive: boolean;
  audioLevel: number;
  currentRequestId: string | null;
  currentTaskId: string | null;
  conversationState: ConversationState;
  onOrbClick: () => void;
  onExpand: () => void;
  onCollapse: () => void;
  onDockCorner: (corner: DockCorner) => void;
  onStop: () => void;
  onStopSpeech: () => void;
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
  cancelling: "Cancelling",
  termination_unconfirmed: "Stop unconfirmed",
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
  tasks,
  pendingApproval,
  providerStatus,
  voiceConnectionState,
  wakeWordActive,
  microphoneTestState,
  microphoneTestMessage,
  onTestMicrophone,
  speechOutputTestState,
  speechOutputTestMessage,
  onTestSpeechOutput,
  isMicActive,
  audioLevel,
  currentRequestId,
  currentTaskId,
  conversationState,
  onOrbClick,
  onExpand,
  onCollapse,
  onDockCorner,
  onStop,
  onStopSpeech,
  onTypedCommandChange,
  onExecute,
  onApprove,
  onReject,
}: CompactAssistantProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const conversationScrollRef = useRef<HTMLDivElement | null>(null);
  const followConversationRef = useRef(true);

  useEffect(() => {
    const node = conversationScrollRef.current;
    if (!node) return;
    if (followConversationRef.current) {
      node.scrollTop = node.scrollHeight;
      setHasNewMessages(false);
    } else {
      setHasNewMessages(true);
    }
  }, [conversationState.turns]);
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

  const recentTasks = tasks.slice(-4).reverse();
  const taskPresentation = (task: Task) => {
    const status = String(task.status);
    if ((status === "success" || status === "succeeded") && task.verification?.verified === true) {
      return { label: "Verified", proof: "Postconditions checked", tone: "verified" };
    }
    if (status === "awaiting_approval") {
      return { label: "Approval", proof: "Waiting for your decision", tone: "approval" };
    }
    if (["failed", "cancelled", "blocked", "expired"].includes(status)) {
      return {
        label: status === "cancelled" ? "Stopped" : status === "blocked" ? "Blocked" : "Failed",
        proof: task.verification?.outcome === "blocked" ? "Stopped by policy" : "Did not complete",
        tone: "failed",
      };
    }
    if (status === "partial" || status === "success" || status === "succeeded") {
      return { label: "Unverified", proof: "Completion evidence is incomplete", tone: "partial" };
    }
    return { label: "Working", proof: "Execution in progress", tone: "working" };
  };

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
            <div className="menu-title">Microphone check</div>
            <div className="mic-test-row">
              <span>Input test</span>
              <span className={`mic-test-badge mic-test-${microphoneTestState}`}>
                {microphoneTestState === "testing" ? "Testing…" : microphoneTestState === "passed" ? "Signal detected" : microphoneTestState === "silent" ? "No signal" : microphoneTestState === "error" ? "Needs attention" : "Not tested"}
              </span>
            </div>
            <button
              className="menu-action"
              onClick={onTestMicrophone}
              disabled={microphoneTestState === "testing"}
              aria-busy={microphoneTestState === "testing"}
            >
              {microphoneTestState === "testing" ? "Testing microphone…" : "Test microphone"}
            </button>
            {microphoneTestMessage && <p className={`mic-test-message mic-test-${microphoneTestState}`}>{microphoneTestMessage}</p>}
            <div className="menu-divider" />
            <div className="menu-title">Local speech fallback</div>
            <div className="mic-test-row">
              <span>Speech playback</span>
              <span className={`mic-test-badge mic-test-${speechOutputTestState}`}>
                {speechOutputTestState === "testing" ? "Playing…" : speechOutputTestState === "finished" ? "Playback ended" : speechOutputTestState === "error" ? "Needs attention" : "Not tested"}
              </span>
            </div>
            <button className="menu-action" onClick={onTestSpeechOutput}>
              {speechOutputTestState === "testing" ? "Restart speech test" : "Test local speech"}
            </button>
            {speechOutputTestMessage && <p className={`mic-test-message mic-test-${speechOutputTestState}`}>{speechOutputTestMessage}</p>}
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

        {conversationState.turns.length > 0 && (
          <section className="conversation-panel" aria-label="Conversation history">
            <div className="conversation-heading">
              <span>Conversation</span>
              <span>{conversationState.turns.length} turns</span>
            </div>
            <div
              ref={conversationScrollRef}
              className="conversation-history"
              role="log"
              aria-label="Conversation messages"
              aria-live="polite"
              aria-relevant="additions text"
              onScroll={(event) => {
                const node = event.currentTarget;
                const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
                followConversationRef.current = atBottom;
                if (atBottom) setHasNewMessages(false);
              }}
            >
              {conversationState.turns.map((turn) => (
                <article
                  className={`conversation-message message-${turn.role} ${turn.status === "failed" ? "message-failed" : ""}`}
                  key={turn.turnId}
                  data-turn-id={turn.turnId}
                >
                  <span className="conversation-speaker">{turn.role === "user" ? "You" : "Vanessa"}</span>
                  <p>{turn.text || (turn.status === "responding" ? "Preparing a response…" : "No message content was returned.")}</p>
                  {turn.status === "failed" && <span className="conversation-state">Response failed</span>}
                </article>
              ))}
            </div>
            {hasNewMessages && (
              <button
                className="conversation-latest no-drag"
                onClick={() => {
                  const node = conversationScrollRef.current;
                  if (node) node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
                  followConversationRef.current = true;
                  setHasNewMessages(false);
                }}
              >
                New messages · Jump to latest
              </button>
            )}
          </section>
        )}

        {isBusy && ["accepted", "planning", "executing", "verifying"].includes(taskStage) && (
          <div className="progress-steps" aria-label="Task progress">
            {(["accepted", "planning", "executing", "verifying"] as TaskStage[]).map((stage) => {
              const current = ["accepted", "planning", "executing", "verifying"].indexOf(taskStage);
              const index = ["accepted", "planning", "executing", "verifying"].indexOf(stage);
              return <span key={stage} className={index <= current ? "step-done" : ""}>{index < current ? <Check size={11} /> : <i />}{stageLabels[stage]}</span>;
            })}
          </div>
        )}

        {recentTasks.length > 0 && (
          <section className="execution-feed" aria-label="Recent execution activity">
            <div className="execution-feed-heading">
              <span>Recent execution</span>
              <span>{recentTasks.length} task{recentTasks.length === 1 ? "" : "s"}</span>
            </div>
            <div className="execution-feed-list">
              {recentTasks.map((task) => {
                const presentation = taskPresentation(task);
                return (
                  <article className={`execution-row execution-${presentation.tone}`} key={task.id}>
                    <span className="execution-marker" aria-hidden="true" />
                    <div className="execution-copy">
                      <strong>{task.action.replace(/[._]/g, " ")}</strong>
                      <span>{task.agent.toUpperCase()} · {presentation.proof}</span>
                    </div>
                    <span className={`execution-state state-${presentation.tone}`}>{presentation.label}</span>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {pendingApproval && (
          <div className="approval-card">
            <div className="approval-heading"><ShieldCheck size={16} /><span>Approval needed</span></div>
            <strong>{pendingApproval.action}</strong>
            <p>{pendingApproval.spokenSummary || pendingApproval.acceptanceCriteria?.[0] || "Vanessa is ready to perform this action."}</p>
            <div className="approval-actions no-drag">
              <button className="button button-primary" onClick={() => onApprove(pendingApproval.id)} disabled={taskStage === "cancelling" || taskStage === "termination_unconfirmed"}><Check size={14} /> Allow</button>
              <button className="button button-quiet" onClick={() => onReject(pendingApproval.id)} disabled={taskStage === "cancelling" || taskStage === "termination_unconfirmed"}><X size={14} /> Decline</button>
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
          {isSpeaking && <button className="button button-quiet" onClick={onStopSpeech} aria-label="Stop speaking"><VolumeX size={15} /> Stop speaking</button>}
          {taskBusy
            ? <button className="stop-button" onClick={onStop} disabled={taskStage === "cancelling"}>
                <CircleStop size={16} /> {taskStage === "cancelling" ? "Cancelling…" : taskStage === "termination_unconfirmed" ? "Retry cancel" : "Cancel task"}
              </button>
            : <button className="send-button" onClick={onExecute} aria-label="Send request" disabled={voiceBusy}>Send</button>}
        </div>
        <div className="footer-hint">
          <span>{voiceConnectionState === "disabled" ? "Text-only mode · typed commands available" : voiceConnectionState !== "connected" ? (voiceConnectionState === "connecting" ? "Connecting to voice service…" : "Voice service offline; reconnecting") : wakeWordActive ? "Wake-word listener active · say Hey Vanessa" : voiceState === "error" ? "Voice service needs attention" : "Alt + Space to talk"}</span>
          {taskStage === "completed" && <span className="verified"><Check size={12} /> Verified</span>}
          {isBusy && taskStage === "planning" && <Loader2 size={13} className="spin" />}
        </div>
      </footer>
    </section>
  );
}
