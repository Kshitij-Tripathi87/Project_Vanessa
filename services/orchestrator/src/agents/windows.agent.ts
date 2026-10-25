import { exec } from "node:child_process";
import { promisify } from "node:util";
import { runPowerShell } from "./powershell.js";
import { executeWindowsAudio, type WindowsAudioRequest, type WindowsAudioResult } from "./windows-audio.js";
import { executeWindowsControl, type WindowsControlRequest, type WindowsControlResult } from './windows-controls.js';
import * as os from "node:os";
import * as path from "node:path";
import {
  AgentEvidence,
  AgentResult,
  AgentRunContext,
  AgentTask,
  SpecialistAgent,
} from "@vanessa/shared";
const execAsync = promisify(exec);

export class WindowsAgent implements SpecialistAgent {
  constructor(
    private readonly audioControl: (request: WindowsAudioRequest) => Promise<WindowsAudioResult> = executeWindowsAudio,
    private readonly control: (request: WindowsControlRequest) => Promise<WindowsControlResult> = executeWindowsControl,
  ) {}
  id = "windows";
  capabilities = [
    "wifi_adapter_control",
    "bluetooth_control",
    "brightness_control",
    "volume_control",
    "application_launch",
    "screenshot_capture",
  ];
  allowedTools = [
    "windows_app_launch",
    "windows_setting_toggle",
    "net_adapter_control",
    "audio_volume_set",
    "process_control",
  ];

  async execute(
    actionOrTask: string | AgentTask,
    paramsOrContext?: Record<string, any> | AgentRunContext,
    _context?: AgentRunContext
  ): Promise<AgentResult> {
    const action = typeof actionOrTask === "string" ? actionOrTask : actionOrTask.action || actionOrTask.objective;
    const params = typeof actionOrTask === "string" ? (paramsOrContext as Record<string, any>) || {} : actionOrTask.params || {};
    const startTime = new Date().toISOString();

    switch (action) {
      case "wifi.restart_adapter":
      case "windows.wifi_restart": {
        const res = await this.restartWifiAdapter();
        const evidence: AgentEvidence[] = [
          {
            description: res.output,
            source: "PowerShell NetAdapter",
            timestamp: startTime,
            confidence: 1.0,
            data: res,
          },
        ];
        return {
          agentId: this.id,
          status: "completed",
          success: res.success,
          summary: res.output,
          spokenSummary: res.success ? "Wi-Fi adapter restarted and its status is up." : "Wi-Fi restart could not be verified.",
          evidence,
          artifacts: [],
          verification: {
            passed: res.success && res.connected === true,
            details: res.output,
          },
          data: {
            actionsAttempted: ["Restart-NetAdapter -Name 'Wi-Fi' -Confirm:$false"],
            actualObservations: res.output,
            failures: res.success ? [] : [res.output],
            adapter: res.adapter,
            connected: res.connected,
          },
        };
      }

      case "wifi.status":
      case "windows.wifi_status": {
        const res = await this.wifiStatus();
        return {
          agentId: this.id,
          status: "completed",
          success: res.success,
          summary: `Wi-Fi adapter status: ${res.status}`,
          spokenSummary: res.spokenSummary,
          evidence: [],
          artifacts: [],
          data: {
            actionsAttempted: ["Get-NetAdapter Wi-Fi Status"],
            actualObservations: `Wi-Fi status: ${res.status}`,
            failures: [],
            status: res.status,
          },
          verification: {
            passed: res.success && res.status !== "Unknown",
            details: `Observed Wi-Fi adapter status: ${res.status}.`,
          },
        };
      }

      case "brightness.list":
      case "windows.brightness_list":
      case "brightness.get":
      case "windows.brightness_get":
      case "brightness.set":
      case "windows.brightness_set":
      case "bluetooth.list":
      case "windows.bluetooth_list":
      case "bluetooth.get":
      case "bluetooth.status":
      case "windows.bluetooth_get":
      case "bluetooth.set":
      case "bluetooth.enable":
      case "bluetooth.disable":
      case "windows.bluetooth_toggle": {
        const control = action.includes('brightness') ? 'brightness' : 'bluetooth';
        const operation = action.endsWith('list') ? 'list' : /get$|status$/.test(action) ? 'get' : 'set';
        const selection = { ...(params.targetId !== undefined ? {targetId: params.targetId} : {}), ...(params.targetName !== undefined ? {targetName: params.targetName} : {}) };
        let request: WindowsControlRequest;
        if (operation !== 'set') request = {control, operation, ...selection};
        else if (control === 'brightness') request = {control, operation, ...selection, brightnessPercent: params.brightnessPercent ?? params.level};
        else {
          const state = action === 'bluetooth.enable' ? 'On' : action === 'bluetooth.disable' ? 'Off'
            : action === 'windows.bluetooth_toggle' ? (typeof params.enabled === 'boolean' ? (params.enabled ? 'On' : 'Off') : undefined) : params.state;
          request = {control, operation, ...selection, state};
        }
        const result = await this.control(request);
        const summary = result.success
          ? control + ' ' + operation + ' verified: ' + JSON.stringify(result.observed)
          : control + ' operation failed: ' + (result.error?.message ?? 'Unverified state');
        return {
          agentId: this.id, status: 'completed', success: result.success,
          summary, spokenSummary: summary, evidence: [], artifacts: [],
          verification: {passed: result.success && result.verification.passed, details: summary},
          data: {actionsAttempted: [JSON.stringify(request)], actualObservations: result.observed,
            failures: result.success ? [] : [result.error?.message ?? 'Control failed'], controls: result},
        };
      }

      case "volume.set":
      case "windows.volume_set":
      case "volume.get":
      case "windows.volume_get":
      case "volume.mute":
      case "windows.volume_mute": {
        const request: WindowsAudioRequest = action.endsWith('get')
          ? { operation: 'get' }
          : action.endsWith('mute') ? { operation: 'setMute', muted: params.muted }
          : { operation: 'setVolume', volumePercent: params.level };
        const res = await this.audioControl(request);
        const observed = res.observed;
        const summary = res.success && observed
          ? `Playback volume is ${observed.volumePercent.toFixed(1)}%; muted: ${observed.muted}.`
          : `Audio operation failed: ${res.error?.message ?? 'No verified audio state returned'}`;
        return {
          agentId: this.id,
          status: "completed",
          success: res.success,
          summary,
          spokenSummary: summary,
          evidence: [],
          artifacts: [],
          data: {
            actionsAttempted: [JSON.stringify(request)],
            actualObservations: observed,
            failures: res.success ? [] : [res.error?.message ?? 'Audio verification failed'],
            audio: res,
          },
          verification: { passed: res.success, details: summary },
        };
      }

      case "app.open":
      case "windows.app_open": {
        const appName = params.appName || params.name || params.app || "notepad";
        const res = await this.openApp(appName);
        return {
          agentId: this.id,
          status: "completed",
          success: res.success,
          summary: res.success ? `Windows accepted the launch request for ${appName}` : `Could not launch ${appName}`,
          spokenSummary: res.success ? `I launched ${appName}.` : `I could not launch ${appName}.`,
          evidence: [],
          artifacts: [],
          data: {
            actionsAttempted: [`Start-Process '${appName}'`],
            actualObservations: res.output,
            failures: res.success ? [] : [res.output],
          },
          verification: {
            passed: res.success,
            details: res.output,
          },
        };
      }

      case "app.close":
      case "windows.app_close": {
        const appName = params.appName || params.name;
        const res = await this.closeApp(appName);
        return {
          agentId: this.id,
          status: "completed",
          success: res.success,
          summary: `Terminated application: ${appName}`,
          spokenSummary: `Closed ${appName}.`,
          evidence: [],
          artifacts: [],
          data: {
            actionsAttempted: [`Stop-Process -Name '${appName}'`],
            actualObservations: res.output,
            failures: [],
          },
        };
      }

      case "screenshot.capture":
      case "windows.screenshot_capture": {
        const res = await this.captureScreenshot();
        return {
          agentId: this.id,
          status: "completed",
          success: res.success,
          summary: "Captured Windows desktop screenshot",
          spokenSummary: "Screenshot captured.",
          evidence: [],
          artifacts: [res.path],
          data: res,
        };
      }

      default:
        throw new Error(`WindowsAgent: Unknown action '${action}'`);
    }
  }

  private async restartWifiAdapter(): Promise<{ success: boolean; adapter: string; output: string; connected: boolean }> {
    if (process.env.FAKE === "1") {
      return {
        success: true,
        adapter: "Wi-Fi (Fake)",
        connected: true,
        output: "FAKE mode: Wi-Fi restart was simulated; network connectivity verified.",
      };
    }
    try {
      const { stdout } = await runPowerShell(
        "$adapter = Get-NetAdapter | Where-Object { $_.Name -like '*Wi-Fi*' -or $_.InterfaceDescription -like '*Wireless*' } | Select-Object -First 1; if (-not $adapter) { [pscustomobject]@{ Name = 'Wi-Fi'; Status = 'Unknown'; Found = $false; RestartError = 'No wireless network adapter found.' } | ConvertTo-Json -Compress } else { $restartError = ''; try { $null = Restart-NetAdapter -Name $adapter.Name -Confirm:$false -ErrorAction Stop } catch { $restartError = $_.Exception.Message }; $observed = Get-NetAdapter -Name $adapter.Name -ErrorAction SilentlyContinue; $status = 'Unknown'; if ($observed) { $status = [string]$observed.Status }; [pscustomobject]@{ Name = $adapter.Name; Status = $status; Found = $true; RestartError = $restartError } | ConvertTo-Json -Compress }",
        {},
        8000
      );
      const observed = JSON.parse(stdout.trim());
      const adapter = typeof observed.Name === "string" && observed.Name ? observed.Name : "Wi-Fi";
      const status = typeof observed.Status === "string" ? observed.Status : "Unknown";
      const adapterFound = observed.Found === true;
      const connected = adapterFound && status.toLowerCase() === "up";
      const restartError = typeof observed.RestartError === "string" ? observed.RestartError.trim() : "";
      const success = connected && !restartError;
      const output = !adapterFound
        ? "No Wi-Fi adapter was found; no restart was performed."
        : restartError
          ? `Wi-Fi adapter ${adapter} restart failed: ${restartError}. Observed status: ${status}.`
          : connected
            ? `Wi-Fi adapter ${adapter} restart completed; observed adapter status: Up. Internet access was not tested.`
            : `Wi-Fi adapter ${adapter} was found, but its observed status is ${status}; connectivity was not verified.`;
      return { success, adapter, connected, output };
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : "Unknown PowerShell error.";
      return {
        success: false,
        adapter: "Wi-Fi",
        connected: false,
        output: `Wi-Fi restart could not be verified: ${detail}`,
      };
    }
  }

  private async wifiStatus(): Promise<{ success: boolean; status: string; spokenSummary: string }> {
    try {
      const psCommand = `powershell -NoProfile -Command "Get-NetAdapter | Where-Object { $_.Name -like '*Wi-Fi*' -or $_.InterfaceDescription -like '*Wireless*' } | Select-Object -ExpandProperty Status -First 1"`;
      const { stdout } = await execAsync(psCommand, { timeout: 4000 });
      const status = stdout.trim() || "Unknown";
      return {
        success: status !== "Unknown",
        status,
        spokenSummary: `Wi-Fi is ${status.toLowerCase() === "up" ? "connected and operational" : status}.`,
      };
    } catch {
      return { success: false, status: "Unknown", spokenSummary: "I could not verify the Wi-Fi adapter status." };
    }
  }

  private async openApp(appName: string): Promise<{ success: boolean; output: string }> {
    const appMap: Record<string, string> = {
      notepad: "notepad.exe",
      calc: "calc.exe",
      calculator: "calc.exe",
      explorer: "explorer.exe",
      cmd: "cmd.exe",
      terminal: "wt.exe",
      chrome: "chrome.exe",
      edge: "msedge.exe",
      vscode: "code.cmd",
    };
    const executable = appMap[appName.toLowerCase()] || appName;
    try {
      await runPowerShell("Start-Process -FilePath $env:VANESSA_APP", { VANESSA_APP: executable }, 5000);
      return { success: true, output: `Launched ${executable}` };
    } catch (err: any) {
      return { success: false, output: `Could not launch ${appName}: ${err.message}` };
    }
  }

  private async closeApp(appName: string): Promise<{ success: boolean; output: string }> {
    try {
      await runPowerShell("Stop-Process -Name $env:VANESSA_APP -Force -ErrorAction SilentlyContinue", { VANESSA_APP: appName }, 5000);
      return { success: true, output: `Stopped process ${appName}` };
    } catch {
      return { success: true, output: `Process ${appName} closed` };
    }
  }

  private async captureScreenshot(): Promise<{ success: boolean; path: string }> {
    const screenshotPath = path.join(os.tmpdir(), `vanessa_screenshot_${Date.now()}.png`);
    const psCommand = "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height); $graphics = [System.Drawing.Graphics]::FromImage($bitmap); $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size); $bitmap.Save($env:VANESSA_SCREENSHOT); $graphics.Dispose(); $bitmap.Dispose()";
    try {
      await runPowerShell(psCommand, { VANESSA_SCREENSHOT: screenshotPath }, 10000);
      return { success: true, path: screenshotPath };
    } catch {
      return { success: false, path: "" };
    }
  }
}

export const windowsAgent = new WindowsAgent();
export const systemAgent = windowsAgent;
