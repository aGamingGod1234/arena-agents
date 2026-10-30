import assert from 'node:assert/strict';
import test from 'node:test';
import { powershellFixture } from './fixtures/g26-powershell-fixture.mjs';

test('matrix cleanup retains its validated handle across PID reuse and rejects exited-parent aliases', { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
 const output = await powershellFixture(String.raw`
$ErrorActionPreference = 'Stop'
$helper = Get-Content -Raw (Join-Path $SourceRoot 'coordinator/src/owned-windows-job.ps1')
$code = [regex]::Match($helper, '(?s)\$ownedJobSource = @"(.*?)"@').Groups[1].Value
# Execute the actual job algorithm with only kernel calls replaced. Handles
# distinguish two incarnations of PID 4242. No real process is opened or stopped.
$replacements = @{
 CreateJobObject = 'static IntPtr CreateJobObject(IntPtr a, string n) { return new IntPtr(1); }'
 SetInformationJobObject = 'static bool SetInformationJobObject(IntPtr j, int c, ref ExtendedLimits l, uint n) { return true; }'
 AssignProcessToJobObject = 'static bool AssignProcessToJobObject(IntPtr j, IntPtr p) { return true; }'
 GetCurrentProcess = 'static IntPtr GetCurrentProcess() { return new IntPtr(99); }'
 CloseHandle = 'static bool CloseHandle(IntPtr h) { return true; }'
 GetCurrentProcessId = 'static uint GetCurrentProcessId() { return 999; }'
 QueryInformationJobObject = 'static bool QueryInformationJobObject(IntPtr j, int k, IntPtr d, uint n, out uint r) { r=0; Marshal.WriteInt32(d,4,Scans++ == 0 ? 1 : 0); Marshal.WriteIntPtr(d,8,new IntPtr(4242)); return true; }'
 OpenProcess = 'static IntPtr OpenProcess(uint a, bool i, uint p) { return new IntPtr(Current); }'
 IsProcessInJob = 'static bool IsProcessInJob(IntPtr p, IntPtr j, out bool member) { member=p.ToInt32()==10; Current=20; return true; }'
 TerminateProcess = 'static bool TerminateProcess(IntPtr p, uint code) { Stops++; StoppedHandle=p.ToInt32(); return true; }'
}
foreach ($name in $replacements.Keys) {
 $pattern = '(?m)^    \[DllImport[^\r\n]+ static extern [^\r\n]+\b' + $name + '\([^\r\n]+;\r?$'
 if (-not [regex]::IsMatch($code,$pattern)) { throw "Missing kernel boundary: $name" }
 $code = [regex]::Replace($code, $pattern, ('    ' + $replacements[$name]))
}
$code = $code.Replace('public static class ArenaOwnedJob {', 'public static class ArenaOwnedJob { public static int Current=10, Scans=0, Stops=0, StoppedHandle=0;')
Add-Type -TypeDefinition $code
[ArenaOwnedJob]::Attach()
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Launcher,[ref]$tokens,[ref]$errors)
$required=@('Stop-TrackedProcessIds','Add-ProcessTreeSnapshot','Test-ChildCreationAfterParent','Test-ProcessIdentityMatch','ConvertTo-ProcessCreationKey')
foreach ($definition in $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $required -contains $n.Name},$true)) { Invoke-Expression $definition.Extent.Text }
function Stop-Process { throw 'PID-only stop is forbidden' }
$tracked=[Collections.Generic.List[object]]::new()
Stop-TrackedProcessIds $tracked
if ([ArenaOwnedJob]::Current -ne 20 -or [ArenaOwnedJob]::Stops -ne 1 -or [ArenaOwnedJob]::StoppedHandle -ne 10) { throw 'Reused PID did not retain original termination handle' }
# Reuse before opening: the replacement handle fails job membership.
[ArenaOwnedJob]::Scans=0; [ArenaOwnedJob]::Stops=0
Stop-TrackedProcessIds $tracked
if ([ArenaOwnedJob]::Stops -ne 0) { throw 'Unrelated replacement was stopped' }
$root=[pscustomobject]@{ProcessId=4242;ParentProcessId=1;CreationDate='1000'}
$child=[pscustomobject]@{ProcessId=4243;ParentProcessId=4242;CreationDate='9001'}
$tracked.Add($root)
Add-ProcessTreeSnapshot $tracked $root @{4243=$child}
if ($tracked.Count -ne 1) { throw 'Exited-parent alias adopted unrelated child' }
Write-Output 'PASS retained-handle race, replacement control, exited-parent alias'
`);
 assert.match(output, /PASS retained-handle race/);
});

test('matrix private job cleans a real exited-root descendant while preserving a pre-existing sentinel', { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
 await powershellFixture(String.raw`
$ErrorActionPreference='Stop'
. $Launcher -ProjectRoot $SourceRoot -FunctionsOnly
$sentinelInfo=[Diagnostics.ProcessStartInfo]::new($Node, '-e "setInterval(()=>{},1000)"')
$sentinelInfo.UseShellExecute=$false; $sentinelInfo.CreateNoWindow=$true
$sentinel=[Diagnostics.Process]::Start($sentinelInfo)
# Retain the handle before this process joins the matrix's private job.
$null=$sentinel.Handle
$tracked=[Collections.Generic.List[object]]::new()
try {
 $beat=Join-Path $PSScriptRoot 'beat.txt'
 $root=Join-Path $PSScriptRoot 'root.cjs'
 $handle=Start-RedirectedProcess $Node ('"'+$root+'" "'+$beat+'"') $PSScriptRoot (Join-Path $PSScriptRoot 'stdout') (Join-Path $PSScriptRoot 'stderr') @{}
 if (-not $handle.Process.WaitForExit(10000)) { throw 'Root failed to exit' }
 if ($handle.Process.ExitCode -ne 0) { throw $handle.StderrTask.Result }
 $deadline=[DateTime]::UtcNow.AddSeconds(10)
 while (-not (Test-Path $beat)) { if ([DateTime]::UtcNow -gt $deadline) { throw 'Child failed to start' }; Start-Sleep -Milliseconds 50 }
 $measurement=Measure-RunnerResourcesUntilExit $handle @($handle) $tracked ([DateTime]::UtcNow.AddSeconds(5))
 if ($tracked.Count -lt 2) { throw 'Genuine late job child was not sampled' }
 Stop-TrackedProcessIds $tracked
 Assert-TrackedProcessIdsGone $tracked
 $before=[IO.File]::ReadAllText($beat)
 Start-Sleep -Milliseconds 200
 if ([IO.File]::ReadAllText($beat) -ne $before) { throw 'Owned descendant still running' }
 if ($sentinel.HasExited) { throw 'Independent sentinel was terminated' }
 Write-Output 'PASS real matrix job ownership and late descendant cleanup'
} finally {
 Stop-TrackedProcessIds $tracked
 if (-not $sentinel.HasExited) { $sentinel.Kill() }
 $sentinel.WaitForExit(); $sentinel.Dispose()
}
`, {
 'root.cjs': `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,[require('node:path').join(__dirname,'child.cjs'),process.argv[2]],{stdio:'ignore',detached:true,windowsHide:true}); child.unref();`,
 'child.cjs': `const fs=require('node:fs'); setInterval(()=>fs.appendFileSync(process.argv[2],'x'),25);`,
 });
});

