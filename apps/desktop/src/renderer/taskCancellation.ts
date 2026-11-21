export type CancellationTaskStage =
  | "executing"
  | "cancelling"
  | "cancellation_unconfirmed"
  | "verifying"
  | "cancelled";

export interface CancellationPresentation {
  kind:
    | "request_failed"
    | "invalid_response"
    | "termination_unconfirmed"
    | "cancellation_pending"
    | "execution_finished"
    | "cancelled_before_execution"
    | "no_active_work";
  stage: CancellationTaskStage;
  message: string;
  clearPendingApproval: boolean;
  clearRequest: boolean;
}

function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function boundedMessage(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 240)
    : fallback;
}

/**
 * The success flag means the orchestrator processed the request. It does not
 * mean the process tree stopped or the whole plan was cancelled.
 */
export function classifyCancellationResponse(response: unknown): CancellationPresentation {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return {
      kind: "invalid_response",
      stage: "executing",
      message: "The cancellation response was missing or malformed. Task state is unchanged.",
      clearPendingApproval: false,
      clearRequest: false,
    };
  }

  const value = response as Record<string, unknown>;
  if (value.success !== true) {
    return {
      kind: "request_failed",
      stage: "executing",
      message: boundedMessage(value.error ?? value.message, "The orchestrator did not accept the cancellation request."),
      clearPendingApproval: false,
      clearRequest: false,
    };
  }

  const cancelled = readCount(value.cancelled);
  const executionFinished = readCount(value.executionFinished);
  const terminationUnconfirmed = readCount(value.terminationUnconfirmed);
  const planningOnly = value.planningOnly;

  if (
    cancelled === null ||
    executionFinished === null ||
    terminationUnconfirmed === null ||
    (planningOnly !== undefined && typeof planningOnly !== "boolean")
  ) {
    return {
      kind: "invalid_response",
      stage: "executing",
      message: "The orchestrator returned an incomplete cancellation result. Task state is unchanged.",
      clearPendingApproval: false,
      clearRequest: false,
    };
  }

  if (terminationUnconfirmed > 0) {
    return {
      kind: "termination_unconfirmed",
      stage: "cancellation_unconfirmed",
      message: boundedMessage(
        value.message,
        "Vanessa could not verify that " + terminationUnconfirmed + " task process(es) stopped. Their resource locks remain held.",
      ),
      clearPendingApproval: false,
      clearRequest: false,
    };
  }

  if (cancelled > 0) {
    const alreadyFinished = executionFinished > 0
      ? " " + executionFinished + " other task(s) had already finished and will keep their actual result."
      : "";
    return {
      kind: "cancellation_pending",
      stage: "cancelling",
      message: cancelled + " task(s) were confirmed cancelled." + alreadyFinished + " Waiting for the overall plan outcome.",
      clearPendingApproval: true,
      clearRequest: false,
    };
  }

  if (executionFinished > 0) {
    return {
      kind: "execution_finished",
      stage: "verifying",
      message: executionFinished + " task(s) finished before cancellation took effect. Checking their actual result.",
      clearPendingApproval: false,
      clearRequest: false,
    };
  }

  if (planningOnly === true) {
    return {
      kind: "cancelled_before_execution",
      stage: "cancelled",
      message: "The request was cancelled before task planning or execution. No task was started.",
      clearPendingApproval: true,
      clearRequest: true,
    };
  }

  return {
    kind: "no_active_work",
    stage: "verifying",
    message: "No cancellable work remained. The existing task result has not been changed.",
    clearPendingApproval: false,
    clearRequest: false,
  };
}

export function isActiveTaskStage(stage: string): boolean {
  return [
    "accepted",
    "planning",
    "executing",
    "verifying",
    "cancelling",
    "cancellation_unconfirmed",
  ].includes(stage);
}
