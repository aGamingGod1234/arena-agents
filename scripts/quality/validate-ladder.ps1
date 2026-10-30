[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)] [string] $Java,
	[Parameter(Mandatory = $true)] [string] $ServerTemplate,
	[Parameter(Mandatory = $true)] [string] $Jar,
	[Parameter(Mandatory = $true)] [string] $Out,
	[int] $PortBase = 28200,
	[string] $Scenarios
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$Out = [IO.Path]::GetFullPath($Out)
if (Test-Path -LiteralPath $Out) { throw 'Use a new output directory for disposable fixture validation' }
if ($PortBase -lt 1024 -or $PortBase -gt 65533) { throw 'Invalid port block' }
foreach ($port in @($PortBase, ($PortBase + 1), ($PortBase + 2))) {
	$probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
	try { $probe.Start() } finally { $probe.Stop() }
}
New-Item -ItemType Directory -Path $Out | Out-Null
$server = Join-Path $Out 'server'
Copy-Item -LiteralPath $ServerTemplate -Destination $server -Recurse
if (Test-Path -LiteralPath (Join-Path $server 'world')) { throw 'Use a clean server template without a saved world' }
Get-ChildItem (Join-Path $server 'mods') -Filter '*arena*.jar' | Remove-Item
Copy-Item -LiteralPath $Jar -Destination (Join-Path $server 'mods\arena-agents-ladder.jar')
$password = [guid]::NewGuid().ToString('N')
$utf8 = [Text.UTF8Encoding]::new($false)
$passwordFile = Join-Path $Out 'rcon-password.txt'
[IO.File]::WriteAllText($passwordFile, $password, $utf8)
$properties = @"
online-mode=false
server-ip=127.0.0.1
server-port=$($PortBase + 2)
enable-rcon=true
rcon.ip=127.0.0.1
rcon.port=$($PortBase + 1)
rcon.password=$password
level-name=world
level-seed=20261009
level-type=minecraft:normal
generate-structures=true
difficulty=normal
gamemode=survival
pause-when-empty-seconds=-1
view-distance=8
simulation-distance=5
"@
[IO.File]::WriteAllText((Join-Path $server 'server.properties'), $properties, $utf8)
[IO.File]::WriteAllText((Join-Path $Out 'bridge-secret.txt'), [guid]::NewGuid().ToString('N'), $utf8)
$quote = { param($s) '"' + $s + '"' }
$arguments = @("-Darenaagents.bridgePort=$PortBase", '-Darenaagents.coordinatorAutoStart=false', "-Darenaagents.bridgeSecretFile=$(& $quote (Join-Path $Out 'bridge-secret.txt'))", '-Xms1G', '-Xmx2G', '-jar', 'fabric-server-launch.jar', 'nogui')
$process = Start-Process -FilePath $Java -ArgumentList $arguments -WorkingDirectory $server -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Out 'server.stdout.log') -RedirectStandardError (Join-Path $Out 'server.stderr.log')
$code = 1
try {
	$validationArgs = @((Join-Path $PSScriptRoot 'validate-ladder-fixtures.mjs'), '--rcon-port', [string]($PortBase + 1), '--password-file', $passwordFile, '--out', (Join-Path $Out 'fixture-validation.json'))
	if ($Scenarios) { $validationArgs += @('--scenarios', $Scenarios) }
	Push-Location $root
	try { & node @validationArgs 2>&1 | Tee-Object -FilePath (Join-Path $Out 'validation.log'); $code = $LASTEXITCODE } finally { Pop-Location }
} finally {
	# The process handle belongs to the Java server created above, never a shared trial.
	if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
}
exit $code
