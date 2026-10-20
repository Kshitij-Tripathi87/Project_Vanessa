/**
 * Vanessa Resource Locking System
 * Strategy Brief (Page 17, 26, 43):
 * "Shared things get a lock. Network adapter, audio and each browser profile have one lock.
 * Two jobs wanting the same lock queue instead of fighting."
 * "A small cap on jobs at once: Start at four so a laptop stays responsive."
 */

export class ResourceLockManager {
  private activeLocks = new Map<string, string>(); // lockName -> taskId
  private waiters = new Map<string, Array<{ taskId: string; resolve: () => void }>>();
  private runningJobCount = 0;
  private readonly maxGlobalConcurrency: number = 4;
  private concurrencyWaiters: Array<() => void> = [];

  /**
   * Acquire a declared resource lock (e.g. 'network-adapter', 'browser-profile', 'audio')
   */
  async acquireLock(lockName: string, taskId: string): Promise<void> {
    if (!this.activeLocks.has(lockName)) {
      this.activeLocks.set(lockName, taskId);
      return;
    }

    if (this.activeLocks.get(lockName) === taskId) {
      return; // Already held by same task
    }

    // Queue waiting task
    return new Promise<void>((resolve) => {
      const queue = this.waiters.get(lockName) || [];
      queue.push({ taskId, resolve });
      this.waiters.set(lockName, queue);
    });
  }

  /**
   * Release a resource lock and grant to next waiter in FIFO order
   */
  releaseLock(lockName: string, taskId: string): void {
    if (this.activeLocks.get(lockName) !== taskId) {
      return;
    }

    const queue = this.waiters.get(lockName);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      this.activeLocks.set(lockName, next.taskId);
      next.resolve();
    } else {
      this.activeLocks.delete(lockName);
    }
  }

  /**
   * Release all locks held by a specific task (e.g. on completion, error, or kill switch)
   */
  releaseAllForTask(taskId: string): void {
    for (const [lockName, ownerTaskId] of this.activeLocks.entries()) {
      if (ownerTaskId === taskId) {
        this.releaseLock(lockName, taskId);
      }
    }
    // Remove from waiting queues
    for (const [lockName, queue] of this.waiters.entries()) {
      this.waiters.set(
        lockName,
        queue.filter((w) => w.taskId !== taskId)
      );
    }
  }

  /**
   * Concurrency gate: enforces global cap of 4 parallel running tasks
   */
  async acquireSlot(): Promise<void> {
    if (this.runningJobCount < this.maxGlobalConcurrency) {
      this.runningJobCount++;
      return;
    }

    return new Promise<void>((resolve) => {
      this.concurrencyWaiters.push(() => {
        this.runningJobCount++;
        resolve();
      });
    });
  }

  releaseSlot(): void {
    if (this.runningJobCount > 0) {
      this.runningJobCount--;
    }
    if (this.concurrencyWaiters.length > 0) {
      const next = this.concurrencyWaiters.shift()!;
      next();
    }
  }

  getHeldLocks(): Record<string, string> {
    return Object.fromEntries(this.activeLocks.entries());
  }

  getActiveSlotCount(): number {
    return this.runningJobCount;
  }
}

export const resourceLockManager = new ResourceLockManager();
