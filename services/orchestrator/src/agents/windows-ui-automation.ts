import { runPowerShell } from "./powershell.js";

export interface UiAutomationControl {
  name: string;
  automationId: string;
  controlType: string;
  className: string;
  isEnabled: boolean;
  isOffscreen: boolean;
  depth: number;
}

export interface ForegroundWindowInspection {
  success: boolean;
  windowTitle?: string;
  windowHandle?: string;
  processId?: number;
  controls?: UiAutomationControl[];
  truncated?: boolean;
  valuesRead?: boolean;
  error?: string;
}

export interface UiAutomationClickRequest {
  windowHandle: string;
  expectedWindowTitle: string;
  expectedProcessId: number;
  automationId?: string;
  name?: string;
  controlType?: string;
}

export interface UiAutomationClickResult {
  success: boolean;
  windowTitle?: string;
  processId?: number;
  control?: { name: string; automationId: string; controlType: string; className?: string };
  invocationAccepted?: boolean;
  postClickStateVerified?: boolean;
  message?: string;
  error?: string;
  matches?: Array<{ name: string; automationId: string; controlType: string }>;
}

/**
 * Inspect only the foreground window's bounded Control View tree.
 * The script deliberately never reads ValuePattern contents or edit-field values.
 */
const UI_INSPECT_SCRIPT = "$ErrorActionPreference = 'Stop'\nAdd-Type -AssemblyName UIAutomationClient\nAdd-Type -AssemblyName UIAutomationTypes\n$nativeSource = @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class VanessaUiNative {\n  [DllImport(\"user32.dll\")]\n  public static extern IntPtr GetForegroundWindow();\n  [DllImport(\"user32.dll\")]\n  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);\n}\n'@\nAdd-Type -TypeDefinition $nativeSource -Language CSharp\n$handle = [VanessaUiNative]::GetForegroundWindow()\nif ($handle -eq [IntPtr]::Zero) { throw 'No foreground window is available.' }\n$root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)\nif ($null -eq $root) { throw 'Windows UI Automation could not access the foreground window.' }\n$processId = [uint32]0\n[void][VanessaUiNative]::GetWindowThreadProcessId($handle, [ref]$processId)\n$windowTitle = [string]$root.Current.Name\n$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker\n$items = [System.Collections.Generic.List[object]]::new()\n$stack = [System.Collections.Generic.Stack[object]]::new()\n$stack.Push([pscustomobject]@{ Element = $root; Depth = 0 })\n$visited = 0\nwhile ($stack.Count -gt 0 -and $items.Count -lt 120 -and $visited -lt 300) {\n  $entry = $stack.Pop()\n  $element = $entry.Element\n  $depth = [int]$entry.Depth\n  $visited++\n  try {\n    $current = $element.Current\n    if ($depth -gt 0) {\n      $name = [string]$current.Name\n      $automationId = [string]$current.AutomationId\n      $className = [string]$current.ClassName\n      if ($name.Length -gt 140) { $name = $name.Substring(0, 140) }\n      if ($automationId.Length -gt 100) { $automationId = $automationId.Substring(0, 100) }\n      if ($className.Length -gt 100) { $className = $className.Substring(0, 100) }\n      $items.Add([pscustomobject]@{\n        name = $name\n        automationId = $automationId\n        controlType = [string]$current.ControlType.ProgrammaticName\n        className = $className\n        isEnabled = [bool]$current.IsEnabled\n        isOffscreen = [bool]$current.IsOffscreen\n        depth = $depth\n      })\n    }\n    if ($depth -lt 8 -and $stack.Count -lt 300 -and $items.Count -lt 120) {\n      $child = $walker.GetLastChild($element)\n      $childCount = 0\n      while ($null -ne $child -and $childCount -lt 80 -and $stack.Count -lt 300) {\n        $stack.Push([pscustomobject]@{ Element = $child; Depth = $depth + 1 })\n        $child = $walker.GetPreviousSibling($child)\n        $childCount++\n      }\n    }\n  } catch {\n    # UIA nodes can disappear during navigation; skip stale nodes and stay bounded.\n  }\n}\n[pscustomobject]@{\n  success = $true\n  windowTitle = $windowTitle\n  windowHandle = [string]$handle.ToInt64()\n  processId = [int]$processId\n  controls = @($items.ToArray())\n  truncated = ($stack.Count -gt 0 -or $visited -ge 300 -or $items.Count -ge 120)\n  valuesRead = $false\n} | ConvertTo-Json -Depth 6 -Compress";

/**
 * Invoke only one uniquely matched, enabled, onscreen control on the exact
 * previously inspected HWND/PID/title. Never falls back to coordinate clicks.
 */
const UI_CLICK_SCRIPT = "$ErrorActionPreference = 'Stop'\nAdd-Type -AssemblyName UIAutomationClient\nAdd-Type -AssemblyName UIAutomationTypes\n$nativeSource = @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class VanessaUiNative {\n  [DllImport(\"user32.dll\")]\n  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);\n}\n'@\nAdd-Type -TypeDefinition $nativeSource -Language CSharp\n[long]$handleNumber = 0\nif (![long]::TryParse($env:VANESSA_UI_WINDOW_HANDLE, [ref]$handleNumber) -or $handleNumber -le 0) {\n  [pscustomobject]@{ success = $false; error = 'The inspected window handle is invalid.' } | ConvertTo-Json -Compress\n  return\n}\n$handle = [IntPtr]$handleNumber\n$root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)\nif ($null -eq $root) {\n  [pscustomobject]@{ success = $false; error = 'The inspected window is no longer available.' } | ConvertTo-Json -Compress\n  return\n}\n$windowTitle = [string]$root.Current.Name\nif ($windowTitle -cne $env:VANESSA_UI_EXPECTED_WINDOW_TITLE) {\n  [pscustomobject]@{ success = $false; error = 'The inspected window title changed. Inspect the current window again before clicking.'; windowTitle = $windowTitle } | ConvertTo-Json -Compress\n  return\n}\n$processId = [uint32]0\n[void][VanessaUiNative]::GetWindowThreadProcessId($handle, [ref]$processId)\nif ([string]$processId -cne $env:VANESSA_UI_EXPECTED_PROCESS_ID) {\n  [pscustomobject]@{ success = $false; error = 'The inspected window process changed. Inspect the current window again before clicking.'; windowTitle = $windowTitle } | ConvertTo-Json -Compress\n  return\n}\n$targetId = [string]$env:VANESSA_UI_AUTOMATION_ID\n$targetName = [string]$env:VANESSA_UI_CONTROL_NAME\n$targetType = [string]$env:VANESSA_UI_CONTROL_TYPE\nif ([string]::IsNullOrWhiteSpace($targetId) -and\n    ([string]::IsNullOrWhiteSpace($targetName) -or [string]::IsNullOrWhiteSpace($targetType))) {\n  [pscustomobject]@{ success = $false; error = 'Provide an exact AutomationId or an exact control name and ControlType.' } | ConvertTo-Json -Compress\n  return\n}\n$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker\n$matches = [System.Collections.Generic.List[object]]::new()\n$stack = [System.Collections.Generic.Stack[object]]::new()\n$stack.Push([pscustomobject]@{ Element = $root; Depth = 0 })\n$visited = 0\nwhile ($stack.Count -gt 0 -and $visited -lt 300 -and $matches.Count -lt 2) {\n  $entry = $stack.Pop()\n  $element = $entry.Element\n  $depth = [int]$entry.Depth\n  $visited++\n  try {\n    $current = $element.Current\n    if ($current.IsEnabled -and -not $current.IsOffscreen) {\n      $idMatches = -not [string]::IsNullOrWhiteSpace($targetId) -and ([string]$current.AutomationId -ceq $targetId)\n      $nameMatches = -not [string]::IsNullOrWhiteSpace($targetName) -and\n        ([string]$current.Name -ceq $targetName) -and\n        ([string]$current.ControlType.ProgrammaticName -ceq $targetType)\n      $matched = if (-not [string]::IsNullOrWhiteSpace($targetId)) {\n        if (-not [string]::IsNullOrWhiteSpace($targetName)) { $idMatches -and $nameMatches } else { $idMatches }\n      } else { $nameMatches }\n      if ($matched) {\n        $matches.Add([pscustomobject]@{\n          Element = $element\n          Name = [string]$current.Name\n          AutomationId = [string]$current.AutomationId\n          ControlType = [string]$current.ControlType.ProgrammaticName\n          ClassName = [string]$current.ClassName\n        })\n      }\n    }\n    if ($depth -lt 8 -and $stack.Count -lt 300 -and $matches.Count -lt 2) {\n      $child = $walker.GetLastChild($element)\n      $childCount = 0\n      while ($null -ne $child -and $childCount -lt 80 -and $stack.Count -lt 300) {\n        $stack.Push([pscustomobject]@{ Element = $child; Depth = $depth + 1 })\n        $child = $walker.GetPreviousSibling($child)\n        $childCount++\n      }\n    }\n  } catch {\n    # UIA nodes can disappear while other windows update; keep searching boundedly.\n  }\n}\nif ($matches.Count -eq 0) {\n  [pscustomobject]@{\n    success = $false\n    error = 'No uniquely matching enabled, onscreen control was found in the bounded UI tree.'\n    windowTitle = $windowTitle\n    visitedControls = $visited\n    searchTruncated = ($stack.Count -gt 0 -or $visited -ge 300)\n  } | ConvertTo-Json -Compress\n  return\n}\nif ($matches.Count -gt 1) {\n  $candidates = @($matches | ForEach-Object {\n    [pscustomobject]@{ name = $_.Name; automationId = $_.AutomationId; controlType = $_.ControlType }\n  })\n  [pscustomobject]@{\n    success = $false\n    error = 'The selector matched more than one control. Use the inspection result to choose a unique AutomationId or control name and type.'\n    windowTitle = $windowTitle\n    matches = $candidates\n  } | ConvertTo-Json -Depth 4 -Compress\n  return\n}\n$target = $matches[0]\n$invokePattern = $null\nif (-not $target.Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePattern)) {\n  [pscustomobject]@{\n    success = $false\n    error = 'The selected control does not support UI Automation InvokePattern; no click was attempted.'\n    windowTitle = $windowTitle\n    control = [pscustomobject]@{ name = $target.Name; automationId = $target.AutomationId; controlType = $target.ControlType }\n  } | ConvertTo-Json -Depth 4 -Compress\n  return\n}\ntry {\n  $invokePattern.Invoke()\n  [pscustomobject]@{\n    success = $true\n    windowTitle = $windowTitle\n    processId = [int]$processId\n    control = [pscustomobject]@{ name = $target.Name; automationId = $target.AutomationId; controlType = $target.ControlType; className = $target.ClassName }\n    invocationAccepted = $true\n    postClickStateVerified = $false\n    message = 'Windows UI Automation InvokePattern returned without exception. The downstream on-screen effect was not independently verified.'\n  } | ConvertTo-Json -Depth 5 -Compress\n} catch {\n  [pscustomobject]@{\n    success = $false\n    error = ('InvokePattern failed: ' + $_.Exception.Message)\n    windowTitle = $windowTitle\n    control = [pscustomobject]@{ name = $target.Name; automationId = $target.AutomationId; controlType = $target.ControlType; className = $target.ClassName }\n    invocationAccepted = $false\n    postClickStateVerified = $false\n  } | ConvertTo-Json -Depth 5 -Compress\n}";

function parseJson<T>(stdout: string, action: string): T {
  try {
    return JSON.parse(String(stdout || "").trim()) as T;
  } catch {
    throw new Error("Windows UI Automation returned malformed JSON for " + action + ".");
  }
}

export async function inspectForegroundWindow(
  runner: typeof runPowerShell,
): Promise<ForegroundWindowInspection> {
  const { stdout } = await runner(UI_INSPECT_SCRIPT, {}, 12000);
  const parsed = parseJson<ForegroundWindowInspection>(stdout, "foreground-window inspection");
  if (parsed.success !== true) {
    return { success: false, error: parsed.error || "The foreground window could not be inspected." };
  }
  return {
    success: true,
    windowTitle: typeof parsed.windowTitle === "string" ? parsed.windowTitle : "",
    windowHandle: typeof parsed.windowHandle === "string" ? parsed.windowHandle : "",
    processId: Number(parsed.processId),
    controls: Array.isArray(parsed.controls) ? parsed.controls.slice(0, 120) : [],
    truncated: parsed.truncated === true,
    valuesRead: false,
  };
}

export async function invokeForegroundControl(
  runner: typeof runPowerShell,
  request: UiAutomationClickRequest,
): Promise<UiAutomationClickResult> {
  const windowHandle = String(request.windowHandle || "").trim();
  const expectedWindowTitle = String(request.expectedWindowTitle || "");
  const expectedProcessId = Number(request.expectedProcessId);
  const automationId = String(request.automationId || "");
  const name = String(request.name || "");
  const controlType = String(request.controlType || "");

  if (!/^[0-9]+$/.test(windowHandle) || Number(windowHandle) <= 0) {
    return { success: false, error: "A valid windowHandle from a prior ui.inspect result is required." };
  }
  if (!expectedWindowTitle.trim() || !Number.isInteger(expectedProcessId) || expectedProcessId <= 0) {
    return { success: false, error: "A prior inspection's exact window title and process ID are required." };
  }
  if (!automationId.trim() && (!name.trim() || !/^ControlType\.[A-Za-z0-9]+$/.test(controlType))) {
    return { success: false, error: "Specify an exact selector: AutomationId or an exact name and ControlType." };
  }
  const { stdout } = await runner(UI_CLICK_SCRIPT, {
    VANESSA_UI_WINDOW_HANDLE: windowHandle,
    VANESSA_UI_EXPECTED_WINDOW_TITLE: expectedWindowTitle,
    VANESSA_UI_EXPECTED_PROCESS_ID: String(expectedProcessId),
    VANESSA_UI_AUTOMATION_ID: automationId,
    VANESSA_UI_CONTROL_NAME: name,
    VANESSA_UI_CONTROL_TYPE: controlType,
  }, 12000);
  return parseJson<UiAutomationClickResult>(stdout, "control invocation");
}
