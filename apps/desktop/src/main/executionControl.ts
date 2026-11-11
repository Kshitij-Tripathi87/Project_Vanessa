/**
 * Phase 2.3: Execution Control State Machine
 *
 * Manages task lifecycle: queued -> validating -> running -> done
 * Enforces permission tiers, handles timeouts, and manages confirmations.
 */

import { EventEmitter } from 'events';
import { TaskState, PermissionTier, createBaseMessage } from '@vanessa/protocol';
import { ToolRegistry } from './toolRegistry.js';
import crypto from 'crypto';

interface TaskContext {
  taskId: string;
  deviceId: string;
  tool: string;
  args: Record<string, unknown>;
  state: TaskState;
  tier: PermissionTier;
  idempotencyKey: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  result?: unknown;
  confirmationRequired?: boolean;
  confirmationHash?: string;
  confirmationExpiresAt?: number;
}

interface ExecutionConfig {
  confirmationTimeout: number; // ms
  maxConcurrentTasks: number;
  idempotencyWindow: number; // ms
}

const DEFAULT_CONFIG: ExecutionConfig = {
  confirmationTimeout: 60000, // 60s to confirm
  maxConcurrentTasks: 10,
  idempotencyWindow: 300000, // 5 minutes
};

/**
 * Execution Control - manages task execution lifecycle
 */
export class ExecutionControl extends EventEmitter {
  private tasks: Map<string, TaskContext> = new Map();
  private idempotencyCache: Map<string, { taskId: string; timestamp: number }> = new Map();
  private config: ExecutionConfig;
  private registry: ToolRegistry;

  constructor(registry: ToolRegistry, config: Partial<ExecutionConfig> = {}) {
    super();
    this.registry = registry;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Cleanup old idempotency keys periodically
    setInterval(() => this.cleanupIdempotencyCache(), 60000);
  }

  /**
   * Submit a new task for execution
   */
  async submitTask(
    deviceId: string,
    tool: string,
    args: Record<string, unknown>,
    idempotencyKey: string
  ): Promise<{ taskId: string; accepted: boolean; reason?: string }> {
    // Check idempotency
    const existing = this.checkIdempotency(idempotencyKey);
    if (existing) {
      console.log(`[Execution] Duplicate task ${idempotencyKey}, returning existing ${existing}`);
      return { taskId: existing, accepted: true };
    }

    // Check concurrent task limit
    const runningTasks = Array.from(this.tasks.values()).filter(
      t => t.state === 'running' || t.state === 'validating'
    );

    if (runningTasks.length >= this.config.maxConcurrentTasks) {
      return {
        taskId: '',
        accepted: false,
        reason: 'Max concurrent tasks reached',
      };
    }

    // Check if tool exists
    if (!this.registry.isToolAvailable(tool)) {
      return {
        taskId: '',
        accepted: false,
        reason: `Tool ${tool} not found or disabled`,
      };
    }

    // Get tool definition
    const toolImpl = this.registry.getTool(tool)!;
    const tier = toolImpl.definition.tier;

    // Create task
    const taskId = this.generateTaskId();
    const task: TaskContext = {
      taskId,
      deviceId,
      tool,
      args,
      state: 'queued',
      tier,
      idempotencyKey,
      createdAt: Date.now(),
    };

    this.tasks.set(taskId, task);
    this.idempotencyCache.set(idempotencyKey, { taskId, timestamp: Date.now() });

    console.log(`[Execution] Task ${taskId} submitted: ${tool} (${tier})`);

    // Emit accepted message
    this.emit('task-accepted', {
      deviceId,
      taskId,
    });

    // Start execution
    this.executeTask(taskId);

    return { taskId, accepted: true };
  }

  /**
   * Execute a task through its lifecycle
   */
  private async executeTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    try {
      // Move to validating
      this.updateTaskState(taskId, 'validating');

      // Check if T2 confirmation required
      if (task.tier === 'T2') {
        await this.requestConfirmation(taskId);
        return; // Wait for confirmation
      }

      // Move to running
      this.updateTaskState(taskId, 'running');
      task.startedAt = Date.now();

      // Execute tool
      const result = await this.registry.executeTool(task.tool, task.args);

      // Task completed successfully
      task.result = result;
      task.completedAt = Date.now();
      this.updateTaskState(taskId, 'done');

      this.emit('task-result', {
        deviceId: task.deviceId,
        taskId,
        result,
      });

    } catch (error: any) {
      console.error(`[Execution] Task ${taskId} failed:`, error);
      task.error = error.message || 'Unknown error';
      task.completedAt = Date.now();
      this.updateTaskState(taskId, 'failed');

      this.emit('task-error', {
        deviceId: task.deviceId,
        taskId,
        error: error.message,
      });
    }
  }

  /**
   * Request T2 confirmation from phone
   */
  private async requestConfirmation(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    this.updateTaskState(taskId, 'awaiting_confirm');

    // Generate action hash
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify({ tool: task.tool, args: task.args, taskId }));
    const actionHash = hash.digest('hex').substring(0, 32);

    task.confirmationRequired = true;
    task.confirmationHash = actionHash;
    task.confirmationExpiresAt = Date.now() + this.config.confirmationTimeout;

    // Create human-readable summary
    const summary = this.generateConfirmationSummary(task);

    this.emit('task-confirmation-required', {
      deviceId: task.deviceId,
      taskId,
      summary,
      actionHash,
      expiresAt: task.confirmationExpiresAt,
    });

    // Set timeout to auto-cancel if not confirmed
    setTimeout(() => {
      const current = this.tasks.get(taskId);
      if (current && current.state === 'awaiting_confirm') {
        console.log(`[Execution] Task ${taskId} confirmation timeout`);
        current.error = 'Confirmation timeout';
        this.updateTaskState(taskId, 'failed');

        this.emit('task-error', {
          deviceId: task.deviceId,
          taskId,
          error: 'Confirmation timeout',
        });
      }
    }, this.config.confirmationTimeout);
  }

  /**
   * Handle confirmation from phone
   */
  async handleConfirmation(
    taskId: string,
    approved: boolean,
    actionHash: string
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      console.error(`[Execution] Confirmation for unknown task ${taskId}`);
      return;
    }

    if (task.state !== 'awaiting_confirm') {
      console.error(`[Execution] Task ${taskId} not awaiting confirmation (state: ${task.state})`);
      return;
    }

    // Verify action hash
    if (actionHash !== task.confirmationHash) {
      console.error(`[Execution] Invalid confirmation hash for task ${taskId}`);
      task.error = 'Invalid confirmation';
      this.updateTaskState(taskId, 'failed');
      return;
    }

    // Check if expired
    if (Date.now() > task.confirmationExpiresAt!) {
      console.error(`[Execution] Confirmation expired for task ${taskId}`);
      task.error = 'Confirmation expired';
      this.updateTaskState(taskId, 'failed');
      return;
    }

    if (!approved) {
      console.log(`[Execution] Task ${taskId} denied by user`);
      task.error = 'User denied confirmation';
      this.updateTaskState(taskId, 'cancelled');

      this.emit('task-error', {
        deviceId: task.deviceId,
        taskId,
        error: 'User denied confirmation',
      });
      return;
    }

    // Approved - continue execution
    console.log(`[Execution] Task ${taskId} confirmed, executing`);
    this.executeTask(taskId);
  }

  /**
   * Cancel a running task
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return false;
    }

    if (task.state === 'done' || task.state === 'failed' || task.state === 'cancelled') {
      return false; // Already finished
    }

    console.log(`[Execution] Cancelling task ${taskId}`);
    task.error = 'Cancelled by user';
    task.completedAt = Date.now();
    this.updateTaskState(taskId, 'cancelled');

    this.emit('task-cancelled', {
      deviceId: task.deviceId,
      taskId,
    });

    return true;
  }

  /**
   * Update task state and emit progress
   */
  private updateTaskState(taskId: string, state: TaskState, message?: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.state = state;

    console.log(`[Execution] Task ${taskId} -> ${state}${message ? `: ${message}` : ''}`);

    this.emit('task-progress', {
      deviceId: task.deviceId,
      taskId,
      state,
      message,
    });
  }

  /**
   * Generate human-readable confirmation summary
   */
  private generateConfirmationSummary(task: TaskContext): string {
    switch (task.tool) {
      case 'delete_file': {
        const name = task.args.name;
        const folder = task.args.folder || 'unknown location';
        return `Delete file "${name}" from ${folder}`;
      }
      default:
        return `Execute ${task.tool}`;
    }
  }

  /**
   * Check idempotency
   */
  private checkIdempotency(key: string): string | null {
    const cached = this.idempotencyCache.get(key);
    if (!cached) return null;

    // Check if still in window
    if (Date.now() - cached.timestamp > this.config.idempotencyWindow) {
      this.idempotencyCache.delete(key);
      return null;
    }

    return cached.taskId;
  }

  /**
   * Cleanup old idempotency keys
   */
  private cleanupIdempotencyCache(): void {
    const now = Date.now();
    for (const [key, value] of this.idempotencyCache.entries()) {
      if (now - value.timestamp > this.config.idempotencyWindow) {
        this.idempotencyCache.delete(key);
      }
    }
  }

  /**
   * Generate unique task ID
   */
  private generateTaskId(): string {
    return crypto.randomUUID();
  }

  /**
   * Get task by ID
   */
  getTask(taskId: string): TaskContext | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get all tasks for a device
   */
  getDeviceTasks(deviceId: string): TaskContext[] {
    return Array.from(this.tasks.values()).filter(t => t.deviceId === deviceId);
  }

  /**
   * Get running task count
   */
  getRunningTaskCount(): number {
    return Array.from(this.tasks.values()).filter(
      t => t.state === 'running' || t.state === 'validating' || t.state === 'awaiting_confirm'
    ).length;
  }
}
