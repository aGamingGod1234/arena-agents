import test from 'node:test';
import { powershellFixture } from './fixtures/g26-powershell-fixture.mjs';
test('lifecycle assertions reject success for every actual pattern', { skip: process.platform !== 'win32', timeout: 120_000 }, async () => {
 await powershellFixture(`Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Lifecycle,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Parse error'}
$helper=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-Fails'},$true)
Invoke-Expression $helper.Extent.Text
$calls=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Assert-Fails'},$true))
$patterns=@($calls | ForEach-Object {$_.CommandElements[-1].Value} | Sort-Object -Unique)
foreach($pattern in $patterns){
 $rejected=$false
 try {Assert-Fails {'normal success'} $pattern} catch {$rejected=$true}
 if(-not $rejected){throw "Success accepted for $pattern"}
 $matching=if($pattern.StartsWith('Coordinator (?:')){'Coordinator bridge did not become ready'}else{($pattern -split '\\|')[0]}
 Assert-Fails {throw $matching} $pattern
 $rejected=$false
 try {Assert-Fails {throw 'unrelated zqx'} $pattern} catch {$rejected=$true}
 if(-not $rejected){throw 'Unrelated failure accepted'}
}
# Exact caller assertions must stop a successful injected launcher before PASS.
function Successful-Launcher {param($ProjectRoot,$MatrixPath,$ServerTemplate) 'success'}
$scriptPath='Successful-Launcher'; $fixture=$PSScriptRoot; $largeMatrix='uncreated.json'
foreach($pattern in @('distinct|duplicate|port','Selected scenario count|bounded maximum|maximum')){
 $call=@($calls|Where-Object {$_.CommandElements[-1].Value -eq $pattern})[0]
 $rejected=$false
 try {& ([scriptblock]::Create($call.Extent.Text + "\`nthrow 'UNREACHED_PASS'"))} catch {
  if($_.Exception.Message -eq 'UNREACHED_PASS'){throw 'Caller falsely reached PASS'}
  $rejected=$true
 }
 if(-not $rejected){throw 'Caller did not reject success'}
}
Write-Output "PASS all $($patterns.Count) assertion patterns and exact negative callers"
`);
});

test('resource snapshots retain transient children without authorizing PID cleanup', { skip: process.platform !== 'win32', timeout: 120_000 }, async () => {
 await powershellFixture(`# Independent f127 fixture. Executes exact AST-extracted production functions.
# CIM, process handles, Stop-Process and Start-Sleep are in-memory boundaries.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$project = (Get-Location).Path
$sourcePath = $Launcher
$expectedHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Parse failure' }
$required = @('ConvertTo-ProcessCreationKey','Get-ProcessSnapshot','Test-ProcessIdentityMatch','Test-ChildCreationAfterParent','Add-ProcessTreeSnapshot','Get-TrackedResourceSnapshot','Add-TrackedProcessIdentity','Measure-RunnerResourcesUntilExit','Stop-TrackedProcessIds','Assert-TrackedProcessIdsGone')
$definitions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $required -contains $node.Name }, $true))
if ($definitions.Count -ne $required.Count) { throw 'Missing production function' }
foreach ($definition in $definitions) { Invoke-Expression $definition.Extent.Text }
$script:CleanupTimeoutSeconds = 30
$script:PairedState = $null
$script:PollMilliseconds = 250
$script:caseMode = 'empty'
$script:cimCalls = 0
$script:sleeps = 0
$script:stops = [Collections.Generic.List[int]]::new()
$script:live = @{}
$script:frames = @()
$script:waits = 0
$results = [Collections.Generic.List[object]]::new()
function Get-CimInstance {
    [CmdletBinding()] param([string]$ClassName)
    if ($ClassName -ne 'Win32_Process') { throw 'Unexpected CIM class' }
    $script:cimCalls += 1
    if ($script:caseMode -eq 'sampling') {
        $index = $script:cimCalls - 1
        if ($index -ge $script:frames.Count) { throw 'Unexpected extra sampling scan' }
        return $script:frames[$index]
    }
    if ($script:caseMode -eq 'reuse-during-discovery' -and $script:cimCalls -eq 2) { $script:live[42] = New-CimRow 42 999 '9000' }
    return @($script:live.Values)
}
function Stop-Process {
    [CmdletBinding()] param([int]$Id, [switch]$Force)
    if ($script:caseMode -ne 'mixed' -or $Id -ne 1001) { throw "Unexpected synthetic termination: $Id" }
    $script:stops.Add($Id)
    $script:live.Remove($Id)
}
function Start-Sleep { param([int]$Milliseconds) $script:sleeps += 1 }
function New-CimRow([int]$Id, [int]$Parent, [string]$Creation) {
    return [pscustomobject]@{ ProcessId=$Id; ParentProcessId=$Parent; CreationDate=$Creation; WorkingSetSize=1000L }
}
function New-HistoricalIdentities([int]$Count) {
    $items = [Collections.Generic.List[object]]::new()
    for ($index=1; $index -le $Count; $index++) { $items.Add((New-CimRow $index 999 ([string](1000+$index)))) }
    return ,$items
}
# New integrated sampler -> cleanup proof: three transient children, then every process exits.
$script:cimCalls=0; $script:sleeps=0; $script:stops.Clear(); $script:caseMode='sampling'; $script:waits=0
$root = New-CimRow 10 1 '100'
$script:frames = @(@($root,(New-CimRow 20 10 '200')), @($root,(New-CimRow 21 10 '201')), @($root,(New-CimRow 22 10 '202')), @())
$process = [pscustomobject]@{ Id=10; HasExited=$false; WorkingSet64=1000L }
$process | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
$process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($milliseconds) $script:waits += 1; $this.HasExited = ($script:waits -ge 3); return $this.HasExited }
$handle = @{ Process=$process; Identity=$root; InitialRssBytes=1000L }
$tracked = [Collections.Generic.List[object]]::new()
$peak = Measure-RunnerResourcesUntilExit $handle @($handle) $tracked ([DateTime]::UtcNow.AddSeconds(30))
$sampleCalls = $script:cimCalls
$trackedIds = @($tracked.ToArray() | ForEach-Object { $_.ProcessId })
if (($trackedIds -join ',') -ne '10,20,21,22' -or $sampleCalls -ne 4) { throw 'Sampler history or shared snapshots disproved' }
$script:caseMode='empty'; $script:cimCalls=0; $script:live=@{}
Stop-TrackedProcessIds $tracked
if ($script:cimCalls -ne 0 -or $script:stops.Count -ne 0) { throw 'Integrated cleanup count mismatch' }
$results.Add([pscustomobject]@{ case='sampler-to-cleanup'; samples=$sampleCalls; retainedIdentities=$trackedIds; peakProcesses=$peak.processCount; cleanupCimCalls=$script:cimCalls; syntheticStops=$script:stops.Count })
Write-Output 'PASS resource sampling and cleanup use separate authorities'
`);
});

test('standalone resource lifecycle initializes state in a fresh session', { skip: process.platform !== 'win32', timeout: 120_000 }, async () => {
 await powershellFixture(`Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$wrapperSource=Get-Content -Raw -LiteralPath $Launcher
$scriptPath=$Launcher
$ast=[Management.Automation.Language.Parser]::ParseFile($Lifecycle,[ref]$tokens,[ref]$errors)
foreach($name in @('Import-WrapperFunction','Test-FastExitResourceSampling')){
 $function=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
 Invoke-Expression $function.Extent.Text
}
if(Get-Variable PairedState -Scope Script -ErrorAction SilentlyContinue){throw 'Expected fresh scope'}
Test-FastExitResourceSampling $PSScriptRoot
Write-Output 'PASS full fast-exit resource test with fresh initialized scope and owned descendant cleanup'
`);
});
