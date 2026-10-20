import React from "react";
import { Mic, MicOff, Loader2, Volume2, ShieldAlert, Sparkles, AlertTriangle, HelpCircle, Heart, Zap } from "lucide-react";
import { VoiceState } from "../stores/vanessaStore.js";
import { SentimentData } from "../hooks/useAudioCapture.js";

interface VoiceOrbProps {
  state: VoiceState;
  isListening: boolean;
  audioLevel?: number;
  sentiment?: SentimentData | null;
  partialTranscript?: string;
  onToggleListen: () => void;
}

export const VoiceOrb: React.FC<VoiceOrbProps> = ({
  state,
  isListening,
  audioLevel = 0,
  sentiment,
  partialTranscript,
  onToggleListen,
}) => {
  const scale = isListening || state === "speaking" ? 1 + Math.min(0.35, audioLevel * 0.7) : 1;

  const getOrbStateClass = () => {
    switch (state) {
      case "listening":
        return "orb-listening";
      case "thinking":
        return "orb-thinking";
      case "executing":
        return "orb-listening";
      case "speaking":
        return "orb-listening";
      default:
        return "orb-idle";
    }
  };

  const getOrbBackground = () => {
    switch (state) {
      case "listening":
        return "radial-gradient(circle, #10b981 0%, #064e3b 80%)";
      case "thinking":
        return "radial-gradient(circle, #a855f7 0%, #3b0764 80%)";
      case "executing":
        return "radial-gradient(circle, #00f2fe 0%, #0369a1 80%)";
      case "speaking":
        return "radial-gradient(circle, #38bdf8 0%, #1e3a8a 80%)";
      case "error":
        return "radial-gradient(circle, #f43f5e 0%, #881337 80%)";
      default:
        return "radial-gradient(circle, #00f2fe 0%, #1e1b4b 80%)";
    }
  };

  const renderSentimentBadge = () => {
    if (!sentiment) return null;

    let badgeColor = "#10b981";
    let badgeBg = "rgba(16, 185, 129, 0.15)";
    let icon = <Sparkles size={12} />;
    let label = "Calm";

    if (sentiment.emotion === "urgent" || sentiment.urgency === "critical") {
      badgeColor = "#ef4444";
      badgeBg = "rgba(239, 68, 68, 0.2)";
      icon = <Zap size={12} />;
      label = `Urgent (${sentiment.urgency})`;
    } else if (sentiment.emotion === "frustrated") {
      badgeColor = "#f59e0b";
      badgeBg = "rgba(245, 158, 11, 0.2)";
      icon = <AlertTriangle size={12} />;
      label = "Frustrated / Direct";
    } else if (sentiment.emotion === "inquisitive") {
      badgeColor = "#38bdf8";
      badgeBg = "rgba(56, 189, 248, 0.2)";
      icon = <HelpCircle size={12} />;
      label = "Inquisitive";
    } else if (sentiment.emotion === "satisfied") {
      badgeColor = "#a855f7";
      badgeBg = "rgba(168, 85, 247, 0.2)";
      icon = <Heart size={12} />;
      label = "Satisfied";
    }

    return (
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "5px",
          padding: "3px 10px",
          borderRadius: "20px",
          background: badgeBg,
          border: `1px solid ${badgeColor}`,
          color: badgeColor,
          fontSize: "11px",
          fontWeight: 600,
          textTransform: "capitalize",
          marginBottom: "12px",
          animation: "fadeIn 0.3s ease-in-out",
        }}
      >
        {icon}
        <span>Tone: {label}</span>
      </div>
    );
  };

  return (
    <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center" }}>
      {/* Dynamic Sentiment Badge */}
      {renderSentimentBadge()}

      {/* Ripple ring modulated by real microphone audioLevel */}
      {(isListening || state === "speaking") && (
        <>
          <div
            className="ripple-effect"
            style={{
              position: "absolute",
              width: `${160 + audioLevel * 60}px`,
              height: `${160 + audioLevel * 60}px`,
              borderRadius: "50%",
              border: `2px solid ${isListening ? "rgba(16, 185, 129, 0.6)" : "rgba(56, 189, 248, 0.6)"}`,
              top: `${sentiment ? 20 : -10}px`,
              pointerEvents: "none",
              transition: "width 0.05s ease-out, height 0.05s ease-out",
            }}
          />
          {audioLevel > 0.15 && (
            <div
              style={{
                position: "absolute",
                width: `${190 + audioLevel * 90}px`,
                height: `${190 + audioLevel * 90}px`,
                borderRadius: "50%",
                border: `1px dashed ${isListening ? "rgba(16, 185, 129, 0.3)" : "rgba(56, 189, 248, 0.3)"}`,
                top: `${sentiment ? 5 : -25}px`,
                pointerEvents: "none",
                animation: "spin 8s linear infinite",
              }}
            />
          )}
        </>
      )}

      {/* Main Orb Button with dynamic scaling */}
      <button
        id="voice-orb-button"
        onClick={onToggleListen}
        className={getOrbStateClass()}
        style={{
          width: "140px",
          height: "140px",
          borderRadius: "50%",
          background: getOrbBackground(),
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          border: `2px solid ${isListening ? "rgba(16, 185, 129, 0.8)" : "rgba(255, 255, 255, 0.2)"}`,
          position: "relative",
          zIndex: 10,
          transform: `scale(${scale})`,
          transition: "transform 0.08s ease-out, background 0.3s ease",
          boxShadow: isListening
            ? `0 0 ${20 + audioLevel * 40}px rgba(16, 185, 129, 0.6)`
            : state === "speaking"
            ? "0 0 30px rgba(56, 189, 248, 0.6)"
            : "0 0 20px rgba(0, 242, 254, 0.3)",
          cursor: "pointer",
        }}
        title="Click to toggle voice (Alt+Space)"
      >
        {state === "thinking" ? (
          <Loader2 size={36} color="#ffffff" style={{ animation: "spin 1s linear infinite" }} />
        ) : state === "speaking" ? (
          <Volume2 size={36} color="#ffffff" />
        ) : state === "error" ? (
          <ShieldAlert size={36} color="#ffffff" />
        ) : isListening ? (
          <Mic size={38} color="#ffffff" />
        ) : (
          <MicOff size={34} color="rgba(255,255,255,0.7)" />
        )}

        <span
          style={{
            fontSize: "11px",
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            marginTop: "6px",
            color: "#ffffff",
          }}
        >
          {isListening ? "Listening" : state}
        </span>
      </button>

      {/* Live partial transcription streaming bubble */}
      {partialTranscript && (
        <div
          style={{
            marginTop: "16px",
            maxWidth: "360px",
            padding: "8px 14px",
            borderRadius: "12px",
            background: "rgba(15, 23, 42, 0.85)",
            border: "1px solid rgba(0, 242, 254, 0.3)",
            backdropFilter: "blur(8px)",
            color: "#e2e8f0",
            fontSize: "13px",
            textAlign: "center",
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
            lineHeight: 1.4,
          }}
        >
          <span style={{ color: "#38bdf8", marginRight: "6px" }}>🎙️</span>
          &ldquo;{partialTranscript}&rdquo;
        </div>
      )}

      {/* Shortcut hint */}
      <div
        style={{
          marginTop: "12px",
          fontSize: "12px",
          color: "var(--text-muted)",
          display: "flex",
          alignItems: "center",
          gap: "6px",
        }}
      >
        <span
          style={{
            padding: "2px 6px",
            borderRadius: "4px",
            background: "rgba(255,255,255,0.08)",
            border: "1px solid rgba(255,255,255,0.1)",
            fontSize: "10px",
            fontFamily: "var(--font-mono)",
          }}
        >
          Alt + Space
        </span>
        <span>{isListening ? "Click to finish / stop listening" : "Click orb or hold Alt+Space to speak"}</span>
      </div>
    </div>
  );
};
