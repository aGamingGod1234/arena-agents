[CmdletBinding()]
param(
    # Which orchestrator's runner helper to test; the default is this checkout's.
    [string] $OrchestratorPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# AUTO-004: a runner attempt must not leave a detached descendant alive, even one started by a runner that exits (or
# is killed at its timeout) before any process snapshot could discover it. Drives the real Invoke-RunnerProcess.
$repositoryRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OrchestratorPath)) { $OrchestratorPath = Join-Path $repositoryRoot 'scripts\run-latency-ab-experiment.ps1' }
$fixtureRunner = Join-Path $repositoryRoot 'scripts\fixtures\latency-ab\fixture-runner-detached-child.mjs'
$script:OwnedJobWrapperPath = Join-Path $repositoryRoot 'coordinator\src\owned-windows-job.ps1'

$ast = [System.Management.Automation.Language.Parser]::ParseFile($OrchestratorPath, [ref]$null, [ref]$null)
foreach ($definition in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    . ([scriptblock]::Create($definition.Extent.Text))
}

$node = (Get-Command node -ErrorAction Stop).Source
$plan = [pscustomobject]@{ Kind = 'node'; Path = $fixtureRunner; Executable = $node; PrefixArguments = @($fixtureRunner); DisplayName = 'fixture-runner-detached-child.mjs' }
$workRoot = Join-Path ([IO.Path]::GetTempPath()) ('latency-ab-containment-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $workRoot | Out-Null
$failures = New-Object 'System.Collections.Generic.List[string]'
$testStarted = [DateTime]::Now.AddSeconds(-1)

function Test-DetachedChild {
    param([string] $Mode, [int] $TimeoutSeconds)
    $pidFile = Join-Path $workRoot "$Mode.pid"
    $child = $null
    try {
        $result = Invoke-RunnerProcess -CommandPlan $plan -Arguments @($pidFile, $Mode) -WorkingDirectory $workRoot -TimeoutSeconds $TimeoutSeconds -OutputLimit 65536
        if (-not (Test-Path -LiteralPath $pidFile)) { $failures.Add("${Mode}: the runner never started its detached child"); return }
        $childPid = [int](Get-Content -Raw -LiteralPath $pidFile)
        try { $child = Get-Process -Id $childPid -ErrorAction Stop } catch { $child = $null }
        # Only a process started during this test counts as the fixture's child (never a reused PID).
        if ($null -ne $child -and $child.StartTime -lt $testStarted) { $child = $null }
        $alive = $null -ne $child -and -not $child.HasExited
        Write-Output ("{0}: started={1} exitCode={2} timedOut={3} cleanupOk={4} detachedChild={5} aliveAfterReturn={6}" -f
            $Mode, $result.Started, $result.ExitCode, $result.TimedOut, $result.Cleanup.Ok, $childPid, $alive)
        if ($alive) { $failures.Add("${Mode}: detached child $childPid survived the attempt (cleanupOk=$($result.Cleanup.Ok))") }
        if ($Mode -eq 'exit' -and -not ([string]$result.Stdout).Contains('"status":"passed"')) { $failures.Add("${Mode}: runner output was not forwarded") }
    }
    finally {
        # Clean up this test's exact child through its acquired handle if the attempt left it running.
        if ($null -ne $child -and -not $child.HasExited) { try { $child.Kill(); $child.WaitForExit(5000) | Out-Null } catch { } }
        if ($null -ne $child) { $child.Dispose() }
    }
}

try {
    Test-DetachedChild -Mode 'exit' -TimeoutSeconds 60
    Test-DetachedChild -Mode 'hang' -TimeoutSeconds 5
}
finally {
    Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
}
if ($failures.Count -gt 0) { throw ("Runner job containment failed:`n" + ($failures -join "`n")) }
Write-Output 'PASS: runner attempts leave no detached descendant alive'
