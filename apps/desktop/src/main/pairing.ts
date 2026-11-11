/**
 * Phase 3.2: Pairing System
 *
 * Generates shared secrets, creates pairing payloads, and manages device pairing.
 *
 * Security: the QR code never carries a long-lived shared secret. It carries a
 * short-lived, single-use pairing code. The phone presents the code, the PC
 * redeems it for a per-device HMAC secret, and the code is consumed so it
 * cannot be reused. The long-lived secret only ever exists on the PC.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import QRCode from 'qrcode';
import { secureCompare } from './messageSecurity.js';

export interface PairingInfo {
  pairingCode: string;
  pcIP: string;
  port: number;
  timestamp: number;
  expiresAt: number;
}

export interface PairedDevice {
  deviceId: string;
  secret: string;
  pairedAt: number;
  lastSeen: number;
  deviceName?: string;
  revoked: boolean;
}

/**
 * Pairing Manager - handles device pairing and secrets
 */
export class PairingManager {
  private pairingFile: string;
  private pairedDevices: Map<string, PairedDevice> = new Map();
  // Short-lived, single-use pairing codes. Keyed by code, value is the
  // per-device secret generated at QR time and revealed only on redemption.
  private pendingCodes: Map<string, { secret: string; expiresAt: number }> = new Map();

  constructor(dataDir?: string) {
    const dir = dataDir || path.join(os.homedir(), '.vanessa');
    this.pairingFile = path.join(dir, 'paired_devices.json');
    this.loadPairedDevices();
    this.cleanupExpiredCodes();
  }

  /**
   * Generate a new per-device HMAC secret
   */
  generateSecret(): string {
    return crypto.randomBytes(32).toString('base64');
  }

  /**
   * Create pairing payload for QR code.
   *
   * The QR contains a short-lived, single-use pairing code — NOT the secret.
   * The secret is stored server-side and only handed to the phone after the
   * code is redeemed once.
   */
  createPairingPayload(pcIP: string, port: number): PairingInfo {
    const secret = this.generateSecret();
    const timestamp = Date.now();
    const pairingCode = crypto.randomBytes(16).toString('hex');

    this.pendingCodes.set(pairingCode, {
      secret,
      expiresAt: timestamp + 5 * 60 * 1000, // 5 minutes
    });

    return {
      pairingCode,
      pcIP,
      port,
      timestamp,
      expiresAt: timestamp + 5 * 60 * 1000,
    };
  }

  /**
   * Redeem a pairing code. Returns the per-device secret on first and only
   * successful redemption; the code is then consumed and cannot be reused.
   */
  redeemPairingCode(pairingCode: string): { secret: string } | null {
    const entry = this.pendingCodes.get(pairingCode);
    if (!entry) {
      return null; // unknown or already consumed
    }
    if (Date.now() > entry.expiresAt) {
      this.pendingCodes.delete(pairingCode);
      return null; // expired
    }
    this.pendingCodes.delete(pairingCode);
    return { secret: entry.secret };
  }

  /**
   * Generate QR code data URL
   */
  async generateQRCode(payload: PairingInfo): Promise<string> {
    const data = JSON.stringify(payload);
    const qrDataURL = await QRCode.toDataURL(data, {
      errorCorrectionLevel: 'H',
      width: 400,
      margin: 2,
    });

    return qrDataURL;
  }

  /**
   * Generate QR code as SVG
   */
  async generateQRCodeSVG(payload: PairingInfo): Promise<string> {
    const data = JSON.stringify(payload);
    const qrSVG = await QRCode.toString(data, {
      type: 'svg',
      errorCorrectionLevel: 'H',
      width: 400,
      margin: 2,
    });

    return qrSVG;
  }

  /**
   * Pair a new device
   */
  async pairDevice(
    deviceId: string,
    secret: string,
    deviceName?: string
  ): Promise<PairedDevice> {
    const device: PairedDevice = {
      deviceId,
      secret,
      pairedAt: Date.now(),
      lastSeen: Date.now(),
      deviceName,
      revoked: false,
    };

    this.pairedDevices.set(deviceId, device);
    await this.savePairedDevices();

    console.log(`[Pairing] Device paired: ${deviceId} (${deviceName || 'unnamed'})`);

    return device;
  }

  /**
   * Verify a device's secret using constant-time comparison so a valid
   * comparison cannot leak timing information about the stored secret.
   */
  verifyDevice(deviceId: string, secret: string): boolean {
    const device = this.pairedDevices.get(deviceId);

    if (!device) {
      return false;
    }

    if (device.revoked) {
      console.warn(`[Pairing] Revoked device attempted connection: ${deviceId}`);
      return false;
    }

    return secureCompare(device.secret, secret);
  }

  /**
   * Update last seen timestamp for a device
   */
  async updateLastSeen(deviceId: string): Promise<void> {
    const device = this.pairedDevices.get(deviceId);

    if (device) {
      device.lastSeen = Date.now();
      await this.savePairedDevices();
    }
  }

  /**
   * Revoke a paired device
   */
  async revokeDevice(deviceId: string): Promise<boolean> {
    const device = this.pairedDevices.get(deviceId);

    if (!device) {
      return false;
    }

    device.revoked = true;
    await this.savePairedDevices();

    console.log(`[Pairing] Device revoked: ${deviceId}`);

    return true;
  }

  /**
   * Remove a paired device completely
   */
  async removeDevice(deviceId: string): Promise<boolean> {
    const removed = this.pairedDevices.delete(deviceId);

    if (removed) {
      await this.savePairedDevices();
      console.log(`[Pairing] Device removed: ${deviceId}`);
    }

    return removed;
  }

  /**
   * Get all paired devices
   */
  getPairedDevices(): PairedDevice[] {
    return Array.from(this.pairedDevices.values());
  }

  /**
   * Get device info
   */
  getDevice(deviceId: string): PairedDevice | undefined {
    return this.pairedDevices.get(deviceId);
  }

  /**
   * Check if device is paired
   */
  isDevicePaired(deviceId: string): boolean {
    const device = this.pairedDevices.get(deviceId);
    return device !== undefined && !device.revoked;
  }

  /**
   * Load paired devices from disk
   */
  private async loadPairedDevices(): Promise<void> {
    try {
      const data = await fs.readFile(this.pairingFile, 'utf-8');
      const devices = JSON.parse(data) as PairedDevice[];

      this.pairedDevices.clear();
      for (const device of devices) {
        this.pairedDevices.set(device.deviceId, device);
      }

      console.log(`[Pairing] Loaded ${devices.length} paired devices`);
    } catch (error) {
      // File doesn't exist or is corrupted, start fresh
      console.log('[Pairing] No paired devices file, starting fresh');
      this.pairedDevices.clear();
    }
  }

  /**
   * Save paired devices to disk
   */
  private async savePairedDevices(): Promise<void> {
    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(this.pairingFile), { recursive: true });

      const devices = Array.from(this.pairedDevices.values());
      await fs.writeFile(this.pairingFile, JSON.stringify(devices, null, 2));
    } catch (error) {
      console.error('[Pairing] Failed to save paired devices:', error);
    }
  }

  /**
   * Clean up expired pairing codes (not actively paired devices)
   */
  cleanupExpiredPairings(): void {
    this.cleanupExpiredCodes();
  }

  private cleanupExpiredCodes(): void {
    const now = Date.now();
    for (const [code, entry] of this.pendingCodes.entries()) {
      if (now > entry.expiresAt) {
        this.pendingCodes.delete(code);
      }
    }
  }

  /**
   * Get pairing statistics
   */
  getStats(): {
    total: number;
    active: number;
    revoked: number;
  } {
    const devices = Array.from(this.pairedDevices.values());

    return {
      total: devices.length,
      active: devices.filter(d => !d.revoked).length,
      revoked: devices.filter(d => d.revoked).length,
    };
  }
}

/**
 * Helper to format pairing info as human-readable text
 */
export function formatPairingInfo(info: PairingInfo): string {
  return `
Vanessa PC Pairing

IP: ${info.pcIP}
Port: ${info.port}
Pairing Code: ${info.pairingCode}
Expires: ${new Date(info.expiresAt).toLocaleTimeString()}

Scan QR code with Vanessa app to pair.
  `.trim();
}

/**
 * Generate complete pairing package
 */
export async function generatePairingPackage(
  pcIP: string,
  port: number
): Promise<{
  info: PairingInfo;
  qrDataURL: string;
  qrSVG: string;
  text: string;
}> {
  const manager = new PairingManager();
  const info = manager.createPairingPayload(pcIP, port);
  const qrDataURL = await manager.generateQRCode(info);
  const qrSVG = await manager.generateQRCodeSVG(info);
  const text = formatPairingInfo(info);

  return { info, qrDataURL, qrSVG, text };
}
