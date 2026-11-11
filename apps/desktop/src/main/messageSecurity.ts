/**
 * Phase 3.3: Message Signing and Security
 *
 * HMAC-SHA256 signing for all protocol messages.
 * Prevents tampering, replay attacks, and unauthorized access.
 */

import crypto from 'crypto';

export interface SignedMessage {
  payload: any;
  signature: string;
  timestamp: number;
  nonce: string;
}

export interface SecurityConfig {
  maxMessageAge: number; // ms
  replayWindowSize: number; // number of recent nonces to track
}

const DEFAULT_CONFIG: SecurityConfig = {
  maxMessageAge: 60000, // 60 seconds
  replayWindowSize: 1000, // track last 1000 nonces
};

/**
 * Message Signer - handles HMAC-SHA256 signing and verification
 */
export class MessageSigner {
  private config: SecurityConfig;
  private recentNonces: Set<string> = new Set();
  private nonceQueue: string[] = [];

  constructor(config: Partial<SecurityConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Sign a message with HMAC-SHA256
   */
  sign(payload: any, secret: string): SignedMessage {
    const timestamp = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');

    // Create canonical representation
    const canonical = JSON.stringify({
      payload,
      timestamp,
      nonce,
    });

    // Generate HMAC signature
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(canonical);
    const signature = hmac.digest('hex');

    return {
      payload,
      signature,
      timestamp,
      nonce,
    };
  }

  /**
   * Verify a signed message
   */
  verify(
    message: SignedMessage,
    secret: string
  ): {
    valid: boolean;
    error?: 'invalid_signature' | 'stale_message' | 'replayed_message';
  } {
    // Check message age
    const age = Date.now() - message.timestamp;
    if (age > this.config.maxMessageAge) {
      return { valid: false, error: 'stale_message' };
    }

    if (age < -5000) {
      // Message from future (allow 5s clock skew)
      return { valid: false, error: 'stale_message' };
    }

    // Check for replay attack
    if (this.recentNonces.has(message.nonce)) {
      return { valid: false, error: 'replayed_message' };
    }

    // Verify signature
    const canonical = JSON.stringify({
      payload: message.payload,
      timestamp: message.timestamp,
      nonce: message.nonce,
    });

    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(canonical);
    const expectedSignature = hmac.digest('hex');

    if (message.signature !== expectedSignature) {
      return { valid: false, error: 'invalid_signature' };
    }

    // Add nonce to replay prevention set
    this.addNonce(message.nonce);

    return { valid: true };
  }

  /**
   * Add nonce to replay prevention tracking
   */
  private addNonce(nonce: string): void {
    this.recentNonces.add(nonce);
    this.nonceQueue.push(nonce);

    // Limit set size
    if (this.nonceQueue.length > this.config.replayWindowSize) {
      const oldNonce = this.nonceQueue.shift()!;
      this.recentNonces.delete(oldNonce);
    }
  }

  /**
   * Clear replay prevention tracking
   */
  clearNonces(): void {
    this.recentNonces.clear();
    this.nonceQueue = [];
  }

  /**
   * Get statistics
   */
  getStats(): {
    trackedNonces: number;
    maxAge: number;
  } {
    return {
      trackedNonces: this.recentNonces.size,
      maxAge: this.config.maxMessageAge,
    };
  }
}

/**
 * Security Manager - coordinates signing, verification, and device authentication
 */
export class SecurityManager {
  private signer: MessageSigner;
  private deviceSecrets: Map<string, string> = new Map();

  constructor(config: Partial<SecurityConfig> = {}) {
    this.signer = new MessageSigner(config);
  }

  /**
   * Register a device with its secret
   */
  registerDevice(deviceId: string, secret: string): void {
    this.deviceSecrets.set(deviceId, secret);
    console.log(`[Security] Device registered: ${deviceId}`);
  }

  /**
   * Unregister a device
   */
  unregisterDevice(deviceId: string): void {
    this.deviceSecrets.delete(deviceId);
    console.log(`[Security] Device unregistered: ${deviceId}`);
  }

  /**
   * Sign a message for a specific device
   */
  signForDevice(deviceId: string, payload: any): SignedMessage | null {
    const secret = this.deviceSecrets.get(deviceId);

    if (!secret) {
      console.error(`[Security] No secret for device: ${deviceId}`);
      return null;
    }

    return this.signer.sign(payload, secret);
  }

  /**
   * Verify a message from a device
   */
  verifyFromDevice(
    deviceId: string,
    message: SignedMessage
  ): {
    valid: boolean;
    error?: string;
  } {
    const secret = this.deviceSecrets.get(deviceId);

    if (!secret) {
      return { valid: false, error: 'unauthorized_device' };
    }

    const result = this.signer.verify(message, secret);

    if (!result.valid) {
      return { valid: false, error: result.error };
    }

    return { valid: true };
  }

  /**
   * Check if device is registered
   */
  isDeviceRegistered(deviceId: string): boolean {
    return this.deviceSecrets.has(deviceId);
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      registeredDevices: this.deviceSecrets.size,
      signer: this.signer.getStats(),
    };
  }
}

/**
 * Helper to wrap protocol message with signature
 */
export function wrapMessage(
  protocolMessage: any,
  secret: string,
  signer: MessageSigner = new MessageSigner()
): SignedMessage {
  return signer.sign(protocolMessage, secret);
}

/**
 * Helper to unwrap and verify signed message
 */
export function unwrapMessage(
  signedMessage: SignedMessage,
  secret: string,
  signer: MessageSigner = new MessageSigner()
): {
  valid: boolean;
  payload?: any;
  error?: string;
} {
  const result = signer.verify(signedMessage, secret);

  if (!result.valid) {
    return { valid: false, error: result.error };
  }

  return {
    valid: true,
    payload: signedMessage.payload,
  };
}

/**
 * Generate a secure random secret
 */
export function generateSecret(bytes: number = 32): string {
  return crypto.randomBytes(bytes).toString('base64');
}

/**
 * Hash a secret for storage (not used for HMAC)
 */
export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

/**
 * Constant-time comparison to prevent timing attacks
 */
export function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
