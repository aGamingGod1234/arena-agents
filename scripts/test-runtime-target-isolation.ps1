[CmdletBinding()]
param([string] $PrepareScriptPath = (Join-Path $PSScriptRoot 'prepare-runtime.ps1'))

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'project-metadata.ps1')
. (Join-Path $PSScriptRoot 'runtime-target-guard.ps1')

function Assert-True([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw "FAIL $Message" }
}
function Assert-Fails([scriptblock] $Action, [string] $Pattern) {
    $message = $null
    try { & $Action } catch { $message = $_.Exception.Message }
    Assert-True ($null -ne $message -and $message -match $Pattern) "expected '$Pattern', got '$message'"
}
function Get-FixtureManifest([string] $Root) {
    (@(Get-ChildItem -LiteralPath $Root -File -Recurse -Force | Sort-Object FullName | ForEach-Object {
        "$($_.FullName):$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)"
    }) -join "`n")
}
function Get-TestTarget([string] $Project, [string] $Target) {
    $null = Use-ArenaMinecraftTarget $Project $Target
    [ordered]@{
        schemaVersion = 1
        minecraftVersion = Get-ArenaGradleProperty $Project 'minecraft_version'
        loaderVersion = Get-ArenaGradleProperty $Project 'loader_version'
        fabricApiVersion = Get-ArenaGradleProperty $Project 'fabric_api_version'
        carpetJar = [IO.Path]::GetFileName((Resolve-ArenaCarpetJar $Project))
        agentJar = [IO.Path]::GetFileName((Resolve-ArenaModJar $Project))
    }
}

$fixture = Join-Path ([IO.Path]::GetTempPath()) "arena-runtime-target-test-$([Guid]::NewGuid().ToString('N'))"
$oldAppData = $env:APPDATA
try {
    $project = Join-Path $fixture 'project'
    $env:APPDATA = Join-Path $fixture 'appdata'
    New-Item -ItemType Directory -Force -Path (Join-Path $project 'gradle/mc'), (Join-Path $env:APPDATA '.minecraft/saves/New World (76)') | Out-Null
    $repo = Split-Path -Parent $PSScriptRoot
    Copy-Item -LiteralPath (Join-Path $repo 'gradle.properties') -Destination $project
    foreach ($target in @('26.1', '26.2')) {
        Copy-Item -LiteralPath (Join-Path $repo "gradle/mc/$target.properties") -Destination (Join-Path $project 'gradle/mc')
    }
    $directories = @((Join-Path $project 'runtime/server'), (Join-Path $env:APPDATA '.minecraft-agent-55'), (Join-Path $env:APPDATA '.minecraft-agent-56'))
    $default = Get-TestTarget $project '26.3'
    Initialize-ArenaRuntimeTarget $directories $default
    foreach ($directory in $directories) {
        [IO.File]::WriteAllText((Join-Path $directory 'user-data.txt'), 'preserve user settings')
        New-Item -ItemType Directory -Path (Join-Path $directory 'mods') | Out-Null
        [IO.File]::WriteAllText((Join-Path $directory "mods/$($default.agentJar)"), 'existing mod')
    }
    New-Item -ItemType Directory -Path (Join-Path $directories[0] 'world') | Out-Null
    [IO.File]::WriteAllText((Join-Path $directories[0] 'world/level.dat'), 'existing world')
    [IO.File]::WriteAllText((Join-Path $directories[0] 'fabric-server-launch.jar'), 'existing 26.3 launcher')
    $before = Get-FixtureManifest $fixture
    Initialize-ArenaRuntimeTarget $directories $default
    Assert-True ((Get-FixtureManifest $fixture) -ceq $before) 'same-target retry preserves markers, launcher, mods and world'

    # Invoke the real preparation entry point. Rejection must precede prerequisite
    # checks, Gradle, downloads, client installation and all runtime writes.
    foreach ($target in @('26.1', '26.2')) {
        Assert-Fails { & $PrepareScriptPath -ProjectRoot $project -Target $target -SkipBuild } 'Runtime target mismatch'
        Assert-True ((Get-FixtureManifest $fixture) -ceq $before) "$target switch left all existing files unchanged"
    }
    Write-Output 'PASS real preparation rejects 26.3 to 26.1 and 26.2 switches without writes'

    foreach ($installedTarget in @('26.1', '26.2', '26.3')) {
        $isolated = Join-Path $fixture "isolated-$installedTarget"
        $expected = Get-TestTarget $project $installedTarget
        Initialize-ArenaRuntimeTarget @($isolated) $expected
        foreach ($selectedTarget in @('26.1', '26.2', '26.3')) {
            $selected = Get-TestTarget $project $selectedTarget
            if ($installedTarget -eq $selectedTarget) {
                Assert-ArenaRuntimeTarget @($isolated) $selected
            } else {
                Assert-Fails { Initialize-ArenaRuntimeTarget @($isolated) $selected } 'Runtime target mismatch'
            }
        }
    }
    Write-Output 'PASS all target-pair mismatches rejected; same-target reuse accepted'

    foreach ($directory in $directories) {
        $empty = Join-Path $fixture "empty-$([Guid]::NewGuid().ToString('N'))"
        $alternate = Get-TestTarget $project '26.1'
        Assert-Fails { Initialize-ArenaRuntimeTarget @($empty, $directory) $alternate } 'Runtime target mismatch'
        Assert-True (-not (Test-Path -LiteralPath $empty)) 'all directories checked before first write'
    }
    $legacy = Join-Path $fixture 'legacy'
    New-Item -ItemType Directory -Path $legacy | Out-Null
    [IO.File]::WriteAllText((Join-Path $legacy 'level.dat'), 'unmarked world')
    $legacyBefore = Get-FixtureManifest $legacy
    Assert-Fails { Initialize-ArenaRuntimeTarget @($legacy) $default } 'Runtime target is unknown'
    Assert-True ((Get-FixtureManifest $legacy) -ceq $legacyBefore) 'unmarked legacy data preserved'

    foreach ($key in $default.Keys) {
        $changed = [ordered]@{}
        foreach ($name in $default.Keys) { $changed[$name] = $default[$name] }
        $changed[$key] = 'different'
        Assert-Fails { Assert-ArenaRuntimeTarget $directories $changed } 'Runtime target mismatch'
    }
    Write-Output 'PASS every profile and managed version guarded; unknown legacy data preserved'
} finally {
    $env:APPDATA = $oldAppData
    if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
