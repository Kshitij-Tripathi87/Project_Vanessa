/**
 * Vanessa Resource Locking System
 * Strategy Brief (Page 17, 26, 43):
 * "Shared things get a lock. Network adapter, audio and each browser profile have one lock.
 * Two jobs wanting the same lock queue instead of fighting."
 * "A small cap on jobs at once: Start at four so a laptop stays responsive."
 */

export class ResourceLockManager {
  private activeLocks = new Map<string, string>(); // lockName -> taskId
  private waiters = new Map<string, Array<{ taskId: string; resolve: (acquired: boolean) => void }>>();
  private runningJobCount = 0;
  private readonly maxGlobalConcurrency: number = 4;
  private concurrencyWaiters: Array<{ taskId?: string; resolve: (acquired: boolean) => void }> = [];

  /**
   * Acquire a declared resource lock (e.g. 'network-adapter', 'browser-profile', 'audio')
   */
  async acquireLock(lockName: string, taskId: string): Promise<boolean> {
    if (!this.activeLocks.has(lockName)) {
      this.activeLocks.set(lockName, taskId);
      return true;
    }

    if (this.activeLocks.get(lockName) === taskId) {
      return true; // Already held by same task
    }

    // A cancelled waiter is resolved with false instead of being silently
    // removed from the queue. This lets the task runner unwind its slot and
    // process reservation without pretending it ever acquired the lock.
    return new Promise<boolean>((resolve) => {
      const queue = this.waiters.get(lockName) || [];
      queue.push({ taskId, resolve });
      this.waiters.set(lockName, queue);
    });
  }

  /**
   * Release a resource lock and grant to next waiter in FIFO order.
   */
  releaseLock(lockName: string, taskId: string): void {
    if (this.activeLocks.get(lockName) !== taskId) return;

    const queue = this.waiters.get(lockName);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) this.waiters.delete(lockName);
      this.activeLocks.set(lockName, next.taskId);
      next.resolve(true);
    } else {
      this.waiters.delete(lockName);
      this.activeLocks.delete(lockName);
    }
  }

  /**
   * Remove a task from all active/waiting resources. Waiting acquisitions are
   * explicitly resolved as not acquired, so callers can exit cancellation
   * paths instead of remaining suspended forever.
   */
  releaseAllForTask(taskId: string): void {
    for (const [lockName, ownerTaskId] of [...this.activeLocks.entries()]) {
      if (ownerTaskId === taskId) this.releaseLock(lockName, taskId);
    }

    for (const [lockName, queue] of this.waiters.entries()) {
      const remaining: Array<{ taskId: string; resolve: (acquired: boolean) => void }> = [];
      for (const waiter of queue) {
        if (waiter.taskId === taskId) waiter.resolve(false);
        else remaining.push(waiter);
      }
      if (remaining.length) this.waiters.set(lockName, remaining);
      else this.waiters.delete(lockName);
    }

    const remainingSlotWaiters: Array<{ taskId?: string; resolve: (acquired: boolean) => void }> = [];
    for (const waiter of this.concurrencyWaiters) {
      if (waiter.taskId === taskId) waiter.resolve(false);
      else remainingSlotWaiters.push(waiter);
    }
    this.concurrencyWaiters = remainingSlotWaiters;
  }

  /**
   * Concurrency gate: enforces global cap of four parallel running tasks.
   * A cancelled waiter resolves false and never consumes a slot.
   */
  async acquireSlot(taskId?: string): Promise<boolean> {
    if (this.runningJobCount < this.maxGlobalConcurrency) {
      this.runningJobCount++;
      return true;
    }

    return new Promise<boolean>((resolve) => {
      this.concurrencyWaiters.push({ taskId, resolve });
    });
  }

  releaseSlot(): void {
    if (this.runningJobCount > 0) this.runningJobCount--;
    if (this.concurrencyWaiters.length > 0) {
      const next = this.concurrencyWaiters.shift()!;
      this.runningJobCount++;
      next.resolve(true);
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
