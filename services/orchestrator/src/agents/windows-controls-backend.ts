// Focused PowerShell 5.1 helpers. Radio bridge reused from preserved local work.
export const windowsControlsBackend = String.raw`
function Wait-SettingsAsync($Operation, [type]$ResultType) {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and
        $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]96 + '1'
    } | Select-Object -First 1
    if (-not $method) { throw 'unsupported: WinRT AsTask bridge is unavailable' }
    $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    if (-not $task.Wait(5000)) { $Operation.Cancel(); throw 'async_timeout: WinRT operation did not finish within 5 seconds' }
    $task.GetAwaiter().GetResult()
}
function Get-SettingsRadios {
    try {
        $null = [Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime]
        $null = [Windows.Devices.Enumeration.DeviceInformation,Windows.Devices.Enumeration,ContentType=WindowsRuntime]
        $infos = Wait-SettingsAsync ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync([Windows.Devices.Radios.Radio]::GetDeviceSelector())) ([Windows.Devices.Enumeration.DeviceInformationCollection,Windows.Devices.Enumeration,ContentType=WindowsRuntime])
        foreach ($info in $infos) {
            $radio = Wait-SettingsAsync ([Windows.Devices.Radios.Radio]::FromIdAsync($info.Id)) ([Windows.Devices.Radios.Radio])
            if ($null -ne $radio -and $radio.Kind.ToString() -eq 'Bluetooth') {
                [pscustomobject]@{ id = $info.Id; name = $radio.Name; state = $radio.State.ToString(); kind = 'Bluetooth' }
            }
        }
    } catch [TypeLoadException] { throw 'unsupported: Windows.Devices.Radios requires compatible Windows 10+ desktop WinRT APIs' }
}
function ConvertTo-ControlDisplayName($Value) {
    $decoded = -join @($Value | Where-Object { $null -ne $_ } | ForEach-Object {
        if ($_ -is [string]) { $_ } else { [char]$_ }
    })
    $decoded = $decoded.Replace(([char]0).ToString(), '').Trim()
    if ([string]::IsNullOrWhiteSpace($decoded)) { return 'Brightness-capable display' }
    $decoded
}
function Get-ControlDevices($Control) {
    if ($Control -eq 'bluetooth') { Get-SettingsRadios; return }
    try {
        $writers = @(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop)
        $readers = @(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness -ErrorAction Stop)
    } catch {
        if ($_.Exception.StatusCode -in @('InvalidClass', 'NotSupported')) { throw 'unsupported: Display driver does not expose WMI brightness' }
        throw
    }
    try { $names = @(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorID -ErrorAction Stop) } catch { $names = @() }
    foreach ($display in $readers) {
        $writer = @($writers | Where-Object { $_.Active -and $_.InstanceName -ceq $display.InstanceName })
        if ($display.Active -and $writer.Count -eq 1) {
            if ($null -eq $display.CurrentBrightness -or $display.CurrentBrightness -lt 0 -or $display.CurrentBrightness -gt 100) { throw 'api_failure: Invalid brightness from provider' }
            $matching = @($names | Where-Object { $_.InstanceName -ceq $display.InstanceName })
            $friendly = 'Brightness-capable display'
            if ($matching.Count -eq 1) { $friendly = ConvertTo-ControlDisplayName $matching[0].UserFriendlyName }
            [pscustomobject]@{ id=$display.InstanceName; name=$friendly; brightnessPercent=[int]$display.CurrentBrightness; levels=@($display.Level); supported=$true }
        }
    }
}
function Get-ControlRadioAccess {
    Wait-SettingsAsync ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus,Windows.System.Devices,ContentType=WindowsRuntime])
}
function Get-ControlRadio($Id) {
    Wait-SettingsAsync ([Windows.Devices.Radios.Radio]::FromIdAsync($Id)) ([Windows.Devices.Radios.Radio])
}
function Set-ControlRadioState($Radio, $State) {
    $desired=[Enum]::Parse([Windows.Devices.Radios.RadioState,Windows.System.Devices,ContentType=WindowsRuntime], $State)
    Wait-SettingsAsync ($Radio.SetStateAsync($desired)) ([Windows.Devices.Radios.RadioAccessStatus])
}
function Set-ControlDevice($Request, $Before) {
    if ($Request.control -eq 'bluetooth') {
        $access = Get-ControlRadioAccess
        if ($access.ToString() -ne 'Allowed') { throw ('access_denied: Radio access returned ' + $access + '; interactive consent or system policy may prevent changes') }
        $radio = Get-ControlRadio $Before.id
        if ($null -eq $radio -or $radio.Kind.ToString() -ne 'Bluetooth') { throw 'target_missing: Selected Bluetooth radio no longer exists' }
        $outcome = Set-ControlRadioState $radio $Request.state
        if ($outcome.ToString() -ne 'Allowed') { throw ('access_denied: SetStateAsync returned ' + $outcome) }
        return
    }
    $matches = @(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop | Where-Object { $_.Active -and $_.InstanceName -ceq $Before.id })
    if ($matches.Count -ne 1) { throw 'target_missing: Brightness writer no longer uniquely available' }
    $outcome = Invoke-CimMethod -InputObject $matches[0] -MethodName WmiSetBrightness -Arguments @{Timeout=[uint32]0;Brightness=[byte]$Request.brightnessPercent} -ErrorAction Stop
    # Documented uint32 return: reject explicit failures. Some providers omit the
    # output/ReturnValue; only bounded actual readback can establish success then.
    if ($null -ne $outcome -and $null -ne $outcome.ReturnValue -and $outcome.ReturnValue -ne 0) {
        throw ('api_failure: WmiSetBrightness returned ' + $outcome.ReturnValue)
    }
}
`;
