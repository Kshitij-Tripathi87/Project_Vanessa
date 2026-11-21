import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useVanessaStore } from "./stores/vanessaStore.js";
import { useTaskStream } from "./hooks/useTaskStream.js";
import { useAudioCapture } from "./hooks/useAudioCapture.js";
import { CompactAssistant } from "./components/CompactAssistant.js";
import { presentTaskCancellation, type TaskCancellationResult } from "./taskCancellation.js";

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
    stopSpeaking,
    stopRecording,
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

  const applyCancellationResult = useCallback((result: TaskCancellationResult | null | undefined) => {
    const outcome = presentTaskCancellation(result);
    setTaskStage(outcome.stage, outcome.message);
    setLastResponse(outcome.message);
    if (outcome.clearApproval) setPendingApproval(null);
    if (outcome.clearRequest) setCurrentRequestId(null);
    return outcome;
  }, [setCurrentRequestId, setLastResponse, setPendingApproval, setTaskStage]);

  const handleStop = useCallback(async () => {
    const requestId = currentRequestId;
    // Silence local output and release local PTT capture without deactivating the
    // voice session; the orchestrator request below is the single task-cancel path.
    stopSpeaking();
    if (!wakeWordActive) stopRecording();

    if (!requestId) {
      // Before the server has returned a request ID, the voice session is the only
      // owner able to fence that not-yet-committed turn. It does not prove process
      // termination, so keep the UI explicitly unresolved until task events arrive.
      cancelVoice();
      const message = "Voice session deactivated, but no request ID was available to verify task cancellation. Check the task timeline.";
      setTaskStage("termination_unconfirmed", message);
      setLastResponse(message);
      return;
    }

    setTaskStage("cancelling", "Requesting cancellation and checking process termination…");
    try {
      const result = await window.vanessa?.cancelTask?.(requestId);
      applyCancellationResult(result);
    } catch (error) {
      applyCancellationResult({
        success: false,
        error: error instanceof Error ? error.message : "The cancellation request failed. Execution may still be active.",
      });
    }
  }, [applyCancellationResult, cancelVoice, currentRequestId, setLastResponse, setTaskStage, stopRecording, stopSpeaking, wakeWordActive]);



  const handleEmergencyStop = useCallback(async () => {
    // Escape is the explicit all-task action. Audio is stopped locally; the global
    // orchestrator endpoint owns cancellation and returns aggregate process proof.
    stopSpeaking();
    if (!wakeWordActive) stopRecording();
    setTaskStage("cancelling", "Emergency cancellation requested; checking all managed processes…");
    try {
      const result = await window.vanessa?.cancelTask?.();
      applyCancellationResult(result);
    } catch (error) {
      applyCancellationResult({
        success: false,
        error: error instanceof Error ? error.message : "Emergency cancellation failed. One or more tasks may still be active.",
      });
    }
  }, [applyCancellationResult, setTaskStage, stopRecording, stopSpeaking, wakeWordActive]);

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
      onStopSpeech={stopSpeaking}
      onTypedCommandChange={setTypedInput}
      onExecute={() => void execute()}
      onApprove={(taskId) => void approve(taskId)}
      onReject={(taskId) => void reject(taskId)}
    />
  );
}
