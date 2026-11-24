import {
  PersistedConversationStateSchema,
  projectPersistedConversation,
  type ConversationState,
  type LocalConversationLoadResult,
  type LocalConversationMutationResult,
  type PersistedConversationState,
} from "@vanessa/protocol/conversation";

export type ConversationHistoryStatus = "loading" | "saved" | "saving" | "clearing" | "session_only" | "error";
export type ClearHistoryResult = "cleared" | "session_only" | "failed";

export interface ConversationHistoryBridge {
  load(): Promise<LocalConversationLoadResult>;
  save(state: PersistedConversationState, revision: number): Promise<LocalConversationMutationResult>;
  clear(revision: number): Promise<LocalConversationMutationResult>;
}

/**
 * Renderer-side ordering only; encryption, validation and storage remain in the
 * main process. In-flight drafts never cross this boundary. At most one write
 * and one newer snapshot are retained, so a slow disk cannot grow an unbounded
 * queue of private conversations in memory.
 */
export class LocalConversationHistory {
  private bridge?: ConversationHistoryBridge;
  private revision = 0;
  private enabled = false;
  private clearing = false;
  private sealed = false;
  private lastQueued = "";
  private pending?: PersistedConversationState;
  private writing = false;
  private tail: Promise<void> = Promise.resolve();
  private initialization?: Promise<PersistedConversationState | null>;
  private clearInFlight?: Promise<ClearHistoryResult>;
  private status: ConversationHistoryStatus = "loading";

  constructor(
    private readonly getBridge: () => ConversationHistoryBridge | undefined,
    private readonly onStatus: (status: ConversationHistoryStatus) => void,
    private readonly initializationTimeoutMs = 5000,
  ) {}

  /** A late load after timeout cannot re-enable writes or replace a new session. */
  initialize(): Promise<PersistedConversationState | null> {
    this.initialization ??= this.loadOnce();
    return this.initialization;
  }

  private async loadOnce(): Promise<PersistedConversationState | null> {
    this.bridge = this.getBridge();
    if (!this.bridge) {
      this.setStatus("session_only");
      return null;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.bridge.load(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Local history initialization timed out.")), this.initializationTimeoutMs);
        }),
      ]);
      if (!result.ok) {
        this.setStatus(result.reason === "unavailable" ? "session_only" : "error");
        return null;
      }
      const valid = result.state === null ? null : PersistedConversationStateSchema.safeParse(result.state);
      if (!Number.isSafeInteger(result.revision) || result.revision < 0 ||
          (valid && !valid.success) || (result.state === null && result.revision !== 0) ||
          (result.state !== null && result.revision < 1)) {
        this.setStatus("error");
        return null;
      }
      const state = valid?.success ? valid.data : null;
      this.revision = result.revision;
      this.lastQueued = state ? JSON.stringify(state) : "";
      this.enabled = true;
      this.setStatus("saved");
      return state;
    } catch {
      this.setStatus("error");
      return null;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  record(state: ConversationState): void {
    if (!this.enabled || this.clearing || this.sealed) return;
    let snapshot: PersistedConversationState;
    try {
      snapshot = projectPersistedConversation(state);
    } catch {
      this.disable();
      return;
    }
    // An empty history is removed only by the explicit clear operation.
    if (!snapshot.turns.length) return;
    const serialized = JSON.stringify(snapshot);
    if (serialized === this.lastQueued) return;
    this.lastQueued = serialized;
    this.pending = snapshot;
    this.setStatus("saving");
    if (!this.writing) {
      this.writing = true;
      this.tail = this.writePending();
    }
  }

  private async writePending(): Promise<void> {
    try {
      while (this.enabled && this.pending && this.bridge) {
        const snapshot = this.pending;
        this.pending = undefined;
        const result = await this.bridge.save(snapshot, this.revision);
        if (!result.ok || result.revision !== this.revision + 1) {
          this.disable();
          return;
        }
        this.revision = result.revision;
      }
    } catch {
      this.disable();
    } finally {
      this.writing = false;
      if (this.enabled && !this.clearing) this.setStatus("saved");
    }
  }

  /** Wait for accepted writes before clearing. An error never discards live data. */
  clear(): Promise<ClearHistoryResult> {
    if (this.clearing || this.sealed) return Promise.resolve("failed");
    if (!this.enabled || !this.bridge) return Promise.resolve(this.status === "session_only" ? "session_only" : "failed");
    this.clearing = true;
    this.setStatus("clearing");
    this.clearInFlight = this.clearAfterWrites();
    return this.clearInFlight;
  }

  private async clearAfterWrites(): Promise<ClearHistoryResult> {
    try {
      await this.tail;
      if (!this.enabled || !this.bridge) return "failed";
      const result = await this.bridge.clear(this.revision);
      if (!result.ok || result.revision !== 0) {
        this.disable();
        return "failed";
      }
      this.revision = 0;
      this.lastQueued = "";
      this.setStatus("saved");
      return "cleared";
    } catch {
      this.disable();
      return "failed";
    } finally {
      this.clearing = false;
      this.clearInFlight = undefined;
    }
  }

  /** Drain writes accepted before shutdown; does not cancel or complete a task. */
  async sealAndFlush(): Promise<boolean> {
    this.sealed = true;
    if (this.initialization) await this.initialization;
    if (this.clearInFlight) await this.clearInFlight;
    await this.tail;
    return (this.enabled || this.status === "session_only") && !this.pending && !this.clearing;
  }

  /** A cancelled close allows new snapshots; failures remain visible and disabled. */
  resumeAfterCancelledClose(state: ConversationState): void {
    this.sealed = false;
    this.record(state);
  }

  /** Exposed for deterministic tests, not task completion. */
  async flush(): Promise<void> {
    await this.tail;
  }

  private disable(): void {
    this.enabled = false;
    this.pending = undefined;
    this.setStatus("error");
  }

  private setStatus(status: ConversationHistoryStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.onStatus(status);
  }
}
