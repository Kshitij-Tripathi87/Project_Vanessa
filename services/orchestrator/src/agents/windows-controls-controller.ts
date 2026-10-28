// Policy/readback separated from hardware APIs for mutation-free mock tests.
export const windowsControlsController = String.raw`
function Invoke-WindowsControl($Request) {
    $result = [ordered]@{success=$false;control=$Request.control;operation=$Request.operation;requested=$Request;target=$null;observed=$null;verification=@{passed=$false;kind='not_run';waitedMs=0};error=$null}
    try {
        if ($Request -isnot [pscustomobject]) { throw 'invalid_input: Request must be an object' }
        if ($Request.control -cnotin @('brightness','bluetooth')) { throw 'invalid_input: Unknown control' }
        if ($Request.operation -cnotin @('list','get','set')) { throw 'invalid_input: Operation must be list, get or set' }
        $fields = @($Request.PSObject.Properties.Name)
        foreach ($name in $fields) { if ($name -cnotin @('control','operation','targetId','targetName','brightnessPercent','state','waitMs')) { throw ('invalid_input: Unknown field ' + $name) } }
        $mutation = $Request.operation -ceq 'set'
        foreach ($name in @('targetId','targetName')) {
            if ($fields -contains $name -and ($Request.$name -isnot [string] -or [string]::IsNullOrWhiteSpace($Request.$name))) { throw ('invalid_input: ' + $name + ' must be a nonempty string') }
        }
        if (($fields -contains 'targetId') -and ($fields -contains 'targetName')) { throw 'invalid_input: Select by targetId OR targetName' }
        if ($Request.operation -eq 'list' -and ($fields -contains 'targetId' -or $fields -contains 'targetName')) { throw 'invalid_input: list does not accept a target' }
        if (($fields -contains 'state') -and (-not $mutation -or $Request.control -ne 'bluetooth')) { throw 'invalid_input: state is only valid for Bluetooth set' }
        if (($fields -contains 'brightnessPercent') -and (-not $mutation -or $Request.control -ne 'brightness')) { throw 'invalid_input: brightnessPercent is only valid for brightness set' }
        if ($Request.control -eq 'bluetooth' -and $mutation -and $Request.state -cnotin @('On','Off')) { throw 'invalid_input: Explicit On or Off required' }
        if ($Request.control -eq 'brightness' -and $mutation) {
            $value=$Request.brightnessPercent
            if ($value -isnot [ValueType] -or $value -is [bool] -or [double]::IsNaN([double]$value) -or [double]::IsInfinity([double]$value) -or $value -lt 0 -or $value -gt 100 -or [Math]::Floor([double]$value) -ne $value) { throw 'invalid_input: brightnessPercent must be an integer 0..100' }
        }
        $waitMs=5000
        if ($fields -contains 'waitMs') {
            $value=$Request.waitMs
            if ($value -isnot [ValueType] -or $value -is [bool] -or $value -lt 100 -or $value -gt 10000 -or [Math]::Floor([double]$value) -ne $value) { throw 'invalid_input: waitMs must be an integer 100..10000' }
            $waitMs=[int]$value
        }
        $devices=@(Get-ControlDevices $Request.control)
        if ($devices.Count -eq 0) {
            $result.observed=@{devices=@()}
            if ($Request.control -eq 'brightness') { throw 'unsupported: No active display exposes brightness read and write support' }
            throw 'no_device: No Bluetooth radios discovered'
        }
        if ($Request.operation -eq 'list') {
            $result.observed=@{devices=@($devices)}; $result.success=$true
            $result.verification=@{passed=$true;kind='discovery_snapshot';waitedMs=0}
            return [pscustomobject]$result
        }
        $matches=$devices
        if ($Request.targetId) { $matches=@($devices | Where-Object { $_.id -ceq $Request.targetId }) }
        if ($Request.targetName) { $matches=@($devices | Where-Object { $_.name -ceq $Request.targetName }) }
        if ($matches.Count -eq 0) { throw 'target_missing: Selected target not present' }
        if ($matches.Count -ne 1) {
            $result.observed=@{devices=@($matches)}
            throw 'ambiguous_target: Choose one friendly candidate; orchestrator must retain its discovered ID'
        }
        $before=$matches[0]; $result.target=@{id=$before.id;name=$before.name}; $result.observed=$before
        if (-not $mutation) {
            $result.success=$true; $result.verification=@{passed=$true;kind='read_only_snapshot';waitedMs=0}
            return [pscustomobject]$result
        }
        if ($Request.control -eq 'brightness' -and @($before.levels).Count -gt 0 -and @($before.levels) -notcontains [int]$Request.brightnessPercent) { throw 'unsupported_value: Requested percent not in exposed display levels' }
        $result.observed=$null
        Set-ControlDevice $Request $before
        $watch=[Diagnostics.Stopwatch]::StartNew()
        do {
            $matches=@(Get-ControlDevices $Request.control | Where-Object { $_.id -ceq $before.id })
            if ($matches.Count -gt 1) { throw 'ambiguous_target: Duplicate target identity during readback' }
            $result.observed=$null
            if ($matches.Count -eq 1) { $result.observed=$matches[0] }
            $passed=$false
            if ($null -ne $result.observed) {
                if ($Request.control -eq 'bluetooth') { $passed=$result.observed.state -ceq $Request.state }
                else { $passed=$result.observed.brightnessPercent -eq $Request.brightnessPercent }
            }
            $result.verification=@{passed=[bool]$passed;kind='state_readback';waitedMs=$watch.ElapsedMilliseconds}
            if ($passed) { $result.success=$true; break }
            if ($watch.ElapsedMilliseconds -ge $waitMs) { throw 'readback_mismatch: Requested state not observed within waitMs; hardware may have partially changed' }
            Start-Sleep -Milliseconds 100
        } while ($true)
    } catch {
        $exception=$_.Exception
        while ($exception.InnerException) { $exception=$exception.InnerException }
        $message=$exception.Message; $code='api_failure'
        if ($message -match '^([a-z_]+):\s*(.*)$') { $code=$Matches[1]; $message=$Matches[2] }
        elseif ($exception.HResult -eq -2147024891 -or $exception.StatusCode -eq 'AccessDenied') { $code='access_denied' }
        elseif ($_.FullyQualifiedErrorId -match 'TypeNotFound|CommandNotFound' -or $exception.StatusCode -in @('InvalidClass','NotSupported')) { $code='unsupported' }
        $result.error=@{code=$code;message=$message;hresult=('0x{0:X8}' -f $exception.HResult)}
        if ($mutation -and $result.target -and $null -eq $result.observed) {
            try {
                $fresh=@(Get-ControlDevices $Request.control | Where-Object { $_.id -ceq $result.target.id })
                if ($fresh.Count -eq 1) { $result.observed=$fresh[0] }
            } catch { }
        }
    }
    [pscustomobject]$result
}
`;
