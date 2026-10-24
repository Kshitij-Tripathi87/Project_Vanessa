// Fixed Windows PowerShell 5.1 program. Request values arrive in a JSON file.
export const powerShellRunner = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$vexRequest = Get-Content -LiteralPath $env:VANESSA_EXEC_REQUEST -Raw -Encoding UTF8 | ConvertFrom-Json
$vexEncoding = New-Object System.Text.UTF8Encoding($false)
function Write-VexEvent($value) {
  [System.IO.File]::AppendAllText($env:VANESSA_EXEC_EVENTS, (($value | ConvertTo-Json -Compress -Depth 8) + [Environment]::NewLine), $vexEncoding)
}
if ($vexRequest.workingDirectory) { Set-Location -LiteralPath $vexRequest.workingDirectory }
$vexNativeBreakpoint = Set-PSBreakpoint -Variable LASTEXITCODE -Mode Write -Action {
  if ($null -ne $global:LASTEXITCODE -and $global:LASTEXITCODE -ne 0 -and $null -eq $global:vexNativeFailure) {
    $global:vexNativeFailure = $global:LASTEXITCODE
  }
}
foreach ($vexStep in $vexRequest.steps) {
  Write-VexEvent @{ type = 'start'; id = $vexStep.id; cwd = (Get-Location).Path; startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  $vexWatch = [System.Diagnostics.Stopwatch]::StartNew()
  $vexCount = 0
  $vexFailed = $false
  $global:LASTEXITCODE = $null
  $global:vexNativeFailure = $null
  $ErrorActionPreference = 'Stop'
  try {
    $vexBlock = [scriptblock]::Create($vexStep.command)
    . $vexBlock *>&1 | ForEach-Object {
      $vexIsError = $_ -is [System.Management.Automation.ErrorRecord]
      if ($vexIsError) { $vexFailed = $true }
      if ($vexCount -lt 65536) {
        $vexText = ($_ | Out-String -Width 200).TrimEnd([char[]]@(13, 10)) + [Environment]::NewLine
        $vexText = $vexText.Substring(0, [Math]::Min($vexText.Length, 65536 - $vexCount))
        $vexCount += $vexText.Length
        Write-VexEvent @{ type = 'output'; id = $vexStep.id; stream = $(if ($vexIsError) { 'stderr' } else { 'stdout' }); text = $vexText }
      }
    }
  } catch {
    $vexFailed = $true
    Write-VexEvent @{ type = 'output'; id = $vexStep.id; stream = 'stderr'; text = $_.ToString().Substring(0, [Math]::Min(4096, $_.ToString().Length)) }
  }
  $vexCode = $global:LASTEXITCODE
  if ($null -ne $global:vexNativeFailure) { $vexCode = $global:vexNativeFailure }
  if ($null -ne $vexCode -and $vexCode -ne 0) { $vexFailed = $true }
  Write-VexEvent @{ type = 'end'; id = $vexStep.id; failed = $vexFailed; exitCode = $vexCode; durationMs = $vexWatch.ElapsedMilliseconds; cwd = (Get-Location).Path; outputTruncated = ($vexCount -ge 65536) }
  if ($vexFailed) { break }
}
Remove-PSBreakpoint -Breakpoint $vexNativeBreakpoint
Write-VexEvent @{ type = 'done'; cwd = (Get-Location).Path }
`;
