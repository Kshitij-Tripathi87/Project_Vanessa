import type { ConversationState } from "@vanessa/protocol/conversation";

/** Coordinates close attempts, including a timeout followed by "keep open". */
export class HistoryShutdownCoordinator {
  private generation = 0;

  constructor(
    private readonly gate: { canSeal(): Promise<boolean> },
    private readonly history: {
      sealAndFlush(): Promise<boolean>;
      resumeAfterCancelledClose(state: ConversationState): void;
    },
    private readonly setClosing: (closing: boolean) => void,
    private readonly currentState: () => ConversationState,
  ) {}

  async request(): Promise<boolean> {
    const attempt = ++this.generation;
    this.setClosing(true);
    const safe = await this.gate.canSeal();
    // The main process may time out while a guard is pending. A late guard
    // must not seal history after the user chose to keep the window open.
    if (!safe || attempt !== this.generation) return false;
    const flushed = await this.history.sealAndFlush();
    return attempt === this.generation && flushed;
  }

  cancel(): void {
    this.generation++;
    this.setClosing(false);
    this.history.resumeAfterCancelledClose(this.currentState());
  }
}
