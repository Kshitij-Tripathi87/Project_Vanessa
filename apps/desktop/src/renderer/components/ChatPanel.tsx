import React from "react";
import { Mic, MicOff, Minus, Send, Settings, Sparkles, Waves } from "lucide-react";
import type { VoiceState } from "../stores/vanessaStore.js";
import type { WakeWordStatus } from "../hooks/useAudioCapture.js";

export interface ChatPanelProps {
  voiceState: VoiceState;
  isListening: boolean;
  wakeWordStatus: WakeWordStatus;
  micError?: string | null;
  command: string;
  setCommand: (value: string) => void;
  lastCommand: string;
  lastResponse: string;
  partialTranscript: string;
  corner: string;
  onSubmit: () => void;
  onToggleMic: () => void;
  onCollapse: () => void;
  onOpenDashboard: () => void;
}

export function ChatPanel({
  voiceState,
  isListening,
  wakeWordStatus,
  micError,
  command,
  setCommand,
  lastCommand,
  lastResponse,
  partialTranscript,
  corner,
  onSubmit,
  onToggleMic,
  onCollapse,
  onOpenDashboard,
}: ChatPanelProps) {
  const statusText = voiceState === "thinking" || voiceState === "executing"
    ? "Working on your request"
    : voiceState === "speaking"
      ? "Speaking"
      : isListening
        ? "Listening"
        : "Ready when you are";

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <section className="chat-panel" aria-label="Chat with Vanessa">
      <header className="chat-header drag-region">
        <div className="chat-brand">
          <span className={"chat-brand-orb " + (voiceState === "listening" ? "is-listening" : "")} aria-hidden="true" />
          <div>
            <div className="chat-brand-title">Vanessa</div>
            <div className="chat-brand-state">{statusText}</div>
          </div>
        </div>
        <div className="chat-header-actions no-drag">
          <button type="button" onClick={onOpenDashboard} title="Open control center" aria-label="Open control center">
            <Settings size={15} />
          </button>
          <button type="button" onClick={onCollapse} title={"Collapse to orb at " + corner} aria-label="Collapse to orb">
            <Minus size={17} />
          </button>
        </div>
      </header>

      <p className="chat-guidance">Start typing to chat, or say <strong>“Hey Vanessa”</strong> to activate.</p>

      <div className="chat-messages" role="log" aria-live="polite" aria-relevant="additions text">
        {!lastCommand && !lastResponse && !partialTranscript && (
          <div className="chat-empty-state">
            <div className="chat-empty-orb" aria-hidden="true"><Waves size={22} /></div>
            <strong>Ready when you are.</strong>
            <span>Ask Vanessa to search, open files, inspect a project, or run a task.</span>
          </div>
        )}
        {lastCommand && (
          <article className="chat-message chat-message-user">
            <span className="chat-message-label">YOU</span>
            <p>{lastCommand}</p>
          </article>
        )}
        {partialTranscript && isListening && (
          <article className="chat-message chat-message-live">
            <span className="chat-message-label">VOICE INPUT</span>
            <p>{partialTranscript}</p>
          </article>
        )}
        {lastResponse && (
          <article className="chat-message chat-message-assistant">
            <span className="chat-message-label"><Sparkles size={11} /> VANESSA</span>
            <p>{lastResponse}</p>
          </article>
        )}
      </div>

      <form className="chat-composer no-drag" onSubmit={handleSubmit}>
        <textarea
          autoFocus
          rows={2}
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (command.trim()) onSubmit();
            }
          }}
          placeholder="Message Vanessa…"
          aria-label="Message Vanessa"
        />
        <div className="chat-composer-actions">
          <button
            className={"chat-mic-button " + (isListening ? "is-active" : "")}
            type="button"
            onClick={onToggleMic}
            aria-pressed={isListening}
            title={isListening ? "Finish voice input" : "Speak to Vanessa"}
          >
            {isListening ? <Mic size={16} /> : <MicOff size={16} />}
            <span>{isListening ? "Listening…" : "Speak"}</span>
          </button>
          <button className="chat-send-button" type="submit" disabled={!command.trim()} aria-label="Send message" title="Send message">
            <Send size={16} />
          </button>
        </div>
      </form>

      <footer className="chat-footer">
        <span className={"wake-status-dot " + (wakeWordStatus.ready && wakeWordStatus.listening ? "is-ready" : "")} />
        <span className="wake-status-text">
          {wakeWordStatus.ready
            ? wakeWordStatus.listening ? (wakeWordStatus.keyword || "Hey Vanessa") + " is listening locally" : "Wake word ready"
            : "Click-to-chat is ready"}
        </span>
        {!wakeWordStatus.ready && wakeWordStatus.reason && (
          <span className="wake-status-detail" title={wakeWordStatus.reason}>Wake setup needed</span>
        )}
      </footer>
      {micError && <p className="chat-mic-error" role="status">{micError}</p>}
    </section>
  );
}
