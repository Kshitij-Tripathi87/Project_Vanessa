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
import { privacyGuard } from "../core/privacy.js";
import { inspectForegroundWindow, invokeForegroundControl } from "./windows-ui-automation.js";

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
    context?: AgentRunContext
  ): Promise<AgentResult> {
    const action = typeof actionOrTask === "string" ? actionOrTask : actionOrTask.action || actionOrTask.objective;
    const params = typeof actionOrTask === "string" ? (paramsOrContext as Record<string, any>) || {} : actionOrTask.params || {};
    const runCtx = typeof actionOrTask === "string" ? context : (paramsOrContext as AgentRunContext);

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
          status: "completed",
          success: true,
          summary: output,
          spokenSummary: "I inspected " + windowTitle + " and found " + controls.length + " accessible controls. I did not read input-field values.",
          evidence: [{ description: output, source: "Windows UI Automation Control View", timestamp: startTime, confidence: 1 }],
          artifacts: [],
          verification: { passed: true, details: "The foreground window identity and bounded accessibility tree were returned. Input-field values were not read." },
          data: {
            output,
            windowTitle,
            windowHandle: inspected.windowHandle,
            processId: inspected.processId,
            controls,
            truncated: inspected.truncated === true,
            valuesRead: false,
          },
        };
      }

      case "ui.click":
      case "windows.ui_click": {
        if (this.fakeMode) return this.simulatedOutcome("Foreground-window control invocation", { invocationAccepted: false, postClickStateVerified: false });
        const request = {
          windowHandle: String(params.windowHandle || ""),
          expectedWindowTitle: String(params.expectedWindowTitle || ""),
          expectedProcessId: Number(params.expectedProcessId),
          automationId: typeof params.automationId === "string" ? params.automationId : undefined,
          name: typeof params.name === "string" ? params.name : undefined,
          controlType: typeof params.controlType === "string" ? params.controlType : undefined,
        };
        let invoked;
        try {
          invoked = await invokeForegroundControl(this.powerShellRunner, request);
        } catch (error) {
          const detail = "Windows UI Automation invocation failed: " + (error instanceof Error ? error.message : String(error));
          return {
            agentId: this.id,
            status: "failed",
            success: false,
            summary: detail,
            spokenSummary: "I could not invoke that Windows control.",
            evidence: [],
            artifacts: [],
            verification: { passed: false, details: detail },
            error: detail,
            data: { output: detail, invocationAccepted: false, postClickStateVerified: false, error: detail },
          };
        }
        const cleanText = (value: string) => privacyGuard.redactSensitiveData(value).cleanText;
        const windowTitle = cleanText(String(invoked.windowTitle || request.expectedWindowTitle)).slice(0, 180);
        const control = invoked.control ? {
          name: cleanText(String(invoked.control.name || "")).slice(0, 140),
          automationId: cleanText(String(invoked.control.automationId || "")).slice(0, 100),
          controlType: String(invoked.control.controlType || ""),
          className: cleanText(String(invoked.control.className || "")).slice(0, 100),
        } : undefined;
        if (!invoked.success || invoked.invocationAccepted !== true) {
          const detail = invoked.error || "Windows did not accept the UI Automation invocation.";
          return {
            agentId: this.id,
            status: "failed",
            success: false,
            summary: detail,
            spokenSummary: "I could not invoke the selected control. I did not fall back to coordinates or a different control.",
            evidence: [],
            artifacts: [],
            verification: { passed: false, details: detail },
            error: detail,
            data: { output: detail, windowTitle, control, invocationAccepted: false, postClickStateVerified: false, error: detail },
          };
        }
        const output = "UI Automation invoked " + (control?.name ? `"${control.name}"` : `AutomationId "${control?.automationId || request.automationId}"`) +
          " in \"" + windowTitle + "\". The resulting screen state was not independently verified.";
        return {
          agentId: this.id,
          status: "completed",
          success: true,
          summary: output,
          spokenSummary: "I invoked the selected control in " + windowTitle + ". I have not independently verified what changed on screen.",
          evidence: [{ description: output, source: "Windows UI Automation InvokePattern", timestamp: startTime, confidence: 1, data: { controlType: control?.controlType, automationId: control?.automationId } }],
          artifacts: [],
          verification: { passed: true, details: "Exactly one enabled, onscreen control matched the inspected window and selector; InvokePattern.Invoke returned without exception. The downstream screen effect was not independently verified." },
          data: { output, windowTitle, processId: invoked.processId, control, invocationAccepted: true, postClickStateVerified: false, message: invoked.message },
        };
      }

      case "wifi.restart_adapter":
      case "windows.wifi_restart": {
        if (this.fakeMode) return this.simulatedOutcome("Wi-Fi adapter restart", { adapter: "Unknown", connected: false });
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

      case "bluetooth.enable":
      case "bluetooth.disable":
      case "windows.bluetooth_toggle": {
        const enable = action.includes("enable") || params.enabled === true;
        if (this.fakeMode) return this.simulatedOutcome("Bluetooth state change", { requestedState: enable ? "On" : "Off", state: "Unknown" });
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
      case "windows.volume_set": {
        const level = params.level ?? 50;
        if (this.fakeMode) return this.simulatedOutcome("Master volume change", { requestedLevel: level, readBackVerified: false });
        const res = await this.setVolume(level);
        return {
          agentId: this.id,
          status: res.success ? "completed" : "failed",
          success: res.success,
          summary: res.success
            ? "System volume read back at " + res.level + "%."
            : "Volume adjustment failed or could not be verified: " + res.output,
          spokenSummary: res.success
            ? "System volume set to " + res.level + " percent."
            : "I could not verify the requested system volume.",
          evidence: res.success ? [{
            description: res.output,
            source: "Windows Core Audio master-volume read-back",
            timestamp: startTime,
            confidence: 1,
            data: { requestedLevel: level, observedLevel: res.level },
          }] : [],
          artifacts: [],
          verification: { passed: res.success, details: res.output },
          data: {
            actionsAttempted: ["Set default playback endpoint master volume to " + String(level) + "%"],
            actualObservations: res.output,
            failures: res.success ? [] : [res.output],
            requestedLevel: level,
            actualObservedLevel: res.level,
            readBackVerified: res.success,
          },
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
        if (this.fakeMode) return this.simulatedOutcome("Desktop screenshot", { path: "" });
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

  private async changeBrightness(value: number, mode: "set" | "adjust"): Promise<{ success: boolean; level: number; output: string }> {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      return { success: false, level: Number.NaN, output: "Brightness must be an integer percentage or adjustment." };
    }
    if (mode === "set" && (value < 0 || value > 100)) {
      return { success: false, level: value, output: "Brightness level must be between 0 and 100." };
    }
    if (mode === "adjust" && (value === 0 || value < -100 || value > 100)) {
      return { success: false, level: Number.NaN, output: "Brightness adjustment must be between -100 and 100 percentage points and cannot be zero." };
    }
    const script = "$ErrorActionPreference = 'Stop'\n$statesBefore = @(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop)\nif ($statesBefore.Count -eq 0) { throw 'No WMI-controlled display brightness device was found.' }\n$current = [int]$statesBefore[0].CurrentBrightness\nif ($env:VANESSA_BRIGHTNESS_MODE -eq 'adjust') {\n  $target = [int][math]::Round($current + [double]$env:VANESSA_BRIGHTNESS_VALUE)\n} else {\n  $target = [int][math]::Round([double]$env:VANESSA_BRIGHTNESS_VALUE)\n}\n$target = [math]::Max(0, [math]::Min(100, $target))\n$methods = @(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop)\nif ($methods.Count -eq 0) { throw 'Windows did not expose a controllable brightness method.' }\nforeach ($method in $methods) {\n  $result = Invoke-CimMethod -InputObject $method -MethodName WmiSetBrightness -Arguments @{ Timeout = [uint32]1; Brightness = [byte]$target } -ErrorAction Stop\n  if ([int]$result.ReturnValue -ne 0) { throw ('WmiSetBrightness returned ' + [string]$result.ReturnValue) }\n}\nStart-Sleep -Milliseconds 400\n$observed = @(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop | ForEach-Object { [int]$_.CurrentBrightness })\nif ($observed.Count -eq 0) { throw 'Brightness read-back returned no monitor values.' }\n$allMatch = @($observed | Where-Object { $_ -ne $target }).Count -eq 0\n[pscustomobject]@{ Current = $current; Target = $target; Observed = $observed; AllMatch = $allMatch } | ConvertTo-Json -Compress -Depth 4";
    try {
      const { stdout } = await this.powerShellRunner(script, {
        VANESSA_BRIGHTNESS_MODE: mode,
        VANESSA_BRIGHTNESS_VALUE: String(value),
      }, 8000);
      const parsed = JSON.parse(String(stdout).trim()) as {
        Current?: number;
        Target?: number;
        Observed?: number[] | number;
        AllMatch?: boolean;
      };
      const level = Number(parsed.Target);
      if (!Number.isFinite(level) || level < 0 || level > 100) {
        return { success: false, level: Number.NaN, output: "Windows returned an invalid brightness target." };
      }
      const observed = Array.isArray(parsed.Observed) ? parsed.Observed.map(Number) : [Number(parsed.Observed)];
      const validReadback = observed.length > 0 && observed.every((item) => Number.isFinite(item) && item >= 0 && item <= 100);
      const verified = validReadback && parsed.AllMatch === true && observed.every((item) => item === level);
      const readbackText = validReadback ? observed.join("%, ") + "%" : "unavailable";
      return {
        success: verified,
        level,
        output: verified
          ? "Windows display brightness set and read back at " + level + "% on all reported displays."
          : "Brightness target was " + level + "% but read-back was " + readbackText + "; the requested state was not verified.",
      };
    } catch (err) {
      return {
        success: false,
        level: Number.NaN,
        output: "Windows brightness control failed: " + (err instanceof Error ? err.message : String(err)) + ". Some external displays do not support WMI brightness control.",
      };
    }
  }

  private async setVolume(level: number): Promise<{ success: boolean; level: number; output: string }> {
    const numericLevel = Number(level);
    if (!Number.isFinite(numericLevel) || numericLevel < 0 || numericLevel > 100) {
      return { success: false, level: numericLevel, output: "Volume level must be a number between 0 and 100." };
    }

    // Use the Windows Core Audio endpoint API instead of media-key events,
    // which depend on foreground focus and cannot prove a target level.
    const script = "$ErrorActionPreference = 'Stop'\n$source = @'\nusing System;\nusing System.Runtime.InteropServices;\n\nnamespace VanessaAudio {\n  public enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }\n  public enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }\n\n  [ComImport, Guid(\"A95664D2-9614-4F35-A746-DE8DB63617E6\"),\n   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]\n  public interface IMMDeviceEnumerator {\n    [PreserveSig] int EnumAudioEndpoints(EDataFlow flow, uint stateMask, out IntPtr devices);\n    [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow flow, ERole role, out IMMDevice device);\n  }\n\n  [ComImport, Guid(\"D666063F-1587-4E43-81F1-B948E807363F\"),\n   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]\n  public interface IMMDevice {\n    [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr activationParams,\n      [MarshalAs(UnmanagedType.Interface)] out IAudioEndpointVolume endpoint);\n  }\n\n  [ComImport, Guid(\"5CDF2C82-841E-4546-9722-0CF74078229A\"),\n   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]\n  public interface IAudioEndpointVolume {\n    [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);\n    [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);\n    [PreserveSig] int GetChannelCount(out uint channelCount);\n    [PreserveSig] int SetMasterVolumeLevel(float levelDb, ref Guid eventContext);\n    [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid eventContext);\n    [PreserveSig] int GetMasterVolumeLevel(out float levelDb);\n    [PreserveSig] int GetMasterVolumeLevelScalar(out float level);\n  }\n\n  public static class EndpointVolume {\n    public static float SetAndRead(float requestedLevel) {\n      if (requestedLevel < 0.0f || requestedLevel > 1.0f)\n        throw new ArgumentOutOfRangeException(\"requestedLevel\");\n      object enumeratorObject = null;\n      IMMDevice device = null;\n      IAudioEndpointVolume endpoint = null;\n      try {\n        Type enumeratorType = Type.GetTypeFromCLSID(new Guid(\"BCDE0395-E52F-467C-8E3D-C4579291692E\"), true);\n        enumeratorObject = Activator.CreateInstance(enumeratorType);\n        IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)enumeratorObject;\n        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device));\n        Guid iid = typeof(IAudioEndpointVolume).GUID;\n        Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out endpoint));\n        Guid eventContext = Guid.Empty;\n        Marshal.ThrowExceptionForHR(endpoint.SetMasterVolumeLevelScalar(requestedLevel, ref eventContext));\n        float observed;\n        Marshal.ThrowExceptionForHR(endpoint.GetMasterVolumeLevelScalar(out observed));\n        return observed;\n      } finally {\n        if (endpoint != null) Marshal.ReleaseComObject(endpoint);\n        if (device != null) Marshal.ReleaseComObject(device);\n        if (enumeratorObject != null && Marshal.IsComObject(enumeratorObject)) Marshal.ReleaseComObject(enumeratorObject);\n      }\n    }\n  }\n}\n'@\nAdd-Type -TypeDefinition $source -Language CSharp\n$target = [single]([double]$env:VANESSA_VOLUME / 100.0)\n$observed = [VanessaAudio.EndpointVolume]::SetAndRead($target)\n[pscustomobject]@{ Requested = [double]$target; Observed = [double]$observed } | ConvertTo-Json -Compress";
    try {
      const { stdout } = await this.powerShellRunner(script, { VANESSA_VOLUME: String(numericLevel) }, 8000);
      const parsed = JSON.parse(String(stdout).trim()) as { Requested?: number; Observed?: number };
      const observed = Number(parsed.Observed);
      if (!Number.isFinite(observed) || observed < 0 || observed > 1) {
        return { success: false, level: numericLevel, output: "Windows returned an invalid master-volume read-back value." };
      }
      const observedPercent = Math.round(observed * 1000) / 10;
      const requestedScalar = numericLevel / 100;
      if (Math.abs(observed - requestedScalar) > 0.015) {
        return {
          success: false,
          level: observedPercent,
          output: "Windows master volume read back as " + observedPercent + "%; requested " + numericLevel + "%. The requested state was not verified.",
        };
      }
      return {
        success: true,
        level: observedPercent,
        output: "Windows Core Audio set the default playback endpoint to " + observedPercent + "% and read back the same master-volume value.",
      };
    } catch (err) {
      return {
        success: false,
        level: numericLevel,
        output: "Windows Core Audio volume adjustment failed: " + (err instanceof Error ? err.message : String(err)),
      };
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
