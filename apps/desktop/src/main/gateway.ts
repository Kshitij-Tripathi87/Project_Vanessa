/**
 * Phase 2.1: Gateway Server
 *
 * WebSocket gateway that handles connections from the Vanessa mobile app.
 * Runs on Tailscale mesh network for secure device-to-device communication.
 *
 * Architecture:
 * - Phone connects via WebSocket to PC's Tailscale IP
 * - All messages validated against protocol schemas
 * - Handles task lifecycle: submit -> accepted -> progress -> result
 * - Keepalive with ping/pong
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { parseProtocolMessage, ProtocolMessage, createBaseMessage } from '@vanessa/protocol';
import { EventEmitter } from 'events';

/**
 * Signature verification callback.
 *
 * The verifier receives the connection-level device id (the identity of the
 * socket) together with the parsed message. It returns that same device id
 * when the signature is valid, or null when the message is unauthorized,
 * stale, or replayed. The phone never asserts a tier or identity field in
 * the message body — the protocol schema is strict and carries no
 * `deviceId`, so identity must come from the pairing/verification layer,
 * not from untrusted payload fields.
 */
export type SignatureVerifier = (
  deviceId: string,
  message: ProtocolMessage & { signature?: string; nonce?: string },
) => Promise<string | null>;

interface GatewayConfig {
  port: number;
  host: string; // Network interface to bind to (Tailscale IP or 127.0.0.1)
  maxConnections: number;
  pingInterval: number; // ms
  messageTimeout: number; // ms
  maxMessagesPerSecond: number; // per-device sliding window
  maxPayload: number; // bytes, per-frame limit enforced by the WS library
}

const DEFAULT_CONFIG: GatewayConfig = {
  port: 8765,
  host: '127.0.0.1', // Bind to loopback by default; set to Tailscale IP for mesh
  maxConnections: 5, // Allow multiple phones
  pingInterval: 30000, // 30s
  messageTimeout: 60000, // 60s
  maxMessagesPerSecond: 10,
  maxPayload: 1024 * 1024, // 1 MB per protocol spec
};

interface ConnectedDevice {
  id: string;
  ws: WebSocket;
  lastPing: number;
  authenticated: boolean;
  messageTimestamps: number[]; // sliding window for rate limiting
}

/**
 * Gateway Server for Vanessa Mobile connections
 */
export class VanessaGateway extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private devices: Map<string, ConnectedDevice> = new Map();
  private pingTimer: NodeJS.Timeout | null = null;
  private config: GatewayConfig;
  private verifier: SignatureVerifier | null = null;
  private actualPort: number = 0;

  constructor(
    config: Partial<GatewayConfig> = {},
    verifier?: SignatureVerifier
  ) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.verifier = verifier ?? null;
  }

  /**
   * Start the gateway server
   */
  async start(): Promise<void> {
    if (this.wss) {
      throw new Error('Gateway already running');
    }

    // Create HTTP server
    this.httpServer = createServer((req, res) => {
      // Health check endpoint
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          connections: this.devices.size,
          uptime: process.uptime(),
        }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    // Create WebSocket server
    this.wss = new WebSocketServer({
      server: this.httpServer,
      maxPayload: this.config.maxPayload, // 1 MB per protocol spec
    });

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    // Start listening
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(this.config.port, this.config.host, () => {
        const addr = this.httpServer!.address();
        this.actualPort = typeof addr === 'object' && addr ? addr.port : this.config.port;
        console.log(`[Gateway] Listening on ${this.config.host}:${this.actualPort}`);
        resolve();
      });

      this.httpServer!.on('error', reject);
    });

    // Start ping timer
    this.startPingTimer();

    this.emit('started', { port: this.config.port });
  }

  /**
   * Stop the gateway server
   */
  async stop(): Promise<void> {
    if (!this.wss) {
      return;
    }

    // Stop ping timer
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    // Close all connections
    for (const [deviceId, device] of this.devices.entries()) {
      device.ws.close(1001, 'Server shutting down');
      this.devices.delete(deviceId);
    }

    // Close WebSocket server
    await new Promise<void>((resolve) => {
      this.wss!.close(() => {
        this.wss = null;
        resolve();
      });
    });

    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => {
          this.httpServer = null;
          resolve();
        });
      });
    }

    this.emit('stopped');
  }

  /**
   * Handle new WebSocket connection
   */
  private handleConnection(ws: WebSocket, req: any): void {
    // Check connection limit
    if (this.devices.size >= this.config.maxConnections) {
      ws.close(1008, 'Max connections reached');
      return;
    }

    const deviceId = this.generateDeviceId();
    const device: ConnectedDevice = {
      id: deviceId,
      ws,
      lastPing: Date.now(),
      authenticated: false,
      messageTimestamps: [],
    };

    this.devices.set(deviceId, device);

    console.log(`[Gateway] Device ${deviceId} connected (${this.devices.size} total)`);

    // Set up handlers
    ws.on('message', (data) => {
      this.handleMessage(deviceId, data);
    });

    ws.on('close', (code, reason) => {
      console.log(`[Gateway] Device ${deviceId} disconnected: ${code} ${reason}`);
      this.devices.delete(deviceId);
      this.emit('device-disconnected', { deviceId, code, reason: reason.toString() });
    });

    ws.on('error', (error) => {
      console.error(`[Gateway] Device ${deviceId} error:`, error);
      this.emit('device-error', { deviceId, error });
    });

    ws.on('pong', () => {
      device.lastPing = Date.now();
    });

    this.emit('device-connected', { deviceId });
  }

  /**
   * Handle incoming message from device
   */
  private async handleMessage(deviceId: string, data: any): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) {
      return;
    }

    try {
      // Parse as JSON
      const json = data.toString('utf8');

      // Validate size BEFORE parsing (plan: "Don't: parse before checking size")
      if (json.length > 1024 * 1024) {
        this.sendError(device, 'PAYLOAD_TOO_LARGE', 'Message exceeds 1 MB limit');
        return;
      }

      // Rate limiting per device (sliding 1s window)
      const now = Date.now();
      const windowStart = now - 1000;
      device.messageTimestamps = device.messageTimestamps.filter(
        t => t > windowStart
      );
      if (device.messageTimestamps.length >= this.config.maxMessagesPerSecond) {
        this.sendError(device, 'RATE_LIMITED', 'Too many messages');
        return;
      }
      device.messageTimestamps.push(now);

      // Parse and validate message
      const message = parseProtocolMessage(JSON.parse(json));

      // Verify signature if a verifier is configured.
      // Identity comes from the connection, not from the message body.
      if (this.verifier) {
        const verifiedDeviceId = await this.verifier(device.id, message);
        if (!verifiedDeviceId) {
          this.sendError(device, 'UNAUTHORIZED_DEVICE', 'Invalid signature, stale message, or replay');
          return;
        }
        // Rebind device id to the authenticated identity
        device.id = verifiedDeviceId;
        device.authenticated = true;
      }

      // Handle message by type
      this.handleProtocolMessage(device.id, message);

    } catch (error) {
      console.error(`[Gateway] Invalid message from ${deviceId}:`, error);
      this.sendError(device, 'INVALID_MESSAGE', 'Failed to parse message');
    }
  }

  /**
   * Handle validated protocol message
   */
  private handleProtocolMessage(deviceId: string, message: ProtocolMessage): void {
    const device = this.devices.get(deviceId);
    if (!device) {
      return;
    }

    switch (message.type) {
      case 'ping':
        // Respond with pong
        this.send(device, {
          ...createBaseMessage(),
          type: 'pong',
          receivedAt: Date.now(),
        });
        break;

      case 'task.submit':
        // Emit for execution control to handle
        this.emit('task-submit', {
          deviceId,
          message,
        });
        break;

      case 'task.confirm':
        // Confirmation from phone for T2 action
        this.emit('task-confirm', {
          deviceId,
          message,
        });
        break;

      case 'task.cancel':
        // Cancel running task
        this.emit('task-cancel', {
          deviceId,
          message,
        });
        break;

      default:
        console.warn(`[Gateway] Unknown message type from ${deviceId}:`, message.type);
        this.sendError(device, 'UNKNOWN_MESSAGE_TYPE', `Unsupported message type: ${message.type}`);
    }
  }

  /**
   * Send message to device
   */
  public sendToDevice(deviceId: string, message: ProtocolMessage): boolean {
    const device = this.devices.get(deviceId);
    if (!device) {
      console.error(`[Gateway] Device ${deviceId} not found`);
      return false;
    }

    return this.send(device, message);
  }

  /**
   * Broadcast message to all connected devices
   */
  public broadcast(message: ProtocolMessage): void {
    for (const device of this.devices.values()) {
      this.send(device, message);
    }
  }

  /**
   * Send message to a device
   */
  private send(device: ConnectedDevice, message: ProtocolMessage): boolean {
    try {
      const json = JSON.stringify(message);
      device.ws.send(json);
      return true;
    } catch (error) {
      console.error(`[Gateway] Failed to send to ${device.id}:`, error);
      return false;
    }
  }

  /**
   * Send error message to device
   */
  private sendError(device: ConnectedDevice, code: string, message: string): void {
    this.send(device, {
      ...createBaseMessage(),
      type: 'task.error',
      code: code as any,
      message,
    });
  }

  /**
   * Start ping timer to keep connections alive
   */
  private startPingTimer(): void {
    this.pingTimer = setInterval(() => {
      const now = Date.now();

      for (const [deviceId, device] of this.devices.entries()) {
        // Check if last ping is too old
        if (now - device.lastPing > this.config.pingInterval * 2) {
          console.warn(`[Gateway] Device ${deviceId} ping timeout, closing`);
          device.ws.close(1001, 'Ping timeout');
          this.devices.delete(deviceId);
          continue;
        }

        // Send ping
        try {
          device.ws.ping();
        } catch (error) {
          console.error(`[Gateway] Failed to ping ${deviceId}:`, error);
        }
      }
    }, this.config.pingInterval);
  }

  /**
   * Generate unique device ID
   */
  private generateDeviceId(): string {
    return `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get the actual port the server is listening on (useful when port 0 is
   * requested and the OS assigns a free port).
   */
  public getActualPort(): number {
    return this.actualPort;
  }

  /**
   * Get connected device count
   */
  public getDeviceCount(): number {
    return this.devices.size;
  }

  /**
   * Get connected device IDs
   */
  public getDeviceIds(): string[] {
    return Array.from(this.devices.keys());
  }

  /**
   * Check if device is connected
   */
  public isDeviceConnected(deviceId: string): boolean {
    return this.devices.has(deviceId);
  }
}
