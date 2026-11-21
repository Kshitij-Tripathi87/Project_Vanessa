export type TaskCancellationResult = {
  success?: boolean;
  cancelled?: number;
  executionFinished?: number;
  terminationUnconfirmed?: number;
  planningOnly?: boolean | number;
  message?: string;
  error?: string;
};

export type TaskCancellationStage =
  | "cancelled"
  | "verifying"
  | "termination_unconfirmed"
  | "partial";

export type TaskCancellationPresentation = {
  stage: TaskCancellationStage;
  message: string;
  clearApproval: boolean;
  clearRequest: boolean;
};

/**
 * Convert process-supervisor evidence into UI state.
 *
 * A successful HTTP response only means the request was processed. It does not
 * prove that every process stopped. Missing counters and failed requests remain
 * unresolved; only confirmed cancellation or a planning tombstone may clear the
 * active request identity.
 */
export function presentTaskCancellation(
  result: TaskCancellationResult | null | undefined,
): TaskCancellationPresentation {
  if (!result || result.success !== true) {
    return {
      stage: "termination_unconfirmed",
      message: result?.error || "Cancellation could not be confirmed. Check the task timeline; execution may still be active.",
      clearApproval: false,
      clearRequest: false,
    };
  }

  const cancelled = Number.isSafeInteger(result.cancelled) && result.cancelled! >= 0
    ? result.cancelled!
    : null;
  const executionFinished = Number.isSafeInteger(result.executionFinished) && result.executionFinished! >= 0
    ? result.executionFinished!
    : null;
  const terminationUnconfirmed = Number.isSafeInteger(result.terminationUnconfirmed) && result.terminationUnconfirmed! >= 0
    ? result.terminationUnconfirmed!
    : null;

  if (cancelled === null || executionFinished === null || terminationUnconfirmed === null) {
    return {
      stage: "partial",
      message: "The cancellation endpoint did not return complete process-state evidence. The request remains unresolved.",
      clearApproval: false,
      clearRequest: false,
    };
  }

  if (terminationUnconfirmed > 0) {
    return {
      stage: "termination_unconfirmed",
      message: terminationUnconfirmed + " process tree(s) could not be verified stopped. Vanessa is retaining the task identity and resource locks.",
      clearApproval: false,
      clearRequest: false,
    };
  }

  if (executionFinished > 0) {
    return {
      stage: "verifying",
      message: executionFinished + " operation(s) finished before cancellation took effect" +
        (cancelled > 0 ? "; " + cancelled + " remaining operation(s) were confirmed cancelled" : "") +
        ". Checking the actual task result.",
      clearApproval: false,
      clearRequest: false,
    };
  }

  const planningOnly = result.planningOnly === true ||
    (typeof result.planningOnly === "number" && result.planningOnly > 0);
  if (cancelled > 0 || planningOnly) {
    return {
      stage: "cancelled",
      message: planningOnly
        ? (typeof result.planningOnly === "number" ? result.planningOnly + " request(s)" : "The request") +
          " was cancelled during planning. Late planner results cannot start work."
        : cancelled + " operation(s) were confirmed cancelled by the process supervisor.",
      clearApproval: true,
      clearRequest: true,
    };
  }

  return {
    stage: "partial",
    message: result.message || "No operation was confirmed cancelled. The task remains unresolved; inspect its timeline before retrying.",
    clearApproval: false,
    clearRequest: false,
  };
}
