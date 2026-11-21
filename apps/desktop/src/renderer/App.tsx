import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useVanessaStore } from "./stores/vanessaStore.js";
import { useTaskStream } from "./hooks/useTaskStream.js";
import { useAudioCapture } from "./hooks/useAudioCapture.js";
import { CompactAssistant } from "./components/CompactAssistant.js";
import { classifyCancellationResponse, isActiveTaskStage } from "./taskCancellation.js";

const PANEL_SIZE = { width: 360, height: 440 };
const ORB_SIZE = { width: 90, height: 90 };
type DockCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

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
    microphoneTestState,
    microphoneTestMessage,
    testMicrophone,
    speechOutputTestState,
    speechOutputTestMessage,
    testSpeechOutput,
    cancelVoice,
    submitTextCommand,
    voiceConnectionState,
    wakeWordActive,
    toggleRecording,
    resumeAudio,
  } = useAudioCapture();
  const [expanded, setExpanded] = useState(false);
  const [dockCorner, setDockCorner] = useState<DockCorner>("bottom-right");
  const [typedInput, setTypedInput] = useState("");

  // Keep typed input local to the surface. It should never become task state
  // until the user explicitly submits it.
  const command = typedInput;

  const resizeSurface = useCallback((open: boolean) => {
    const size = open ? PANEL_SIZE : ORB_SIZE;
    // Resize first, then re-anchor using the new dimensions so expanded panels
    // remain entirely visible on screen.
    void (async () => {
      await window.vanessa?.resizeWindow?.(size);
      await window.vanessa?.dockCorner?.(dockCorner);
    })();
  }, [dockCorner]);

  const handleDockCorner = useCallback((corner: DockCorner) => {
    setDockCorner(corner);
    void window.vanessa?.dockCorner?.(corner);
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
    // Stop capture/playback immediately. A completed task must remain completed:
    // stopping speech is not a reason to send a second cancellation request.
    cancelVoice();
    if (!isActiveTaskStage(taskStage)) return;

    const requestId = currentRequestId;
    if (!requestId) {
      setLastResponse("Voice input or playback stopped. The active task was not cancelled because its request ID is unavailable.");
      setTaskStage(taskStage, "Cancellation was not sent. The task state is unchanged.");
      return;
    }

    setTaskStage("cancelling", "Cancellation requested. Waiting for verified task termination.");
    let response: unknown;
    try {
      response = await window.vanessa?.cancelTask?.(requestId);
    } catch (error) {
      response = { success: false, error: error instanceof Error ? error.message : "Cancellation request failed." };
    }

    // Task events may win the race with the HTTP response. Never let a late
    // cancellation response resurrect a finished task or overwrite a newer one.
    const latest = useVanessaStore.getState();
    if (latest.currentRequestId !== requestId || !isActiveTaskStage(latest.taskStage)) return;

    const outcome = classifyCancellationResponse(response);
    if (outcome.kind === "request_failed" || outcome.kind === "invalid_response") {
      setLastResponse(outcome.message);
      setTaskStage(latest.taskStage, "Cancellation was not confirmed. The task state is unchanged.");
      return;
    }

    setTaskStage(outcome.stage, outcome.message);
    if (outcome.kind === "termination_unconfirmed") setLastResponse(outcome.message);
    if (outcome.clearPendingApproval) setPendingApproval(null);
    if (outcome.clearRequest) setCurrentRequestId(null);
  }, [cancelVoice, currentRequestId, setCurrentRequestId, setLastResponse, setPendingApproval, setTaskStage, taskStage]);

  const handleEmergencyStop = useCallback(async () => {
    // Escape is the explicit global action. The API reports process outcomes;
    // an HTTP acknowledgement alone is never presented as a successful stop.
    cancelVoice();
    let response: unknown;
    try {
      response = await window.vanessa?.cancelTask?.();
    } catch (error) {
      response = { success: false, error: error instanceof Error ? error.message : "Emergency cancellation failed." };
    }

    const outcome = classifyCancellationResponse(response);
    const latest = useVanessaStore.getState();
    if (!isActiveTaskStage(latest.taskStage)) return;

    if (outcome.kind === "request_failed" || outcome.kind === "invalid_response") {
      setLastResponse(outcome.message);
      setTaskStage(latest.taskStage, "Emergency cancellation was not confirmed. Task state is unchanged.");
      return;
    }

    setTaskStage(outcome.stage, outcome.message);
    if (outcome.kind === "termination_unconfirmed" || outcome.kind === "no_active_work") {
      setLastResponse(outcome.message);
    }
    if (outcome.clearPendingApproval) setPendingApproval(null);
  }, [cancelVoice, setPendingApproval, setLastResponse, setTaskStage, taskStage]);

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
      dockCorner={dockCorner}
      voiceState={voiceState}
      taskStage={taskStage}
      progressMessage={progressMessage}
      partialTranscript={partialTranscript}
      lastResponse={lastResponse}
      typedCommand={typedInput}
      activePlan={activePlan}
      activeTask={activeTask}
      tasks={tasks}
      pendingApproval={pendingApproval}
      providerStatus={providerStatus}
      voiceConnectionState={voiceConnectionState}
      wakeWordActive={wakeWordActive}
      microphoneTestState={microphoneTestState}
      microphoneTestMessage={microphoneTestMessage}
      onTestMicrophone={() => void testMicrophone()}
      speechOutputTestState={speechOutputTestState}
      speechOutputTestMessage={speechOutputTestMessage}
      onTestSpeechOutput={testSpeechOutput}
      isMicActive={isMicActive}
      audioLevel={audioLevel}
      currentRequestId={currentRequestId}
      currentTaskId={currentTaskId}
      onOrbClick={handleOrbClick}
      onExpand={openPanel}
      onCollapse={collapsePanel}
      onDockCorner={handleDockCorner}
      onStop={handleStop}
      onTypedCommandChange={setTypedInput}
      onExecute={() => void execute()}
      onApprove={(taskId) => void approve(taskId)}
      onReject={(taskId) => void reject(taskId)}
    />
  );
}
