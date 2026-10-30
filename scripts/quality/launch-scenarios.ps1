[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)] [string] $ProjectRoot,
	[Parameter(Mandatory = $true)] [string] $ArgumentsFile,
	[ValidateSet("run-scenarios.mjs", "run-generality.mjs", "run-long.mjs", "run-ladder.mjs")] [string] $Runner = "run-scenarios.mjs",
	[string] $JobDirectory
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
$ArgumentsFile = [IO.Path]::GetFullPath($ArgumentsFile)
$arguments = Get-Content -LiteralPath $ArgumentsFile -Raw | ConvertFrom-Json
if ($arguments -isnot [array] -or $arguments.Count -eq 0 -or @($arguments | Where-Object { $_ -isnot [string] }).Count -gt 0) { throw 'ArgumentsFile must contain a nonempty JSON array of strings' }
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot ('scripts\quality\' + $Runner)))) { throw 'Missing scenario runner' }
if ([string]::IsNullOrWhiteSpace($JobDirectory)) { $JobDirectory = Join-Path $ProjectRoot ('runtime\quality-jobs\' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)) }
$JobDirectory = [IO.Path]::GetFullPath($JobDirectory)
if (Test-Path -LiteralPath $JobDirectory) { throw 'Use a new job directory to preserve prior results' }
$node = Join-Path $ProjectRoot 'runtime\toolchains\node\node.exe'
if (-not (Test-Path -LiteralPath $node)) { $node = (Get-Command node.exe -ErrorAction Stop).Source }
New-Item -ItemType Directory -Path $JobDirectory -Force | Out-Null
$encoding = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText((Join-Path $JobDirectory 'arguments.json'), (ConvertTo-Json -InputObject ([string[]] $arguments)), $encoding)
function Quote-Literal([string] $value) { return "'" + $value.Replace("'", "''") + "'" }
$worker = @"
`$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $(Quote-Literal $ProjectRoot)
`$started = [DateTime]::UtcNow.ToString('o')
`$argsFromFile = Get-Content -LiteralPath $(Quote-Literal (Join-Path $JobDirectory 'arguments.json')) -Raw | ConvertFrom-Json
`$exitCode = 1
try {
 & $(Quote-Literal $node) $(Quote-Literal (Join-Path $ProjectRoot ('scripts\quality\' + $Runner))) @argsFromFile *> $(Quote-Literal (Join-Path $JobDirectory 'worker.log'))
 `$exitCode = `$LASTEXITCODE
} catch {
 `$_ | Out-String | Add-Content -LiteralPath $(Quote-Literal (Join-Path $JobDirectory 'worker.log'))
}
@{ started = `$started; finished = [DateTime]::UtcNow.ToString('o'); exitCode = `$exitCode } | ConvertTo-Json | Set-Content -LiteralPath $(Quote-Literal (Join-Path $JobDirectory 'status.json'))
exit `$exitCode
"@
[IO.File]::WriteAllText((Join-Path $JobDirectory 'worker.ps1'), $worker.Replace("`r`n", "`n").Replace("`n", "`r`n"), $encoding)
# WMI creation avoids the SSH job that killed a Start-Process child on disconnect.
$startup = New-CimInstance -CimClass (Get-CimClass Win32_ProcessStartup) -Property @{ ShowWindow = [uint16] 0 } -ClientOnly
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("& " + (Quote-Literal (Join-Path $JobDirectory 'worker.ps1'))))
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"; CurrentDirectory = $ProjectRoot; ProcessStartupInformation = $startup }
if ($result.ReturnValue -ne 0) { throw "Hidden worker creation failed: $($result.ReturnValue)" }
[IO.File]::WriteAllText((Join-Path $JobDirectory 'pid.txt'), [string] $result.ProcessId, $encoding)
Write-Output "Worker PID $($result.ProcessId); status: $JobDirectory\status.json; log: $JobDirectory\worker.log"
