/**
 * Phase 2: PC Agent Core - Integration
 *
 * Wires together Gateway, ToolRegistry, ExecutionControl, and AuditLog
 * into a complete PC agent system.
 */

import { VanessaGateway, SignatureVerifier, PairingRedeemer } from './gateway.js';
import crypto from 'crypto';
import os from 'os';
import { ToolRegistry, createToolDefinition } from './toolRegistry.js';
import { ExecutionControl } from './executionControl.js';
import { AuditLog } from './auditLog.js';
import { SecurityManager } from './messageSecurity.js';
import { PairingManager } from './pairing.js';
import * as tools from './tools.js';
import { getTailscaleIP } from './tailscale.js';
import { EventEmitter } from 'events';

/**
 * Vanessa PC Agent - complete system integration
 */
export class VanessaPCAgent extends EventEmitter {
  private gateway: VanessaGateway;
  private registry: ToolRegistry;
  private execution: ExecutionControl;
  private audit: AuditLog;
  private security: SecurityManager;
  private pairing: PairingManager;
  private verifier: SignatureVerifier | null = null;
  private running: boolean = false;

  /**
   * Exchange a single-use pairing code for a per-device secret.
   *
   * The code itself is never a credential: it expires after 5 minutes and is
   * consumed on first use. On success the PC mints a device id, registers the
   * secret for signature verification, and persists the pairing so the phone
   * can reconnect after a restart.
   */
  private redeemPairingCode: PairingRedeemer = async ({ pairingCode, deviceName }) => {
    const redeemed = this.pairing.redeemPairingCode(pairingCode);
    if (!redeemed) {
      return null;
    }

    const deviceId = `device_${crypto.randomUUID()}`;
    this.security.registerDevice(deviceId, redeemed.secret);
    await this.pairing.pairDevice(deviceId, redeemed.secret, deviceName);

    console.log(`[Agent] Paired device ${deviceId}${deviceName ? ` (${deviceName})` : ''}`);
    this.emit('device-paired', { deviceId, deviceName });

    return { deviceId, secret: redeemed.secret, pcName: os.hostname() };
  };

  constructor() {
    super();

    // Initialize components
    this.registry = new ToolRegistry();
    this.execution = new ExecutionControl(this.registry);
    this.audit = new AuditLog();
    this.security = new SecurityManager();
    this.pairing = new PairingManager();

    // Wire signature verification into the gateway.
    // The verifier is called with the device id the socket claimed during the
    // WebSocket upgrade and the parsed message. It returns that id when the
    // signature is valid, or null when it is invalid, stale (>60s) or a
    // replay. The signature covers the message minus its own `signature`
    // field, so verification can reproduce the signed bytes.
    this.verifier = async (deviceId, message) => {
      const result = this.security.verifyFromDevice(deviceId, message as unknown as Record<string, unknown>);
      return result.valid ? deviceId : null;
    };

    // Re-register secrets for devices paired in an earlier run so they can
    // authenticate immediately after a restart.
    for (const device of this.pairing.getPairedDevices()) {
      if (!device.revoked) {
        this.security.registerDevice(device.deviceId, device.secret);
      }
    }

    this.gateway = new VanessaGateway({}, this.verifier, this.redeemPairingCode);

    // Register all tools
    this.registerAllTools();

    // Wire up event handlers
    this.setupEventHandlers();
  }

  /**
   * Register all 10 tools from Phase 2.4
   */
  private registerAllTools(): void {
    // T0 Tools (Auto - read-only)
    this.registry.registerTool(
      createToolDefinition(
        'system_status',
        'Get current PC system status (battery, CPU, disk, memory)',
        {
          type: 'object',
          properties: {
            metric: {
              type: 'string',
              enum: ['battery', 'cpu', 'disk', 'memory', 'all'],
            },
          },
        },
        'T0',
        { idempotent: true, timeout: 10 }
      ),
      tools.systemStatus
    );

    this.registry.registerTool(
      createToolDefinition(
        'find_file',
        'Search for files by name, type, folder, or modification date',
        {
          type: 'object',
          properties: {
            query: { type: 'string' },
            type: { type: 'string', enum: ['pdf', 'image', 'video', 'doc', 'sheet', 'any'] },
            folder: { type: 'string', enum: ['downloads', 'documents', 'desktop', 'pictures', 'videos', 'any'] },
            since: { type: 'string', enum: ['today', 'yesterday', 'week', 'month', 'any'] },
          },
        },
        'T0',
        { idempotent: true, timeout: 30 }
      ),
      tools.findFile
    );

    this.registry.registerTool(
      createToolDefinition(
        'escalate',
        'Escalate to PC brain for complex queries, multi-step tasks, or unsupported commands',
        {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              enum: ['chat', 'multi_step', 'unsupported', 'unsafe', 'unclear'],
            },
          },
          required: ['reason'],
        },
        'T0',
        { idempotent: true, timeout: 5 }
      ),
      tools.escalate
    );

    // T1 Tools (Auto, logged)
    this.registry.registerTool(
      createToolDefinition(
        'open_app',
        'Open an application on the PC',
        {
          type: 'object',
          properties: {
            app: { type: 'string' },
          },
          required: ['app'],
        },
        'T1',
        { idempotent: false, timeout: 10 }
      ),
      tools.openApp
    );

    this.registry.registerTool(
      createToolDefinition(
        'open_url',
        'Open a URL or search query in the default browser',
        {
          type: 'object',
          properties: {
            target: { type: 'string' },
            query: { type: 'string' },
          },
          required: ['target'],
        },
        'T1',
        { idempotent: false, timeout: 10 }
      ),
      tools.openUrl
    );

    this.registry.registerTool(
      createToolDefinition(
        'media_control',
        'Control media playback (play, pause, next, previous)',
        {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['play', 'pause', 'next', 'previous', 'toggle'],
            },
          },
          required: ['action'],
        },
        'T1',
        { idempotent: false, timeout: 5 }
      ),
      tools.mediaControl
    );

    this.registry.registerTool(
      createToolDefinition(
        'set_volume',
        'Control system volume',
        {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['set', 'up', 'down', 'mute', 'unmute'],
            },
            level: {
              type: 'integer',
              minimum: 0,
              maximum: 100,
            },
          },
          required: ['mode'],
        },
        'T1',
        { idempotent: false, timeout: 5 }
      ),
      tools.setVolume
    );

    this.registry.registerTool(
      createToolDefinition(
        'lock_pc',
        'Lock the computer screen',
        {
          type: 'object',
          properties: {},
        },
        'T1',
        { idempotent: true, timeout: 5 }
      ),
      tools.lockPc
    );

    this.registry.registerTool(
      createToolDefinition(
        'take_screenshot',
        'Take a screenshot of the screen or active window',
        {
          type: 'object',
          properties: {
            target: {
              type: 'string',
              enum: ['screen', 'active_window'],
            },
          },
        },
        'T1',
        { idempotent: false, timeout: 10 }
      ),
      tools.takeScreenshot
    );

    this.registry.registerTool(
      createToolDefinition(
        'open_file',
        'Open a specific file with its default application',
        {
          type: 'object',
          properties: {
            name: { type: 'string' },
            folder: { type: 'string', enum: ['downloads', 'documents', 'desktop', 'pictures', 'videos', 'any'] },
          },
          required: ['name'],
        },
        'T1',
        { idempotent: false, timeout: 10 }
      ),
      tools.openFile
    );

    // T2 Tools (Confirm - destructive)
    this.registry.registerTool(
      createToolDefinition(
        'delete_file',
        'Delete a file (REQUIRES CONFIRMATION)',
        {
          type: 'object',
          properties: {
            name: { type: 'string' },
            folder: { type: 'string', enum: ['downloads', 'documents', 'desktop', 'pictures', 'videos'] },
          },
          required: ['name'],
        },
        'T2',
        { idempotent: true, timeout: 10 }
      ),
      tools.deleteFile
    );

    console.log(`[Agent] Registered ${this.registry.getToolCount()} tools`);
  }

  /**
   * Wire up event handlers between components
   */
  private setupEventHandlers(): void {
    // Gateway -> Execution: task submission
    this.gateway.on('task-submit', async ({ deviceId, message }) => {
      const { tool, args, idempotencyKey } = message;

      try {
        const result = await this.execution.submitTask(deviceId, tool, args, idempotencyKey);

        if (result.accepted) {
          // Send acceptance
          this.gateway.sendToDevice(deviceId, {
            ...message,
            type: 'task.accepted',
            taskId: result.taskId,
          });
        } else {
          // Send error
          this.gateway.sendToDevice(deviceId, {
            ...message,
            type: 'task.error',
            code: 'TASK_FAILED',
            message: result.reason || 'Task submission failed',
          });
        }
      } catch (error: any) {
        console.error('[Agent] Task submission error:', error);
        this.gateway.sendToDevice(deviceId, {
          ...message,
          type: 'task.error',
          code: 'INTERNAL_ERROR',
          message: error.message,
        });
      }
    });

    // Gateway -> Execution: confirmation
    this.gateway.on('task-confirm', ({ deviceId, message }) => {
      const { taskId, approved, actionHash } = message;
      this.execution.handleConfirmation(taskId, approved, actionHash);
    });

    // Gateway -> Execution: cancellation
    this.gateway.on('task-cancel', ({ deviceId, message }) => {
      const { taskId } = message;
      this.execution.cancelTask(taskId);
    });

    // Execution -> Gateway: progress updates
    this.execution.on('task-progress', ({ deviceId, taskId, state, message }) => {
      this.gateway.sendToDevice(deviceId, {
        ...this.createBaseMessage(),
        type: 'task.progress',
        taskId,
        state,
        message,
        // The protocol requires a per-message nonce on progress frames so the
        // phone can reject duplicates; outbound frames are not HMAC-signed.
        nonce: crypto.randomUUID(),
      });
    });

    // Execution -> Gateway: confirmation required
    this.execution.on('task-confirmation-required', ({ deviceId, taskId, summary, actionHash, expiresAt }) => {
      this.gateway.sendToDevice(deviceId, {
        ...this.createBaseMessage(),
        type: 'task.confirm_required',
        taskId,
        summary,
        actionHash,
        expiresAt,
      });
    });

    // Execution -> Gateway: result
    this.execution.on('task-result', ({ deviceId, taskId, result }) => {
      const task = this.execution.getTask(taskId);

      // Log to audit
      if (task) {
        this.audit.logExecution({
          timestamp: task.createdAt,
          deviceId,
          taskId,
          tool: task.tool,
          tier: task.tier,
          args: JSON.stringify(task.args),
          result: JSON.stringify(result),
          duration: Date.now() - task.createdAt,
          confirmed: task.confirmationRequired,
        });
      }

      // Send result
      this.gateway.sendToDevice(deviceId, {
        ...this.createBaseMessage(),
        type: 'task.result',
        taskId,
        status: 'done',
        result,
      });
    });

    // Execution -> Gateway: error
    this.execution.on('task-error', ({ deviceId, taskId, error }) => {
      const task = this.execution.getTask(taskId);

      // Log to audit
      if (task) {
        this.audit.logExecution({
          timestamp: task.createdAt,
          deviceId,
          taskId,
          tool: task.tool,
          tier: task.tier,
          args: JSON.stringify(task.args),
          error,
          duration: Date.now() - task.createdAt,
          confirmed: task.confirmationRequired,
        });
      }

      // Send error
      this.gateway.sendToDevice(deviceId, {
        ...this.createBaseMessage(),
        type: 'task.error',
        taskId,
        code: 'TASK_FAILED',
        message: error,
      });
    });

    // Gateway events
    this.gateway.on('device-connected', ({ deviceId }) => {
      console.log(`[Agent] Device connected: ${deviceId}`);

      // Send manifest to new device
      const manifest = this.registry.generateManifestMessage();
      this.gateway.sendToDevice(deviceId, manifest);

      this.emit('device-connected', { deviceId });
    });

    this.gateway.on('device-disconnected', ({ deviceId }) => {
      console.log(`[Agent] Device disconnected: ${deviceId}`);
      this.emit('device-disconnected', { deviceId });
    });
  }

  /**
   * Start the PC agent
   */
  async start(port: number = 8765): Promise<void> {
    if (this.running) {
      throw new Error('Agent already running');
    }

    console.log('[Agent] Starting Vanessa PC Agent...');

    // Bind the gateway to the Tailscale mesh IP when available so the phone
    // can reach the PC over the secure Tailscale network. Falls back to
    // loopback if Tailscale is not running (e.g. during local development).
    let host = '127.0.0.1';
    const tailscaleIP = await getTailscaleIP();
    if (tailscaleIP) {
      host = tailscaleIP;
      console.log(`[Agent] Binding gateway to Tailscale IP: ${host}`);
    } else {
      console.log('[Agent] Tailscale not available, binding to loopback');
    }

    // Rebuild the gateway with the resolved host and re-wire event handlers
    // so the new server instance receives the agent's task/lifecycle events.
    await this.gateway.stop();
    this.gateway = new VanessaGateway({ port, host }, this.verifier ?? undefined, this.redeemPairingCode);
    this.setupEventHandlers();

    // Start gateway
    await this.gateway.start();

    this.running = true;
    console.log('[Agent] Vanessa PC Agent started');
    console.log(`[Agent] - Gateway: ws://${host}:${port}`);
    console.log(`[Agent] - Tools: ${this.registry.getToolCount()} registered`);

    this.emit('started');
  }

  /**
   * Stop the PC agent
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    console.log('[Agent] Stopping Vanessa PC Agent...');

    await this.gateway.stop();
    this.audit.close();

    this.running = false;
    console.log('[Agent] Vanessa PC Agent stopped');

    this.emit('stopped');
  }

  /**
   * Create a pairing payload plus QR codes for the desktop UI.
   *
   * The QR carries the short-lived pairing code, never the secret; the phone
   * redeems it at `POST /pair` and receives its own secret in response.
   */
  async createPairing(pcIP?: string, port: number = 8765) {
    const host = pcIP ?? (await getTailscaleIP()) ?? '127.0.0.1';
    const payload = this.pairing.createPairingPayload(host, port);
    const [qrDataUrl, qrSvg] = await Promise.all([
      this.pairing.generateQRCode(payload),
      this.pairing.generateQRCodeSVG(payload),
    ]);

    return { payload, qrDataUrl, qrSvg };
  }

  /**
   * Get agent statistics
   */
  getStats() {
    return {
      gateway: {
        connections: this.gateway.getDeviceCount(),
        devices: this.gateway.getDeviceIds(),
      },
      registry: {
        tools: this.registry.getToolCount(),
        enabled: this.registry.getEnabledToolCount(),
      },
      execution: {
        running: this.execution.getRunningTaskCount(),
      },
      audit: this.audit.getStats(),
    };
  }

  /**
   * Helper to create base message
   */
  private createBaseMessage() {
    return {
      v: 1 as const,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    };
  }

  /**
   * Get audit log
   */
  getAuditLog() {
    return this.audit;
  }

  /**
   * Get tool registry
   */
  getRegistry() {
    return this.registry;
  }
}
