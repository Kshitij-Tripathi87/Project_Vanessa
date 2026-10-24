import { runPowerShell } from "./powershell.js";
import * as os from "node:os";
import * as path from "node:path";
import {
  AgentEvidence,
  AgentResult,
  AgentRunContext,
  AgentTask,
  SpecialistAgent,
} from "@vanessa/shared";
import { eventBus } from "../core/eventBus.js";

export interface WindowsAgentOptions {
  runPowerShell?: typeof runPowerShell;
  fakeMode?: boolean;
}

export class WindowsAgent implements SpecialistAgent {
  private readonly powerShellRunner: typeof runPowerShell;
  private readonly fakeMode: boolean;

  constructor(options: WindowsAgentOptions = {}) {
    this.powerShellRunner = options.runPowerShell || runPowerShell;
    this.fakeMode = options.fakeMode ?? process.env.FAKE === "1";
  }

  id = "windows";
  capabilities = [
    "wifi_adapter_control",
    "bluetooth_control",
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
    context?: AgentRunContext
  ): Promise<AgentResult> {
    const action = typeof actionOrTask === "string" ? actionOrTask : actionOrTask.action || actionOrTask.objective;
    const params = typeof actionOrTask === "string" ? (paramsOrContext as Record<string, any>) || {} : actionOrTask.params || {};
    const runCtx = typeof actionOrTask === "string" ? context : (paramsOrContext as AgentRunContext);

    const startTime = new Date().toISOString();

    switch (action) {
      case "wifi.restart_adapter":
      case "windows.wifi_restart": {
        const res = await this.restartWifiAdapter();
        const evidence: AgentEvidence[] = res.success ? [{
          description: res.output,
          source: "PowerShell NetAdapter",
          timestamp: startTime,
          confidence: 1.0,
          data: res,
        }] : [];
        return {
          agentId: this.id,
          status: res.success ? "completed" : "failed",
          success: res.success,
          summary: res.output,
          spokenSummary: res.success
            ? "The Wi-Fi adapter is " + (res.connected ? "up" : "not up") + ". I have not independently verified internet access."
            : "I could not restart and verify the Wi-Fi adapter.",
          evidence,
          artifacts: [],
          verification: {
            passed: res.success && res.connected === true,
            details: res.output,
          },
          data: {
            actionsAttempted: ["Restart-NetAdapter on the detected Wi-Fi adapter"],
            actualObservations: res.output,
            failures: res.success ? [] : [res.output],
            adapter: res.adapter,
            connected: res.connected,
            internetReachabilityVerified: false,
          },
        };
      }

      case "wifi.status":
      case "windows.wifi_status": {
        const res = await this.wifiStatus();
        return {
          agentId: this.id,
          status: res.success ? "completed" : "failed",
          success: res.success,
          summary: res.success ? "Wi-Fi adapter status: " + res.status : "Wi-Fi adapter status could not be verified.",
          spokenSummary: res.spokenSummary,
          evidence: res.success ? [{
            description: "Observed Wi-Fi adapter status: " + res.status + ".",
            source: "PowerShell NetAdapter",
            timestamp: startTime,
            confidence: 1,
            data: { status: res.status },
          }] : [],
          artifacts: [],
          data: {
            actionsAttempted: ["Read the observed Wi-Fi adapter status"],
            actualObservations: "Wi-Fi status: " + res.status,
            failures: res.success ? [] : [res.spokenSummary],
            status: res.status,
          },
          verification: {
            passed: res.success && res.status !== "Unknown",
            details: "Observed Wi-Fi adapter status: " + res.status + ".",
          },
        };
      }

      case "bluetooth.enable":
      case "bluetooth.disable":
      case "windows.bluetooth_toggle": {
        const enable = action.includes("enable") || params.enabled === true;
        const res = await this.setBluetoothState(enable);
        return {
          agentId: this.id,
          status: res.success ? "completed" : "failed",
          success: res.success,
          summary: res.success ? "Bluetooth radio is " + res.state : "Bluetooth state could not be verified: " + res.state,
          spokenSummary: res.success ? "Bluetooth " + res.state + "." : "I could not verify the Bluetooth radio state.",
          evidence: res.success ? [{
            description: res.output,
            source: "Windows Radio API",
            timestamp: startTime,
            confidence: 1,
            data: { state: res.state },
          }] : [],
          artifacts: [],
          data: {
            actionsAttempted: ["Set Bluetooth radio state to " + (enable ? "On" : "Off")],
            actualObservations: res.output,
            failures: res.success ? [] : [res.output],
            state: res.state,
          },
          verification: {
            passed: res.success,
            details: res.output,
          },
        };
      }

      case "volume.set":
      case "windows.volume_set": {
        const level = params.level ?? 50;
        const res = await this.setVolume(level);
        return {
          agentId: this.id,
          status: res.success ? "partial" : "failed",
          success: res.success,
          summary: res.success
            ? "Windows accepted volume-key adjustments toward " + res.level + "%; exact master volume was not read back."
            : "Volume adjustment failed: " + res.output,
          spokenSummary: res.success
            ? "I sent the volume adjustment, but I cannot verify the exact system volume."
            : "I could not adjust the system volume.",
          evidence: [],
          artifacts: [],
          verification: { passed: false, details: res.output },
          data: {
            actionsAttempted: ["Request volume adjustment: " + String(level)],
            actualObservations: res.output,
            failures: [res.output],
            requestedLevel: level,
            readBackVerified: false,
          },
        };
      }

      case "app.open":
      case "windows.app_open": {
        const appName = params.appName || params.name || params.app || "notepad";
        const res = await this.openApp(appName);
        return {
          agentId: this.id,
          status: res.success ? "completed" : "failed",
          success: res.success,
          summary: res.success ? "Windows accepted the launch request for " + appName : "Could not launch " + appName,
          spokenSummary: res.success ? "I launched " + appName + "." : "I could not launch " + appName + ".",
          evidence: res.success ? [{
            description: res.output,
            source: "Windows process launch",
            timestamp: startTime,
            confidence: 0.9,
          }] : [],
          artifacts: [],
          data: {
            actionsAttempted: ["Start-Process with the resolved app executable"],
            actualObservations: res.output,
            failures: res.success ? [] : [res.output],
            launchAccepted: res.success,
          },
          verification: {
            passed: res.success,
            details: res.output,
          },
        };
      }

      case "app.close":
      case "windows.app_close": {
        const appName = String(params.appName || params.name || "");
        const res = await this.closeApp(appName);
        return {
          agentId: this.id,
          status: res.success ? "completed" : "failed",
          success: res.success,
          summary: res.output,
          spokenSummary: res.success ? "Closed " + appName + "." : "I could not verify that " + appName + " closed.",
          evidence: res.success ? [{
            description: res.output,
            source: "Windows process state",
            timestamp: startTime,
            confidence: 1,
          }] : [],
          artifacts: [],
          data: {
            actionsAttempted: ["Request stop for process " + appName],
            actualObservations: res.output,
            failures: res.success ? [] : [res.output],
          },
          verification: { passed: res.success, details: res.output },
        };
      }

      case "screenshot.capture":
      case "windows.screenshot_capture": {
        const res = await this.captureScreenshot();
        return {
          agentId: this.id,
          status: res.success ? "completed" : "failed",
          success: res.success,
          summary: res.success ? "Captured Windows desktop screenshot." : "Windows desktop screenshot capture failed.",
          spokenSummary: res.success ? "Screenshot captured." : "I could not capture a screenshot.",
          evidence: res.success ? [{
            description: "Screenshot saved to a temporary PNG file.",
            source: res.path,
            timestamp: startTime,
            confidence: 1,
          }] : [],
          artifacts: res.success ? [res.path] : [],
          verification: { passed: res.success, details: res.success ? "Screenshot file was saved." : "Screenshot capture did not produce a file." },
          data: res,
        };
      }

      default:
        throw new Error(`WindowsAgent: Unknown action '${action}'`);
    }
  }

  private async restartWifiAdapter(): Promise<{ success: boolean; adapter: string; output: string; connected: boolean }> {
    if (this.fakeMode) {
      return {
        success: true,
        adapter: "Wi-Fi (Fake)",
        connected: true,
        output: "FAKE mode: Wi-Fi restart was simulated; no real adapter or internet state was checked.",
      };
    }
    try {
      const { stdout } = await this.powerShellRunner(
        "$ErrorActionPreference = 'Stop'; $adapter = Get-NetAdapter | Where-Object { $_.Name -like '*Wi-Fi*' -or $_.InterfaceDescription -like '*Wireless*' } | Select-Object -First 1; if (-not $adapter) { throw 'No Wi-Fi adapter was found.' }; Restart-NetAdapter -Name $adapter.Name -Confirm:$false -ErrorAction Stop; Start-Sleep -Milliseconds 500; $observed = Get-NetAdapter -Name $adapter.Name -ErrorAction Stop; [pscustomobject]@{ Name = $observed.Name; Status = $observed.Status } | ConvertTo-Json -Compress",
        {},
        8000
      );
      const observed = JSON.parse(String(stdout).trim()) as { Name?: string; Status?: string };
      const status = String(observed.Status || "Unknown");
      const adapterUp = status.toLowerCase() === "up";
      return {
        success: adapterUp,
        adapter: observed.Name || "Wi-Fi",
        connected: adapterUp,
        output: adapterUp
          ? "Wi-Fi adapter " + (observed.Name || "Wi-Fi") + " restarted and its observed status is Up. Internet reachability was not independently tested."
          : "Wi-Fi adapter " + (observed.Name || "Wi-Fi") + " was found but its observed status is " + status + ".",
      };
    } catch (err) {
      return {
        success: false,
        adapter: "Wi-Fi",
        connected: false,
        output: "Wi-Fi adapter restart or verification failed: " + (err instanceof Error ? err.message : String(err)),
      };
    }
  }

  private async wifiStatus(): Promise<{ success: boolean; status: string; spokenSummary: string }> {
    try {
      const { stdout } = await this.powerShellRunner(
        "$ErrorActionPreference = 'Stop'; $adapter = Get-NetAdapter | Where-Object { $_.Name -like '*Wi-Fi*' -or $_.InterfaceDescription -like '*Wireless*' } | Select-Object -First 1; if (-not $adapter) { throw 'No Wi-Fi adapter was found.' }; [string]$adapter.Status",
        {},
        4000
      );
      const status = String(stdout).trim() || "Unknown";
      return {
        success: status !== "Unknown",
        status,
        spokenSummary: status === "Unknown"
          ? "I could not verify the Wi-Fi adapter status."
          : "The Wi-Fi adapter status is " + status + ".",
      };
    } catch {
      return { success: false, status: "Unknown", spokenSummary: "I could not verify the Wi-Fi adapter status." };
    }
  }

  private async setBluetoothState(enable: boolean): Promise<{ success: boolean; state: string; output: string }> {
    if (this.fakeMode) {
      const state = enable ? "enabled" : "disabled";
      return { success: true, state: "simulated " + state, output: "FAKE mode: Bluetooth " + state + " was simulated; no real radio state was checked." };
    }
    const stateStr = enable ? "On" : "Off";
    try {
      const { stdout } = await this.powerShellRunner(
        "$ErrorActionPreference = 'Stop'; [Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null; $radios = [Windows.Devices.Radios.Radio]::GetRadiosAsync().GetAwaiter().GetResult(); $bt = $radios | Where-Object {$_.Kind -eq 'Bluetooth'} | Select-Object -First 1; if (-not $bt) { throw 'No Bluetooth radio was found.' }; $access = $bt.SetStateAsync([Windows.Devices.Radios.RadioState]::" + stateStr + ").GetAwaiter().GetResult(); if ([string]$access -ne 'Allowed') { throw ('Windows denied the Bluetooth state change: ' + [string]$access) }; Start-Sleep -Milliseconds 300; $updated = [Windows.Devices.Radios.Radio]::GetRadiosAsync().GetAwaiter().GetResult() | Where-Object {$_.Kind -eq 'Bluetooth'} | Select-Object -First 1; if (-not $updated) { throw 'Bluetooth radio disappeared during verification.' }; [pscustomobject]@{ State = $updated.State.ToString() } | ConvertTo-Json -Compress",
        {},
        6000
      );
      const parsed = JSON.parse(String(stdout).trim()) as { State?: string };
      const observed = String(parsed.State || "Unknown");
      const expected = enable ? "on" : "off";
      const verified = observed.toLowerCase() === expected;
      return {
        success: verified,
        state: observed.toLowerCase() === "on" ? "enabled" : observed.toLowerCase() === "off" ? "disabled" : observed,
        output: verified
          ? "Bluetooth radio state verified as " + observed + "."
          : "Bluetooth state request was not verified; Windows reported " + observed + ".",
      };
    } catch (err) {
      return {
        success: false,
        state: "unknown",
        output: "Bluetooth state change failed: " + (err instanceof Error ? err.message : String(err)),
      };
    }
  }

  private async setVolume(level: number): Promise<{ success: boolean; level: number; output: string }> {
    const numericLevel = Number(level);
    if (!Number.isFinite(numericLevel) || numericLevel < 0 || numericLevel > 100) {
      return { success: false, level: numericLevel, output: "Volume level must be a number between 0 and 100." };
    }
    try {
      await this.powerShellRunner(
        "$ErrorActionPreference = 'Stop'; $wsh = New-Object -ComObject WScript.Shell; 1..50 | ForEach-Object { $wsh.SendKeys([char]174) }; $steps = [math]::Round([double]$env:VANESSA_VOLUME / 2); 1..$steps | ForEach-Object { $wsh.SendKeys([char]175) }",
        { VANESSA_VOLUME: String(Math.round(numericLevel)) },
        5000
      );
      return { success: true, level: Math.round(numericLevel), output: "Windows accepted volume-key adjustment requests; the exact master volume was not read back." };
    } catch (err) {
      return { success: false, level: numericLevel, output: "Windows volume adjustment failed: " + (err instanceof Error ? err.message : String(err)) };
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
      await this.powerShellRunner("Start-Process -FilePath $env:VANESSA_APP", { VANESSA_APP: executable }, 5000);
      return { success: true, output: `Launched ${executable}` };
    } catch (err: any) {
      return { success: false, output: `Could not launch ${appName}: ${err.message}` };
    }
  }

  private async closeApp(appName: string): Promise<{ success: boolean; output: string }> {
    if (!appName || !/^[A-Za-z0-9_.-]{1,120}$/.test(appName)) {
      return { success: false, output: "A valid process name is required." };
    }
    try {
      await this.powerShellRunner(
        "$ErrorActionPreference = 'Stop'; $existing = Get-Process -Name $env:VANESSA_APP -ErrorAction SilentlyContinue; if (-not $existing) { 'Process was not running; requested state already holds.' } else { $existing | Stop-Process -Force -ErrorAction Stop; Start-Sleep -Milliseconds 250; $remaining = Get-Process -Name $env:VANESSA_APP -ErrorAction SilentlyContinue; if ($remaining) { throw 'Process remains after stop request.' }; 'Process stopped and absence verified.' }",
        { VANESSA_APP: appName },
        5000
      );
      return { success: true, output: "Process " + appName + " is not running." };
    } catch (err) {
      return { success: false, output: "Could not verify that process " + appName + " closed: " + (err instanceof Error ? err.message : String(err)) };
    }
  }

  private async captureScreenshot(): Promise<{ success: boolean; path: string }> {
    const screenshotPath = path.join(os.tmpdir(), "vanessa_screenshot_" + Date.now() + ".png");
    const psCommand = "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height); $graphics = [System.Drawing.Graphics]::FromImage($bitmap); $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size); $bitmap.Save($env:VANESSA_SCREENSHOT); $graphics.Dispose(); $bitmap.Dispose()";
    try {
      await this.powerShellRunner(psCommand, { VANESSA_SCREENSHOT: screenshotPath }, 10000);
      return { success: true, path: screenshotPath };
    } catch {
      return { success: false, path: "" };
    }
  }
}

export const windowsAgent = new WindowsAgent();
export const systemAgent = windowsAgent;
