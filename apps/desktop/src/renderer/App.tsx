import React, { useState, useEffect, useCallback, useRef } from "react";
import type { DockPosition } from "@vanessa/shared";
import { useVanessaStore } from "./stores/vanessaStore.js";
import { useTaskStream } from "./hooks/useTaskStream.js";
import { useElevenLabs } from "./hooks/useElevenLabs.js";
import { useAudioCapture } from "./hooks/useAudioCapture.js";
import { VoiceOrb } from "./components/VoiceOrb.js";
import { ChatPanel } from "./components/ChatPanel.js";
import { TaskPlan } from "./components/TaskPlan.js";
import { AuditLog } from "./components/AuditLog.js";
import { MemoryPalaceViewer } from "./components/MemoryPalaceViewer.js";
import { MobilePairingModal } from "./components/MobilePairingModal.js";
import { ApprovalModal } from "./components/ApprovalModal.js";
import { ControlDeck } from "./components/ControlDeck.js";
import {
  Settings,
  Minimize2,
  X,
  ShieldCheck,
  OctagonAlert,
  Send,
  Sparkles,
  Smartphone,
  HardDrive,
  FolderLock,
  Volume2,
  Mic,
  Activity,
  CheckCircle2,
  Brain,
  Layers,
  FileText,
  Minus,
  Monitor,
} from "lucide-react";

export function App() {
  const {
    voiceState,
    activePlan,
    tasks,
    pendingApproval,
    auditLogs,
    lastResponse,
    setVoiceState,
    setLastResponse,
    setPendingApproval,
  } = useVanessaStore();

  useEffect(() => {
    let mounted = true;
    void window.vanessa?.getDockPosition?.().then((result) => {
      if (mounted && result?.success && result.dockPosition) setCurrentCorner(result.dockPosition);
    }).catch(() => undefined);
    return () => { mounted = false; };
  }, []);

  useTaskStream();
  const { executeSpeechCommand } = useElevenLabs();
  const {
    isMicActive,
    audioLevel,
    liveSentiment,
    partialTranscript,
    providerStatus,
    micError,
    toggleRecording,
    resumeAudio,
    wakeWordStatus,
    wakeWordActivationId,
    lastFinalTranscript,
  } = useAudioCapture();

  type ViewMode = "orb" | "chat" | "dashboard";
  const [viewMode, setViewMode] = useState<ViewMode>("orb");
  const [currentCorner, setCurrentCorner] = useState<DockPosition>("bottom-right");
  const [activeTab, setActiveTab] = useState<"control" | "memory" | "audit" | "plan" | "privacy" | "scenarios">("control");
  const [typedCommand, setTypedCommand] = useState("");
  const [lastCommand, setLastCommand] = useState("");
  const lastSeenFinalTranscriptRef = useRef("");
  const [justActivated, setJustActivated] = useState(false);
  const [isPairingOpen, setIsPairingOpen] = useState(false);
  const [allowedFolders, setAllowedFolders] = useState<string[]>([]);
  const [newFolderInput, setNewFolderInput] = useState("");

  const [controlStatus, setControlStatus] = useState<VanessaControlStatus | null>(null);
  const [controlStatusLoading, setControlStatusLoading] = useState(false);
  const [controlStatusError, setControlStatusError] = useState<string | null>(null);

  const refreshControlStatus = useCallback(async () => {
    setControlStatusLoading(true);
    try {
      const result = await window.vanessa.getControlStatus();
      setControlStatus(result);
      setAllowedFolders(result.allowedFolders || []);
      setControlStatusError(result.errors?.length ? result.errors.join(" · ") : null);
    } catch {
      setControlStatusError("Could not read Vanessa local runtime status.");
      setControlStatus({
        success: false,
        orchestratorOnline: false,
        orchestratorPort: 4139,
        activeTasksCount: 0,
        platform: "unknown",
        allowedFolders: [],
        checkedAt: Date.now(),
        errors: ["Desktop status IPC is unavailable."],
      });
    } finally {
      setControlStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    if (viewMode !== "dashboard") return;
    void refreshControlStatus();
    const refreshTimer = window.setInterval(() => { void refreshControlStatus(); }, 15000);
    return () => window.clearInterval(refreshTimer);
  }, [viewMode, refreshControlStatus]);

  // Speak aloud helper
  const speakText = (text: string) => {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const utt = new SpeechSynthesisUtterance(text);
      utt.rate = 1.08;
      utt.pitch = 1.04;
      window.speechSynthesis.speak(utt);
    }
  };

  const handleDockCorner = useCallback((position: DockPosition) => {
    setCurrentCorner(position);
    void window.vanessa?.dockCorner?.(position);
  }, []);

  const handleToggleView = useCallback((view: ViewMode) => {
    setViewMode(view);
    if (view === "orb") {
      void window.vanessa?.resizeWindow?.({ width: 90, height: 90 });
    } else if (view === "chat") {
      void window.vanessa?.resizeWindow?.({ width: 410, height: 540 });
    } else {
      void window.vanessa?.resizeWindow?.({ width: 580, height: 680 });
    }
    void window.vanessa?.dockCorner?.(currentCorner);
  }, [currentCorner]);

  const handleOpenChat = useCallback(() => {
    // Wake-word activation can arrive while the window is hidden in the tray.
    void window.vanessa?.showWindow?.();
    handleToggleView("chat");
  }, [handleToggleView]);

  // The main process owns global shortcuts so they also work while the orb is hidden.
  const handleOrbClick = useCallback(async () => {
    if (resumeAudio) {
      await resumeAudio();
    }
    setJustActivated(true);
    window.setTimeout(() => setJustActivated(false), 2000);
    toggleRecording();
  }, [resumeAudio, toggleRecording]);

  useEffect(() => {
    if (wakeWordActivationId > 0) {
      handleOpenChat();
      setJustActivated(true);
      const activationTimer = window.setTimeout(() => setJustActivated(false), 1800);
      return () => window.clearTimeout(activationTimer);
    }
  }, [wakeWordActivationId, handleOpenChat]);

  useEffect(() => {
    const transcript = lastFinalTranscript.trim();
    if (transcript && transcript !== lastSeenFinalTranscriptRef.current) {
      lastSeenFinalTranscriptRef.current = transcript;
      setLastCommand(transcript);
    }
  }, [lastFinalTranscript]);

  useEffect(() => {
    const unsubscribe = window.vanessa?.onOpenChat?.(() => handleOpenChat());
    return () => unsubscribe?.();
  }, [handleOpenChat]);

  const handleExecute = async (cmdToRun?: string) => {
    const cmd = (cmdToRun ?? typedCommand).trim();
    if (!cmd) return;
    setLastCommand(cmd);
    setTypedCommand("");
    setViewMode("chat");
    await executeSpeechCommand(cmd);
  };

  // Dashboard actions stay in the control deck so task updates are visible
  // immediately, instead of navigating away to the generic chat view.
  const handleControlExecute = async (command: string) => {
    const cmd = command.trim();
    if (!cmd) return;
    setLastCommand(cmd);
    setTypedCommand("");
    await executeSpeechCommand(cmd);
  };

  const handleApproveTask = useCallback(async (taskId: string) => {
    const result = await window.vanessa.approveTask(taskId);
    if (result.success) {
      setPendingApproval(null);
    } else {
      setLastResponse(result.error || "This approval is no longer valid. Review the updated task status.");
    }
  }, [setPendingApproval, setLastResponse]);

  const handleRejectTask = useCallback(async (taskId: string) => {
    const result = await window.vanessa.rejectTask(taskId);
    if (result.success) {
      setPendingApproval(null);
    } else {
      setLastResponse(result.error || "This approval could not be rejected.");
    }
  }, [setPendingApproval, setLastResponse]);

  const handleKillSwitch = useCallback(async () => {
    if (!window.vanessa?.cancelTask) {
      setLastResponse("The emergency stop bridge is unavailable. Check Vanessa's local runtime.");
      return;
    }
    try {
      const result = await window.vanessa.cancelTask();
      if (!result.success) setLastResponse(result.error || "Vanessa could not confirm the emergency stop request.");
      else setLastResponse(result.message || "Emergency stop requested. Check each task's final status.");
    } catch {
      setLastResponse("Vanessa could not reach the orchestrator to request an emergency stop.");
    }
  }, [setLastResponse]);

  useEffect(() => {
    const unsubscribePtt = window.vanessa?.onTriggerPTT?.(() => {
      void handleOrbClick();
    });
    const unsubscribeCancel = window.vanessa?.onTriggerCancel?.(() => {
      void handleKillSwitch();
    });
    return () => {
      unsubscribePtt?.();
      unsubscribeCancel?.();
    };
  }, [handleOrbClick, handleKillSwitch]);

  const handleAddFolder = async () => {
    if (!newFolderInput.trim()) return;
    try {
      const result = await window.vanessa.addAllowedFolder(newFolderInput.trim());
      if (result.success && result.allowedFolders) {
        setAllowedFolders(result.allowedFolders);
        setNewFolderInput("");
        setLastResponse("Folder added to Vanessa's approved filesystem roots.");
      } else {
        setLastResponse(result.error || "That folder could not be added to the approved roots.");
      }
      void refreshControlStatus();
    } catch {
      setLastResponse("Vanessa could not update the approved folder list.");
    }
  };

  // Locked evaluation scenarios
  const lockedScenarios = [
    {
      label: "🔍 Investigate Checkout Failure (v0.2)",
      desc: "4 concurrent specialists + isolated patch + test verify",
      command:
        "Hey Vanessa, investigate why the checkout service is failing. Check the recent code changes, logs, previous incidents and runbook. Prepare a fix, run the tests, and explain what you found. Don't deploy anything.",
    },
    {
      label: "📶 Restart Wi-Fi Adapter (Autonomous)",
      desc: "Immediate execution with zero confirmation voice",
      command: "Hey Vanessa, my Wi-Fi isn’t working—restart the adapter.",
    },
    {
      label: "🌐 Bluetooth + Chrome + Folder",
      desc: "Parallel independent task execution",
      command: "Turn on Bluetooth, open Chrome, and create a Buildathon Demo folder.",
    },
    {
      label: "📤 Drive Upload & Share Link",
      desc: "Cloud sync and link generator",
      command: "Upload today's report to Drive and send me the link.",
    },
    {
      label: "💻 Claude Code Terminal",
      desc: "Autonomous developer agent session",
      command: "Open Claude Code and ask it to build a landing page.",
    },
    {
      label: "📅 Everyday System Schedule",
      desc: "Persistent 30-day cron task in SQLite/Rust",
      command: "Schedule an everyday task to run system health check every morning at 9am.",
    },
  ];

  // -------------------------------------------------------------
  // MODE 1: COMPACT CORNER CIRCULAR ICON WIDGET (90x90)
  // -------------------------------------------------------------
  const cycleCorner = (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const positions: DockPosition[] = [
      "bottom-right", "bottom-left", "top-left", "top-right",
      "left", "right", "top", "bottom",
    ];
    const nextPosition = positions[(positions.indexOf(currentCorner) + 1) % positions.length];
    handleDockCorner(nextPosition);
  };

  const cornerLabel: Record<DockPosition, string> = {
    "bottom-right": "↘ BR", "bottom-left": "↙ BL",
    "top-left": "↖ TL", "top-right": "↗ TR",
    left: "← LEFT", right: "RIGHT →", top: "↑ TOP", bottom: "↓ BOTTOM",
  };

  if (viewMode === "orb") {
    return (
      <div
        className="drag-region"
        onContextMenu={cycleCorner}
        style={{
          width: "90px",
          height: "90px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
          position: "relative",
          userSelect: "none",
        }}
      >
        {/* Floating Compact Orb (70px) */}
        <div
          className={`no-drag ${isMicActive ? "orb-listening" : voiceState === "thinking" || voiceState === "executing" ? "orb-thinking" : "orb-idle"}`}
          onClick={handleOpenChat}
          onContextMenu={cycleCorner}
          title={`Vanessa (${currentCorner.toUpperCase()})\nClick to chat\nSay “Hey Vanessa” to activate\nRight-click to change dock position`}
          style={{
            width: "72px",
            height: "72px",
            borderRadius: "50%",
            background: isMicActive || justActivated
              ? "radial-gradient(circle at 35% 30%, #065f46 0%, #022c22 75%, #000000 100%)"
              : voiceState === "thinking"
              ? "radial-gradient(circle at 35% 30%, #581c87 0%, #2e1065 75%, #000000 100%)"
              : voiceState === "speaking"
              ? "radial-gradient(circle at 35% 30%, #0284c7 0%, #075985 75%, #000000 100%)"
              : "radial-gradient(circle at 35% 30%, #0e7490 0%, #0f172a 75%, #020617 100%)",
            border: isMicActive || justActivated
              ? "2px solid #10b981"
              : voiceState === "thinking"
              ? "2px solid #a855f7"
              : voiceState === "speaking"
              ? "2px solid #38bdf8"
              : "2px solid rgba(0, 242, 254, 0.65)",
            boxShadow: isMicActive || justActivated
              ? `0 0 ${16 + audioLevel * 30}px rgba(16, 185, 129, 0.85), inset 0 0 12px rgba(16, 185, 129, 0.4)`
              : voiceState === "thinking"
              ? "0 0 20px rgba(168, 85, 247, 0.8), inset 0 0 10px rgba(168, 85, 247, 0.3)"
              : voiceState === "speaking"
              ? "0 0 22px rgba(56, 189, 248, 0.8), inset 0 0 10px rgba(56, 189, 248, 0.3)"
              : "0 0 18px rgba(0, 242, 254, 0.45), inset 0 0 8px rgba(0, 242, 254, 0.2)",
            position: "relative",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            transform: `scale(${isMicActive ? 1 + Math.min(0.15, audioLevel * 0.35) : 1})`,
            transition: "all 0.15s cubic-bezier(0.4, 0, 0.2, 1)",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
          }}
        >
          {/* Audio Pulsing Ring */}
          {isMicActive && (
            <div
              style={{
                position: "absolute",
                inset: "-4px",
                borderRadius: "50%",
                border: "1.5px solid rgba(16, 185, 129, 0.6)",
                animation: "pulse 1.4s ease-in-out infinite",
                pointerEvents: "none",
              }}
            />
          )}

          {/* Core Mic Icon */}
          <Mic
            size={22}
            color="#ffffff"
            style={{
              filter: "drop-shadow(0 0 6px rgba(255, 255, 255, 0.85))",
              transform: isMicActive ? "scale(1.08)" : "scale(1)",
              transition: "transform 0.15s ease",
            }}
          />

          {/* Micro Status Label or Live Transcript */}
          <span
            style={{
              fontSize: partialTranscript ? "6.8px" : "7.5px",
              fontWeight: 800,
              letterSpacing: partialTranscript ? "0.02em" : "0.06em",
              color: justActivated || isMicActive
                ? "#34d399"
                : voiceState === "thinking"
                ? "#c084fc"
                : voiceState === "speaking"
                ? "#7dd3fc"
                : "rgba(255, 255, 255, 0.85)",
              textTransform: partialTranscript ? "none" : "uppercase",
              marginTop: "2px",
              lineHeight: 1,
              maxWidth: "60px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {partialTranscript
              ? partialTranscript
              : justActivated
              ? "ACTIVE"
              : isMicActive
              ? "LISTEN"
              : voiceState === "thinking"
              ? "THINK"
              : voiceState === "speaking"
              ? "SPEAK"
              : "VANESSA"}
          </span>

          {/* Tiny Corner Badge: shows current corner position */}
          <div
            title={`Docked: ${currentCorner}. Right-click orb to cycle corners.`}
            style={{
              position: "absolute",
              bottom: "-2px",
              background: "rgba(0, 0, 0, 0.75)",
              border: "1px solid rgba(0, 242, 254, 0.4)",
              borderRadius: "4px",
              padding: "1px 3px",
              fontSize: "6px",
              color: "var(--cyan-glow)",
              fontWeight: 700,
              letterSpacing: "0.04em",
              pointerEvents: "none",
            }}
          >
            {cornerLabel[currentCorner]}
          </div>
        </div>

        {/* Mini Drawer Button (Gear) */}
        <button
          className="no-drag"
          onClick={() => handleToggleView("dashboard")}
          title="Open Vanessa Control Center & Memory Palace"
          style={{
            position: "absolute",
            top: "2px",
            right: "2px",
            background: "rgba(15, 23, 42, 0.85)",
            border: "1px solid rgba(0, 242, 254, 0.35)",
            borderRadius: "50%",
            width: "20px",
            height: "20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--cyan-glow)",
            cursor: "pointer",
            boxShadow: "0 2px 8px rgba(0, 0, 0, 0.5)",
            transition: "all 0.2s ease",
            zIndex: 10,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(0, 242, 254, 0.25)";
            e.currentTarget.style.transform = "scale(1.15)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "rgba(15, 23, 42, 0.85)";
            e.currentTarget.style.transform = "scale(1)";
          }}
        >
          <Settings size={10} />
        </button>
      </div>
    );
  }

  if (viewMode === "chat") {
    return (
      <ChatPanel
        voiceState={voiceState}
        isListening={isMicActive}
        wakeWordStatus={wakeWordStatus}
        micError={micError}
        command={typedCommand}
        setCommand={setTypedCommand}
        lastCommand={lastCommand}
        lastResponse={lastResponse}
        partialTranscript={partialTranscript}
        corner={currentCorner}
        onSubmit={() => { void handleExecute(); }}
        onToggleMic={() => { void handleOrbClick(); }}
        onCollapse={() => handleToggleView("orb")}
        onOpenDashboard={() => handleToggleView("dashboard")}
      />
    );
  }

  // The control center remains available from the small settings button.
  // It is no longer the default interaction surface.
  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "rgba(10, 14, 24, 0.95)",
        border: "1px solid rgba(0, 242, 254, 0.25)",
        borderRadius: "16px",
        boxShadow: "0 12px 48px rgba(0, 0, 0, 0.85), 0 0 35px rgba(0, 242, 254, 0.15)",
        backdropFilter: "blur(24px)",
        WebkitBackdropFilter: "blur(24px)",
        overflow: "hidden",
        padding: "14px 18px",
        gap: "10px",
      }}
    >
      {/* Top Header Bar (Draggable) */}
      <header
        className="drag-region"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          paddingBottom: "8px",
          borderBottom: "1px solid var(--border-subtle)",
          cursor: "grab",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div
            style={{
              width: "10px",
              height: "10px",
              borderRadius: "50%",
              background: "var(--cyan-glow)",
              boxShadow: "0 0 10px var(--cyan-glow)",
            }}
          />
          <h1
            style={{
              fontSize: "14px",
              fontWeight: 700,
              letterSpacing: "0.06em",
              color: "#ffffff",
              margin: 0,
            }}
          >
            VANESSA <span style={{ color: "var(--cyan-glow)", fontWeight: 400 }}>// OS CONTROL & CONFIGURATION</span>
          </h1>
          <span
            style={{
              fontSize: "10px",
              color: "#10b981",
              background: "rgba(16, 185, 129, 0.12)",
              border: "1px solid rgba(16, 185, 129, 0.3)",
              padding: "2px 8px",
              borderRadius: "12px",
              fontWeight: 600,
            }}
          >
            {controlStatus?.autonomousMode === true
              ? "AUTONOMY ENABLED"
              : controlStatus?.autonomousMode === false
                ? "APPROVAL GATES ACTIVE"
                : "POLICY STATUS UNKNOWN"}
          </span>
        </div>

        {/* Window controls (Collapse to orb, Minimize, Close) */}
        <div className="no-drag" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <button
            onClick={() => handleToggleView("orb")}
            title="Collapse to Floating Orb Widget"
            style={{
              background: "rgba(255, 255, 255, 0.06)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "6px",
              padding: "5px 8px",
              color: "var(--cyan-glow)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "4px",
              fontSize: "11px",
              fontWeight: 600,
            }}
          >
            <Minimize2 size={12} />
            <span>Collapse to Orb</span>
          </button>

          <button
            onClick={() => window.vanessa?.minimizeWindow?.()}
            title="Minimize"
            style={{
              background: "rgba(255, 255, 255, 0.06)",
              border: "none",
              borderRadius: "6px",
              padding: "5px 7px",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            <Minus size={12} />
          </button>

          <button
            onClick={() => window.vanessa?.closeWindow?.()}
            title="Close"
            style={{
              background: "rgba(244, 63, 94, 0.15)",
              border: "none",
              borderRadius: "6px",
              padding: "5px 7px",
              color: "#f43f5e",
              cursor: "pointer",
            }}
          >
            <X size={12} />
          </button>
        </div>
      </header>

      {/* Mini Command & Status Strip */}
      <section
        style={{
          display: "flex",
          gap: "8px",
          alignItems: "center",
          background: "rgba(14, 20, 32, 0.6)",
          padding: "8px 12px",
          borderRadius: "8px",
          border: "1px solid var(--border-subtle)",
        }}
      >
        <button
          className="no-drag"
          onClick={handleOrbClick}
          style={{
            background: isMicActive ? "rgba(16, 185, 129, 0.2)" : "rgba(0, 242, 254, 0.12)",
            border: isMicActive ? "1px solid #10b981" : "1px solid var(--cyan-glow)",
            borderRadius: "6px",
            padding: "5px 10px",
            color: isMicActive ? "#10b981" : "var(--cyan-glow)",
            display: "flex",
            alignItems: "center",
            gap: "5px",
            fontSize: "11px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          <Mic size={12} />
          <span>{isMicActive ? "Mic Live" : "Click to Speak"}</span>
        </button>

        {providerStatus && (
          <div
            title={`ASR: ${providerStatus.asr.active} (${providerStatus.asr.state})${providerStatus.asr.detail ? ` — ${providerStatus.asr.detail}` : ""}\nTTS: ${providerStatus.tts.active} (${providerStatus.tts.state})${providerStatus.tts.detail ? ` — ${providerStatus.tts.detail}` : ""}`}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "2px",
              maxWidth: "112px",
              overflow: "hidden",
              fontSize: "9px",
              lineHeight: 1.1,
              color: providerStatus.asr.state === "fallback" || providerStatus.tts.state === "fallback"
                ? "#fbbf24"
                : providerStatus.asr.state === "error" || providerStatus.tts.state === "error"
                ? "#fb7185"
                : "var(--text-muted)",
            }}
          >
            <span>ASR · {providerStatus.asr.active}{providerStatus.asr.state === "fallback" ? " (fallback)" : ""}</span>
            <span>TTS · {providerStatus.tts.active}{providerStatus.tts.state === "fallback" ? " (fallback)" : ""}</span>
          </div>
        )}

        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: "6px" }}>
          <input
            type="text"
            placeholder="Type command (e.g. 'Turn on Bluetooth and open Chrome')..."
            value={typedCommand}
            onChange={(e) => setTypedCommand(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleExecute()}
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              color: "var(--text-main)",
              fontSize: "12px",
              outline: "none",
            }}
          />
        </div>

        <button
          className="no-drag"
          onClick={() => handleExecute()}
          style={{
            background: "linear-gradient(135deg, #00f2fe 0%, #0284c7 100%)",
            color: "#08090d",
            padding: "5px 12px",
            borderRadius: "6px",
            fontWeight: 600,
            fontSize: "11px",
            border: "none",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "4px",
          }}
        >
          <span>Run</span>
          <Send size={11} />
        </button>
      </section>

      {/* Spoken Response Banner */}
      {lastResponse && (
        <div
          style={{
            background: "rgba(0, 242, 254, 0.06)",
            border: "1px solid rgba(0, 242, 254, 0.2)",
            borderRadius: "8px",
            padding: "8px 12px",
            fontSize: "11px",
            color: "var(--text-main)",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <Volume2 size={13} color="var(--cyan-glow)" />
          <span style={{ flex: 1 }}>{lastResponse}</span>
        </div>
      )}

      {/* Navigation Tabs */}
      <nav
        style={{
          display: "flex",
          gap: "6px",
          borderBottom: "1px solid var(--border-subtle)",
          paddingBottom: "6px",
        }}
      >
        {[
          { id: "control", label: "Windows & Browser", icon: <Monitor size={12} /> },
          { id: "memory", label: "Memory Palace (30D)", icon: <Brain size={12} /> },
          { id: "audit", label: "Audit Ledger", icon: <ShieldCheck size={12} /> },
          { id: "plan", label: "Active Task DAG", icon: <Layers size={12} /> },
          { id: "privacy", label: "Folder Allowlists", icon: <FolderLock size={12} /> },
          { id: "scenarios", label: "Locked Scenarios", icon: <Sparkles size={12} /> },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "5px",
              padding: "6px 10px",
              borderRadius: "6px",
              fontSize: "11px",
              fontWeight: 600,
              cursor: "pointer",
              background: activeTab === tab.id ? "rgba(0, 242, 254, 0.15)" : "transparent",
              color: activeTab === tab.id ? "var(--cyan-glow)" : "var(--text-muted)",
              border: activeTab === tab.id ? "1px solid rgba(0, 242, 254, 0.3)" : "1px solid transparent",
              transition: "all 0.2s ease",
            }}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </nav>

      {/* Tab Panels */}
      <main style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {activeTab === "control" && (
          <ControlDeck
            status={controlStatus}
            statusLoading={controlStatusLoading}
            statusError={controlStatusError}
            tasks={tasks}
            onRefresh={() => { void refreshControlStatus(); }}
            onExecute={(command) => { void handleControlExecute(command); }}
          />
        )}

        {activeTab === "memory" && <MemoryPalaceViewer />}

        {activeTab === "audit" && (
          <div style={{ height: "100%", overflowY: "auto" }}>
            <AuditLog logs={auditLogs} isOpen={true} onToggle={() => {}} />
          </div>
        )}

        {activeTab === "plan" && (
          <div style={{ height: "100%", overflowY: "auto" }}>
            <TaskPlan plan={activePlan} />
          </div>
        )}

        {activeTab === "privacy" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", fontSize: "12px" }}>
            <div
              style={{
                background: "rgba(56, 189, 248, 0.08)",
                border: "1px solid rgba(56, 189, 248, 0.25)",
                borderRadius: "8px",
                padding: "10px",
              }}
            >
              <h4 style={{ margin: "0 0 4px 0", color: "#38bdf8", fontSize: "12px" }}>
                Protected Folder Allowlist Policy
              </h4>
              <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "11px" }}>
                Vanessa strictly confines file operations to approved folders. Access to sensitive Windows system paths is permanently blocked.
              </p>
            </div>

            <div style={{ display: "flex", gap: "8px" }}>
              <input
                type="text"
                placeholder="Add allowed folder path (e.g. c:\Users\21330\Documents\MyFolder)..."
                value={newFolderInput}
                onChange={(e) => setNewFolderInput(e.target.value)}
                style={{
                  flex: 1,
                  background: "rgba(255, 255, 255, 0.04)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "6px",
                  padding: "7px 10px",
                  color: "#fff",
                  fontSize: "12px",
                  outline: "none",
                }}
              />
              <button
                onClick={handleAddFolder}
                style={{
                  background: "rgba(0, 242, 254, 0.15)",
                  color: "var(--cyan-glow)",
                  border: "1px solid var(--cyan-glow)",
                  borderRadius: "6px",
                  padding: "6px 12px",
                  fontWeight: 600,
                  fontSize: "11px",
                  cursor: "pointer",
                }}
              >
                Allow Folder
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={{ fontSize: "11px", color: "var(--text-dim)", textTransform: "uppercase" }}>
                Active Allowed Folders:
              </span>
              {allowedFolders.map((f, i) => (
                <div
                  key={i}
                  style={{
                    background: "rgba(255, 255, 255, 0.03)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "6px",
                    padding: "8px 12px",
                    fontFamily: "var(--font-mono)",
                    fontSize: "11px",
                    color: "var(--text-main)",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  <FolderLock size={12} color="#34d399" />
                  <span>{f}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "scenarios" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ fontSize: "11px", color: "var(--text-dim)", textTransform: "uppercase" }}>
              One-Click Locked Test Scenarios:
            </div>
            {lockedScenarios.map((sc, i) => (
              <button
                key={i}
                onClick={() => handleExecute(sc.command)}
                style={{
                  padding: "8px 12px",
                  borderRadius: "8px",
                  background: i === 0 ? "rgba(0, 242, 254, 0.08)" : "rgba(255, 255, 255, 0.03)",
                  border: i === 0 ? "1px solid var(--cyan-glow)" : "1px solid var(--border-subtle)",
                  color: "var(--text-main)",
                  fontSize: "12px",
                  textAlign: "left",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: "2px",
                }}
              >
                <span style={{ fontWeight: 600, color: i === 0 ? "var(--cyan-glow)" : "#fff" }}>
                  {sc.label}
                </span>
                <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                  {sc.desc}
                </span>
              </button>
            ))}
          </div>
        )}
      </main>

      {/* Bottom Footer with Emergency Kill Switch & Status */}
      <footer
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          paddingTop: "8px",
          borderTop: "1px solid var(--border-subtle)",
          fontSize: "11px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px", color: "var(--text-muted)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <Activity size={12} color={controlStatus?.orchestratorOnline ? "#34d399" : "#fb7185"} />
            <span>
              {controlStatus?.orchestratorOnline
                ? "Orchestrator · " + controlStatus.orchestratorPort + " online"
                : controlStatus
                  ? "Orchestrator · " + controlStatus.orchestratorPort + " offline"
                  : "Orchestrator status loading"}
            </span>
          </div>
          <span>•</span>
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <HardDrive size={12} color="#34d399" />
            <span>SQLite 30D Retention Active</span>
          </div>
        </div>

        <button
          onClick={handleKillSwitch}
          title="Emergency Kill Switch (Esc)"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "5px",
            padding: "5px 12px",
            borderRadius: "6px",
            background: "rgba(244, 63, 94, 0.15)",
            color: "#f43f5e",
            border: "1px solid rgba(244, 63, 94, 0.3)",
            fontWeight: 600,
            fontSize: "11px",
            cursor: "pointer",
          }}
        >
          <OctagonAlert size={12} />
          <span>Kill Switch (Esc)</span>
        </button>
      </footer>

      <ApprovalModal task={pendingApproval} onApprove={handleApproveTask} onReject={handleRejectTask} />
    </div>
  );
}
