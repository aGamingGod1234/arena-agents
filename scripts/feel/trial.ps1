<#
Feel-harness trial runner (runs on Windows in an isolated trial checkout).
Runs real LLM agents headlessly on a random-seed natural world with the goal "beat the game." for a fixed
play window, one agent per world (the headless runner allows one agent per natural world), all worlds
sharing ONE seed so providers face identical terrain. Providers run in parallel unless -Sequential.

  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\feel\trial.ps1 -TrialId baseline-1 -PlayMinutes 30

Artifacts: <OutRoot>\<TrialId>\<sol|opus>\{coordinator.jsonl, server-latest.log, provider-turns.private.jsonl, ...}
plus trial.json (seed, jar sha, profiles, times). Nothing here touches the real .minecraft or launcher.
#>
[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)] [string] $TrialId,
	[string] $Repo = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent),
	[string] $ModJar,
	[string[]] $Providers = @('sol', 'opus'),
	[double] $PlayMinutes = 30,
	[string] $Seed,
	[string] $Task = 'beat the game.',
	[string] $OutRoot = (Join-Path $env:USERPROFILE 'aa-trials\runs'),
	[string] $Template,
	[string] $Java,
	[int] $StaggerSeconds = 25,
	[switch] $Sequential
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Template)) { $Template = Join-Path $Repo 'runtime\server-template' }
if ([string]::IsNullOrWhiteSpace($Java)) { $Java = $env:ARENA_HEADLESS_JAVA }
if ([string]::IsNullOrWhiteSpace($Java)) {
	$javaPathFile = Join-Path $env:USERPROFILE 'aa-trials\java-path.txt'
	if (Test-Path -LiteralPath $javaPathFile) { $Java = (Get-Content -LiteralPath $javaPathFile -Raw).Trim() }
}
if ([string]::IsNullOrWhiteSpace($Java)) { $Java = (Get-Command java.exe -ErrorAction Stop).Source }
if (-not (Test-Path -LiteralPath $Java)) { throw "Missing Java: $Java" }
$env:ARENA_HEADLESS_JAVA = $Java
$profiles = @{
	sol  = @{ provider = 'codex';  model = 'gpt-6.1-sol';     reasoningEffort = 'low'; serviceTier = 'default' }
	opus = @{ provider = 'claude'; model = 'claude-opus-5-5'; reasoningEffort = 'low'; serviceTier = 'priority' }
}
foreach ($p in $Providers) { if (-not $profiles.ContainsKey($p)) { throw "Unknown provider key '$p' (use sol, opus)" } }
if ([string]::IsNullOrWhiteSpace($ModJar)) { $ModJar = Join-Path $Repo 'build\libs\arena-agents-0.2.0.jar' }
foreach ($path in @($Repo, $ModJar, $Template)) { if (-not (Test-Path -LiteralPath $path)) { throw "Missing: $path" } }
if ([string]::IsNullOrWhiteSpace($Seed)) {
	$bytes = New-Object byte[] 8
	[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
	$Seed = [string][BitConverter]::ToInt64($bytes, 0)
}
$trialDir = Join-Path $OutRoot $TrialId
if (Test-Path -LiteralPath $trialDir) { throw "Trial directory already exists: $trialDir" }
New-Item -ItemType Directory -Path $trialDir -Force | Out-Null

$playMs = [int]($PlayMinutes * 60000)
$prepMs = 300000
$matrixScenarios = @()
foreach ($p in $Providers) {
	$pr = $profiles[$p]
	$matrixScenarios += [ordered]@{
		id = "feel-$p"; provider = $pr.provider; model = $pr.model; reasoningEffort = $pr.reasoningEffort; serviceTier = $pr.serviceTier
		task = $Task; timeoutMs = $playMs + $prepMs; scenarioTimeoutMs = $playMs + $prepMs; rosterSize = 1; repetitions = 1
		playWindowMs = $playMs; preparationTimeoutMs = $prepMs; continueAfterDeath = $true; requireFactualSuccess = $true
		assert = @(@{ type = 'rcon'; command = 'data get entity {agent} Pos'; match = 'has the following entity data' })
		world = [ordered]@{ mode = 'natural'; seed = $Seed; generator = 'minecraft:normal'; difficulty = 'normal'; gameMode = 'survival'
			rules = [ordered]@{ advance_time = $true; spawn_mobs = $true }; spawn = @{ policy = 'world_spawn' } }
	}
}
$matrixPath = Join-Path $trialDir 'matrix.json'
[IO.File]::WriteAllText($matrixPath, ([ordered]@{ version = 1; scenarios = $matrixScenarios } | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))

$wrapper = Join-Path $Repo 'scripts\run-headless-provider-matrix.ps1'
$head = (& git -C $Repo rev-parse --short HEAD).Trim()
$jarSha = (Get-FileHash -LiteralPath $ModJar -Algorithm SHA256).Hash
$started = [DateTimeOffset]::UtcNow
$info = [ordered]@{ trialId = $TrialId; seed = $Seed; playMinutes = $PlayMinutes; task = $Task; repo = $Repo; commit = $head; modJar = $ModJar; modSha256 = $jarSha
	providers = $Providers; profiles = $profiles; parallel = (-not $Sequential); startedUtc = $started.ToString('o') }
$info | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $trialDir 'trial.json')
Write-Host "Trial $TrialId seed=$Seed commit=$head jar=$($jarSha.Substring(0,12)) play=${PlayMinutes}m providers=$($Providers -join ',')"

$runs = @()
foreach ($p in $Providers) {
	$out = Join-Path $trialDir "$p.wrapper.out.txt"; $err = Join-Path $trialDir "$p.wrapper.err.txt"
	$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$wrapper`" -ProjectRoot `"$Repo`" -MatrixPath `"$matrixPath`" -ScenarioId feel-$p -ServerTemplate `"$Template`" -ModJar `"$ModJar`" -KeepArtifacts"
	$proc = Start-Process -FilePath powershell.exe -ArgumentList $arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
	Write-Host "Started $p wrapper pid $($proc.Id)"
	$runs += [pscustomobject]@{ key = $p; proc = $proc; out = $out }
	if ($Sequential) { $proc.WaitForExit() } elseif ($p -ne $Providers[-1]) { Start-Sleep -Seconds $StaggerSeconds } # stagger so free-port reservation does not race
}
foreach ($r in $runs) { $r.proc.WaitForExit() }

$summary = @()
foreach ($r in $runs) {
	$text = Get-Content -LiteralPath $r.out -Raw -ErrorAction SilentlyContinue
	$reportPath = $null
	if ($text -match '"reportPath":\s*"([^"]+)"') { $reportPath = ($Matches[1] -replace '\\\\', '\') }
	$runDir = if ($reportPath) { Split-Path -Parent $reportPath } else { $null }
	$dest = Join-Path $trialDir $r.key
	New-Item -ItemType Directory -Path $dest -Force | Out-Null
	if ($runDir -and (Test-Path -LiteralPath $runDir)) {
		$scenarioDir = Get-ChildItem -LiteralPath $runDir -Directory | Select-Object -First 1
		if ($scenarioDir) {
			foreach ($pattern in 'coordinator*.jsonl*', 'provider-turns*.jsonl*', 'protocol*.jsonl*', 'report.json', 'manifest.json', 'world-manifest.json') {
				Get-ChildItem -Path (Join-Path $scenarioDir.FullName $pattern) -File -ErrorAction SilentlyContinue | Copy-Item -Destination $dest -Force
			}
			$log = Join-Path $scenarioDir.FullName 'server\logs\latest.log'
			if (Test-Path -LiteralPath $log) { Copy-Item -LiteralPath $log -Destination (Join-Path $dest 'server-latest.log') -Force }
			if (Test-Path -LiteralPath (Join-Path $scenarioDir.FullName 'traces')) { Copy-Item -LiteralPath (Join-Path $scenarioDir.FullName 'traces') -Destination $dest -Recurse -Force }
			foreach ($directory in 'report-artifacts', 'logs') {
				if (Test-Path -LiteralPath (Join-Path $scenarioDir.FullName $directory)) { Copy-Item -LiteralPath (Join-Path $scenarioDir.FullName $directory) -Destination $dest -Recurse -Force }
			}
			Copy-Item -LiteralPath $reportPath -Destination (Join-Path $dest 'matrix-report.json') -Force -ErrorAction SilentlyContinue
			$info['runDir_' + $r.key] = $runDir
		}
	}
	$classification = $null
	$rp = Join-Path $dest 'report.json'
	if (Test-Path -LiteralPath $rp) { try { $classification = (Get-Content -LiteralPath $rp -Raw | ConvertFrom-Json).classification } catch {} }
	# A fixed play window ends as TIMEOUT with wrapper exit 1; that is the normal result for this harness.
	$summary += [pscustomobject]@{ provider = $r.key; wrapperExit = $r.proc.ExitCode; classification = $classification; artifacts = $dest }
}
$info['finishedUtc'] = [DateTimeOffset]::UtcNow.ToString('o')
$info['results'] = $summary
$info | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $trialDir 'trial.json')
$summary | Format-Table -AutoSize | Out-String | Write-Host
Write-Host "Done. Artifacts: $trialDir"
