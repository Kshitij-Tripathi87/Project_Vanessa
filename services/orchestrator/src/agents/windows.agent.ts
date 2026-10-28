import { runPowerShell } from "./powershell.js";
import { inspectForegroundWindow, invokeForegroundControl, type ForegroundWindowInspection, type UiAutomationClickRequest, type UiAutomationClickResult } from "./windows-ui-automation.js";
import { executeWindowsAudio, type WindowsAudioRequest, type WindowsAudioResult } from "./windows-audio.js";
import { executeWindowsControl, type WindowsControlRequest, type WindowsControlResult } from './windows-controls.js';
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AgentEvidence,
  AgentResult,
  AgentRunContext,
  AgentTask,
  SpecialistAgent,
} from "@vanessa/shared";
export class WindowsAgent implements SpecialistAgent {
  constructor(
    private readonly audioControl: (request: WindowsAudioRequest) => Promise<WindowsAudioResult> = executeWindowsAudio,
    private readonly control: (request: WindowsControlRequest) => Promise<WindowsControlResult> = executeWindowsControl,
    private readonly inspectForeground: () => Promise<ForegroundWindowInspection> = () => inspectForegroundWindow(runPowerShell),
    private readonly invokeForeground: (request: UiAutomationClickRequest) => Promise<UiAutomationClickResult> = (request) => invokeForegroundControl(runPowerShell, request),
  ) {}
  id = "windows";
  capabilities = [
    "wifi_adapter_control",
    "bluetooth_control",
    "brightness_control",
    "volume_control",
    "application_launch",
    "screenshot_capture",
    "ui_inspection",
    "ui_control_invocation",
  ];
  allowedTools = [
    "windows_app_launch",
    "windows_setting_toggle",
    "net_adapter_control",
    "audio_volume_set",
    "process_control",
    "windows_ui_automation",
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
      case "ui.inspect":
      case "windows.ui_inspect": {
        const result = await this.inspectForeground();
        const controls = Array.isArray(result.controls) ? result.controls : [];
        const verified = result.success === true && result.valuesRead === false;
        const title = typeof result.windowTitle === "string" && result.windowTitle ? result.windowTitle : "the foreground window";
        const summary = verified
          ? "Inspected " + title + " and found " + controls.length + " accessible controls. Input-field values were not read."
          : "Foreground-window inspection was not verified: " + (result.error || "Windows returned incomplete inspection data") + ".";
        return {
          agentId: this.id,
          status: verified ? "completed" : "failed",
          success: verified,
          summary,
          spokenSummary: summary,
          evidence: verified ? [{ description: summary, source: "windows-ui-automation.inspect", timestamp: startTime, confidence: 1, data: result }] : [],
          artifacts: [],
          verification: { passed: verified, details: summary },
          data: {
            outcome: verified ? "succeeded" : "failed",
            windowTitle: result.windowTitle,
            windowHandle: result.windowHandle,
            processId: result.processId,
            controls,
            truncated: result.truncated === true,
            valuesRead: result.valuesRead,
            actionsAttempted: ["Inspect foreground UI Automation Control View"],
            actualObservations: summary,
            failures: verified ? [] : [result.error || "UI Automation inspection was not verified"],
          },
        };
      }

      case "ui.click":
      case "windows.ui_click": {
        const request: UiAutomationClickRequest = {
          windowHandle: typeof params.windowHandle === "string" ? params.windowHandle : "",
          expectedWindowTitle: typeof params.expectedWindowTitle === "string" ? params.expectedWindowTitle : "",
          expectedProcessId: Number(params.expectedProcessId),
          ...(typeof params.automationId === "string" && params.automationId ? { automationId: params.automationId } : {}),
          ...(typeof params.name === "string" && params.name ? { name: params.name } : {}),
          ...(typeof params.controlType === "string" && params.controlType ? { controlType: params.controlType } : {}),
        };
        const result = await this.invokeForeground(request);
        const accepted = result.success === true && result.invocationAccepted === true;
        const summary = accepted
          ? "Windows accepted the UI Automation invoke request. The resulting visual state was not independently verified."
          : "UI Automation invocation failed: " + (result.error || result.message || "the target control was not uniquely and safely invokable") + ".";
        return {
          agentId: this.id,
          status: accepted ? "completed" : "failed",
          success: accepted,
          summary,
          spokenSummary: summary,
          evidence: [{ description: summary, source: "windows-ui-automation.invoke", timestamp: startTime, confidence: accepted ? 1 : 0, data: { request, result } }],
          artifacts: [],
          verification: { passed: accepted && result.postClickStateVerified === true, details: summary },
          data: {
            outcome: accepted ? "invocation_accepted" : "failed",
            invocationAccepted: accepted,
            postClickStateVerified: result.postClickStateVerified === true,
            actionsAttempted: ["Invoke UI Automation control"],
            actualObservations: summary,
            failures: accepted ? [] : [result.error || result.message || "UI Automation invocation was not accepted"],
            control: result.control,
            matches: result.matches,
          },
        };
      }

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
          status: res.simulated ? "partial" : res.success ? "completed" : "failed",
          success: res.success && !res.simulated,
          summary: res.output,
          spokenSummary: res.simulated
            ? "Wi-Fi restart was simulated. No adapter state was changed or verified."
            : res.success ? "Wi-Fi adapter restart completed and adapter status was read back as up." : "Wi-Fi restart could not be verified.",
          evidence,
          artifacts: [],
          verification: {
            passed: res.success && res.connected === true && !res.simulated,
            details: res.output,
          },
          data: {
            outcome: res.simulated ? "simulated" : res.success ? "succeeded" : "failed",
            simulated: res.simulated === true,
            actualStateChanged: res.simulated ? false : undefined,
            actualStateVerified: res.simulated ? false : res.success && res.connected,
            actionsAttempted: res.simulated ? [] : ["Restart-NetAdapter -Name 'Wi-Fi' -Confirm:$false"],
            actualObservations: res.output,
            failures: res.success && !res.simulated ? [] : [res.output],
            adapter: res.adapter,
            connected: res.simulated ? undefined : res.connected,
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
          agentId: this.id, status: result.success ? "completed" : "failed", success: result.success,
          summary, spokenSummary: summary,
          evidence: [{
            description: summary, source: "windows-control.readback", timestamp: new Date().toISOString(),
            confidence: result.success && result.verification.passed ? 1 : 0,
            data: { request, observed: result.observed, verification: result.verification },
          }],
          artifacts: [],
          verification: { passed: result.success && result.verification.passed, details: summary },
          data: { outcome: result.success && result.verification.passed ? "succeeded" : "failed", actionsAttempted: [JSON.stringify(request)], actualObservations: result.observed,
            failures: result.success ? [] : [result.error?.message ?? "Control failed"], controls: result },
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
          status: res.success ? "completed" : "failed",
          success: res.success,
          summary,
          spokenSummary: summary,
          evidence: [{
            description: summary, source: "windows-audio.readback", timestamp: new Date().toISOString(),
            confidence: res.success && Boolean(observed) ? 1 : 0,
            data: { operation: request, observed, device: res.device, error: res.error },
          }],
          artifacts: [],
          data: {
            outcome: res.success ? "succeeded" : "failed",
            actionsAttempted: [JSON.stringify(request)],
            actualObservations: observed,
            failures: res.success ? [] : [res.error?.message ?? "Audio verification failed"],
            audio: res,
          },
          verification: { passed: res.success && Boolean(observed), details: summary },
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
        const detail = res.output;
        return {
          agentId: this.id,
          status: res.success ? "completed" : "failed",
          success: res.success,
          summary: res.success ? detail : "Could not verify that " + String(appName || "the requested application") + " closed: " + detail,
          spokenSummary: res.success ? "The application close state was verified." : "I could not verify that the application closed.",
          evidence: [{ description: detail, source: "windows.process-close", timestamp: startTime, confidence: res.success ? 1 : 0,
            data: { requestedApplication: appName ?? null, processStateVerified: res.success } }],
          artifacts: [],
          verification: { passed: res.success, details: detail },
          data: {
            outcome: res.success ? "succeeded" : "failed",
            actionsAttempted: res.success ? ["Stop-Process through allow-listed process mapping"] : [],
            actualObservations: detail,
            processStateVerified: res.success,
            failures: res.success ? [] : [detail],
          },
        };
      }

      case "screenshot.capture":
      case "windows.screenshot_capture": {
        const res = await this.captureScreenshot();
        const detail = res.success
          ? "Captured and verified a non-empty Windows desktop screenshot at " + res.path + "."
          : "Screenshot capture failed or produced no verifiable file.";
        return {
          agentId: this.id,
          status: res.success ? "completed" : "failed",
          success: res.success,
          summary: detail,
          spokenSummary: res.success ? "Screenshot captured and the file was verified." : "I could not verify screenshot capture.",
          evidence: res.success ? [{ description: detail, source: res.path, timestamp: new Date().toISOString(), confidence: 1, data: { artifactExists: true } }] : [],
          artifacts: res.success ? [res.path] : [],
          verification: { passed: res.success, details: detail },
          data: { outcome: res.success ? "succeeded" : "failed", path: res.path || null, artifactExists: res.success },
        };
      }

      default:
        throw new Error(`WindowsAgent: Unknown action '${action}'`);
    }
  }

  private async restartWifiAdapter(): Promise<{ success: boolean; adapter: string; output: string; connected: boolean; simulated?: boolean }> {
    if (process.env.FAKE === "1") {
      return {
        success: false,
        adapter: "Wi-Fi (Fake)",
        connected: false,
        simulated: true,
        output: "FAKE mode: Wi-Fi restart was simulated. No adapter state was changed or verified.",
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
      const psCommand = "$adapter = Get-NetAdapter | Where-Object { $_.Name -like '*Wi-Fi*' -or $_.InterfaceDescription -like '*Wireless*' } | Select-Object -First 1; if ($adapter) { [string]$adapter.Status } else { 'Unknown' }";
      const { stdout } = await runPowerShell(psCommand, {}, 4000);
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
    const key = typeof appName === "string" ? appName.trim().toLowerCase() : "";
    const executable = appMap[key];
    if (!executable || ["cmd", "terminal"].includes(key)) {
      return { success: false, output: "Application is not on the safe launch allow-list. Arbitrary executable and terminal launches are disabled." };
    }
    try {
      const { stdout } = await runPowerShell(
        "$process = Start-Process -FilePath $env:VANESSA_APP -PassThru -ErrorAction Stop; if (-not $process) { throw 'Start-Process did not return a process' }; [pscustomobject]@{ pid = [int]$process.Id; name = [string]$process.ProcessName } | ConvertTo-Json -Compress",
        { VANESSA_APP: executable }, 5000
      );
      const observed = JSON.parse(stdout.trim());
      if (!Number.isSafeInteger(observed?.pid) || observed.pid < 1 || typeof observed?.name !== "string" || !observed.name) {
        return { success: false, output: "Windows did not return a valid process identity for the launch request." };
      }
      return { success: true, output: "Windows accepted launch for " + executable + " (PID " + observed.pid + ", process " + observed.name + ")." };
    } catch (err: any) {
      return { success: false, output: "Could not launch " + appName + ": " + err.message };
    }
  }

  private async closeApp(appName: string): Promise<{ success: boolean; output: string }> {
    const processNames: Record<string, string> = {
      notepad: "notepad", calc: "Calculator", calculator: "Calculator",
      explorer: "explorer", chrome: "chrome", edge: "msedge", vscode: "Code",
    };
    const key = typeof appName === "string" ? appName.trim().toLowerCase() : "";
    const processName = processNames[key];
    if (!processName) {
      return { success: false, output: "Application is not on the safe close allow-list." };
    }
    try {
      const { stdout } = await runPowerShell(
        "$name = $env:VANESSA_APP; $before = @(Get-Process -Name $name -ErrorAction SilentlyContinue); if ($before.Count -gt 0) { $before | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 150 }; $remaining = @(Get-Process -Name $name -ErrorAction SilentlyContinue); [pscustomobject]@{ before = $before.Count; remaining = $remaining.Count } | ConvertTo-Json -Compress",
        { VANESSA_APP: processName }, 5000
      );
      const observed = JSON.parse(stdout.trim());
      if (!Number.isSafeInteger(observed?.before) || !Number.isSafeInteger(observed?.remaining) || observed.remaining < 0) {
        return { success: false, output: "Windows returned no valid process-close verification." };
      }
      if (observed.remaining !== 0) {
        return { success: false, output: "Could not verify that all " + processName + " processes stopped; remaining: " + observed.remaining + "." };
      }
      return { success: true, output: observed.before === 0
        ? "Verified that no " + processName + " process was running."
        : "Stopped " + observed.before + " " + processName + " process(es) and verified none remain." };
    } catch (error: any) {
      return { success: false, output: "Could not verify process termination: " + (error?.message || "unknown PowerShell error") };
    }
  }

  private async captureScreenshot(): Promise<{ success: boolean; path: string }> {
    const screenshotPath = path.join(os.tmpdir(), `vanessa_screenshot_${Date.now()}.png`);
    const psCommand = "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height); $graphics = [System.Drawing.Graphics]::FromImage($bitmap); $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size); $bitmap.Save($env:VANESSA_SCREENSHOT); $graphics.Dispose(); $bitmap.Dispose()";
    try {
      await runPowerShell(psCommand, { VANESSA_SCREENSHOT: screenshotPath }, 10000);
      const observed = fs.statSync(screenshotPath);
      if (!observed.isFile() || observed.size <= 0) return { success: false, path: "" };
      return { success: true, path: screenshotPath };
    } catch {
      return { success: false, path: "" };
    }
  }
}

export const windowsAgent = new WindowsAgent();
export const systemAgent = windowsAgent;
