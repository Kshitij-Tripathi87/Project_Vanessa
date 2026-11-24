type ShutdownGuard = () => boolean | Promise<boolean>;

/**
 * Conversation owners know about pending requests and microphone capture.
 * A retired owner can still have promise callbacks in flight, so replacement
 * is not proof that its work has drained. Keep its guard until the renderer
 * exits and require every owner to certify the drain.
 */
export class ConversationShutdownGate {
  private guard?: ShutdownGuard;
  private readonly retired = new Set<ShutdownGuard>();
  private hasMountedOwner = false;
  private version = 0;

  register(guard: ShutdownGuard): () => void {
    if (this.guard && this.guard !== guard) this.retired.add(this.guard);
    this.hasMountedOwner = true;
    this.guard = guard;
    this.version++;
    return () => {
      if (this.guard !== guard) return;
      this.retired.add(guard);
      this.guard = undefined;
      this.version++;
    };
  }

  async canSeal(): Promise<boolean> {
    // Before the first mount no conversation input is admitted. Thereafter a
    // mounted owner must exist; unmount alone does not fence async callbacks.
    if (!this.guard) return !this.hasMountedOwner;
    const version = this.version;
    const guards = new Set([this.guard, ...this.retired]);
    try {
      for (const guard of guards) {
        if (await guard() !== true || this.version !== version) return false;
      }
      return this.version === version;
    } catch {
      return false;
    }
  }
}

export const conversationShutdownGate = new ConversationShutdownGate();
