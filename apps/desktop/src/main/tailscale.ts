/**
 * Phase 3.1: Tailscale Integration
 *
 * Handles Tailscale mesh network setup and IP address discovery.
 * Ensures the gateway only listens on the Tailscale interface.
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface TailscaleInfo {
  installed: boolean;
  running: boolean;
  ip: string | null;
  hostname: string | null;
  version: string | null;
}

/**
 * Check if Tailscale is installed and running
 */
export async function checkTailscale(): Promise<TailscaleInfo> {
  const info: TailscaleInfo = {
    installed: false,
    running: false,
    ip: null,
    hostname: null,
    version: null,
  };

  try {
    // Check if Tailscale is installed
    const { stdout: versionOutput } = await execAsync('tailscale version');
    info.installed = true;
    info.version = versionOutput.trim().split('\n')[0];

    // Check if Tailscale is running
    const { stdout: statusOutput } = await execAsync('tailscale status --json');
    const status = JSON.parse(statusOutput);

    if (status.BackendState === 'Running') {
      info.running = true;
    }

    // Get Tailscale IP
    const { stdout: ipOutput } = await execAsync('tailscale ip -4');
    info.ip = ipOutput.trim();

    // Get hostname
    if (status.Self) {
      info.hostname = status.Self.HostName || null;
    }

  } catch (error) {
    console.log('[Tailscale] Not installed or not running');
  }

  return info;
}

/**
 * Get the Tailscale IP address
 */
export async function getTailscaleIP(): Promise<string | null> {
  try {
    const { stdout } = await execAsync('tailscale ip -4');
    const ip = stdout.trim();

    if (ip && ip.match(/^100\.\d+\.\d+\.\d+$/)) {
      return ip;
    }

    return null;
  } catch (error) {
    console.error('[Tailscale] Failed to get IP:', error);
    return null;
  }
}

/**
 * Get all devices on the Tailscale network
 */
export async function getTailscaleDevices(): Promise<Array<{
  hostname: string;
  ip: string;
  online: boolean;
}>> {
  try {
    const { stdout } = await execAsync('tailscale status --json');
    const status = JSON.parse(stdout);

    const devices: Array<{ hostname: string; ip: string; online: boolean }> = [];

    for (const [key, peer] of Object.entries(status.Peer || {})) {
      const p = peer as any;
      devices.push({
        hostname: p.HostName || 'unknown',
        ip: p.TailscaleIPs?.[0] || '',
        online: p.Online || false,
      });
    }

    return devices;
  } catch (error) {
    console.error('[Tailscale] Failed to get devices:', error);
    return [];
  }
}

/**
 * Verify Tailscale is ready for use
 */
export async function verifyTailscaleReady(): Promise<{
  ready: boolean;
  error?: string;
}> {
  const info = await checkTailscale();

  if (!info.installed) {
    return {
      ready: false,
      error: 'Tailscale is not installed. Install from https://tailscale.com/download',
    };
  }

  if (!info.running) {
    return {
      ready: false,
      error: 'Tailscale is installed but not running. Please start Tailscale.',
    };
  }

  if (!info.ip) {
    return {
      ready: false,
      error: 'Tailscale is running but has no IP address. Check your Tailscale connection.',
    };
  }

  return { ready: true };
}

/**
 * Get connection URL for QR code pairing
 */
export async function getTailscaleConnectionURL(port: number): Promise<string | null> {
  const ip = await getTailscaleIP();

  if (!ip) {
    return null;
  }

  return `ws://${ip}:${port}`;
}

/**
 * Monitor Tailscale connection status
 */
export class TailscaleMonitor {
  private checkInterval: NodeJS.Timeout | null = null;
  private onStatusChange?: (connected: boolean) => void;
  private lastStatus: boolean = false;

  /**
   * Start monitoring Tailscale connection
   */
  start(onStatusChange: (connected: boolean) => void, intervalMs: number = 10000): void {
    this.onStatusChange = onStatusChange;

    // Check immediately
    this.checkStatus();

    // Then check periodically
    this.checkInterval = setInterval(() => {
      this.checkStatus();
    }, intervalMs);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Check current status
   */
  private async checkStatus(): Promise<void> {
    const info = await checkTailscale();
    const connected = info.running && info.ip !== null;

    if (connected !== this.lastStatus) {
      this.lastStatus = connected;

      if (this.onStatusChange) {
        this.onStatusChange(connected);
      }

      console.log(`[Tailscale] Status changed: ${connected ? 'connected' : 'disconnected'}`);
    }
  }
}

/**
 * Get user-friendly Tailscale status message
 */
export async function getTailscaleStatusMessage(): Promise<string> {
  const info = await checkTailscale();

  if (!info.installed) {
    return 'Tailscale not installed';
  }

  if (!info.running) {
    return 'Tailscale not running';
  }

  if (!info.ip) {
    return 'Tailscale connected but no IP';
  }

  return `Connected: ${info.ip} (${info.hostname || 'unknown'})`;
}
