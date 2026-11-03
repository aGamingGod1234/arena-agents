import assert from 'node:assert/strict';
import test from 'node:test';
import { powershellFixture } from './fixtures/g26-powershell-fixture.mjs';

test('job witness publishes closed ready files before immediate consumption', { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
 const output = await powershellFixture(String.raw`
$ErrorActionPreference = 'Stop'
$helper = Get-Content -Raw (Join-Path $SourceRoot 'coordinator/src/owned-job-witness.ps1')
$code = [regex]::Match($helper, '(?s)Add-Type -TypeDefinition @"(.*?)"@').Groups[1].Value
# Run Observe itself. Replace kernel calls with a frozen one-member census;
# real Windows file handles below force observation during every ready write.
$replacements = @{
 QueryInformationJobObject = 'static bool QueryInformationJobObject(IntPtr j,int k,IntPtr d,uint n,out uint r) { r=0; Marshal.WriteInt32(d,4,1); Marshal.WriteIntPtr(d,8,new IntPtr(42)); return true; }'
 OpenProcess = 'static IntPtr OpenProcess(uint a,bool i,uint p) { return new IntPtr(3); }'
 IsProcessInJob = 'static bool IsProcessInJob(IntPtr p,IntPtr j,out bool member) { member=true; return true; }'
 WaitForSingleObject = 'static uint WaitForSingleObject(IntPtr p,uint ms) { return WitnessFiles.Frozen ? 0u : 258u; }'
 CloseHandle = 'static bool CloseHandle(IntPtr h) { WitnessFiles.Closed.Add(h.ToInt32()); return true; }'
 NtSuspendProcess = 'static int NtSuspendProcess(IntPtr p) { return 0; }'
 NtResumeProcess = 'static int NtResumeProcess(IntPtr p) { throw new Exception("Exited member must not be resumed"); }'
}
foreach ($name in $replacements.Keys) {
 $pattern = '(?m)^    \[DllImport[^\r\n]+ static extern [^\r\n]+\b' + $name + '\([^\r\n]+;\r?$'
 if (-not [regex]::IsMatch($code,$pattern)) { throw "Missing kernel boundary: $name" }
 $code = [regex]::Replace($code,$pattern,('    '+$replacements[$name]))
}
$code = 'using File = WitnessFiles;' + [Environment]::NewLine + $code + @'
public static class WitnessFiles {
    public static string Control, Evidence;
    public static bool Frozen, RejectReadyPublication;
    public static int Publications, OpenWriteChecks;
    public static System.Collections.Generic.List<int> Closed = new System.Collections.Generic.List<int>();
    public static bool Exists(string path) { return System.IO.File.Exists(path); }
    public static string ReadAllText(string path) { return System.IO.File.ReadAllText(path); }
    public static void Delete(string path) { System.IO.File.Delete(path); }
    public static void WriteAllText(string path, string value) {
        using (var stream = new System.IO.FileStream(path, System.IO.FileMode.Create, System.IO.FileAccess.Write, System.IO.FileShare.Read))
        using (var writer = new System.IO.StreamWriter(stream)) {
            writer.Write(value); writer.Flush();
            if (value == "ready" || value == "FROZEN_JOB_HANDLE_CLOSED") {
                OpenWriteChecks++;
                string ready = value == "ready" ? Control + ".ready" : Evidence + ".ready";
                // This observation runs before Dispose, deterministically exposing direct publication.
                if (System.IO.File.Exists(ready)) throw new Exception("Ready became visible with its writer open");
            }
        }
    }
    public static void Move(string from, string to) {
        if (RejectReadyPublication && to.EndsWith(".ready")) throw new System.IO.IOException("Injected publication failure");
        System.IO.File.Move(from, to);
        if (to == Control + ".ready" || to == Evidence + ".ready") {
            string expected = to == Control + ".ready" ? "ready" : "FROZEN_JOB_HANDLE_CLOSED";
            // An immediate consumer must get the entire token and exclusive access, then delete successfully.
            using (var stream = new System.IO.FileStream(to, System.IO.FileMode.Open, System.IO.FileAccess.Read, System.IO.FileShare.None))
            using (var reader = new System.IO.StreamReader(stream)) {
                if (reader.ReadToEnd() != expected) throw new Exception("Incomplete ready token");
            }
            System.IO.File.Delete(to);
            Publications++;
            if (to == Evidence + ".ready") {
                if (Closed.Count != 1 || Closed[0] != 1) throw new Exception("Job query handle must close before freeze publication");
                Frozen = true;
            }
        }
    }
}
'@
Add-Type -TypeDefinition $code
$control = Join-Path $PSScriptRoot 'control'
$proof = Join-Path $PSScriptRoot 'proof.json'
[WitnessFiles]::Control = $control; [WitnessFiles]::Evidence = $proof
[IO.File]::WriteAllText($control,'1 2')
[IO.File]::WriteAllText($proof+'.freeze','freeze')
[ArenaJobWitness]::Observe($control,$proof)
if ([WitnessFiles]::OpenWriteChecks -ne 2 -or [WitnessFiles]::Publications -ne 2) { throw 'Both ready signals must publish only after closing their writers' }
$result = [IO.File]::ReadAllText($proof) | ConvertFrom-Json
if ($result.status -ne 'COMPLETE' -or -not $result.allMembersExited -or -not $result.wrapperExited -or -not $result.jobHandleClosedBeforeStop -or -not $result.observationHandlesClosed -or $result.frozenMemberCount -ne 1) { throw 'Witness did not preserve complete cleanup evidence' }
if (([WitnessFiles]::Closed -join ',') -ne '1,3,2') { throw 'Observation handles were not closed exactly once' }
if (([IO.Directory]::GetFiles($PSScriptRoot,'control*')).Length -ne 0 -or ([IO.Directory]::GetFiles($PSScriptRoot,'proof.json.*')).Length -ne 0) { throw 'Witness left handshake files behind' }
# A failed rename must keep the witness incomplete and remove the closed staging file.
[IO.File]::Delete($proof)
[WitnessFiles]::Frozen = $false; [WitnessFiles]::RejectReadyPublication = $true
[WitnessFiles]::Closed.Clear()
[IO.File]::WriteAllText($control,'1 2')
[ArenaJobWitness]::Observe($control,$proof)
$result = [IO.File]::ReadAllText($proof) | ConvertFrom-Json
if ($result.status -ne 'INCOMPLETE' -or $result.allMembersExited -or $result.jobHandleClosedBeforeStop -or -not $result.observationHandlesClosed -or $result.frozenMemberCount -ne 0) { throw 'Publication failure must fail closed' }
if (([WitnessFiles]::Closed -join ',') -ne '1,2') { throw 'Publication failure leaked an observation handle' }
if (([IO.Directory]::GetFiles($PSScriptRoot,'control*')).Length -ne 0 -or ([IO.Directory]::GetFiles($PSScriptRoot,'proof.json.*')).Length -ne 0) { throw 'Failed publication left handshake files behind' }
Write-Output 'PASS closed ready publication and cleanup'
`);
 assert.match(output, /PASS closed ready publication and cleanup/);
});
