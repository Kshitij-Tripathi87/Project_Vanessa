import { runPowerShell } from "./powershell.js";
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
  ) {}
  id = "windows";
  capabilities = [
    "wifi_adapter_control",
    "bluetooth_control",
    "brightness_control",
    "volume_control",
    "brightness_control",
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
    "display_brightness_control",
    "process_control",
    "windows_ui_automation",
  ];

  private simulatedOutcome(action: string, extraData: Record<string, unknown> = {}): AgentResult {
    const details = "FAKE mode: " + action + " was simulated for testing. No real Windows state was changed or verified.";
    return {
      agentId: this.id,
      status: "partial",
      success: true,
      summary: details,
      spokenSummary: "This action was simulated for testing. No real Windows state was changed or verified.",
      evidence: [],
      artifacts: [],
      verification: { passed: false, details },
      data: { simulated: true, actualStateChanged: false, actualStateVerified: false, actualObservations: details, failures: [], ...extraData },
    };
  }

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
        if (this.fakeMode) return this.simulatedOutcome("Active-window UI Automation inspection", { windowTitle: "", controls: [], valuesRead: false });
        let inspected;
        try {
          inspected = await inspectForegroundWindow(this.powerShellRunner);
        } catch (error) {
          const detail = "Foreground-window inspection failed: " + (error instanceof Error ? error.message : String(error));
          return {
            agentId: this.id,
            status: "failed",
            success: false,
            summary: detail,
            spokenSummary: "I could not inspect the active Windows window.",
            evidence: [],
            artifacts: [],
            verification: { passed: false, details: detail },
            error: detail,
            data: { output: detail, controls: [], valuesRead: false, error: detail },
          };
        }
        if (!inspected.success || !inspected.windowHandle || !/^\d+$/.test(inspected.windowHandle) ||
            !inspected.windowTitle?.trim() || !Number.isInteger(inspected.processId)) {
          const detail = inspected.error || "Windows did not return a complete foreground-window identity.";
          return {
            agentId: this.id,
            status: "failed",
            success: false,
            summary: detail,
            spokenSummary: "I could not identify the active Windows window safely.",
            evidence: [],
            artifacts: [],
            verification: { passed: false, details: detail },
            error: detail,
            data: { output: detail, controls: [], valuesRead: false, error: detail },
          };
        }
        const cleanText = (value: string) => privacyGuard.redactSensitiveData(value).cleanText;
        const windowTitle = cleanText(inspected.windowTitle).slice(0, 180);
        const controls = (inspected.controls || []).slice(0, 120).map((control) => ({
          name: cleanText(String(control.name || "")).slice(0, 140),
          automationId: cleanText(String(control.automationId || "")).slice(0, 100),
          controlType: String(control.controlType || ""),
          className: cleanText(String(control.className || "")).slice(0, 100),
          isEnabled: control.isEnabled === true,
          isOffscreen: control.isOffscreen === true,
          depth: Number.isInteger(control.depth) ? control.depth : 0,
        }));
        const output = "Inspected foreground window \"" + windowTitle + "\"; found " + controls.length +
          " accessibility controls" + (inspected.truncated ? " (list truncated)." : ".") + " No input-field values were read.";
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
        if (this.fakeMode) return this.simulatedOutcome("Wi-Fi status read", { status: "Unknown" });
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

      case "brightness.set":
      case "windows.brightness_set": {
        const level = Number(params.level);
        if (this.fakeMode) return this.simulatedOutcome("Display brightness change", { requestedLevel: level, readBackVerified: false });
        const res = await this.changeBrightness(level, "set");
        return {
          agentId: this.id,
          status: res.success ? "completed" : "failed",
          success: res.success,
          summary: res.output,
          spokenSummary: res.success
            ? "Display brightness set to " + res.level + " percent."
            : "I could not verify the requested display brightness.",
          evidence: res.success ? [{
            description: res.output,
            source: "Windows WMI brightness read-back",
            timestamp: startTime,
            confidence: 1,
            data: { requestedLevel: level, observedLevel: res.level },
          }] : [],
          artifacts: [],
          verification: { passed: res.success, details: res.output },
          data: {
            actionsAttempted: ["Set supported Windows display brightness to " + level + "%"],
            actualObservations: res.output,
            failures: res.success ? [] : [res.output],
            requestedLevel: level,
            actualObservedLevel: res.level,
            readBackVerified: res.success,
          },
        };
      }

      case "brightness.adjust":
      case "windows.brightness_adjust": {
        const delta = Number(params.delta ?? 10);
        if (this.fakeMode) return this.simulatedOutcome("Display brightness adjustment", { requestedDelta: delta, readBackVerified: false });
        const res = await this.changeBrightness(delta, "adjust");
        return {
          agentId: this.id,
          status: res.success ? "completed" : "failed",
          success: res.success,
          summary: res.output,
          spokenSummary: res.success
            ? "Display brightness is now " + res.level + " percent."
            : "I could not verify the display brightness adjustment.",
          evidence: res.success ? [{
            description: res.output,
            source: "Windows WMI brightness read-back",
            timestamp: startTime,
            confidence: 1,
            data: { observedLevel: res.level },
          }] : [],
          artifacts: [],
          verification: { passed: res.success, details: res.output },
          data: {
            actionsAttempted: ["Adjust supported Windows display brightness by " + delta + " percentage points"],
            actualObservations: res.output,
            failures: res.success ? [] : [res.output],
            requestedDelta: delta,
            actualObservedLevel: res.level,
            readBackVerified: res.success,
          },
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
          verification: { passed: res.success, details: res.output },
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
        if (this.fakeMode) return this.simulatedOutcome("Application launch", { appName });
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
        if (this.fakeMode) return this.simulatedOutcome("Application close", { appName });
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
          verification: { passed: res.success, details: res.output },
        };
      }

      case "screenshot.capture":
      case "windows.screenshot_capture": {
        if (this.fakeMode) return this.simulatedOutcome("Desktop screenshot", { path: "" });
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
        spokenSummary: status === "Unknown"
          ? "I could not verify the Wi-Fi adapter status."
          : "The Wi-Fi adapter status is " + status + ".",
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
      taskmgr: "taskmgr.exe",
      "task manager": "taskmgr.exe",
      "file explorer": "explorer.exe",
      settings: "ms-settings:",
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
    const screenshotPath = path.join(os.tmpdir(), "vanessa_screenshot_" + Date.now() + ".png");
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
