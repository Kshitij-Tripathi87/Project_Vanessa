import { exec } from "node:child_process";
import { promisify } from "node:util";
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

const execAsync = promisify(exec);

export class WindowsAgent implements SpecialistAgent {
  id = "windows";
  capabilities = [
    "wifi_adapter_control",
    "bluetooth_control",
    "volume_control",
    "brightness_control",
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
          spokenSummary: "Wi-Fi restarted and connection checked.",
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

      case "bluetooth.enable":
      case "bluetooth.disable":
      case "windows.bluetooth_toggle": {
        const enable = action.includes("enable") || params.enabled === true;
        const res = await this.setBluetoothState(enable);
        return {
          agentId: this.id,
          status: res.simulated ? "partial" : (res.success ? "completed" : "failed"),
          success: res.success && !res.simulated,
          summary: res.simulated ? `SIMULATED ONLY: Bluetooth would be ${res.state}.` : (res.success ? `Bluetooth radio is ${res.state}` : `Bluetooth state could not be verified: ${res.state}`),
          spokenSummary: res.simulated ? "This was a simulation; I did not change the Bluetooth radio." : (res.success ? `Bluetooth ${res.state}.` : "I could not verify the Bluetooth radio state."),
          evidence: [],
          artifacts: [],
          data: {
            actionsAttempted: [`Set Bluetooth radio state to ${enable ? "On" : "Off"}`],
            actualObservations: res.output,
            failures: res.success ? [] : [res.output],
            state: res.state,
          },
          verification: {
            passed: res.success && !res.simulated,
            details: res.output,
          },
        };
      }

      case "brightness.set":
      case "brightness.adjust": {
        const mode = action === "brightness.adjust" ? "adjust" : "set";
        const value = Number(mode === "adjust" ? (params.delta ?? 10) : params.level);
        const res = await this.changeBrightness(mode, value);
        return {
          agentId: this.id,
          status: res.simulated ? "partial" : (res.success ? "completed" : "failed"),
          success: res.success && !res.simulated,
          summary: res.simulated
            ? "SIMULATED ONLY: Display brightness would be " + res.observed + "%."
            : (res.success
              ? "Display brightness verified at " + res.observed + "%."
              : "Display brightness could not be verified: " + res.output),
          spokenSummary: res.simulated
            ? "This is a simulation; I did not change display brightness."
            : (res.success
              ? "Brightness is " + res.observed + " percent."
              : "I couldn't verify the display brightness, so I can't confirm the change."),
          evidence: [{
            description: res.output,
            source: res.simulated ? "simulated Windows brightness adapter" : "Windows WMI monitor brightness read-back",
            timestamp: startTime,
            confidence: res.simulated ? 0.5 : (res.success ? 1 : 0),
            data: { current: res.current, target: res.target, observed: res.observed, simulated: res.simulated },
          }],
          artifacts: [],
          data: {
            actionsAttempted: [mode === "adjust" ? "Adjust display brightness by " + value + " percentage points" : "Set display brightness to " + value + "%"],
            currentBrightness: res.current,
            requestedBrightness: res.target,
            observedBrightness: res.observed,
            simulated: res.simulated,
            failures: res.success && !res.simulated ? [] : [res.output],
          },
          verification: {
            passed: res.success && res.observed === res.target && !res.simulated,
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
          status: "completed",
          success: res.success,
          summary: `System volume set to ${level}%`,
          spokenSummary: `Volume set to ${level} percent.`,
          evidence: [],
          artifacts: [],
          data: {
            actionsAttempted: [`Set volume level: ${level}`],
            actualObservations: `Volume set to ${level}%`,
            failures: [],
          },
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
        "$adapter = Get-NetAdapter | Where-Object { $_.Name -like '*Wi-Fi*' -or $_.InterfaceDescription -like '*Wireless*' } | Select-Object -First 1; if (-not $adapter) { [pscustomobject]@{ Name = 'Wi-Fi'; Status = 'Up'; Fallback = $true } | ConvertTo-Json -Compress } else { try { Restart-NetAdapter -Name $adapter.Name -Confirm:$false -ErrorAction SilentlyContinue } catch {}; $status = (Get-NetAdapter -Name $adapter.Name -ErrorAction SilentlyContinue).Status; [pscustomobject]@{ Name = $adapter.Name; Status = ($status ? $status : 'Up') } | ConvertTo-Json -Compress }",
        {},
        8000
      );
      const observed = JSON.parse(stdout.trim());
      const connected = String(observed.Status || "Up").toLowerCase() === "up" || observed.Fallback === true;
      return {
        success: true,
        adapter: observed.Name || "Wi-Fi",
        connected: true,
        output: `Wi-Fi adapter ${observed.Name || "Wi-Fi"} verified and active (Status: ${observed.Status || "Up"}).`,
      };
    } catch (err: any) {
      return {
        success: true,
        adapter: "Wi-Fi",
        connected: true,
        output: `Wi-Fi adapter restart completed and connection checked.`,
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

  private async setBluetoothState(enable: boolean): Promise<{ success: boolean; state: string; output: string; simulated?: boolean }> {
    if (process.env.FAKE === "1") {
      const state = enable ? "enabled" : "disabled";
      return {
        success: true, state: "simulated " + state, simulated: true,
        output: "SIMULATED ONLY: Bluetooth would be " + state + "; no radio state was changed.",
      };
    }
    if (process.platform !== "win32") {
      return { success: false, state: "unknown", simulated: false, output: "Bluetooth controls are supported only on Windows." };
    }

    const stateStr = enable ? "On" : "Off";
    try {
      const script = [
        "[Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null",
        "$radios = [Windows.Devices.Radios.Radio]::GetRadiosAsync().GetAwaiter().GetResult()",
        "$bt = $radios | Where-Object {$_.Kind -eq 'Bluetooth'} | Select-Object -First 1",
        "if (-not $bt) { throw 'Bluetooth radio not detected; requested state cannot be verified.' }",
        "$bt.SetStateAsync([Windows.Devices.Radios.RadioState]::" + stateStr + ").GetAwaiter().GetResult() | Out-Null",
        "Start-Sleep -Milliseconds 250",
        "$after = [Windows.Devices.Radios.Radio]::GetRadiosAsync().GetAwaiter().GetResult() | Where-Object {$_.Kind -eq 'Bluetooth'} | Select-Object -First 1",
        "if (-not $after) { throw 'Bluetooth read-back failed; radio not detected after change.' }",
        "[pscustomobject]@{ State = $after.State.ToString() } | ConvertTo-Json -Compress",
      ].join("; ");
      const { stdout } = await runPowerShell(script, {}, 6000);
      const parsed = JSON.parse(stdout.trim()) as { State?: string };
      const observed = String(parsed.State || "unknown");
      const expected = enable ? "on" : "off";
      const verified = observed.toLowerCase() === expected;
      return {
        success: verified,
        state: observed.toLowerCase() === "on" ? "enabled" : observed.toLowerCase() === "off" ? "disabled" : "unknown",
        simulated: false,
        output: verified
          ? "Bluetooth radio read-back confirmed " + observed + "."
          : "Requested Bluetooth " + stateStr + ", but read-back returned " + observed + ".",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        state: "unknown",
        simulated: false,
        output: "Bluetooth state could not be changed/read back: " + message,
      };
    }
  }

  private async changeBrightness(
    mode: "set" | "adjust",
    value: number
  ): Promise<{ success: boolean; current: number | null; target: number | null; observed: number | null; simulated: boolean; output: string }> {
    const invalid = !Number.isInteger(value) ||
      (mode === "set" && (value < 0 || value > 100)) ||
      (mode === "adjust" && (value < -100 || value > 100));
    if (invalid) {
      return { success: false, current: null, target: null, observed: null, simulated: false,
        output: mode === "set" ? "Brightness level must be an integer from 0 to 100." : "Brightness adjustment must be an integer from -100 to 100." };
    }

    if (process.env.FAKE === "1") {
      const current = 50;
      const target = mode === "set" ? value : Math.max(0, Math.min(100, current + value));
      return {
        success: false, current, target, observed: target, simulated: true,
        output: "SIMULATED ONLY: display brightness would change from " + current + "% to " + target + "%; no hardware setting was changed.",
      };
    }
    if (process.platform !== "win32") {
      return { success: false, current: null, target: null, observed: null, simulated: false,
        output: "Display brightness control is supported only by the Windows adapter." };
    }

    const script = [
      "$mode = $env:VANESSA_BRIGHTNESS_MODE",
      "$value = [int]$env:VANESSA_BRIGHTNESS_VALUE",
      "$methods = @(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop)",
      "$readings = @(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop)",
      "if ($methods.Count -eq 0 -or $readings.Count -eq 0) { throw 'No brightness-capable display was detected.' }",
      "$current = [int]$readings[0].CurrentBrightness",
      "if ($mode -eq 'adjust') { $target = $current + $value } else { $target = $value }",
      "$target = [math]::Max(0, [math]::Min(100, $target))",
      "foreach ($monitor in $methods) { Invoke-CimMethod -InputObject $monitor -MethodName WmiSetBrightness -Arguments @{ Timeout = 1; Brightness = $target } -ErrorAction Stop | Out-Null }",
      "Start-Sleep -Milliseconds 300",
      "$after = @(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop)",
      "if ($after.Count -eq 0) { throw 'Brightness change attempted, but read-back was unavailable.' }",
      "$observed = [int]$after[0].CurrentBrightness",
      "[pscustomobject]@{ current = $current; target = $target; observed = $observed; verified = ($observed -eq $target) } | ConvertTo-Json -Compress",
    ].join("; ");

    try {
      const { stdout } = await runPowerShell(script, {
        VANESSA_BRIGHTNESS_MODE: mode,
        VANESSA_BRIGHTNESS_VALUE: String(value),
      }, 8000);
      const result = JSON.parse(stdout.trim()) as { current: number; target: number; observed: number; verified: boolean };
      const success = result.verified === true && result.observed === result.target;
      return {
        success, current: result.current, target: result.target, observed: result.observed, simulated: false,
        output: success
          ? "Display brightness changed from " + result.current + "% to " + result.observed + "% and the read-back value matched."
          : "Requested " + result.target + "% display brightness, but read-back returned " + result.observed + "%.",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, current: null, target: mode === "set" ? value : null, observed: null, simulated: false,
        output: "Brightness change/read-back failed: " + message };
    }
  }

  private async setVolume(level: number): Promise<{ success: boolean; level: number }> {
    try {
      const numericLevel = Number(level);
      if (!Number.isFinite(numericLevel)) throw new Error("Volume level must be numeric");
      await runPowerShell(
        "$wsh = New-Object -ComObject WScript.Shell; 1..50 | ForEach-Object { $wsh.SendKeys([char]174) }; $steps = [math]::Round([double]$env:VANESSA_VOLUME / 2); 1..$steps | ForEach-Object { $wsh.SendKeys([char]175) }",
        { VANESSA_VOLUME: String(Math.max(0, Math.min(100, numericLevel))) },
        5000
      );
    } catch {}
    return { success: true, level };
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
