import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useVanessaStore } from "./stores/vanessaStore.js";
import { useTaskStream } from "./hooks/useTaskStream.js";
import { useAudioCapture } from "./hooks/useAudioCapture.js";
import { CompactAssistant } from "./components/CompactAssistant.js";

const PANEL_SIZE = { width: 360, height: 440 };
const ORB_SIZE = { width: 90, height: 90 };

export function App() {
  const {
    voiceState,
    taskStage,
    progressMessage,
    currentRequestId,
    currentTaskId,
    activePlan,
    tasks,
    pendingApproval,
    lastResponse,
    setLastResponse,
    setPendingApproval,
    setCurrentRequestId,
    setTaskStage,
  } = useVanessaStore();

  useTaskStream();
  const {
    isMicActive,
    audioLevel,
    partialTranscript,
    providerStatus,
    micError,
    cancelVoice,
    submitTextCommand,
    voiceConnectionState,
    toggleRecording,
    resumeAudio,
  } = useAudioCapture();
  const [expanded, setExpanded] = useState(false);
  const [typedInput, setTypedInput] = useState("");

  // Keep typed input local to the surface. It should never become task state
  // until the user explicitly submits it.
  const command = typedInput;

  const resizeSurface = useCallback((open: boolean) => {
    const size = open ? PANEL_SIZE : ORB_SIZE;
    void window.vanessa?.resizeWindow?.(size);
    if (!open) void window.vanessa?.dockCorner?.("bottom-right");
  }, []);

  const openPanel = useCallback(() => {
    setExpanded(true);
    resizeSurface(true);
  }, [resizeSurface]);

  const collapsePanel = useCallback(() => {
    setExpanded(false);
    resizeSurface(false);
  }, [resizeSurface]);

  const handleOrbClick = useCallback(async () => {
    await resumeAudio?.();
    if (!expanded) openPanel();
    toggleRecording();
  }, [expanded, openPanel, resumeAudio, toggleRecording]);

  const handleStop = useCallback(async () => {
    const requestId = currentRequestId;
    const taskWasActive = ["accepted", "planning", "executing", "verifying"].includes(taskStage);
    // Stop the local voice turn and use request-scoped cancellation as a fallback
    // if the voice socket is down. Never escalate ordinary Stop to cancel-all.
    cancelVoice();
    setPendingApproval(null);
    if (requestId) {
      const result = await window.vanessa?.cancelTask?.(requestId);
      if (result && !result.success) {
        setLastResponse(result.error || "Cancellation could not be confirmed. Check task status before retrying.");
        setTaskStage("failed", "Cancellation could not be confirmed.");
        return;
      }
    }
    setCurrentRequestId(null);
    if (taskWasActive) {
      setTaskStage("cancelled", requestId ? "Cancellation requested for this task." : "Voice turn stopped; task cancellation was not independently confirmed.");
    }
  }, [cancelVoice, currentRequestId, setCurrentRequestId, setLastResponse, setPendingApproval, setTaskStage, taskStage]);

  const handleEmergencyStop = useCallback(async () => {
    // Escape is the explicit emergency action for all orchestrator work.
    cancelVoice();
    const result = await window.vanessa?.cancelTask?.();
    setCurrentRequestId(null);
    setPendingApproval(null);
    if (result && !result.success) setLastResponse(result.error || "Emergency stop could not be confirmed.");
    if (["accepted", "planning", "executing", "verifying"].includes(taskStage)) {
      setTaskStage("cancelled", "Emergency stop requested.");
    }
  }, [cancelVoice, setCurrentRequestId, setPendingApproval, setLastResponse, setTaskStage, taskStage]);

  const execute = useCallback((value = command) => {
    if (!value.trim()) return;
    if (submitTextCommand(value.trim())) setTypedInput("");
  }, [command, submitTextCommand]);

  const approve = useCallback(async (taskId: string) => {
    const result = await window.vanessa.approveTask(taskId);
    if (result.success) setPendingApproval(null);
    else setLastResponse(result.error || "This approval is no longer valid.");
  }, [setLastResponse, setPendingApproval]);

  const reject = useCallback(async (taskId: string) => {
    const result = await window.vanessa.rejectTask(taskId);
    if (result.success) setPendingApproval(null);
    else setLastResponse(result.error || "This approval could not be declined.");
  }, [setLastResponse, setPendingApproval]);

  useEffect(() => {
    if (micError) setLastResponse(micError);
  }, [micError, setLastResponse]);

  useEffect(() => {
    const unsubscribePtt = window.vanessa?.onTriggerPTT?.(handleOrbClick);
    const unsubscribeCancel = window.vanessa?.onTriggerCancel?.(handleEmergencyStop);
    return () => {
      unsubscribePtt?.();
      unsubscribeCancel?.();
    };
  }, [handleOrbClick, handleEmergencyStop]);

  const activeTask = useMemo(() => {
    if (currentTaskId) return tasks.find((task) => task.id === currentTaskId) || null;
    return [...tasks].reverse().find((task) => !["success", "succeeded", "failed", "cancelled"].includes(task.status)) || tasks[tasks.length - 1] || null;
  }, [currentTaskId, tasks]);

  return (
    <CompactAssistant
      expanded={expanded}
      voiceState={voiceState}
      taskStage={taskStage}
      progressMessage={progressMessage}
      partialTranscript={partialTranscript}
      lastResponse={lastResponse}
      typedCommand={typedInput}
      activePlan={activePlan}
      activeTask={activeTask}
      pendingApproval={pendingApproval}
      providerStatus={providerStatus}
      voiceConnectionState={voiceConnectionState}
      isMicActive={isMicActive}
      audioLevel={audioLevel}
      currentRequestId={currentRequestId}
      currentTaskId={currentTaskId}
      onOrbClick={handleOrbClick}
      onExpand={openPanel}
      onCollapse={collapsePanel}
      onStop={handleStop}
      onTypedCommandChange={setTypedInput}
      onExecute={() => void execute()}
      onApprove={(taskId) => void approve(taskId)}
      onReject={(taskId) => void reject(taskId)}
    />
  );
}
