$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
  throw "This acceptance test must run on a real Windows host."
}

$env:VANESSA_RUN_WINDOWS_HOST_ACCEPTANCE = "1"
pnpm --filter @vanessa/orchestrator exec tsx --test src/tests/windowsReadOnlyExecution.hostAcceptance.test.ts
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
